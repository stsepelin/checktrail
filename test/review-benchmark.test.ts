import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtemp,
  chmod,
  readFile,
  writeFile,
  rm,
  stat,
  symlink,
  link,
  readdir,
  mkdir,
  truncate,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  ReviewBenchmark,
  freezeReviewBenchmark,
} from "../src/review-benchmark.js";
import {
  reviewBenchmarkPacketSchema,
  reviewBenchmarkJudgingSchema,
  type ReviewBenchmarkPlan,
} from "../src/review-benchmark-schema.js";
import { ReviewWorkflowSession } from "../src/review-workflow-session.js";
import {
  reviewWorkflowLimitsSchema,
  reviewWorkflowAssignmentSchema,
  reviewWorkflowSummarySchema,
} from "../src/review-workflow-schema.js";
import { inspectReviewWorkflowAudit } from "../src/review-workflow-audit.js";
import {
  setup,
  pin,
  response,
  limits,
  source,
} from "./review-workflow-fixture.js";
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const privateCase = "OriginalCuratorCaseCanary";
const privateGroup = "OriginalCuratorGroupCanary";
const privateAnswer = "OriginalHiddenAnswerCanary";
async function prepare(
  t: TestContext,
  count = 1,
  repetitions = 1,
  native = false,
) {
  const cases = [];
  for (let i = 0; i < count; i++) {
    const code =
      i === 0
        ? source
        : i === 1
          ? "export function decision(name){return name.startsWith('grant:');}\n"
          : "export function decision(name){return name === 'grant:read';}\n";
    cases.push(await setup(t, code));
  }
  const operator = await mkdtemp(
    path.join(tmpdir(), "checktrail-original-benchmark-"),
  );
  await chmod(operator, 0o700);
  t.after(() => rm(operator, { recursive: true, force: true }));
  const host = {
    client: "original-any-ai-host",
    clientVersion: "fixture-1",
    provider: "operator-chosen-provider",
    model: "fictional-exact-model",
  };
  const settings = {
    allowReviewSource: true as const,
    trusted: native,
    workflowLimits: { ...limits, maxWorkflows: 1 },
    nativeWallMs: 30000,
    maxNativeOutputBytes: 65536,
    nativeBudget: { maxCalls: 16, maxOutputBytes: 65536 },
    probes: native ? [{ id: "OriginalWorkflow", sha256: pin().sha256 }] : [],
  };
  const plan: ReviewBenchmarkPlan = {
    schemaVersion: 1,
    profile: "workflow-journal-paired-synthetic-v1",
    provenance: "operator-declared-original-synthetic",
    curatorSessionId: "OriginalCuratorSessionCanary",
    repetitions,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    arms: [
      {
        id: "OriginalArmA",
        instructions: "Review independently under declared condition A.",
        settings,
        host,
      },
      {
        id: "OriginalArmB",
        instructions: "Review independently under declared condition B.",
        settings: structuredClone(settings),
        host,
      },
    ],
    cases: cases.map((c, i) => ({
      id: `${privateCase}${i}`,
      group: privateGroup,
      context: c.context,
      labels: {
        variant: i === 0 ? "broken" : i === 1 ? "fixed" : "near-miss",
        expectedDefects:
          i === 0
            ? [
                {
                  id: privateAnswer,
                  claim: "The synthetic prefix admits grantToken.",
                },
              ]
            : [],
      },
    })),
  };
  const frozen = freezeReviewBenchmark(
    cases[0]!.root,
    plan,
    path.join(operator, "run"),
  );
  const benchmark = new ReviewBenchmark(cases[0]!.root, frozen.reference);
  const manifest = JSON.parse(
    await readFile(
      path.join(frozen.reference.directory, "manifest.json"),
      "utf8",
    ),
  ) as {
    trials: {
      trialId: string;
      caseIndex: number;
      armIndex: number;
      blindId: string;
    }[];
  };
  return { ...frozen, benchmark, operator, cases, plan, manifest };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;
async function runTrial(
  t: TestContext,
  fixture: Prepared,
  index: number,
  mode: "empty" | "native" | "malformed" | "refused" | "cancelled" = "empty",
  sessionId?: string,
  sourceCaseIndex?: number,
  model?: string,
) {
  const trial = fixture.manifest.trials[index]!,
    c = fixture.cases[sourceCaseIndex ?? trial.caseIndex]!;
  // Every trial gets fresh source storage; identical contexts must not depend on its absolute location.
  const fresh = await setup(t, c.context.files[0]!.content);
  assert.equal(fresh.context.contextDigest, c.context.contextDigest);
  const startup = fixture.benchmark.trialSetup(trial.trialId);
  const session = new ReviewWorkflowSession(fresh.root, {
    allowReviewSource: true,
    trusted: startup.settings.trusted,
    limits: reviewWorkflowLimitsSchema.parse(
      fixture.plan.arms[trial.armIndex]!.settings.workflowLimits,
    ),
    nativeWallMs: startup.settings.nativeWallMs,
    maxNativeOutputBytes: startup.settings.maxNativeOutputBytes,
    nativeBudget: startup.settings.nativeBudget,
    probes: startup.settings.probes.length ? [pin()] : [],
    audit: startup.audit,
  });
  try {
    const opened = reviewWorkflowSummarySchema.parse(
      await session.command({
        operation: "open",
        context: ".checktrail/context.json",
      }),
    );
    const assignment = reviewWorkflowAssignmentSchema.parse(
      await session.command({
        operation: "next",
        workflowId: opened.workflowId,
      }),
    );
    const submission = response(
      assignment,
      mode === "native" ? [fresh.target] : [],
    );
    if (sessionId) submission.host.sessionId = sessionId;
    if (model) submission.host.model = model;
    if (mode === "refused" || mode === "cancelled") {
      submission.status = mode;
      submission.output = null;
    }
    const input =
      mode === "malformed"
        ? {
            ...submission,
            originalMalformedCanary: "OriginalRejectedAttemptCanary",
          }
        : submission;
    let result = reviewWorkflowSummarySchema.parse(
      await session.command({
        operation: "submit",
        workflowId: opened.workflowId,
        response: input,
      }),
    );
    if (mode === "native") {
      // A replay must remain in the raw archive without duplicating the accepted finding in judging.
      await assert.rejects(
        session.command({
          operation: "submit",
          workflowId: opened.workflowId,
          response: input,
        }),
        /No available host assignment/,
      );
      let refuter = reviewWorkflowAssignmentSchema.parse(
        await session.command({
          operation: "next",
          workflowId: opened.workflowId,
          target: result.candidateHandles[0],
        }),
      );
      const replay = reviewWorkflowSummarySchema.parse(
        await session.command({
          operation: "submit",
          workflowId: opened.workflowId,
          response: input,
        }),
      );
      assert.equal(replay.assignments.at(-1)!.status, "invalid-binding");
      refuter = reviewWorkflowAssignmentSchema.parse(
        await session.command({
          operation: "next",
          workflowId: opened.workflowId,
          target: result.candidateHandles[0],
        }),
      );
      await session.command({
        operation: "submit",
        workflowId: opened.workflowId,
        response: response(refuter),
      });
      result = reviewWorkflowSummarySchema.parse(
        await session.command({
          operation: "probe",
          workflowId: opened.workflowId,
          probeId: "OriginalWorkflow",
        }),
      );
      const adjudicator = reviewWorkflowAssignmentSchema.parse(
        await session.command({
          operation: "next",
          workflowId: result.workflowId,
        }),
      );
      result = reviewWorkflowSummarySchema.parse(
        await session.command({
          operation: "submit",
          workflowId: result.workflowId,
          response: response(adjudicator),
        }),
      );
      assert.equal(result.disposition, "advisory-stages-completed");
    } else if (mode === "empty")
      assert.equal(result.disposition, "no-candidates-declared");
  } finally {
    session.dispose();
  }
  return startup.audit.file;
}
function noPrivate(text: string, fixture: Prepared) {
  for (const value of [
    privateCase,
    privateGroup,
    privateAnswer,
    fixture.plan.curatorSessionId,
    "OriginalArmA",
    "OriginalArmB",
    fixture.operator,
  ])
    assert.equal(text.includes(value), false, value);
}
async function privateJson(filename: string, value: unknown) {
  await writeFile(filename, JSON.stringify(value), { mode: 0o600 });
  await chmod(filename, 0o600);
}
test("benchmark freezes complete paired synthetic protocols before writes and rejects invalid inventories without artifacts", async (t) => {
  const f = await prepare(t, 3, 2);
  assert.equal(f.summary.planned, 12);
  assert.equal(f.summary.accounted, 0);
  assert.equal(f.summary.qualityAssessed, false);
  assert.equal(
    (await stat(path.join(f.reference.directory, "manifest.json"))).mode &
      0o777,
    0o600,
  );
  const invalids = [
    { ...f.plan, repetitions: 0 },
    { ...f.plan, arms: [f.plan.arms[0], f.plan.arms[0]] },
    { ...f.plan, cases: [f.plan.cases[0], f.plan.cases[0]] },
    {
      ...f.plan,
      cases: [
        {
          ...f.plan.cases[1],
          labels: { ...f.plan.cases[0]!.labels, variant: "fixed" },
        },
      ],
    },
    {
      ...f.plan,
      arms: f.plan.arms.map((a) => ({
        ...a,
        settings: {
          ...a.settings,
          workflowLimits: { ...limits, maxWorkflows: 2 },
        },
      })),
    },
    { ...f.plan, profile: "held-out-real-project" },
  ];
  for (const [i, invalid] of invalids.entries()) {
    const destination = path.join(f.operator, `invalid-${i}`);
    assert.throws(() =>
      freezeReviewBenchmark(f.cases[0]!.root, invalid, destination),
    );
    await assert.rejects(stat(destination), { code: "ENOENT" });
  }
  assert.throws(
    () =>
      freezeReviewBenchmark(f.cases[0]!.root, f.plan, f.reference.directory),
    /exists/,
  );
  const file = path.join(f.reference.directory, "manifest.json");
  const original = await readFile(file);
  for (const mutate of [
    (value: typeof f.manifest) => value.trials.pop(),
    (value: typeof f.manifest) => {
      value.trials[0]!.blindId = value.trials[0]!.trialId;
    },
  ]) {
    const value = JSON.parse(original.toString());
    mutate(value);
    await privateJson(file, value);
    assert.throws(
      () =>
        new ReviewBenchmark(f.cases[0]!.root, {
          ...f.reference,
          sha256: digest(Buffer.from(JSON.stringify(value))),
        }),
      /inventory|missing/,
    );
  }
  await writeFile(file, original);
  assert.equal(
    digest(await readFile(path.join(f.reference.directory, "manifest.json"))),
    f.reference.sha256,
  );
});
test("benchmark anonymous packets withhold labels sibling state and private paths and require startup source disclosure", async (t) => {
  const f = await prepare(t, 3, 2);
  noPrivate(JSON.stringify(f.summary), f);
  for (const trial of f.manifest.trials) {
    assert.throws(
      () =>
        f.benchmark.command(
          { operation: "packet", trialId: trial.trialId },
          false,
        ),
      /startup authorization/,
    );
    const packet = reviewBenchmarkPacketSchema.parse(
      f.benchmark.command(
        { operation: "packet", trialId: trial.trialId },
        true,
      ),
    );
    noPrivate(JSON.stringify(packet), f);
    assert.deepEqual(packet.context, f.cases[trial.caseIndex]!.context);
    assert.equal(packet.hostIsolationVerified, false);
    assert.equal(packet.externalAttemptsComplete, false);
  }
  assert.throws(
    () =>
      f.benchmark.command({ operation: "packet", trialId: randomUUID() }, true),
    /Unknown/,
  );
  assert.throws(() =>
    f.benchmark.command(
      {
        operation: "packet",
        trialId: f.summary.trials[0]!.trialId,
        allowSource: true,
      },
      true,
    ),
  );
  assert.throws(() => f.benchmark.command({ operation: "collect" }, true));
  assert.throws(() => f.benchmark.prepareJudging(), /before judging/);
});
test("benchmark original broken fixed and near-miss native trials retain receipts and rejected replays without unblinding judging", async (t) => {
  const f = await prepare(t, 3, 1, true);
  for (let i = 0; i < f.manifest.trials.length; i++)
    await runTrial(t, f, i, "native");
  const collected = f.benchmark.collect();
  assert.equal(collected.accounted, 6);
  assert.equal(collected.completed, 6);
  assert.equal(collected.qualityAssessed, false);
  noPrivate(JSON.stringify(collected), f);
  const archive = JSON.parse(
    await readFile(path.join(f.reference.directory, "collection.json"), "utf8"),
  );
  for (const row of archive.trials) {
    const bytes = Buffer.from(row.journalBase64, "base64");
    assert.equal(digest(bytes), row.journalDigest);
    assert.deepEqual(
      bytes,
      await readFile(
        path.join(f.reference.directory, "journals", `${row.trialId}.jsonl`),
      ),
    );
    assert.equal(
      inspectReviewWorkflowAudit(
        path.join(f.reference.directory, "journals", `${row.trialId}.jsonl`),
      ).nativeReceipts.retained,
      1,
    );
  }
  assert.equal(f.benchmark.prepareJudging().state, "judging-prepared");
  const judging = reviewBenchmarkJudgingSchema.parse(
    JSON.parse(
      await readFile(path.join(f.reference.directory, "judging.json"), "utf8"),
    ),
  );
  noPrivate(JSON.stringify(judging), f);
  assert.equal(judging.packets.length, 6);
  for (const packet of judging.packets) {
    assert.equal(
      packet.outputs.length,
      1,
      "Replayed response must not duplicate an accepted output",
    );
    assert.equal(packet.outputs[0]!.candidates.length, 1);
    assert.equal(packet.native.length, 1);
    const result = packet.native[0]!.run;
    assert.equal(result.status, "completed");
    assert.equal(result.claimsVerified, false);
  }
  assert.throws(
    () =>
      f.benchmark.command(
        { operation: "packet", trialId: f.summary.trials[0]!.trialId },
        true,
      ),
    /closed/,
  );
  assert.throws(
    () => f.benchmark.trialSetup(f.summary.trials[0]!.trialId),
    /unavailable/,
  );
  const broken = judging.packets.filter(
    (p) => p.context.files[0]!.content === source,
  );
  const controls = judging.packets.filter(
    (p) => p.context.files[0]!.content !== source,
  );
  assert.equal(broken.length, 2);
  assert.equal(controls.length, 4);
  assert.ok(
    broken.every(
      (p) =>
        p.native[0]!.run.trials.find((c) => c.id === "Trigger")!
          .matchesExpectation === false,
    ),
  );
  assert.ok(
    controls.every(
      (p) =>
        p.native[0]!.run.trials.find((c) => c.id === "Trigger")!
          .matchesExpectation === true,
    ),
  );
});
test("benchmark collection accounts for every missing invalid refused cancelled malformed and interrupted trial before judging", async (t) => {
  const f = await prepare(t, 3, 1);
  const files = [
    null,
    path.join(
      f.reference.directory,
      "journals",
      `${f.manifest.trials[1]!.trialId}.jsonl`,
    ),
    await runTrial(t, f, 2, "refused"),
    await runTrial(t, f, 3, "cancelled"),
    await runTrial(t, f, 4, "malformed"),
    await runTrial(t, f, 5),
  ];
  await writeFile(files[1]!, "OriginalInvalidJournalCanary\n", { mode: 0o600 });
  const complete = await readFile(files[5]!, "utf8");
  await writeFile(
    files[5]!,
    complete.slice(0, complete.lastIndexOf("\n", complete.length - 2) + 1) +
      '{"torn":',
  );
  const summary = f.benchmark.collect();
  assert.equal(summary.planned, 6);
  assert.equal(summary.accounted, 6);
  assert.equal(summary.completed, 0);
  assert.deepEqual(
    summary.trials.map((t) => t.status),
    [
      "missing",
      "invalid",
      "sealed-incomplete",
      "sealed-incomplete",
      "sealed-incomplete",
      "interrupted",
    ],
  );
  assert.equal(summary.trials[0]!.commands, null);
  assert.equal(summary.trials[1]!.commands, null);
  const collection = JSON.parse(
    await readFile(path.join(f.reference.directory, "collection.json"), "utf8"),
  );
  assert.ok(
    Buffer.from(collection.trials[4].journalBase64, "base64")
      .toString()
      .includes("OriginalRejectedAttemptCanary"),
  );
  for (let i = 1; i < files.length; i++)
    assert.deepEqual(
      Buffer.from(collection.trials[i].journalBase64, "base64"),
      await readFile(files[i]!),
    );
  assert.equal(f.benchmark.prepareJudging().accounted, 6);
});
test("benchmark frozen trial bindings reject swapped journals and source contexts while retaining all foreign artifacts", async (t) => {
  const f = await prepare(t, 2);
  for (let i = 0; i < 4; i++) await runTrial(t, f, i);
  const a = path.join(
      f.reference.directory,
      "journals",
      `${f.manifest.trials[0]!.trialId}.jsonl`,
    ),
    b = path.join(
      f.reference.directory,
      "journals",
      `${f.manifest.trials[1]!.trialId}.jsonl`,
    );
  const bytesA = await readFile(a),
    bytesB = await readFile(b);
  await writeFile(a, bytesB);
  await writeFile(b, bytesA);
  const summary = f.benchmark.collect();
  assert.deepEqual(
    summary.trials.slice(0, 2).map((t) => t.status),
    ["foreign", "foreign"],
  );
  assert.equal(summary.completed, 2);
  f.benchmark.prepareJudging();
  const judging = reviewBenchmarkJudgingSchema.parse(
    JSON.parse(
      await readFile(path.join(f.reference.directory, "judging.json"), "utf8"),
    ),
  );
  assert.ok(
    judging.packets
      .filter((p) => p.status === "foreign")
      .every((p) => !p.outputs.length && !p.native.length),
  );
});

test("benchmark intake reconciles frozen runtime settings host and source identities rather than trusting sealed audit status", async (t) => {
  const f = await prepare(t, 2);
  const files = [
    await runTrial(t, f, 0, "empty", undefined, 1),
    await runTrial(
      t,
      f,
      1,
      "empty",
      undefined,
      undefined,
      "OriginalWrongModel",
    ),
    await runTrial(t, f, 2),
    await runTrial(t, f, 3),
  ];
  for (const [index, change] of [
    [2, "runtime"],
    [3, "settings"],
  ] as const) {
    const events = (await readFile(files[index]!, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    if (change === "runtime")
      events[0].body.runtime.arch = "OriginalWrongArchitecture";
    else events[0].body.settings.nativeWallMs += 1;
    let previous: string | null = null;
    for (const event of events) {
      event.previous = previous;
      const body = { ...event };
      delete body.digest;
      event.digest = digest(JSON.stringify(body));
      previous = event.digest;
    }
    await writeFile(
      files[index]!,
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    assert.equal(
      inspectReviewWorkflowAudit(files[index]!).journalStatus,
      "sealed",
      "The protocol binding must catch a structurally valid journal",
    );
  }
  const summary = f.benchmark.collect();
  assert.equal(summary.accounted, 4);
  assert.equal(summary.completed, 0);
  assert.ok(summary.trials.every((t) => t.status === "foreign"));
});
test("benchmark cross-trial and curator session reuse invalidates both arms including declarations in malformed submissions", async (t) => {
  for (const curator of [false, true]) {
    const f = await prepare(t);
    const sessionId = curator
      ? f.plan.curatorSessionId
      : "OriginalReusedIndependentSession";
    await runTrial(t, f, 0, "empty", sessionId);
    await runTrial(t, f, 1, "malformed", sessionId);
    const summary = f.benchmark.collect();
    assert.equal(summary.accounted, 2);
    assert.equal(summary.completed, 0);
    assert.deepEqual(
      summary.trials.map((t) => t.status),
      ["foreign", "foreign"],
    );
  }
});
test("benchmark detects changed manifests late attempts and forged collections and never overwrites an earlier seal", async (t) => {
  const f = await prepare(t);
  const file = await runTrial(t, f, 0);
  await runTrial(t, f, 1);
  f.benchmark.collect();
  const original = await readFile(
    path.join(f.reference.directory, "collection.json"),
  );
  assert.throws(() => f.benchmark.collect(), /already exists/);
  assert.equal(
    digest(await readFile(path.join(f.reference.directory, "collection.json"))),
    digest(original),
  );
  const journal = await readFile(file);
  await writeFile(
    file,
    Buffer.concat([journal, Buffer.from("LateAttemptCanary")]),
  );
  assert.throws(() => f.benchmark.prepareJudging(), /changed/);
  await assert.rejects(stat(path.join(f.reference.directory, "judging.json")), {
    code: "ENOENT",
  });
  await writeFile(file, journal);
  const collection = JSON.parse(original.toString());
  collection.trials.pop();
  await privateJson(
    path.join(f.reference.directory, "collection.json"),
    collection,
  );
  assert.throws(() => f.benchmark.status(), /changed|small/);
  await writeFile(
    path.join(f.reference.directory, "collection.json"),
    original,
  );
  f.benchmark.prepareJudging();
  const judging = await readFile(
    path.join(f.reference.directory, "judging.json"),
  );
  assert.throws(() => f.benchmark.prepareJudging());
  assert.deepEqual(
    await readFile(path.join(f.reference.directory, "judging.json")),
    judging,
  );
  assert.equal(
    (await readdir(f.reference.directory)).some((p) =>
      p.startsWith(".pending-"),
    ),
    false,
  );
  const forgedJudging = JSON.parse(judging.toString());
  forgedJudging.packets[0].outputs[0].files[0].note =
    "OriginalForgedJudgingCanary";
  await privateJson(
    path.join(f.reference.directory, "judging.json"),
    forgedJudging,
  );
  assert.throws(() => f.benchmark.status(), /judging artifact disagrees/);
  await writeFile(path.join(f.reference.directory, "judging.json"), judging);
  const manifest = JSON.parse(
    await readFile(path.join(f.reference.directory, "manifest.json"), "utf8"),
  );
  manifest.plan.cases[0].labels.expectedDefects[0].claim = "ChangedAfterFreeze";
  await privateJson(
    path.join(f.reference.directory, "manifest.json"),
    manifest,
  );
  assert.throws(
    () =>
      f.benchmark.command(
        { operation: "packet", trialId: f.summary.trials[0]!.trialId },
        true,
      ),
    /digest/,
  );
});
test("benchmark private storage rejects public and linked artifacts and records unreadable journals as unavailable", async (t) => {
  const f = await prepare(t);
  const manifest = path.join(f.reference.directory, "manifest.json");
  await chmod(manifest, 0o644);
  assert.throws(() => f.benchmark.status(), /private/);
  await chmod(manifest, 0o600);
  const file = await runTrial(t, f, 0);
  const second = f.benchmark.trialSetup(f.manifest.trials[1]!.trialId).audit
    .file;
  await symlink(file, second);
  await link(file, path.join(f.operator, "linked-copy"));
  const summary = f.benchmark.collect();
  assert.deepEqual(
    summary.trials.map((t) => t.status),
    ["unavailable", "unavailable"],
  );
  assert.equal(summary.completed, 0);
  assert.equal(summary.trials[0]!.journalDigest, null);
  assert.throws(() =>
    freezeReviewBenchmark(
      f.cases[0]!.root,
      f.plan,
      path.join(f.cases[0]!.root, "inside"),
    ),
  );
  await chmod(f.operator, 0o755);
  assert.throws(
    () =>
      freezeReviewBenchmark(
        f.cases[0]!.root,
        f.plan,
        path.join(f.operator, "public-parent"),
      ),
    /private/,
  );
});
test("benchmark per-trial byte bounds retain oversized journals as unavailable alongside a valid completed control", async (t) => {
  const f = await prepare(t);
  const startup = f.benchmark.trialSetup(f.summary.trials[0]!.trialId);
  await writeFile(
    startup.audit.file,
    Buffer.alloc(startup.audit.maxBytes + 1, 32),
    { mode: 0o600 },
  );
  await runTrial(t, f, 1);
  const summary = f.benchmark.collect();
  assert.equal(summary.accounted, 2);
  assert.equal(summary.completed, 1);
  assert.deepEqual(
    summary.trials.map((t) => t.status),
    ["unavailable", "sealed-completed"],
  );
  assert.equal(summary.trials[0]!.journalDigest, null);
  assert.equal(summary.trials[0]!.commands, null);
  const collection = JSON.parse(
    await readFile(path.join(f.reference.directory, "collection.json"), "utf8"),
  );
  assert.equal(collection.trials[0].journalBase64, null);
});
test("benchmark runtime byte identity rejects a structurally valid journal from a different build under the same version", async (t) => {
  const f = await prepare(t);
  const file = await runTrial(t, f, 0);
  await runTrial(t, f, 1);
  const events = (await readFile(file, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  events[0].body.engineRuntimeDigest = "0".repeat(64);
  let previous: string | null = null;
  for (const event of events) {
    event.previous = previous;
    const body = { ...event };
    delete body.digest;
    event.digest = digest(JSON.stringify(body));
    previous = event.digest;
  }
  await writeFile(
    file,
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  assert.equal(inspectReviewWorkflowAudit(file).journalStatus, "sealed");
  const summary = f.benchmark.collect();
  assert.equal(summary.completed, 1);
  assert.deepEqual(
    summary.trials.map((t) => t.status),
    ["foreign", "sealed-completed"],
  );
  const manifestFile = path.join(f.reference.directory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.engineRuntimeDigest = "0".repeat(64);
  await privateJson(manifestFile, manifest);
  assert.throws(
    () =>
      new ReviewBenchmark(f.cases[0]!.root, {
        ...f.reference,
        sha256: digest(Buffer.from(JSON.stringify(manifest))),
      }),
    /engine or plan identity/,
  );
});
test("benchmark runtime observer hashes actual JS and package bytes and rejects linked oversized and empty runtime inventories", async (t) => {
  const root = await mkdtemp(
    path.join(tmpdir(), "checktrail-original-engine-identity-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, "dist/src");
  await mkdir(runtime, { recursive: true });
  const observer = path.join(runtime, "review-engine-identity.js"),
    marker = path.join(runtime, "marker.js"),
    declaration = path.join(root, "package.json");
  await writeFile(
    observer,
    await readFile(
      new URL("../src/review-engine-identity.js", import.meta.url),
    ),
  );
  const originalPackage = JSON.stringify({
    type: "module",
    version: "original-synthetic-v1",
  });
  await writeFile(declaration, originalPackage);
  const originalJS = "export const marker = 1;\n";
  await writeFile(marker, originalJS);
  const { observeReviewEngineDigest } = await import(
    pathToFileURL(observer).href
  );
  const first = observeReviewEngineDigest();
  await writeFile(marker, "export const marker = 2;\n");
  assert.notEqual(
    observeReviewEngineDigest(),
    first,
    "Actual runtime byte changes must change the digest",
  );
  await writeFile(marker, originalJS);
  assert.equal(
    observeReviewEngineDigest(),
    first,
    "File timestamps and absolute storage are outside the byte digest",
  );
  await writeFile(
    declaration,
    JSON.stringify({
      type: "module",
      version: "original-synthetic-v1",
      description: "changed declaration",
    }),
  );
  assert.notEqual(
    observeReviewEngineDigest(),
    first,
    "A changed package declaration must change the digest",
  );
  await writeFile(declaration, originalPackage);
  const added = path.join(runtime, "additional.js");
  await writeFile(added, "export const extra = true;\n");
  assert.notEqual(
    observeReviewEngineDigest(),
    first,
    "An additional runtime file must change the digest",
  );
  await rm(added);
  await truncate(marker, 2097153);
  assert.throws(
    () => observeReviewEngineDigest(),
    /Unsupported review engine runtime file/,
  );
  await rm(marker);
  const linked = path.join(root, "outside.txt");
  await writeFile(linked, originalJS);
  await symlink(linked, marker);
  assert.throws(() => observeReviewEngineDigest(), { code: "ELOOP" });
  await rm(marker);
  await rm(observer);
  assert.throws(
    () => observeReviewEngineDigest(),
    /Unsupported review engine runtime inventory/,
  );
});
async function cliTrial(t: TestContext, f: Prepared, trialIndex: number) {
  const trial = f.manifest.trials[trialIndex]!,
    startup = f.benchmark.trialSetup(trial.trialId);
  const binding = path.join(f.operator, "binding.json"),
    limitFile = path.join(f.operator, "limits.json");
  await privateJson(binding, startup.audit.binding);
  await privateJson(limitFile, startup.settings.workflowLimits);
  const child = spawn(
    process.execPath,
    [
      cli,
      "review-session",
      "--root",
      f.cases[0]!.root,
      "--detailed",
      "--allow-review-source",
      "--workflow-audit",
      startup.audit.file,
      "--workflow-audit-binding",
      binding,
      "--workflow-audit-max-bytes",
      String(startup.audit.maxBytes),
      "--workflow-audit-max-events",
      String(startup.audit.maxEvents),
      "--workflow-limits",
      limitFile,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (value) => (stderr += value));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  const command = async (value: unknown) => {
    child.stdin.write(JSON.stringify(value) + "\n");
    const next = await lines.next();
    assert.equal(next.done, false, stderr);
    return JSON.parse(next.value!);
  };
  const opened = reviewWorkflowSummarySchema.parse(
    await command({ operation: "open", context: ".checktrail/context.json" }),
  );
  const assignment = reviewWorkflowAssignmentSchema.parse(
    await command({ operation: "next", workflowId: opened.workflowId }),
  );
  await command({
    operation: "submit",
    workflowId: opened.workflowId,
    response: response(assignment),
  });
  child.stdin.end();
  assert.equal(await exited, 0, stderr);
  return startup;
}
test(
  "benchmark CLI freezes operator plans enforces packet grants binds fresh journals and reports incomplete denominators",
  { timeout: 30000 },
  async (t) => {
    const f = await prepare(t);
    const reference = `${f.reference.directory}#sha256=${f.reference.sha256}`;
    const invoke = (args: string[]) =>
      spawnSync(process.execPath, [cli, ...args, "--root", f.cases[0]!.root], {
        encoding: "utf8",
        timeout: 10000,
      });
    const privatePlan = path.join(f.operator, "plan.json");
    await privateJson(privatePlan, f.plan);
    const frozen = invoke([
      "review-benchmark-freeze",
      "--input",
      privatePlan,
      "--output",
      path.join(f.operator, "cli-run"),
    ]);
    assert.equal(frozen.status, 0, frozen.stderr);
    assert.equal(JSON.parse(frozen.stdout).summary.planned, 2);
    assert.equal(
      invoke([
        "review-benchmark-packet",
        "--benchmark",
        reference,
        "--trial",
        f.summary.trials[0]!.trialId,
      ]).status,
      2,
    );
    const packet = invoke([
      "review-benchmark-packet",
      "--benchmark",
      reference,
      "--trial",
      f.summary.trials[0]!.trialId,
      "--detailed",
      "--allow-review-source",
    ]);
    assert.equal(packet.status, 0, packet.stderr);
    noPrivate(packet.stdout, f);
    assert.equal(
      invoke(["review-benchmark-judge", "--benchmark", reference]).status,
      2,
    );
    const startup = await cliTrial(t, f, 0);
    const setup = invoke([
      "review-benchmark-setup",
      "--benchmark",
      reference,
      "--trial",
      f.summary.trials[0]!.trialId,
    ]);
    assert.equal(setup.status, 0, setup.stderr);
    assert.deepEqual(JSON.parse(setup.stdout).audit, startup.audit);
    const collected = invoke([
      "review-benchmark-collect",
      "--benchmark",
      reference,
    ]);
    assert.equal(collected.status, 2, collected.stderr);
    assert.equal(JSON.parse(collected.stdout).accounted, 2);
    assert.equal(JSON.parse(collected.stdout).completed, 1);
    assert.equal(
      invoke(["review-benchmark-judge", "--benchmark", reference]).status,
      2,
    );
    assert.equal(
      invoke(["review-session", "--workflow-audit-binding", privatePlan])
        .status,
      2,
    );
    assert.equal(invoke(["plan", "--benchmark", reference]).status, 2);
  },
);
test(
  "benchmark MCP exposes only startup pinned anonymous packets and metadata and cannot grant source or operator mutations",
  { timeout: 30000 },
  async (t) => {
    const f = await prepare(t),
      reference = `${f.reference.directory}#sha256=${f.reference.sha256}`;
    for (const allow of [false, true]) {
      const client = new Client(
        { name: "original-benchmark-client", version: "1" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          cli,
          "serve",
          "--root",
          f.cases[0]!.root,
          "--benchmark",
          reference,
          "--trial",
          f.summary.trials[0]!.trialId,
          ...(allow ? ["--detailed", "--allow-review-source"] : []),
        ],
        stderr: "pipe",
      });
      try {
        await client.connect(transport);
        const status = await client.callTool({
          name: "review_benchmark",
          arguments: { operation: "status" },
        });
        assert.equal(status.isError, undefined);
        assert.deepEqual(
          status.structuredContent,
          f.benchmark.workerCommand(
            { operation: "status" },
            false,
            f.summary.trials[0]!.trialId,
          ),
        );
        noPrivate(JSON.stringify(status), f);
        const packet = await client.callTool({
          name: "review_benchmark",
          arguments: { operation: "packet" },
        });
        assert.equal(packet.isError, allow ? undefined : true);
        if (allow)
          assert.deepEqual(
            packet.structuredContent,
            f.benchmark.command(
              { operation: "packet", trialId: f.summary.trials[0]!.trialId },
              true,
            ),
          );
        for (const args of [
          { operation: "collect" },
          { operation: "packet", trialId: f.summary.trials[1]!.trialId },
          { operation: "packet", allowSource: true },
          { operation: "status", benchmark: reference },
        ]) {
          const result = await client.callTool({
            name: "review_benchmark",
            arguments: args,
          });
          assert.equal(result.isError, true);
        }
        assert.equal(
          JSON.stringify(status).includes(f.summary.trials[1]!.trialId),
          false,
        );
        assert.deepEqual(
          await readdir(path.join(f.reference.directory, "journals")),
          [],
        );
        await assert.rejects(
          stat(path.join(f.reference.directory, "collection.json")),
          { code: "ENOENT" },
        );
      } finally {
        await client.close();
      }
    }
  },
);
