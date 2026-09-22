import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { promisify } from "node:util";
import * as harness from "./agent-evaluation.mjs";
import { treeDigest } from "./agent-evaluation-gateway.mjs";
import {
  analyzeSessionEvents,
  runSession,
} from "./agent-evaluation-session.mjs";

const execute = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const gatewayScript = fileURLToPath(
  new URL("./agent-evaluation-gateway.mjs", import.meta.url),
);
const encode = (value) => JSON.stringify(value, null, 2) + "\n";
const writeNew = (file, value) =>
  fs.writeFile(file, encode(value), { flag: "wx", mode: 0o600 });
const budget = {
  wallSeconds: 120,
  maxToolCalls: 20,
  maxInputTokens: null,
  maxOutputTokens: 100,
};
const identity = (sessionId) => ({
  sessionId,
  provider: "synthetic",
  model: "scripted-client",
  version: "1",
  provenance: "orchestrator-declared",
});
const declaredUsage = {
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  elapsedMs: null,
  provenance: "reviewer-declared",
};

async function scriptedClient(configFile) {
  const config = JSON.parse(await fs.readFile(configFile, "utf8"));
  const { Client } = await import(
    pathToFileURL(
      path.join(
        config.runtime,
        "node_modules/@modelcontextprotocol/client/dist/index.mjs",
      ),
    )
  );
  const { StdioClientTransport } = await import(
    pathToFileURL(
      path.join(
        config.runtime,
        "node_modules/@modelcontextprotocol/client/dist/stdio.mjs",
      ),
    )
  );
  const client = new Client(
    { name: "synthetic-enforced-canary", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  let calls = 0;
  async function call(name, args = {}) {
    const id = "synthetic-call-" + ++calls;
    process.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: {
          id,
          content: [
            { type: "tool_use", id, name: "mcp__eval__" + name, input: args },
          ],
        },
      }) + "\n",
    );
    const response = await client.callTool({ name, arguments: args });
    const result = JSON.parse(
      response.content.find((item) => item.type === "text").text,
    );
    assert.equal(result.ok, true, name + " failed");
    if (["evaluation_native", "evaluation_probe"].includes(name))
      assert.equal(result.value.exitCode, 0, name + " exited unsuccessfully");
    return result;
  }
  let submission;
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [gatewayScript, config.gatewayConfig, "--trust-execution"],
        stderr: "inherit",
      }),
    );
    const evidence = [];
    for (const item of config.items) {
      const read = await call("evaluation_read", {
        file: item.file,
        line: 1,
        count: 2,
      });
      assert.deepEqual(read.value.lines, [
        { line: 1, text: "def double(value):" },
        { line: 2, text: "    return value * 2" },
      ]);
      await call("evaluation_citation", {
        file: item.file,
        line: 1,
        endLine: 1,
        quote: "def double(value):",
      });
      if (config.role === "reviewer") await call("evaluation_native");
      const probe = await call("evaluation_probe", {
        language: "python",
        sourceEvidenceIds: [read.evidenceId],
        code:
          "import importlib.util\n" +
          `spec = importlib.util.spec_from_file_location("controlled_module", ${JSON.stringify("/source/" + item.file)})\n` +
          "module = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(module)\nassert module.double(3) == 6\nprint('source-control-passed')\n",
      });
      evidence.push({
        blindId: item.blindId,
        probeEvidenceId: probe.evidenceId,
      });
    }
    if (config.treatment) await call("checktrail_validate");
    submission =
      config.role === "reviewer"
        ? config.receipt
        : {
            schemaVersion: 1,
            manifestSha256: config.manifestSha256,
            adjudicator: identity("synthetic-judge"),
            status: "completed",
            judgments: evidence.map((item) => ({
              blindId: item.blindId,
              labelStatus: "accepted",
              findings: [],
              rationale:
                "Executed the captured module and asserted double(3) equals 6.",
              probeEvidenceIds: [item.probeEvidenceId],
            })),
          };
  } finally {
    await client.close();
  }
  // Zero provider tokens are intentional: this client executes no model inference.
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      structured_output: submission,
      modelUsage: {
        synthetic: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    }) + "\n",
  );
}

async function verifyArchive(archive, runtime, version) {
  const python = String.raw`
import hashlib,json,pathlib,sys,tarfile
archive=pathlib.Path(sys.argv[1]); root=pathlib.Path(sys.argv[2]).resolve()/'node_modules/@stsepelin/checktrail'
expected=set()
with tarfile.open(archive,'r:gz') as package:
    for entry in package:
        if entry.isdir(): continue
        assert entry.isfile(), 'Archive contains nonregular entry'
        p=pathlib.PurePosixPath(entry.name)
        assert len(p.parts)>1 and p.parts[0]=='package' and all(x not in ('.','..') for x in p.parts), 'Invalid archive path'
        relative=pathlib.Path(*p.parts[1:]); target=root/relative
        assert relative.as_posix() not in expected, 'Duplicate archive entry'
        assert target.resolve().is_relative_to(root) and not target.is_symlink(), 'Installed file leaves package'
        assert target.read_bytes()==package.extractfile(entry).read(), 'Installed package differs from archive'
        expected.add(relative.as_posix())
actual={p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()}
assert actual==expected, 'Installed package has a different file inventory'
assert json.loads((root/'package.json').read_text())['version']==sys.argv[3], 'Package version mismatch'
print(json.dumps({'files':len(expected),'sha256':hashlib.sha256(archive.read_bytes()).hexdigest()}))
`;
  const result = await execute(
    "python3",
    ["-c", python, archive, runtime, version],
    { maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(result.stdout);
}

async function verify(image, runtimeInput, archiveInput, version, outputInput) {
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const runtime = await fs.realpath(runtimeInput);
  const archive = await fs.realpath(archiveInput);
  const output = path.resolve(outputInput);
  const artifacts = output + ".artifacts";
  await fs.mkdir(artifacts, { mode: 0o700 });
  const directory = await fs.realpath(artifacts);
  const source = path.join(directory, "source");
  await fs.mkdir(source);
  const captured = {
    "value.py": "def double(value):\n    return value * 2\n",
    "test_value.py":
      "import unittest\nfrom value import double\nclass DoubleTest(unittest.TestCase):\n    def test_double(self):\n        self.assertEqual(double(3), 6)\n",
    "pyproject.toml":
      '[project]\nname = "synthetic-enforced-evaluation"\nversion = "0.0.0"\n',
    "checktrail.json":
      JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: ".", checks: ["python.unittest"] }],
      }) + "\n",
  };
  for (const [file, text] of Object.entries(captured))
    await fs.writeFile(path.join(source, file), text, { flag: "wx" });
  const archiveEvidence = await verifyArchive(archive, runtime, version);
  const sdk = JSON.parse(
    await fs.readFile(
      path.join(
        runtime,
        "node_modules/@modelcontextprotocol/client/package.json",
      ),
      "utf8",
    ),
  );
  assert.equal(sdk.version, "2.0.0");
  const profile = {
    image,
    runtimeSha256: await treeDigest(runtime),
    dependenciesSha256: null,
    native: {
      executable: "python3",
      args: ["-B", "-m", "unittest", "discover", "-s", "."],
    },
    languages: ["python"],
    timeoutMs: 30000,
    maxOutputBytes: 1048576,
  };
  const plan = {
    schemaVersion: 1,
    id: "synthetic-enforced-live",
    purpose:
      "Exercise enforced delivery through actual SDK, Docker and packaged MCP without model inference",
    evidenceClass: "development",
    curatorSessionId: "synthetic-curator",
    reviewerProfile: {
      provider: "synthetic",
      model: "scripted-client",
      version: "1",
      settings: "Deterministic no-inference JSONL client",
    },
    environment: {
      platform: "POSIX host with pinned Linux container",
      runtime: "Operator-prepared public package and SDK 2.0.0",
      dependencies: "No project dependencies",
    },
    engine: {
      package: "@stsepelin/checktrail",
      version,
      artifact: archive,
      sha256: archiveEvidence.sha256,
    },
    isolation: "external-sandbox",
    isolationEvidence:
      "Execution uses offline unprivileged read-only gateway containers; synthetic clients are host processes",
    budget: { ...budget, repetitions: 1 },
    executionProtocol: {
      kind: "gateway-v1",
      judgeBudget: budget,
      judgeProfile: profile,
    },
    cases: [
      {
        id: "double-control",
        family: "python",
        group: "synthetic-double",
        split: "development",
        root: source,
        files: Object.keys(captured),
        task: "Check the original synthetic double function",
        source: {
          repository: "https://example.org/synthetic-enforced-evaluation",
          revision: "a".repeat(40),
          license: "MIT",
        },
        reviewCommands: [],
        validators: [],
        exclusion: null,
        executionProfile: profile,
        nativeEvidence: { parser: "unittest", scope: ["test_value.py"] },
      },
    ],
  };
  const labels = [
    {
      caseId: "double-control",
      scope: "Original synthetic valid control",
      expectedDefects: [],
      provenance:
        "Authored for transport and evidence verification, not review-quality measurement",
    },
  ];
  const run = path.join(directory, "run");
  const frozen = await harness.freeze(plan, labels, run);
  await writeNew(path.join(directory, "declaration.json"), { plan, labels });
  const environment = Object.fromEntries(
    ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  const reviews = [];
  const controls = [];
  async function session(
    name,
    sourceDirectory,
    files,
    binding,
    treatment,
    clientConfig,
  ) {
    const evidenceDirectory = path.join(directory, name);
    const gatewayConfig = path.join(directory, name + "-gateway.json");
    await writeNew(gatewayConfig, {
      schemaVersion: 1,
      source: sourceDirectory,
      files,
      audit: path.join(evidenceDirectory, "gateway-audit.jsonl"),
      image,
      runtime,
      dependencies: null,
      treatment,
      binding,
      native: profile.native,
      languages: profile.languages,
      timeoutMs: profile.timeoutMs,
      maxOutputBytes: profile.maxOutputBytes,
      maxCalls: budget.maxToolCalls,
    });
    const clientFile = path.join(directory, name + "-client.json");
    await writeNew(clientFile, {
      ...clientConfig,
      runtime,
      gatewayConfig,
      treatment,
      role: binding.role,
      manifestSha256: frozen.sha256,
    });
    if (binding.role === "reviewer")
      await harness.beginAttempt(
        run,
        binding.subjectId,
        binding.sessionId,
        evidenceDirectory,
      );
    const meter = await runSession({
      client: "claude",
      executable: process.execPath,
      args: [script, "--synthetic-client", clientFile, "--trust-execution"],
      cwd: directory,
      environment,
      outputDirectory: evidenceDirectory,
      binding,
      budget,
      killGraceMs: 1000,
    });
    assert.equal(
      meter.complete,
      true,
      "Synthetic client incomplete: " + meter.stoppedReason,
    );
    return { evidenceDirectory, meter, submission: meter.submission };
  }
  for (const [index, assignment] of frozen.manifest.assignments.entries()) {
    const packetDirectory = path.join(directory, "packet-" + index);
    await harness.packet(run, assignment.id, packetDirectory);
    const receipt = {
      schemaVersion: 1,
      assignmentId: assignment.id,
      manifestSha256: frozen.sha256,
      sourceSha256: frozen.manifest.cases[0].captured.sha256,
      reviewer: identity("synthetic-reviewer-" + index),
      status: "completed",
      findings: [],
      limitations: [
        "Synthetic execution canary; no model review or quality claim",
      ],
      usage: declaredUsage,
    };
    const review = await session(
      "review-" + index,
      path.join(packetDirectory, "source"),
      Object.keys(captured),
      {
        manifestSha256: frozen.sha256,
        subjectId: assignment.id,
        sessionId: receipt.reviewer.sessionId,
        role: "reviewer",
      },
      assignment.arm === "mcp",
      { receipt, items: [{ file: "value.py" }] },
    );
    const checked = await harness.preflight(
      run,
      assignment.id,
      review.submission,
      review.evidenceDirectory,
    );
    await writeNew(
      path.join(directory, "preflight-" + index + ".json"),
      checked,
    );
    assert.equal(checked.valid, true, JSON.stringify(checked));
    if (index === 0) {
      const records = (
        await fs.readFile(
          path.join(review.evidenceDirectory, "gateway-audit.jsonl"),
          "utf8",
        )
      )
        .trimEnd()
        .split("\n")
        .map(JSON.parse);
      const probe = records.find(
        (record) =>
          record.type === "result" && record.tool === "evaluation_probe",
      );
      const changedClaim = globalThis.structuredClone(receipt);
      changedClaim.findings = [
        {
          id: "changed-after-delivery",
          claim: "Operator-added synthetic claim",
          citations: [
            {
              file: "value.py",
              line: 1,
              endLine: 1,
              quote: "def double(value):",
            },
          ],
          reproduction: "Operator-added reproduction statement",
          probeEvidenceIds: [
            `evidence-${probe.sequence}-${probe.sha256.slice(0, 12)}`,
          ],
        },
      ];
      for (const [name, altered] of [
        ["altered-claim", changedClaim],
        [
          "altered-usage",
          { ...receipt, usage: { ...declaredUsage, outputTokens: 1 } },
        ],
      ]) {
        const negative = await harness.preflight(
          run,
          assignment.id,
          altered,
          review.evidenceDirectory,
        );
        assert.equal(negative.valid, false, name + " unexpectedly accepted");
        assert.ok(
          negative.protocol.problems.some((problem) =>
            problem.includes("client terminal submission"),
          ),
          JSON.stringify(negative),
        );
        await writeNew(path.join(directory, name + ".json"), {
          submitted: altered,
          preflight: negative,
        });
        controls.push({ name, rejected: true });
      }
      const missing = path.join(directory, "negative-missing-end");
      await fs.cp(review.evidenceDirectory, missing, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      await fs.writeFile(
        path.join(missing, "gateway-audit.jsonl"),
        records
          .slice(0, -1)
          .map((record) => JSON.stringify(record) + "\n")
          .join(""),
      );
      const negative = await harness.preflight(
        run,
        assignment.id,
        receipt,
        missing,
      );
      assert.equal(negative.valid, false);
      assert.ok(
        negative.protocol.problems.includes("gateway-cleanup-incomplete"),
      );
      await writeNew(
        path.join(directory, "missing-end-preflight.json"),
        negative,
      );
      controls.push({ name: "missing-gateway-end", rejected: true });
    }
    await harness.seal(
      run,
      assignment.id,
      review.submission,
      review.evidenceDirectory,
    );
    reviews.push({ ...review, protocol: checked.protocol });
  }
  const judgingPacket = path.join(directory, "judging-packet");
  await harness.blind(run, judgingPacket);
  const judgeFiles = [
    "judging.json",
    ...frozen.manifest.assignments.flatMap((assignment) =>
      Object.keys(captured).map(
        (file) => `${assignment.blindId}/source/${file}`,
      ),
    ),
  ];
  const judged = await session(
    "judge",
    judgingPacket,
    judgeFiles,
    {
      manifestSha256: frozen.sha256,
      subjectId: "judging",
      sessionId: "synthetic-judge",
      role: "judge",
    },
    false,
    {
      items: frozen.manifest.assignments.map((assignment) => ({
        blindId: assignment.blindId,
        file: `${assignment.blindId}/source/value.py`,
      })),
    },
  );
  const score = await harness.score(
    run,
    judged.submission,
    judged.evidenceDirectory,
  );
  await writeNew(path.join(directory, "score.json"), score);
  assert.equal(score.complete, true, JSON.stringify(score.judgeProtocol));
  const sibling = globalThis.structuredClone(judged.submission);
  sibling.judgments[0].probeEvidenceIds = sibling.judgments[1].probeEvidenceIds;
  const siblingDirectory = path.join(directory, "negative-sibling-probe");
  await fs.cp(judged.evidenceDirectory, siblingDirectory, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const events = (
    await fs.readFile(path.join(siblingDirectory, "events.jsonl"), "utf8")
  )
    .trimEnd()
    .split("\n")
    .map(JSON.parse);
  events.at(-1).structured_output = sibling;
  const changedEvents = events
    .map((event) => JSON.stringify(event) + "\n")
    .join("");
  await fs.writeFile(
    path.join(siblingDirectory, "events.jsonl"),
    changedEvents,
  );
  await fs.writeFile(
    path.join(siblingDirectory, "metering.json"),
    encode({
      ...judged.meter,
      ...analyzeSessionEvents(changedEvents, { client: "claude", budget }),
    }),
  );
  const rejected = await harness.score(run, sibling, siblingDirectory);
  assert.equal(rejected.complete, false);
  assert.ok(
    rejected.judgeProtocol.problems.some((problem) =>
      problem.includes("own source-bound control probe"),
    ),
    JSON.stringify(rejected.judgeProtocol),
  );
  await writeNew(path.join(directory, "negative-sibling-score.json"), rejected);
  controls.push({ name: "sibling-control-probe", rejected: true });
  assert.equal(await treeDigest(runtime), profile.runtimeSha256);
  const summary = {
    schemaVersion: 1,
    kind: "synthetic-enforced-live",
    verifierSha256: harness.sha256(await fs.readFile(script)),
    modelInference: false,
    effectivenessClaimSupported: false,
    image,
    engine: {
      version,
      archiveSha256: archiveEvidence.sha256,
      verifiedArchiveFiles: archiveEvidence.files,
      runtimeSha256: profile.runtimeSha256,
    },
    sdk: { version: sdk.version, protocol: "2026-07-28" },
    manifestSha256: frozen.sha256,
    implementation: frozen.manifest.supportDigests.filter((item) =>
      [
        "agent-evaluation-gateway.mjs",
        "agent-evaluation-worker.mjs",
        "agent-evaluation-session.mjs",
        "agent-evaluation-protocol.mjs",
      ].includes(item.file),
    ),
    reviews: reviews.map((review) => ({
      complete: review.protocol.complete,
      nativeRuns: review.protocol.native.length,
      mcpValidations: review.protocol.validations.length,
      probes: review.protocol.probes.length,
      toolCalls: review.meter.toolCalls,
      eventsSha256: review.meter.eventsSha256,
      auditSha256: review.protocol.auditSha256,
    })),
    judge: {
      complete: score.judgeProtocol.complete,
      controlProbes: score.judgeProtocol.probes.length,
      toolCalls: judged.meter.toolCalls,
      eventsSha256: judged.meter.eventsSha256,
      auditSha256: score.judgeProtocol.auditSha256,
    },
    scoringComplete: score.complete,
    completedAssessments: score.observations.filter(
      (item) => item.status === "complete",
    ).length,
    controls,
  };
  assert.ok(
    !/\/Users\/|\/private\/var\/|sessionId|api_key|access_token|refresh_token/i.test(
      JSON.stringify(summary),
    ),
  );
  await writeNew(output, summary);
  process.stdout.write(encode(summary));
}

const args = process.argv.slice(2);
if (args[0] === "--synthetic-client") {
  assert.ok(
    args.length === 3 && args[2] === "--trust-execution",
    "Synthetic client needs explicit execution trust",
  );
  await scriptedClient(args[1]);
} else {
  assert.ok(
    args.length === 6 && args[5] === "--trust-execution",
    "Usage: verify-enforced-evaluation.mjs IMAGE RUNTIME ARCHIVE VERSION OUTPUT --trust-execution",
  );
  await verify(...args.slice(0, 5));
}
