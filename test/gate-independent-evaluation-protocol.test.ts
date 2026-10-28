import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  realpath,
  rm,
  rename,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { setPrivateFixtureAccess } from "./windows-private-fixture.js";
import { runProcess } from "../src/runner.js";
import { inspectReviewEvaluationProtocol } from "../src/review-evaluation-protocol.js";
import { inspectReviewEvaluationCaptures } from "../src/review-evaluation-captures.js";
import { reviewEvaluationJudgmentPacket as judgePacket } from "../src/review-evaluation-judging.js";
import {
  sealReviewEvaluationMappings as seal,
  scoreReviewEvaluationArtifacts as score,
  inspectSealedReviewEvaluationMappings as replay,
} from "../src/review-evaluation-matching.js";
import {
  sealReviewEvaluationCaptures,
  inspectSealedReviewEvaluationCaptures,
  encodeReviewEvaluationArtifact,
} from "../src/review-evaluation-artifacts.js";
import { matchingFixture } from "./review-evaluation-matching-fixture.js";
import { artifactFixture } from "./review-evaluation-artifacts-fixture.js";
import { protocolFixture } from "./review-evaluation-protocol-fixture.js";
import { fixture, nodeManifest } from "./helpers.js";
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const empty = {
  schemaVersion: 1,
  profile: "independent-review-output-v1",
  claims: [],
};
const broken = "export function permits(value) { return value > 4; }";
const fixed = "export function permits(value) { return value >= 4; }";
async function finish(f: Awaited<ReturnType<typeof matchingFixture>>) {
  const rows = [];
  for (const id of f.matching.blindIds) rows.push(await f.mappingResponse(id));
  const receipt = seal(f.project, f.store, f.matching.bookSha256, rows);
  assert.deepEqual(replay(f.project, f.store, receipt.mappingsSha256), receipt);
  return { receipt, scored: score(f.project, f.store, receipt.mappingsSha256) };
}
function aggregate(
  s: ReturnType<typeof score>,
  which: "baseline" | "reference",
) {
  return s.comparisons[which].aggregate as {
    selected: number;
    clusters: number;
    arms: { a: Arm; b: Arm };
  };
}
interface Arm {
  retainedClaims: number;
  supportedClaims: number;
  materialDefectRecall: { value: number | null };
  supportedClaimPrecision: { value: number | null };
  falseAlarmRate: { value: number | null };
  nearMissFalseAlarmRate: { value: number | null };
  completedCoverage: { value: number | null };
}
function unverified(s: ReturnType<typeof score>) {
  for (const field of [
    "claimTruthVerified",
    "labelsVerified",
    "hostIndependenceVerified",
    "actualAttemptsComplete",
    "qualityAssessed",
    "gateAClosed",
    "inferenceInvoked",
    "sourceIncluded",
    "privateIdentitiesIncluded",
  ] as const)
    assert.equal(s[field], false, field);
}
async function witness(t: TestContext, source: string) {
  const root = await fixture(t, { "src/decision.mjs": source });
  const program = `import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto';
const source=readFileSync('src/decision.mjs');const module=await import('data:text/javascript;base64,'+source.toString('base64'));
const observed=[3,4,5].map(value=>module.permits(value));
console.log(JSON.stringify({sourceSha256:createHash('sha256').update(source).digest('hex'),observed}));
if(JSON.stringify(observed)!==JSON.stringify([false,true,true]))process.exitCode=1;`;
  const result = await runProcess(
    root,
    {
      executable: process.execPath,
      args: ["--input-type=module", "--eval", program],
      cwd: ".",
    },
    { timeoutMs: 15000, maxOutputBytes: 4096, captureRawOutput: true },
  );
  assert.equal(result.errorCode, undefined);
  assert.equal(result.truncated, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  assert.ok(result.capturedOutput?.completeForObservedStreams);
  const observed = JSON.parse(result.stdout) as {
    sourceSha256: string;
    observed: boolean[];
  };
  assert.equal(observed.sourceSha256, sha(Buffer.from(source)));
  assert.equal(
    sha(await readFile(path.join(root, "src/decision.mjs"))),
    observed.sourceSha256,
  );
  return { result, observed };
}
test("independent-evaluation-protocol broken acceptance", async (t) => {
  const f = await matchingFixture(t, { source: broken });
  const packet = judgePacket(
    f.project,
    f.store,
    f.book.bookSha256,
    f.book.blindIds[0]!,
    true,
  );
  const native = await witness(t, packet.source.files[0]!.content);
  assert.equal(native.result.exitCode, 1);
  assert.deepEqual(native.observed.observed, [false, false, true]);
  assert.equal(
    f.input.declaration.cohort.cases[0]!.contentSha256,
    sha(encodeReviewEvaluationArtifact(packet.source)),
  );
  const { receipt, scored } = await finish(f);
  assert.equal(receipt.counts.mappedClaims, 18);
  assert.equal(scored.scoringBindingsComplete, true);
  for (const which of ["baseline", "reference"] as const) {
    const a = aggregate(scored, which);
    assert.equal(a.selected, 6);
    assert.equal(a.clusters, 3);
    assert.equal(a.arms.a.supportedClaims, 6);
    assert.equal(a.arms.b.supportedClaims, 6);
    assert.equal(a.arms.b.materialDefectRecall.value, 1);
    assert.equal(a.arms.b.supportedClaimPrecision.value, 1);
  }
  unverified(scored);
});
test("independent-evaluation-protocol fixed acceptance", async (t) => {
  const f = await matchingFixture(t, {
    source: fixed,
    label: "valid",
    review: empty,
  });
  const p = judgePacket(
      f.project,
      f.store,
      f.book.bookSha256,
      f.book.blindIds[0]!,
      true,
    ),
    native = await witness(t, p.source.files[0]!.content);
  assert.equal(native.result.exitCode, 0);
  assert.deepEqual(native.observed.observed, [false, true, true]);
  const { scored } = await finish(f);
  assert.equal(scored.scoringBindingsComplete, true);
  for (const which of ["baseline", "reference"] as const) {
    const a = aggregate(scored, which);
    assert.equal(a.selected, 6);
    assert.equal(a.arms.b.supportedClaims, 0);
    assert.equal(a.arms.b.retainedClaims, 0);
    assert.equal(a.arms.b.falseAlarmRate.value, 0);
    assert.equal(a.arms.b.completedCoverage.value, 1);
  }
  unverified(scored);
});
test("independent-evaluation-protocol near-miss acceptance", async (t) => {
  const f = await matchingFixture(t, {
    source: fixed + ' const decoy="return value > 4";',
    label: "near-miss",
    review: empty,
  });
  const p = judgePacket(
      f.project,
      f.store,
      f.book.bookSha256,
      f.book.blindIds[0]!,
      true,
    ),
    native = await witness(t, p.source.files[0]!.content);
  assert.equal(native.result.exitCode, 0);
  assert.deepEqual(native.observed.observed, [false, true, true]);
  const { scored } = await finish(f);
  for (const which of ["baseline", "reference"] as const) {
    const a = aggregate(scored, which);
    assert.equal(a.selected, 6);
    assert.equal(a.arms.a.nearMissFalseAlarmRate.value, 0);
    assert.equal(a.arms.b.nearMissFalseAlarmRate.value, 0);
    assert.equal(a.arms.b.completedCoverage.value, 1);
  }
  unverified(scored);
});
test("independent-evaluation-protocol prerequisite acceptance", async (t) => {
  const declaration = protocolFixture(),
    original = inspectReviewEvaluationProtocol(declaration);
  declaration.protocol.implementation.nativeToolsSha256 = "0".repeat(64);
  assert.throws(
    () => inspectReviewEvaluationProtocol(declaration, original.protocolSha256),
    /identity/,
  );
  const unavailable = protocolFixture();
  unavailable.cohort.cases[0]!.distribution = "unknown";
  const report = inspectReviewEvaluationProtocol(unavailable);
  assert.equal(report.declarationComplete, false);
  assert.equal(report.counts.plannedArmSlots, 18);
  assert.equal(report.inferenceExecuted, false);
  const project = await fixture(t, { marker: "Original prerequisite canary" }),
    store = await fixture(t, {});
  assert.throws(() => score(project, store, "0".repeat(64)));
  assert.deepEqual(await readdir(store), []);
  assert.deepEqual(await readdir(project), ["marker"]);
});
test("independent-evaluation-protocol stale acceptance", async (t) => {
  const f = await matchingFixture(t),
    file = path.join(f.store, "judging.book.json"),
    bytes = await readFile(file),
    book = JSON.parse(bytes.toString());
  const source = JSON.parse(
    Buffer.from(book.sources[0].base64, "base64").toString(),
  );
  source.files[0].content += "\n// Original same-citation source change";
  book.sources[0].base64 =
    encodeReviewEvaluationArtifact(source).toString("base64");
  const changed = encodeReviewEvaluationArtifact(book);
  await writeFile(file, changed);
  assert.throws(
    () =>
      judgePacket(f.project, f.store, sha(changed), f.book.blindIds[0]!, true),
    /source|binding|identity/i,
  );
  await writeFile(file, bytes);
  const { scored } = await finish(f);
  assert.equal(scored.scoringBindingsComplete, true);
  assert.ok(
    (await readdir(f.store)).every((name) => !name.startsWith(".pending-")),
  );
  unverified(scored);
});
test("independent-evaluation-protocol empty acceptance", async (t) => {
  const f = await matchingFixture(t, { review: empty }),
    { scored } = await finish(f);
  assert.equal(scored.scoringBindingsComplete, true);
  for (const which of ["baseline", "reference"] as const) {
    const a = aggregate(scored, which);
    assert.equal(a.selected, 6);
    assert.equal(a.arms.b.materialDefectRecall.value, 0);
    assert.equal(a.arms.b.supportedClaimPrecision.value, null);
    assert.equal(a.arms.b.retainedClaims, 0);
  }
  const g = await matchingFixture(t, {
      review: { malformed: "Original malformed body" },
    }),
    bad = await finish(g);
  assert.equal(bad.scored.scoringBindingsComplete, false);
  assert.equal(aggregate(bad.scored, "baseline").selected, 6);
  assert.equal(
    aggregate(bad.scored, "baseline").arms.b.completedCoverage.value,
    0,
  );
  unverified(scored);
  unverified(bad.scored);
});
test("independent-evaluation-protocol privacy acceptance", async (t) => {
  const f = await matchingFixture(t),
    id = f.book.blindIds[0]!;
  assert.throws(
    () => judgePacket(f.project, f.store, f.book.bookSha256, id, false),
    /operator grant/,
  );
  const cli = fileURLToPath(
    new URL("../../scripts/evaluation-judgments.mjs", import.meta.url),
  );
  const denied = spawnSync(
    process.execPath,
    [cli, "packet", f.project, f.store, f.book.bookSha256, id],
    { encoding: "utf8", timeout: 30000, maxBuffer: 65536 },
  );
  assert.equal(denied.status, 1);
  assert.equal(denied.stdout, "");
  assert.equal(
    denied.stderr,
    "Independent judging input or artifacts invalid or unavailable\n",
  );
  const p = judgePacket(f.project, f.store, f.book.bookSha256, id, true);
  for (const key of [
    "role",
    "caseId",
    "repetition",
    "probability",
    "label",
    "sessionId",
    "previousJudgments",
    "peerOutputs",
  ])
    assert.equal(key in p, false, key);
  assert.equal(
    JSON.stringify(p).includes("OriginalCommonDefectAnswerCanary"),
    false,
  );
  assert.equal("probability" in p.claims[0]!, false);
  const { scored } = await finish(f);
  const literal = f.store + "-'[literal]-🧪";
  await rename(f.store, literal);
  f.store = literal;
  assert.deepEqual(score(f.project, f.store, scored.mappingsSha256), scored);
  const summary = JSON.stringify(scored);
  for (const secret of [
    f.store,
    f.project,
    f.input.captures[0]!.caseId,
    "OriginalCommonDefectAnswerCanary",
    p.source.files[0]!.content,
  ])
    assert.equal(summary.includes(secret), false);
  const sealedFile = path.join(f.store, "mappings.sealed.json"),
    sealedBytes = await readFile(sealedFile);
  await setPrivateFixtureAccess(sealedFile, "file", false);
  try {
    assert.throws(
      () => score(f.project, f.store, scored.mappingsSha256),
      /private/i,
    );
    assert.throws(
      () => score(f.project, f.store, scored.mappingsSha256),
      /private/i,
      "Inspection must not repair existing access",
    );
    assert.deepEqual(await readFile(sealedFile), sealedBytes);
  } finally {
    await setPrivateFixtureAccess(sealedFile, "file");
  }
  assert.deepEqual(score(f.project, f.store, scored.mappingsSha256), scored);
  const project = await fixture(t, {
    "package.json": nodeManifest,
    "case.test.js":
      'import {writeFileSync} from "node:fs"; import {test} from "node:test"; test("Original forbidden execution",()=>writeFileSync("executed","unexpected"));',
  });
  const client = new Client(
    { name: "original-independent-privacy", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../src/cli.js", import.meta.url)),
        "serve",
        "--root",
        project,
      ],
      stderr: "pipe",
    }),
  );
  const tools = await client.listTools();
  assert.ok(tools.tools.some((x) => x.name === "review_workflow"));
  assert.ok(
    tools.tools.every((x) => !x.name.startsWith("independent_evaluation")),
  );
  const baselineDenied = await client.callTool({
    name: "validation_run",
    arguments: {},
  });
  assert.equal(baselineDenied.isError, true);
  const injection = await client.callTool({
    name: "validation_run",
    arguments: { trusted: true, allowExecution: true },
  });
  assert.equal(injection.isError, true);
  await assert.rejects(readFile(path.join(project, "executed")), {
    code: "ENOENT",
  });
  unverified(scored);
});

async function terminatedCollector(
  t: TestContext,
  mode: "cancelled" | "timed-out" | "budget-exhausted",
) {
  const child = `const fs=require('node:fs');fs.writeFileSync('child.ready',String(process.pid));setTimeout(()=>fs.writeFileSync('late-child-write','unexpected'),6000);setInterval(()=>{},100);`;
  const parent = `const fs=require('node:fs'),cp=require('node:child_process');cp.spawn(process.execPath,['--eval',${JSON.stringify(child)}],{stdio:'ignore'});
const timer=setInterval(()=>{if(!fs.existsSync('child.ready'))return;clearInterval(timer);process.stdout.write('Original partial collector output');fs.writeFileSync('parent.ready',String(process.pid));${mode === "budget-exhausted" ? "setInterval(()=>process.stdout.write(Buffer.alloc(8192,120)),10);" : ""}},10);setInterval(()=>{},100);`;
  const root = await fixture(t, {}),
    controller = new AbortController();
  // Warm the fixed process-ownership helper before starting a body deadline.
  const warm = await runProcess(
    root,
    { executable: process.execPath, args: ["--eval", ""], cwd: "." },
    { timeoutMs: 15000, maxOutputBytes: 512, captureRawOutput: true },
  );
  assert.equal(warm.exitCode, 0);
  assert.equal(warm.errorCode, undefined);
  const pending = runProcess(
    root,
    { executable: process.execPath, args: ["--eval", parent], cwd: "." },
    {
      timeoutMs: mode === "timed-out" ? 3000 : 15000,
      maxOutputBytes: 512,
      captureRawOutput: true,
      signal: controller.signal,
    },
  );
  t.after(async () => {
    controller.abort();
    await pending;
  });
  if (mode === "cancelled") {
    let ready = false;
    const until = Date.now() + 12000;
    while (Date.now() < until) {
      try {
        await readFile(path.join(root, "parent.ready"));
        ready = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await delay(20);
      }
    }
    try {
      assert.equal(
        ready,
        true,
        "The collector must reach its body before cancellation",
      );
    } finally {
      controller.abort();
    }
  }
  const result = await pending;
  assert.equal(result.errorCode, undefined);
  assert.equal(result.cancelled, mode === "cancelled");
  assert.equal(result.timedOut, mode === "timed-out");
  assert.equal(result.truncated, mode === "budget-exhausted");
  assert.ok(result.capturedOutput);
  assert.ok(
    (await readFile(path.join(root, "parent.ready"), "utf8")).length > 0,
  );
  const pid = Number(await readFile(path.join(root, "child.ready"), "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  let gone = false;
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
      await delay(25);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      gone = true;
      break;
    }
  }
  assert.equal(
    gone,
    true,
    "Reached collector descendants must be gone before accepting terminal evidence",
  );
  await assert.rejects(readFile(path.join(root, "late-child-write")), {
    code: "ENOENT",
  });
  assert.equal(result.capturedOutput.stderr.bytes, 0);
  assert.ok(result.capturedOutput.stdout.bytes > 0);
  assert.ok(result.capturedOutput.stdout.bytes <= 512);
  assert.equal(result.capturedOutput.observedBytes, result.outputBytes);
  return result;
}
test(
  "independent-evaluation-protocol lifecycle acceptance",
  { timeout: 120000 },
  async (t) => {
    for (const state of [
      "cancelled",
      "timed-out",
      "budget-exhausted",
    ] as const) {
      const result = await terminatedCollector(t, state),
        raw = Buffer.from(result.capturedOutput!.stdout.base64, "base64");
      const root = await fixture(t, {
          "project/marker": "Original lifecycle project",
        }),
        store = path.join(root, "private-captures");
      await mkdir(store, { mode: 0o700 });
      const f = await artifactFixture(
        store,
        (record) => {
          record.stdout.observedBytes = result.outputBytes;
          record.stdout.truncated = result.truncated;
        },
        (input) => {
          for (const slot of input.metering.slots) {
            slot.status = state;
            slot.elapsedMs = result.durationMs * 2 + 1;
            for (const attempt of slot.attempts) {
              attempt.elapsedMs = result.durationMs;
              attempt.outputBytes = result.outputBytes;
              attempt.inputTokens = null;
              attempt.outputTokens = null;
              attempt.toolCalls = null;
              attempt.costMicrousd = null;
            }
            slot.attempts.at(-1)!.status =
              state === "budget-exhausted" ? "incomplete" : state;
          }
          for (const capture of input.captures) capture.status = state;
          return raw;
        },
      );
      const receipt = sealReviewEvaluationCaptures(
        path.join(root, "project"),
        store,
        f.input,
      );
      assert.equal(receipt.plannedSlots, 18);
      assert.equal(receipt.retainedCaptureRecords, 18);
      assert.equal(receipt.retainedAttemptRecords, 36);
      assert.equal(receipt.declaredOutputsComplete, false);
      assert.equal(receipt.measurementAccountingComplete, false);
      assert.equal(receipt.inferenceInvoked, false);
      const archive = JSON.parse(
        await readFile(path.join(store, "captures.sealed.json"), "utf8"),
      );
      const retained = archive.blobs.find(
        (b: { sha256: string }) => b.sha256 === sha(raw),
      );
      assert.ok(retained);
      assert.equal(retained.base64, raw.toString("base64"));
      await rm(path.join(store, "blobs"), { recursive: true });
      assert.deepEqual(
        inspectSealedReviewEvaluationCaptures(
          path.join(root, "project"),
          store,
          receipt.archiveSha256,
        ),
        receipt,
      );
      assert.ok(
        (await readdir(store)).every((name) => !name.startsWith(".pending-")),
      );
      assert.equal(
        inspectReviewEvaluationCaptures(f.input).declaredOutputsComplete,
        false,
      );
    }
  },
);

test(
  "independent-evaluation-protocol installed acceptance",
  { timeout: process.platform === "win32" ? 600000 : 120000 },
  async () => {
    if (process.env.CHECKTRAIL_EVALUATION_PROTOCOL_INSTALLED === "1") {
      const loaded = await realpath(
        fileURLToPath(
          new URL("../src/review-evaluation-matching.js", import.meta.url),
        ),
      );
      assert.ok(
        loaded.includes(path.join("node_modules", "@stsepelin", "checktrail")),
      );
      return;
    }
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const command = fileURLToPath(
      new URL(
        "../../scripts/verify-evaluation-protocol-package.mjs",
        import.meta.url,
      ),
    );
    const result = spawnSync(process.execPath, [command, "--whole"], {
      env,
      encoding: "utf8",
      maxBuffer: 4 * 1048576,
      timeout: process.platform === "win32" ? 590000 : 115000,
    });
    assert.equal(
      result.status,
      0,
      (result.stdout + result.stderr).slice(-5000),
    );
    const proof = JSON.parse(result.stdout);
    if (process.env.CHECKTRAIL_EVAL_RUNTIME_RECEIPT)
      await writeFile(
        process.env.CHECKTRAIL_EVAL_RUNTIME_RECEIPT,
        JSON.stringify(proof) + "\n",
        { mode: 0o600, flag: "wx" },
      );
    assert.equal(proof.offlineProductionInstall, true);
    assert.equal(proof.lifecycleScriptsExecuted, false);
    assert.equal(proof.harnessOutsideInstalledPackage, true);
    assert.equal(proof.profileEvidence.complete, true);
    assert.equal(proof.profileEvidence.required, 9);
    assert.equal(proof.profileEvidence.passed, 9);
  },
);
