import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import process from "node:process";
import console from "node:console";
import { runProcess } from "../dist/src/runner.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  executionProfileSchema,
  executionProtocolSchema,
  nativeEvidenceSchema,
  probeEvidenceIds,
  readProtocolEvidence,
  verifyProtocolEvidence,
} from "./agent-evaluation-protocol.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(16000);
const relative = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !path.isAbsolute(value) &&
      !value.includes("\\") &&
      value
        .split("/")
        .every(
          (part) => part && part !== "." && part !== ".." && part !== ".git",
        ),
  );
const identity = z
  .object({
    sessionId: id,
    provider: text,
    model: text,
    version: text,
    provenance: z.literal("orchestrator-declared"),
  })
  .strict();
const usage = z
  .object({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    costUsd: z.number().nonnegative().nullable(),
    elapsedMs: z.number().nonnegative().nullable(),
    provenance: z.enum(["reviewer-declared", "orchestrator-measured"]),
  })
  .strict();
const source = z
  .object({
    repository: z.url().startsWith("https://"),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    license: text,
  })
  .strict();
const validator = z
  .object({
    id,
    kind: z.enum(["native", "additional", "reproduction"]),
    version: text,
    command: z.array(text).min(1).max(64),
    required: z.boolean(),
    assets: z.array(z.object({ path: text, sha256: digest }).strict()).max(32),
  })
  .strict();
export const planSchema = z
  .object({
    schemaVersion: z.literal(1),
    id,
    purpose: text,
    evidenceClass: z.enum(["development", "historical-pilot", "held-out"]),
    curatorSessionId: id,
    reviewerProfile: z
      .object({ provider: text, model: text, version: text, settings: text })
      .strict(),
    environment: z
      .object({ platform: text, runtime: text, dependencies: text })
      .strict(),
    engine: z
      .object({
        package: z.literal("@stsepelin/checktrail"),
        version: text,
        artifact: text,
        sha256: digest,
      })
      .strict(),
    isolation: z.enum(["procedural", "external-sandbox"]),
    isolationEvidence: text,
    executionProtocol: executionProtocolSchema.optional(),
    budget: z
      .object({
        wallSeconds: z.number().int().min(1).max(3600),
        maxToolCalls: z.number().int().min(1).max(500),
        maxInputTokens: z.number().int().positive().nullable(),
        maxOutputTokens: z.number().int().min(1).max(100000),
        repetitions: z.number().int().min(1).max(10),
      })
      .strict(),
    cases: z
      .array(
        z
          .object({
            id,
            family: id,
            group: id,
            split: z.enum(["development", "holdout"]),
            root: text,
            files: z.array(relative).min(1).max(512),
            task: text,
            source,
            executionProfile: executionProfileSchema.optional(),
            nativeEvidence: nativeEvidenceSchema.optional(),
            reviewCommands: z
              .array(
                z
                  .object({
                    command: z.array(text).min(1).max(64),
                    version: text,
                  })
                  .strict(),
              )
              .max(32),
            validators: z.array(validator).max(16),
            exclusion: text.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const labelsSchema = z
  .array(
    z
      .object({
        caseId: id,
        scope: text,
        expectedDefects: z
          .array(
            z
              .object({
                id,
                description: text,
                evidence: z.array(text).min(1).max(16),
                probeEvidenceIds: probeEvidenceIds.optional(),
              })
              .strict(),
          )
          .max(64),
        provenance: text,
      })
      .strict(),
  )
  .min(1)
  .max(100);
const citation = z
  .object({
    file: relative,
    line: z.number().int().positive(),
    endLine: z.number().int().positive(),
    quote: text,
  })
  .strict();
export const receiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    assignmentId: id,
    manifestSha256: digest,
    sourceSha256: digest,
    reviewer: identity,
    status: z.enum(["completed", "incomplete"]),
    findings: z
      .array(
        z
          .object({
            id,
            claim: text,
            citations: z.array(citation).min(1).max(8),
            reproduction: text,
            probeEvidenceIds: probeEvidenceIds.optional(),
          })
          .strict(),
      )
      .max(64),
    limitations: z.array(text).max(64),
    usage,
  })
  .strict();
const decision = z
  .object({
    findingId: id,
    verdict: z.enum([
      "confirmed",
      "false-positive",
      "unresolved",
      "duplicate",
      "out-of-scope",
    ]),
    defectId: id.nullable(),
    duplicateOf: id.nullable(),
    evidence: z.array(text).min(1).max(16),
    probeEvidenceIds: probeEvidenceIds.optional(),
  })
  .strict();
export const judgmentsSchema = z
  .object({
    schemaVersion: z.literal(1),
    manifestSha256: digest,
    adjudicator: identity,
    status: z.enum(["completed", "incomplete"]).optional(),
    judgments: z
      .array(
        z
          .object({
            blindId: id,
            labelStatus: z.enum(["accepted", "disputed"]),
            findings: z.array(decision).max(64),
            rationale: text,
            probeEvidenceIds: probeEvidenceIds.optional(),
          })
          .strict(),
      )
      .max(2000),
  })
  .strict();
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const encode = (value) => JSON.stringify(value, null, 2) + "\n";
const hash = (value) => sha256(encode(value));
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const writeNew = (file, value) =>
  fs.writeFile(file, encode(value), { flag: "wx", mode: 0o600 });
const unique = (values, label) =>
  assert.equal(new Set(values).size, values.length, `Duplicate ${label}`);
const sameSet = (a, b, label) => {
  unique(a, label);
  assert.deepEqual([...a].sort(), [...b].sort(), label);
};

async function regularFile(root, name) {
  let current = root;
  assert.ok(
    (await fs.lstat(root)).isDirectory() &&
      !(await fs.lstat(root)).isSymbolicLink(),
    "Source root must be a regular directory",
  );
  for (const part of relative.parse(name).split("/")) {
    current = path.join(current, part);
    assert.ok(
      !(await fs.lstat(current)).isSymbolicLink(),
      "Symbolic source paths are unsupported",
    );
  }
  const stat = await fs.lstat(current);
  assert.ok(
    stat.isFile() && stat.size <= 2 * 1024 * 1024,
    "Expected a bounded regular source file",
  );
  return fs.readFile(current);
}
async function snapshot(root, files, destination) {
  const records = [];
  let total = 0;
  unique(files, "source file");
  for (const file of [...files].sort()) {
    const bytes = await regularFile(root, file);
    total += bytes.length;
    assert.ok(total <= 32 * 1024 * 1024, "Source snapshot exceeds 32 MiB");
    records.push({ file, sha256: sha256(bytes) });
    if (destination) {
      await fs.mkdir(path.dirname(path.join(destination, file)), {
        recursive: true,
      });
      await fs.writeFile(path.join(destination, file), bytes, {
        flag: "wx",
        mode: 0o600,
      });
    }
  }
  return { files: records, sha256: hash(records) };
}
async function atomicDirectory(destination, work) {
  await assert.rejects(
    fs.stat(destination),
    { code: "ENOENT" },
    "Destination already exists",
  );
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = await fs.mkdtemp(
    path.join(path.dirname(destination), ".agent-eval-"),
  );
  try {
    await work(temporary);
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
async function supportDigests() {
  const compiled = (await fs.readdir(path.join(here, "../dist/src")))
    .filter((file) => file.endsWith(".js"))
    .sort()
    .map((file) => "../dist/src/" + file);
  return Promise.all(
    [
      "agent-evaluation-mcp.mjs",
      "agent-evaluation-gateway.mjs",
      "agent-evaluation-worker.mjs",
      "agent-evaluation-protocol.mjs",
      "agent-evaluation-session.mjs",
      "../package-lock.json",
      ...compiled,
    ].map(async (file) => ({
      file,
      sha256: sha256(await fs.readFile(path.join(here, file))),
    })),
  );
}

async function promptFiles() {
  return Promise.all(
    ["reviewer", "adjudicator", "curator"].map(async (name) => ({
      name,
      content: await fs.readFile(
        path.join(here, "agent-evaluation-prompts", name + ".md"),
        "utf8",
      ),
    })),
  );
}

export async function freeze(planInput, labelsInput, destination) {
  const plan = planSchema.parse(planInput),
    labels = labelsSchema.parse(labelsInput);
  unique(
    plan.cases.map((c) => c.id),
    "case",
  );
  sameSet(
    labels.map((l) => l.caseId),
    plan.cases.map((c) => c.id),
    "label coverage",
  );
  const groups = new Map();
  for (const c of plan.cases) {
    assert.notEqual(c.family, "all", "Reserved aggregate family");
    if (plan.executionProtocol) {
      assert.ok(
        c.executionProfile && c.nativeEvidence,
        "Enforced runs require a native execution profile for every case",
      );
      assert.ok(
        c.nativeEvidence.scope.every((file) => c.files.includes(file)),
        "Native evidence scope must be captured",
      );
    }
    if (groups.has(c.group))
      assert.equal(
        groups.get(c.group),
        c.split,
        "Related cases cross development/holdout split",
      );
    groups.set(c.group, c.split);
    unique(
      c.validators.map((v) => v.id),
      "validator",
    );
    unique(
      labels.find((l) => l.caseId === c.id).expectedDefects.map((d) => d.id),
      "expected defect",
    );
    for (const v of c.validators)
      for (const a of v.assets)
        assert.equal(
          sha256(await fs.readFile(a.path)),
          a.sha256,
          "Validator asset changed",
        );
  }
  assert.equal(
    sha256(await fs.readFile(plan.engine.artifact)),
    plan.engine.sha256,
    "Engine artifact changed",
  );
  const prompts = await promptFiles();
  let frozen;
  await atomicDirectory(destination, async (temporary) => {
    const cases = [];
    for (const c of plan.cases) {
      const captured = await snapshot(
        c.root,
        c.files,
        path.join(temporary, "sources", c.id),
      );
      const after = await snapshot(c.root, c.files);
      assert.equal(
        captured.sha256,
        after.sha256,
        "Source changed during capture",
      );
      cases.push({ ...c, captured });
    }
    const assignments = [];
    for (let trial = 0; trial < plan.budget.repetitions; trial++)
      for (const [index, c] of cases.entries()) {
        for (const arm of (index + trial) % 2
          ? ["mcp", "baseline"]
          : ["baseline", "mcp"])
          assignments.push({
            id: randomBytes(12).toString("hex"),
            blindId: randomBytes(12).toString("hex"),
            caseId: c.id,
            arm,
            trial,
          });
      }
    const manifest = {
      ...plan,
      cases,
      assignments,
      labelsSha256: hash(labels),
      harnessSha256: sha256(await fs.readFile(fileURLToPath(import.meta.url))),
      supportDigests: await supportDigests(),
      prompts,
      createdAt: new Date().toISOString(),
    };
    frozen = { manifest, sha256: hash(manifest) };
    await writeNew(path.join(temporary, "manifest.json"), frozen);
    await writeNew(path.join(temporary, "labels.json"), labels);
    await fs.mkdir(path.join(temporary, "receipts"));
    await fs.mkdir(path.join(temporary, "attempts"));
    await fs.mkdir(path.join(temporary, "references"));
    for (const c of cases)
      await fs.mkdir(path.join(temporary, "references", c.id));
  });
  return frozen;
}
export async function loadRun(root) {
  const frozen = await readJson(path.join(root, "manifest.json"));
  assert.equal(hash(frozen.manifest), frozen.sha256, "Manifest changed");
  assert.equal(
    sha256(await fs.readFile(fileURLToPath(import.meta.url))),
    frozen.manifest.harnessSha256,
    "Harness changed; retain run and declare a new one",
  );
  assert.deepEqual(
    await supportDigests(),
    frozen.manifest.supportDigests,
    "Runner or MCP bridge changed",
  );
  assert.equal(
    sha256(await fs.readFile(frozen.manifest.engine.artifact)),
    frozen.manifest.engine.sha256,
    "Engine artifact changed",
  );
  const labels = labelsSchema.parse(
    await readJson(path.join(root, "labels.json")),
  );
  assert.equal(hash(labels), frozen.manifest.labelsSha256, "Labels changed");
  for (const c of frozen.manifest.cases)
    assert.deepEqual(
      await snapshot(path.join(root, "sources", c.id), c.files),
      c.captured,
      "Frozen source changed",
    );
  return { ...frozen, labels };
}
function assignmentFor(run, assignmentId) {
  const a = run.manifest.assignments.find((a) => a.id === assignmentId);
  assert.ok(a, "Unknown assignment");
  return { a, c: run.manifest.cases.find((c) => c.id === a.caseId) };
}
export async function packet(root, assignmentId, destination) {
  const run = await loadRun(root),
    { a, c } = assignmentFor(run, assignmentId);
  assert.equal(c.exclusion, null, "Excluded case cannot be reviewed");
  await atomicDirectory(destination, async (temporary) => {
    await snapshot(
      path.join(root, "sources", c.id),
      c.files,
      path.join(temporary, "source"),
    );
    await writeNew(path.join(temporary, "task.json"), {
      schemaVersion: 1,
      assignmentId,
      manifestSha256: run.sha256,
      sourceSha256: c.captured.sha256,
      family: c.family,
      task: c.task,
      budget: run.manifest.budget,
      ...(run.manifest.executionProtocol
        ? {
            executionProtocol: run.manifest.executionProtocol.kind,
            executionProfile: c.executionProfile,
            nativeEvidence: c.nativeEvidence,
            evidenceRequirements:
              "Run the selected native suite; MCP arm also validates. Read numbered source and preflight citations. Every finding needs probeEvidenceIds from executed probes with sourceEvidenceIds covering its cited files.",
          }
        : {}),
      reviewerProfile: run.manifest.reviewerProfile,
      environment: run.manifest.environment,
      reviewCommands: c.reviewCommands,
      tools:
        a.arm === "mcp"
          ? "Native tools and frozen Checktrail MCP"
          : "Native tools only; no Checktrail",
      engine:
        a.arm === "mcp"
          ? {
              package: run.manifest.engine.package,
              version: run.manifest.engine.version,
              sha256: run.manifest.engine.sha256,
            }
          : null,
      instruction: run.manifest.prompts.find((p) => p.name === "reviewer")
        .content,
    });
  });
}
async function validateReceipt(root, assignmentId, input) {
  const run = await loadRun(root),
    { c } = assignmentFor(run, assignmentId);
  assert.equal(
    c.exclusion,
    null,
    "Excluded case cannot have a reviewer receipt",
  );
  const receipt = receiptSchema.parse(input);
  assert.equal(receipt.assignmentId, assignmentId);
  assert.equal(receipt.manifestSha256, run.sha256);
  assert.equal(receipt.sourceSha256, c.captured.sha256);
  assert.notEqual(
    receipt.reviewer.sessionId,
    run.manifest.curatorSessionId,
    "Curator cannot review",
  );
  for (const key of ["provider", "model", "version"])
    assert.equal(
      receipt.reviewer[key],
      run.manifest.reviewerProfile[key],
      "Reviewer differs from frozen profile",
    );
  unique(
    receipt.findings.map((f) => f.id),
    "finding",
  );
  for (const a of run.manifest.assignments) {
    const other = await maybeJson(path.join(root, "receipts", a.id + ".json"));
    if (other)
      assert.notEqual(
        other.receipt.reviewer.sessionId,
        receipt.reviewer.sessionId,
        "Each assignment needs a fresh reviewer session",
      );
  }
  for (const finding of receipt.findings)
    for (const citation of finding.citations) {
      assert.ok(
        c.files.includes(citation.file),
        "Citation outside frozen scope",
      );
      const lines = (
        await regularFile(path.join(root, "sources", c.id), citation.file)
      )
        .toString("utf8")
        .split("\n");
      assert.ok(
        citation.endLine >= citation.line && citation.endLine <= lines.length,
        "Invalid citation range",
      );
      assert.equal(
        lines.slice(citation.line - 1, citation.endLine).join("\n"),
        citation.quote,
        "Citation does not match frozen source",
      );
    }
  return { run, receipt };
}
function protocolExpectation(run, assignment, receipt) {
  const c = run.manifest.cases.find((c) => c.id === assignment.caseId);
  const digestFor = (file) =>
    run.manifest.supportDigests.find((item) => item.file === file).sha256;
  return {
    binding: {
      manifestSha256: run.sha256,
      subjectId: assignment.id,
      sessionId: receipt.reviewer.sessionId,
      role: "reviewer",
    },
    files: c.captured.files,
    exactFiles: true,
    treatment: assignment.arm === "mcp",
    profile: c.executionProfile,
    nativeEvidence: c.nativeEvidence,
    gatewaySha256: digestFor("agent-evaluation-gateway.mjs"),
    workerSha256: digestFor("agent-evaluation-worker.mjs"),
    budget: run.manifest.budget,
    engineVersion: run.manifest.engine.version,
  };
}
function disclosedRange(reads, citation) {
  let next = citation.line;
  for (const read of reads
    .filter((read) => read.file === citation.file)
    .sort((a, b) => a.line - b.line)) {
    if (read.line > next) break;
    next = Math.max(next, read.endLine + 1);
    if (next > citation.endLine) return true;
  }
  return false;
}
function reviewProtocol(run, assignment, receipt, evidence) {
  if (!run.manifest.executionProtocol)
    return {
      mode: "declaration-only",
      complete: false,
      problems: ["No enforced execution protocol was declared."],
    };
  const { submission, ...result } = verifyProtocolEvidence(
    evidence,
    protocolExpectation(run, assignment, receipt),
  );
  const problems = [...result.problems];
  if (!isDeepStrictEqual(submission, receipt))
    problems.push("Receipt differs from the client terminal submission.");
  if (!result.native.length)
    problems.push("A conclusive nonempty native test run is required.");
  if (assignment.arm === "mcp" && !result.validations.length)
    problems.push(
      "A conclusive real MCP validation with matching retained report is required.",
    );
  for (const finding of receipt.findings) {
    const ids = finding.probeEvidenceIds ?? [];
    if (!ids.length || ids.some((id) => !result.probes.includes(id)))
      problems.push(`Finding ${finding.id} needs usable probe evidence.`);
    for (const citation of finding.citations) {
      if (!disclosedRange(result.reads, citation))
        problems.push(
          `Finding ${finding.id} cites lines not disclosed by a recorded source read.`,
        );
      if (!ids.some((id) => result.probeSources?.[id]?.includes(citation.file)))
        problems.push(
          `Finding ${finding.id} needs a probe bound to cited file ${citation.file}.`,
        );
    }
  }
  return {
    ...result,
    mode: "gateway-v1",
    complete: problems.length === 0,
    problems,
  };
}
export async function beginAttempt(
  root,
  assignmentId,
  sessionId,
  evidenceDirectory,
) {
  const run = await loadRun(root),
    { c } = assignmentFor(run, assignmentId);
  assert.ok(
    run.manifest.executionProtocol,
    "Attempt reservation requires an enforced run",
  );
  assert.equal(c.exclusion, null, "Excluded assignment cannot start");
  id.parse(sessionId);
  assert.notEqual(
    sessionId,
    run.manifest.curatorSessionId,
    "Curator cannot review",
  );
  const directory = path.resolve(evidenceDirectory);
  assert.equal(
    await fs.realpath(path.dirname(directory)),
    path.dirname(directory),
    "Canonical evidence parent required",
  );
  await assert.rejects(
    fs.stat(directory),
    { code: "ENOENT" },
    "Evidence directory must be new",
  );
  for (const a of run.manifest.assignments) {
    const existing = await maybeJson(
      path.join(root, "attempts", a.id + ".json"),
    );
    if (existing) {
      assert.notEqual(
        existing.sessionId,
        sessionId,
        "Each assignment needs a fresh reviewer session",
      );
      assert.notEqual(
        existing.evidenceDirectory,
        directory,
        "Each attempt needs its own evidence directory",
      );
    }
  }
  const reservation = {
    manifestSha256: run.sha256,
    assignmentId,
    sessionId,
    evidenceDirectory: directory,
  };
  await writeNew(
    path.join(root, "attempts", assignmentId + ".json"),
    reservation,
  );
  return reservation;
}
async function reservedAttempt(
  root,
  run,
  assignmentId,
  receipt,
  evidenceDirectory,
) {
  const reservation = await maybeJson(
    path.join(root, "attempts", assignmentId + ".json"),
  );
  const problems = [];
  if (!reservation)
    problems.push("Assignment was not reserved before execution.");
  else {
    if (
      reservation.manifestSha256 !== run.sha256 ||
      reservation.assignmentId !== assignmentId ||
      reservation.sessionId !== receipt.reviewer.sessionId
    )
      problems.push("Assignment reservation identity mismatch.");
    if (
      evidenceDirectory &&
      reservation.evidenceDirectory !== path.resolve(evidenceDirectory)
    )
      problems.push("Evidence is not from the reserved attempt directory.");
  }
  return { reservation, problems };
}
async function submittedProtocol(
  root,
  run,
  a,
  receipt,
  evidence,
  evidenceDirectory,
) {
  const protocol = reviewProtocol(run, a, receipt, evidence);
  if (!run.manifest.executionProtocol) return { protocol, reservation: null };
  const { reservation, problems } = await reservedAttempt(
    root,
    run,
    a.id,
    receipt,
    evidenceDirectory,
  );
  protocol.problems.push(...problems);
  protocol.complete = protocol.problems.length === 0;
  return { protocol, reservation };
}
export async function preflight(root, assignmentId, input, evidenceDirectory) {
  try {
    const { run, receipt } = await validateReceipt(root, assignmentId, input);
    const { a } = assignmentFor(run, assignmentId);
    const evidence = evidenceDirectory
      ? await readProtocolEvidence(evidenceDirectory)
      : null;
    const { protocol } = await submittedProtocol(
      root,
      run,
      a,
      receipt,
      evidence,
      evidenceDirectory,
    );
    return {
      valid:
        !run.manifest.executionProtocol ||
        receipt.status === "incomplete" ||
        protocol.complete,
      protocolComplete: protocol.complete && receipt.status === "completed",
      citationValid: true,
      protocol,
    };
  } catch (error) {
    return { valid: false, citationValid: false, problems: [error.message] };
  }
}
export async function seal(root, assignmentId, input, evidenceDirectory) {
  const { run, receipt } = await validateReceipt(root, assignmentId, input);
  const { a } = assignmentFor(run, assignmentId);
  const evidence = evidenceDirectory
    ? await readProtocolEvidence(evidenceDirectory)
    : null;
  const { protocol, reservation } = await submittedProtocol(
    root,
    run,
    a,
    receipt,
    evidence,
    evidenceDirectory,
  );
  if (run.manifest.executionProtocol && receipt.status === "completed")
    assert.ok(
      protocol.complete,
      "Completed review violates enforced protocol: " +
        protocol.problems.join("; "),
    );
  const saved = {
    receipt,
    sha256: hash(receipt),
    sealedAt: new Date().toISOString(),
  };
  if (run.manifest.executionProtocol)
    Object.assign(saved, {
      reservation,
      reservationSha256: hash(reservation),
      protocolEvidence: evidence,
      protocolEvidenceSha256: hash(evidence),
      protocol,
    });
  await writeNew(path.join(root, "receipts", assignmentId + ".json"), saved);
}

async function maybeJson(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function receiptsFor(root, run) {
  const entries = [];
  for (const a of run.manifest.assignments) {
    const entry = await maybeJson(path.join(root, "receipts", a.id + ".json"));
    if (entry) {
      assert.equal(
        run.manifest.cases.find((c) => c.id === a.caseId).exclusion,
        null,
        "Excluded case cannot have a reviewer receipt",
      );
      receiptSchema.parse(entry.receipt);
      if (run.manifest.executionProtocol) {
        assert.equal(
          hash(entry.protocolEvidence ?? null),
          entry.protocolEvidenceSha256,
          "Sealed protocol evidence changed",
        );
        const verified = await submittedProtocol(
          root,
          run,
          a,
          entry.receipt,
          entry.protocolEvidence,
        );
        assert.equal(
          hash(verified.reservation),
          entry.reservationSha256,
          "Sealed attempt reservation changed",
        );
        assert.deepEqual(
          verified.reservation,
          entry.reservation,
          "Sealed attempt reservation changed",
        );
        entry.protocol = verified.protocol;
      }
      assert.equal(hash(entry.receipt), entry.sha256, "Sealed receipt changed");
      assert.equal(entry.receipt.assignmentId, a.id);
      assert.equal(entry.receipt.manifestSha256, run.sha256);
      assert.equal(
        entry.receipt.sourceSha256,
        run.manifest.cases.find((c) => c.id === a.caseId).captured.sha256,
      );
    }
    entries.push({ a, entry });
  }
  return entries;
}
async function judgingPacket(root, run, entries) {
  const items = [];
  for (const { a, entry } of entries
    .filter((e) => e.entry)
    .sort((x, y) => x.a.blindId.localeCompare(y.a.blindId))) {
    const c = run.manifest.cases.find((c) => c.id === a.caseId);
    const { caseId: _caseId, ...label } = run.labels.find(
      (l) => l.caseId === a.caseId,
    );
    void _caseId;
    const references = [];
    for (const v of c.validators) {
      const saved = await maybeJson(
        path.join(root, "references", c.id, `${v.id}.json`),
      );
      if (saved) {
        assert.equal(hash(saved.record), saved.sha256, "Reference changed");
        references.push({
          id: v.id,
          kind: v.kind,
          required: v.required,
          record: saved.record,
        });
      } else
        references.push({
          id: v.id,
          kind: v.kind,
          required: v.required,
          record: null,
        });
    }
    items.push({
      blindId: a.blindId,
      references,
      task: c.task,
      label,
      findings: entry.receipt.findings,
      status: entry.receipt.status,
      limitations: entry.receipt.limitations,
      ...(run.manifest.executionProtocol
        ? {
            protocol: {
              complete: entry.protocol.complete,
              problems: entry.protocol.problems,
            },
          }
        : {}),
    });
  }
  return {
    schemaVersion: 1,
    manifestSha256: run.sha256,
    ...(run.manifest.executionProtocol
      ? {
          executionProtocol: run.manifest.executionProtocol.kind,
          budget: run.manifest.executionProtocol.judgeBudget,
        }
      : {}),
    instruction: run.manifest.prompts.find((p) => p.name === "adjudicator")
      .content,
    items,
  };
}
export async function blind(root, destination) {
  const run = await loadRun(root),
    entries = await receiptsFor(root, run);
  assert.ok(
    entries.every(
      ({ a, entry }) =>
        entry || run.manifest.cases.find((c) => c.id === a.caseId).exclusion,
    ),
    "Seal every terminal review before revealing labels",
  );
  const packet = await judgingPacket(root, run, entries);
  await atomicDirectory(destination, async (temporary) => {
    for (const { a, entry } of entries) {
      if (!entry) continue;
      const c = run.manifest.cases.find((c) => c.id === a.caseId);
      await snapshot(
        path.join(root, "sources", c.id),
        c.files,
        path.join(temporary, a.blindId, "source"),
      );
    }
    await writeNew(path.join(temporary, "judging.json"), packet);
  });
}

export async function reference(root, caseId, validatorId, trusted) {
  assert.equal(trusted, true, "Reference execution needs --trust-project");
  const run = await loadRun(root),
    c = run.manifest.cases.find((c) => c.id === caseId);
  assert.ok(c && !c.exclusion, "Unknown or excluded case");
  const v = c.validators.find((v) => v.id === validatorId);
  assert.ok(v, "Unknown validator");
  for (const a of v.assets)
    assert.equal(
      sha256(await fs.readFile(a.path)),
      a.sha256,
      "Validator asset changed",
    );
  const output = path.join(root, "references", caseId, `${validatorId}.json`);
  await assert.rejects(fs.stat(output), { code: "ENOENT" });
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "checktrail-reference-"),
  );
  try {
    await snapshot(path.join(root, "sources", caseId), c.files, temporary);
    const result = await runProcess(
      temporary,
      { executable: v.command[0], args: v.command.slice(1), cwd: "." },
      {
        timeoutMs: Math.min(run.manifest.budget.wallSeconds * 1000, 120000),
        maxOutputBytes: 2 * 1024 * 1024,
        environment: { PYTHONDONTWRITEBYTECODE: "1" },
      },
    );
    let unchanged = false;
    try {
      unchanged =
        (await snapshot(temporary, c.files)).sha256 === c.captured.sha256;
    } catch {
      unchanged = false;
    }
    let assetsUnchanged = true;
    for (const a of v.assets) {
      try {
        if (sha256(await fs.readFile(a.path)) !== a.sha256)
          assetsUnchanged = false;
      } catch {
        assetsUnchanged = false;
      }
    }
    const record = {
      manifestSha256: run.sha256,
      caseId,
      validatorId,
      kind: v.kind,
      version: v.version,
      sourceSha256: c.captured.sha256,
      sourceUnchanged: unchanged,
      status:
        result.errorCode ||
        result.signal ||
        result.timedOut ||
        result.cancelled ||
        result.truncated ||
        !unchanged ||
        !assetsUnchanged
          ? "incomplete"
          : "completed",
      exitCode: result.exitCode,
      signal: result.signal,
      error: result.errorCode ?? null,
      timedOut: result.timedOut,
      truncated: result.truncated,
      assetsUnchanged,
      elapsedMs: result.durationMs,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      interpretation:
        "Process evidence only; a nonzero exit is not automatically a detected defect",
    };
    await writeNew(output, { record, sha256: hash(record) });
    return record;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function verifyJudgeProtocol(
  root,
  run,
  entries,
  judgments,
  evidenceDirectory,
) {
  if (!run.manifest.executionProtocol)
    return {
      mode: "declaration-only",
      complete: false,
      problems: ["No enforced judging protocol was declared."],
    };
  const protocol = run.manifest.executionProtocol;
  const files = entries
    .filter((item) => item.entry)
    .flatMap(({ a }) =>
      run.manifest.cases
        .find((c) => c.id === a.caseId)
        .captured.files.map((file) => ({
          ...file,
          file: `${a.blindId}/source/${file.file}`,
        })),
    );
  files.push({
    file: "judging.json",
    sha256: sha256(encode(await judgingPacket(root, run, entries))),
  });
  const digestFor = (file) =>
    run.manifest.supportDigests.find((item) => item.file === file).sha256;
  const evidence = evidenceDirectory
    ? await readProtocolEvidence(evidenceDirectory)
    : null;
  const { submission, ...verified } = verifyProtocolEvidence(evidence, {
    binding: {
      manifestSha256: run.sha256,
      subjectId: "judging",
      sessionId: judgments.adjudicator.sessionId,
      role: "judge",
    },
    files,
    exactFiles: true,
    treatment: false,
    profile: protocol.judgeProfile,
    budget: protocol.judgeBudget,
    gatewaySha256: digestFor("agent-evaluation-gateway.mjs"),
    workerSha256: digestFor("agent-evaluation-worker.mjs"),
  });
  const problems = [...verified.problems];
  if (!isDeepStrictEqual(submission, judgments))
    problems.push("Judgments differ from the client terminal submission.");
  if (judgments.status !== "completed")
    problems.push("Judge has no completed terminal status.");
  const selected = entries.filter(
    ({ a }) => !run.manifest.cases.find((c) => c.id === a.caseId).exclusion,
  );
  if (
    judgments.judgments.length !== selected.length ||
    selected.some(({ entry }) => !entry)
  )
    problems.push("Judge must account for every selected terminal assessment.");
  const bound = (ids, blindId) =>
    ids?.length &&
    ids.every(
      (id) =>
        verified.probes.includes(id) &&
        verified.probeSources?.[id]?.some((file) =>
          file.startsWith(`${blindId}/source/`),
        ),
    );
  for (const item of judgments.judgments) {
    if (
      item.labelStatus === "accepted" &&
      !bound(item.probeEvidenceIds, item.blindId)
    )
      problems.push(
        `Accepted label ${item.blindId} needs its own source-bound control probe.`,
      );
    for (const finding of item.findings)
      if (
        !["duplicate", "unresolved"].includes(finding.verdict) &&
        !bound(finding.probeEvidenceIds, item.blindId)
      )
        problems.push(
          `Decision ${item.blindId}/${finding.findingId} needs source-bound probe evidence.`,
        );
  }
  return {
    ...verified,
    mode: "gateway-v1",
    complete: problems.length === 0,
    problems,
  };
}

export async function score(root, input, evidenceDirectory) {
  const run = await loadRun(root),
    judgments = judgmentsSchema.parse(input),
    entries = await receiptsFor(root, run);
  assert.equal(judgments.manifestSha256, run.sha256);
  assert.notEqual(
    judgments.adjudicator.sessionId,
    run.manifest.curatorSessionId,
    "Curator cannot adjudicate",
  );
  unique(
    judgments.judgments.map((j) => j.blindId),
    "judgment",
  );
  unique(
    entries
      .filter((e) => e.entry)
      .map((e) => e.entry.receipt.reviewer.sessionId),
    "reviewer session",
  );
  for (const { entry } of entries)
    if (entry)
      assert.notEqual(
        judgments.adjudicator.sessionId,
        entry.receipt.reviewer.sessionId,
        "Reviewer cannot adjudicate own run",
      );
  assert.ok(
    judgments.judgments.every((j) =>
      entries.some((e) => e.a.blindId === j.blindId && e.entry),
    ),
    "Unknown judgment or missing review",
  );
  const judgeProtocol = await verifyJudgeProtocol(
    root,
    run,
    entries,
    judgments,
    evidenceDirectory,
  );
  const observations = [];
  for (const { a, entry } of entries) {
    const c = run.manifest.cases.find((c) => c.id === a.caseId),
      label = run.labels.find((l) => l.caseId === a.caseId),
      j = judgments.judgments.find((j) => j.blindId === a.blindId);
    const expected = label.expectedDefects.map((d) => d.id);
    if (j) {
      sameSet(
        j.findings.map((f) => f.findingId),
        entry.receipt.findings.map((f) => f.id),
        "Every finding must be adjudicated",
      );
      for (const f of j.findings) {
        if (f.verdict === "confirmed") {
          assert.ok(
            f.defectId && expected.includes(f.defectId),
            "Confirmed match needs a predeclared defect; new discoveries are out-of-scope",
          );
          assert.equal(f.duplicateOf, null);
        } else {
          assert.equal(f.defectId, null);
          if (f.verdict === "duplicate") {
            const original = j.findings.find(
              (o) => o.findingId === f.duplicateOf,
            );
            assert.ok(
              original &&
                original.findingId !== f.findingId &&
                ["confirmed", "false-positive", "out-of-scope"].includes(
                  original.verdict,
                ),
              "Duplicate needs a resolved original",
            );
          } else assert.equal(f.duplicateOf, null);
        }
      }
      unique(
        j.findings
          .filter((f) => f.verdict === "confirmed")
          .map((f) => f.defectId),
        "Confirmed defect; mark repeat claims duplicate",
      );
    }
    const references = [];
    for (const v of c.validators) {
      const saved = await maybeJson(
        path.join(root, "references", c.id, `${v.id}.json`),
      );
      if (saved) {
        assert.equal(
          hash(saved.record),
          saved.sha256,
          "Reference evidence changed",
        );
        assert.equal(saved.record.manifestSha256, run.sha256);
        assert.equal(saved.record.sourceSha256, c.captured.sha256);
        assert.equal(saved.record.caseId, c.id);
        assert.equal(saved.record.validatorId, v.id);
      }
      references.push({
        id: v.id,
        kind: v.kind,
        required: v.required,
        status: saved?.record.status ?? "missing",
        exitCode: saved?.record.exitCode ?? null,
        evidenceSha256: saved?.sha256 ?? null,
      });
    }
    const u = entry?.protocol?.usage ?? entry?.receipt.usage;
    const budgetExceeded = Boolean(
      u &&
      ((u.elapsedMs !== null &&
        u.elapsedMs > run.manifest.budget.wallSeconds * 1000) ||
        (u.outputTokens !== null &&
          u.outputTokens > run.manifest.budget.maxOutputTokens) ||
        (u.inputTokens !== null &&
          run.manifest.budget.maxInputTokens !== null &&
          u.inputTokens > run.manifest.budget.maxInputTokens)),
    );
    const ready =
      c.exclusion === null &&
      !budgetExceeded &&
      (!run.manifest.executionProtocol ||
        (entry?.protocol?.complete && judgeProtocol.complete)) &&
      entry?.receipt.status === "completed" &&
      j?.labelStatus === "accepted" &&
      !j.findings.some((f) => f.verdict === "unresolved") &&
      references.every((v) => !v.required || v.status === "completed");
    const matched =
      j?.labelStatus === "accepted"
        ? j.findings
            .filter((f) => f.verdict === "confirmed")
            .map((f) => f.defectId)
        : [];
    observations.push({
      caseId: c.id,
      family: c.family,
      group: c.group,
      split: c.split,
      arm: a.arm,
      trial: a.trial,
      status: c.exclusion ? "excluded" : ready ? "complete" : "incomplete",
      exclusion: c.exclusion,
      expected: expected.length,
      matched: matched.length,
      matchedDefectIds: matched,
      missed: ready ? expected.length - matched.length : null,
      falseClaims:
        j?.findings.filter((f) => f.verdict === "false-positive").length ?? 0,
      unresolvedClaims:
        j?.findings.filter((f) => f.verdict === "unresolved").length ?? 0,
      duplicateClaims:
        j?.findings.filter((f) => f.verdict === "duplicate").length ?? 0,
      outOfScopeClaims:
        j?.findings.filter((f) => f.verdict === "out-of-scope").length ?? 0,
      receiptSha256: entry?.sha256 ?? null,
      labelAccepted: j?.labelStatus === "accepted",
      references,
      usage: u ?? null,
      budgetExceeded,
      protocol: entry?.protocol ?? {
        mode: run.manifest.executionProtocol?.kind ?? "declaration-only",
        complete: false,
        problems: ["No enforced evidence."],
      },
    });
  }
  const families = [...new Set(observations.map((o) => o.family))];
  const summaries = [];
  for (const family of ["all", ...families])
    for (const arm of ["baseline", "mcp"]) {
      const rows = observations.filter(
        (o) => o.arm === arm && (family === "all" || o.family === family),
      );
      const sum = (key) => rows.reduce((s, o) => s + (o[key] ?? 0), 0);
      summaries.push({
        family,
        arm,
        assignments: rows.length,
        distinctCases: new Set(rows.map((o) => o.caseId)).size,
        groups: new Set(rows.map((o) => o.group)).size,
        complete: rows.filter((o) => o.status === "complete").length,
        incomplete: rows.filter((o) => o.status === "incomplete").length,
        excluded: rows.filter((o) => o.status === "excluded").length,
        expectedDefects: sum("expected"),
        detected: sum("matched"),
        confirmedMisses: sum("missed"),
        unresolvedExpected: rows
          .filter((o) => o.status !== "complete")
          .reduce((s, o) => s + o.expected - o.matched, 0),
        falseClaims: sum("falseClaims"),
        validCaseFalseAlarms: rows.filter(
          (o) => o.expected === 0 && o.falseClaims > 0,
        ).length,
        validCases: rows.filter((o) => o.expected === 0).length,
        unresolvedClaims: sum("unresolvedClaims"),
        duplicates: sum("duplicateClaims"),
        outOfScopeClaims: sum("outOfScopeClaims"),
        unknownCostAssignments: rows.filter((o) => o.usage?.costUsd == null)
          .length,
      });
    }
  const pairs = [];
  for (const c of run.manifest.cases)
    for (let trial = 0; trial < run.manifest.budget.repetitions; trial++) {
      const base = observations.find(
        (o) => o.caseId === c.id && o.trial === trial && o.arm === "baseline",
      );
      const mcp = observations.find(
        (o) => o.caseId === c.id && o.trial === trial && o.arm === "mcp",
      );
      const both = base.matchedDefectIds.filter((d) =>
        mcp.matchedDefectIds.includes(d),
      ).length;
      pairs.push({
        caseId: c.id,
        family: c.family,
        group: c.group,
        split: c.split,
        trial,
        complete: base.status === "complete" && mcp.status === "complete",
        expected: base.expected,
        both,
        baselineOnly: base.matched - both,
        mcpOnly: mcp.matched - both,
        neither:
          base.expected -
          new Set([...base.matchedDefectIds, ...mcp.matchedDefectIds]).size,
        baselineFalseClaims: base.falseClaims,
        mcpFalseClaims: mcp.falseClaims,
      });
    }
  const complete = observations.every((o) => o.status === "complete");
  return {
    schemaVersion: 1,
    runId: run.manifest.id,
    manifestSha256: run.sha256,
    evidenceClass: run.manifest.evidenceClass,
    engine: {
      package: run.manifest.engine.package,
      version: run.manifest.engine.version,
      sha256: run.manifest.engine.sha256,
    },
    complete,
    executionProtocol:
      run.manifest.executionProtocol?.kind ?? "declaration-only",
    protocolComplete:
      Boolean(run.manifest.executionProtocol) &&
      complete &&
      judgeProtocol.complete,
    judgeProtocol,
    effectivenessClaimSupported: false,
    identityProvenance:
      "orchestrator-declared; sessions do not prove distinct models or independent organizations",
    isolation: run.manifest.isolation,
    observations,
    pairs,
    summaries,
    learningQueue: observations
      .filter(
        (o) =>
          o.status !== "complete" ||
          o.missed ||
          o.falseClaims ||
          o.outOfScopeClaims,
      )
      .map((o) => ({
        caseId: o.caseId,
        arm: o.arm,
        trial: o.trial,
        reason:
          o.status !== "complete"
            ? "resolve-incomplete-evidence"
            : o.missed
              ? "reproduce-missed-defect"
              : o.falseClaims
                ? "reproduce-false-alarm"
                : "adjudicate-new-discovery-separately",
        nextGate:
          "development reproduction, regression, reviewed change, then fresh group-disjoint holdout",
      })),
    limits: [
      "Historical cases may be known to model training; this harness does not establish model independence or lack of contamination.",
      run.manifest.executionProtocol
        ? "Labels, reviewer identity and semantic adjudication remain declarations; budget evidence is checked against captured telemetry and trusted supervisor observations, not independently attested by the provider."
        : "Labels, reviewer identity, budget compliance and adjudication are declarations; artifact hashes establish binding, not truth.",
      "No population inference, non-inferiority claim, automatic code changes or model training follows from this report.",
      "Missing, disputed, excluded and incomplete cases remain visible; repeated trials are not independent new cases.",
    ],
  };
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === "freeze" && rest.length === 3) {
    const frozen = await freeze(
      await readJson(rest[0]),
      await readJson(rest[1]),
      path.resolve(rest[2]),
    );
    console.log(
      encode({
        sha256: frozen.sha256,
        assignments: frozen.manifest.assignments,
      }),
    );
  } else if (command === "begin" && rest.length === 4) {
    const reservation = await beginAttempt(
      path.resolve(rest[0]),
      rest[1],
      rest[2],
      path.resolve(rest[3]),
    );
    console.log(
      encode({
        assignmentId: reservation.assignmentId,
        sessionId: reservation.sessionId,
        reserved: true,
      }),
    );
  } else if (command === "packet" && rest.length === 3)
    await packet(path.resolve(rest[0]), rest[1], path.resolve(rest[2]));
  else if (
    (command === "seal" || command === "preflight") &&
    (rest.length === 3 || rest.length === 4)
  ) {
    const parameters = [
      path.resolve(rest[0]),
      rest[1],
      await readJson(rest[2]),
      rest[3] ? path.resolve(rest[3]) : undefined,
    ];
    if (command === "seal") await seal(...parameters);
    else {
      const result = await preflight(...parameters);
      console.log(encode(result));
      if (!result.valid) process.exitCode = 1;
    }
  } else if (command === "blind" && rest.length === 2)
    await blind(path.resolve(rest[0]), path.resolve(rest[1]));
  else if (
    command === "reference" &&
    rest.length === 4 &&
    rest[3] === "--trust-project"
  ) {
    const r = await reference(path.resolve(rest[0]), rest[1], rest[2], true);
    console.log(encode({ status: r.status, exitCode: r.exitCode }));
  } else if (command === "score" && (rest.length === 3 || rest.length === 4)) {
    const result = await score(
      path.resolve(rest[0]),
      await readJson(rest[1]),
      rest[3] ? path.resolve(rest[3]) : undefined,
    );
    await writeNew(rest[2], result);
    console.log(
      encode({
        complete: result.complete,
        protocolComplete: result.protocolComplete,
        executionProtocol: result.executionProtocol,
        summaries: result.summaries,
      }),
    );
  } else
    throw new Error(
      "Usage: agent-evaluation.mjs freeze PLAN LABELS RUN | begin RUN ASSIGNMENT SESSION_ID EVIDENCE_DIR | packet RUN ASSIGNMENT OUT | preflight RUN ASSIGNMENT RECEIPT [EVIDENCE_DIR] | seal RUN ASSIGNMENT RECEIPT [EVIDENCE_DIR] | blind RUN OUT | reference RUN CASE VALIDATOR --trust-project | score RUN JUDGMENTS OUTPUT [EVIDENCE_DIR]",
    );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
