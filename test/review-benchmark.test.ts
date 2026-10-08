import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  ReviewBenchmark,
  freezeReviewBenchmark,
} from "../src/review-benchmark.js";
import {
  reviewBenchmarkScoreReportSchema,
  reviewBenchmarkScoreSummarySchema,
  reviewBenchmarkPacketSchema,
  reviewBenchmarkJudgingSchema,
  reviewBenchmarkJudgePacketSchema,
  reviewBenchmarkJudgeWorkerSummarySchema,
} from "../src/review-benchmark-schema.js";

import {
  reviewWorkflowAssignmentSchema,
  reviewWorkflowSummarySchema,
} from "../src/review-workflow-schema.js";
import { inspectReviewWorkflowAudit } from "../src/review-workflow-audit.js";
import { response, limits, source } from "./review-workflow-fixture.js";
import {
  cli,
  digest,
  prepare,
  runTrial,
  noPrivate,
  privateJson,
  prepareJudgments,
  judgmentResponse,
  putJudgment,
  judgmentArchive,
  type Prepared,
} from "./review-benchmark-fixture.js";
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
    {
      ...f.plan,
      arms: f.plan.arms.map((arm) => ({
        ...arm,
        settings: { ...arm.settings, candidateScope: "all" },
      })),
    },
    {
      ...f.plan,
      arms: f.plan.arms.map((arm) => ({
        ...arm,
        settings: {
          ...arm.settings,
          workflowLimits: {
            ...limits,
            maxWorkflows: 1,
            maxAssignments: 65,
            maxNativeCalls: 96,
            maxNativeOutputBytes: 65536,
          },
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

test("benchmark judging requires frozen profiles and complete intake before any source packet or response path", async (t) => {
  const legacy = await prepare(t);
  assert.throws(
    () => legacy.benchmark.judgeSetup(randomUUID()),
    /No judging profile/,
  );
  assert.equal(legacy.benchmark.status().judgments, null);
  const f = await prepare(t, 1, 1, false, true);
  assert.throws(
    () => f.benchmark.judgeSetup(f.manifest.trials[0]!.blindId),
    /collected/,
  );
  assert.throws(() => f.benchmark.sealJudgments(), /collected/);
  assert.deepEqual(
    await readdir(path.join(f.reference.directory, "judgments")),
    [],
  );
  for (const judging of [
    { ...f.plan.judging, host: { ...f.plan.judging!.host, model: "" } },
    { ...f.plan.judging, maxAttempts: 10 },
  ]) {
    const target = path.join(f.operator, randomUUID());
    assert.throws(() =>
      freezeReviewBenchmark(f.cases[0]!.root, { ...f.plan, judging }, target),
    );
    await assert.rejects(stat(target), { code: "ENOENT" });
  }
});
test("benchmark judging seals independent anonymous source-bound responses and distinguishes unresolved declarations", async (t) => {
  const f = await prepareJudgments(t, 1, 1, true);
  const first = f.book.packets[0]!.blindId,
    second = f.book.packets[1]!.blindId;
  const packet = reviewBenchmarkJudgePacketSchema.parse(
    f.benchmark.judgeWorkerCommand({ operation: "packet" }, true, first),
  );
  assert.equal(packet.claims.length, 1);
  assert.equal(packet.evidence.native.length, 1);
  assert.equal(
    packet.evidence.native[0]!.observations.cases.filter(
      (c) => c.role === "trigger" && c.actual !== c.expected,
    ).length,
    1,
  );
  noPrivate(JSON.stringify(packet), f);
  for (const value of [
    second,
    f.manifest.trials[0]!.trialId,
    f.plan.judging!.host.model,
  ])
    assert.equal(JSON.stringify(packet).includes(value), false);
  assert.throws(
    () => f.benchmark.judgeWorkerCommand({ operation: "packet" }, false, first),
    /authorization/,
  );
  await putJudgment(f, first, judgmentResponse(f, first));
  const unresolved = judgmentResponse(f, second);
  unresolved.output!.label = "unresolved";
  unresolved.output!.citations = [];
  unresolved.output!.claims.forEach((c) => {
    c.judgement = "unresolved";
    c.citations = [];
  });
  await putJudgment(f, second, unresolved);
  const sealed = f.benchmark.sealJudgments();
  assert.equal(sealed.state, "judgments-sealed");
  assert.equal(sealed.judgments!.accepted, 2);
  assert.equal(sealed.judgments!.resolved, 1);
  assert.equal(sealed.claimsVerified, false);
  assert.equal(sealed.qualityAssessed, false);
  const archive = await judgmentArchive(f);
  assert.deepEqual(
    archive.judgments.map((j) => j.status),
    ["accepted", "accepted"],
  );
  assert.equal(
    archive.judgments[1]!.responseDigest,
    digest(Buffer.from(JSON.stringify(unresolved))),
  );
  const reopen = new ReviewBenchmark(f.cases[0]!.root, f.reference);
  assert.deepEqual(reopen.status(), sealed);
  assert.throws(() => reopen.judgeSetup(first), /closed/);
  assert.throws(
    () => reopen.judgeWorkerCommand({ operation: "packet" }, true, first),
    /closed/,
  );
  assert.throws(() => reopen.sealJudgments(), /already sealed/);
  const status = reviewBenchmarkJudgeWorkerSummarySchema.parse(
    reopen.judgeWorkerCommand({ operation: "status" }, false, first),
  );
  assert.equal(status.status, "accepted");
  noPrivate(JSON.stringify(status), f);
});
test("benchmark judging rejects missing duplicate foreign and misaddressed claim decisions while retaining a valid control", async (t) => {
  const f = await prepareJudgments(t, 1, 2, true);
  const responses = f.book.packets.map((p) => judgmentResponse(f, p.blindId));
  responses[0]!.output!.claims = [];
  responses[1]!.output!.claims.push(
    structuredClone(responses[1]!.output!.claims[0]!),
  );
  responses[2]!.output!.claims[0]!.citations[0]!.quote =
    "OriginalQuoteNeverPresent";
  for (let i = 0; i < responses.length; i++)
    await putJudgment(f, f.book.packets[i]!.blindId, responses[i]);
  const summary = f.benchmark.sealJudgments();
  assert.equal(summary.judgments!.accounted, 4);
  assert.equal(summary.judgments!.accepted, 1);
  assert.deepEqual(
    (await judgmentArchive(f)).judgments.map((j) => j.status),
    ["invalid", "invalid", "invalid", "accepted"],
  );
});
test("benchmark judging reconciles source revisions line ranges digests labels host identity and assignment binding", async (t) => {
  const f = await prepareJudgments(t, 4, 2);
  const responses = f.book.packets.map((p) => judgmentResponse(f, p.blindId));
  responses[0]!.output!.citations[0]!.file = "missing.mjs";
  responses[1]!.output!.citations[0]!.revision = "base";
  responses[2]!.output!.citations[0]!.sourceDigest = "0".repeat(64);
  responses[3]!.output!.citations[0]!.endLine = 9999;
  responses[4]!.output!.citations[0]!.endLine = 0;
  responses[5]!.output!.citations = [];
  responses[6]!.assignmentDigest = "0".repeat(64);
  responses[7]!.blindId = responses[8]!.blindId;
  responses[8]!.host.model = "foreign-judge-model";
  responses[9]!.host.isolation = "unknown";
  responses[10]!.status = "refused";
  responses[10]!.output = null;
  responses[11]!.status = "cancelled"; // A terminal failure carrying a completed output is invalid.
  responses[12]!.output = null;
  for (let i = 0; i < responses.length; i++)
    await putJudgment(f, f.book.packets[i]!.blindId, responses[i]);
  const sealed = f.benchmark.sealJudgments();
  assert.equal(sealed.judgments!.accepted, 3);
  assert.deepEqual(
    (await judgmentArchive(f)).judgments.map((j) => j.status),
    [
      "invalid",
      "invalid",
      "invalid",
      "invalid",
      "invalid",
      "invalid",
      "foreign",
      "foreign",
      "foreign",
      "incomplete",
      "incomplete",
      "invalid",
      "invalid",
      "accepted",
      "accepted",
      "accepted",
    ],
  );
});
test("benchmark judging accounts missing unsafe oversized malformed and interrupted responses without invented output", async (t) => {
  const f = await prepareJudgments(t, 2, 2);
  const paths = f.book.packets.map(
    (p) => f.benchmark.judgeSetup(p.blindId).file,
  );
  await writeFile(paths[1]!, '{"interrupted":', { mode: 0o600 });
  await writeFile(paths[2]!, Buffer.from([255, 254]), { mode: 0o600 });
  await writeFile(paths[3]!, Buffer.alloc(262145, 32), { mode: 0o600 });
  await symlink(paths[1]!, paths[4]!);
  await putJudgment(
    f,
    f.book.packets[5]!.blindId,
    judgmentResponse(f, f.book.packets[5]!.blindId),
  );
  await chmod(paths[5]!, 0o644);
  await putJudgment(
    f,
    f.book.packets[6]!.blindId,
    judgmentResponse(f, f.book.packets[6]!.blindId),
  );
  await link(paths[6]!, path.join(f.operator, "judge-hardlink"));
  await putJudgment(
    f,
    f.book.packets[7]!.blindId,
    judgmentResponse(f, f.book.packets[7]!.blindId),
  );
  const sealed = f.benchmark.sealJudgments();
  assert.equal(sealed.judgments!.accounted, 8);
  assert.equal(sealed.judgments!.accepted, 1);
  const archive = await judgmentArchive(f);
  assert.deepEqual(
    archive.judgments.map((j) => j.status),
    [
      "missing",
      "invalid",
      "invalid",
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
      "accepted",
    ],
  );
  assert.equal(
    Buffer.from(archive.judgments[1]!.responseBase64!, "base64").toString(),
    '{"interrupted":',
  );
  for (const i of [0, 3, 4, 5, 6])
    assert.equal(archive.judgments[i]!.responseDigest, null);
});
test("benchmark judging rejects curator reviewer and sibling session reuse including malformed identity declarations", async (t) => {
  const f = await prepareJudgments(t, 2, 2);
  const responses = f.book.packets.map((p) => judgmentResponse(f, p.blindId));
  responses[0]!.host.sessionId = f.plan.curatorSessionId;
  responses[1]!.host.sessionId = "original-review-session-0";
  responses[2]!.host.sessionId = "original-reused-judge-session";
  responses[3]!.host.sessionId = "original-reused-judge-session";
  for (let i = 0; i < responses.length; i++)
    await putJudgment(
      f,
      f.book.packets[i]!.blindId,
      i === 3 ? { ...responses[i], originalMalformed: true } : responses[i],
    );
  const sealed = f.benchmark.sealJudgments();
  assert.equal(sealed.judgments!.accepted, 4);
  assert.deepEqual(
    (await judgmentArchive(f)).judgments.map((j) => j.status),
    [
      "foreign",
      "foreign",
      "foreign",
      "foreign",
      "accepted",
      "accepted",
      "accepted",
      "accepted",
    ],
  );
});
test("benchmark judging rejects late responses altered permissions and forged sealed verdicts on every reopen", async (t) => {
  for (const mode of ["late", "content", "permissions", "archive"] as const) {
    const f = await prepareJudgments(t);
    const id = f.book.packets[0]!.blindId,
      setup = f.benchmark.judgeSetup(id),
      response = judgmentResponse(f, id);
    if (mode !== "late") await putJudgment(f, id, response);
    f.benchmark.sealJudgments();
    if (mode === "late") await privateJson(setup.file, response);
    else if (mode === "content") {
      response.output!.rationale = "Changed after seal";
      await privateJson(setup.file, response);
    } else if (mode === "permissions") await chmod(setup.file, 0o644);
    else {
      const archive = await judgmentArchive(f);
      archive.judgments[0]!.status = "foreign";
      await privateJson(
        path.join(f.reference.directory, "judgments-sealed.json"),
        archive,
      );
    }
    assert.throws(
      () => f.benchmark.status(),
      /judgments or reached responses changed/,
    );
    assert.throws(
      () => f.benchmark.judgeWorkerCommand({ operation: "status" }, false, id),
      /judgments or reached responses changed/,
    );
  }
});
test("benchmark judge CLI and MCP share one read-only startup-selected slot with grant and sealed-incomplete exit controls", async (t) => {
  const f = await prepareJudgments(t),
    id = f.book.packets[0]!.blindId;
  const reference = `${f.reference.directory}#sha256=${f.reference.sha256}`;
  const args = ["--root", f.cases[0]!.root, "--benchmark", reference];
  const run = (command: string, extra: string[] = []) =>
    spawnSync(process.execPath, [cli, command, ...args, ...extra], {
      encoding: "utf8",
    });
  const denied = run("review-benchmark-judge-packet", ["--judge", id]);
  assert.equal(denied.status, 2);
  const packet = run("review-benchmark-judge-packet", [
    "--judge",
    id,
    "--detailed",
    "--allow-review-source",
  ]);
  assert.equal(packet.status, 0, packet.stderr);
  assert.deepEqual(
    JSON.parse(packet.stdout),
    f.benchmark.judgeWorkerCommand({ operation: "packet" }, true, id),
  );
  assert.equal(run("review-benchmark-judge-setup", ["--judge", id]).status, 0);
  assert.equal(run("review-benchmark-status", ["--judge", id]).status, 2);
  assert.equal(
    run("serve", ["--judge", id, "--trial", f.manifest.trials[0]!.trialId])
      .status,
    2,
  );
  const client = new Client({
    name: "original-independent-judge-control",
    version: "1",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      cli,
      "serve",
      ...args,
      "--judge",
      id,
      "--detailed",
      "--allow-review-source",
    ],
    stderr: "pipe",
  });
  t.after(() => client.close());
  await client.connect(transport);
  try {
    const inventory = await client.listTools();
    assert.ok(inventory.tools.some((tool) => tool.name === "review_benchmark"));
    assert.deepEqual(
      await readdir(path.join(f.reference.directory, "judgments")),
      [],
    );
    const call = await client.callTool({
      name: "review_benchmark",
      arguments: { operation: "packet" },
    });
    assert.equal(call.isError, undefined);
    assert.deepEqual(call.structuredContent, JSON.parse(packet.stdout));
    for (const input of [
      { operation: "packet", judgeId: f.book.packets[1]!.blindId },
      { operation: "seal" },
      { operation: "packet", allowSource: true },
    ]) {
      const invalid = await client.callTool({
        name: "review_benchmark",
        arguments: input,
      });
      assert.equal(invalid.isError, true);
    }
    const sealed = run("review-benchmark-seal-judgments");
    assert.equal(sealed.status, 2, sealed.stderr);
    assert.equal(JSON.parse(sealed.stdout).judgments.accounted, 2);
    const closed = await client.callTool({
      name: "review_benchmark",
      arguments: { operation: "packet" },
    });
    assert.equal(closed.isError, true);
    const status = await client.callTool({
      name: "review_benchmark",
      arguments: { operation: "status" },
    });
    const parsed = reviewBenchmarkJudgeWorkerSummarySchema.parse(
      status.structuredContent,
    );
    assert.equal(parsed.status, "missing");
    noPrivate(JSON.stringify(parsed), f);
  } finally {
    await client.close();
  }
});

test("benchmark judging leaves unusable trial evidence incomplete and rejects supported claims on known valid labels", async (t) => {
  const f = await prepare(t, 1, 1, false, true);
  await runTrial(t, f, 0);
  f.benchmark.collect();
  f.benchmark.prepareJudging();
  const book = reviewBenchmarkJudgingSchema.parse(
    JSON.parse(
      await readFile(path.join(f.reference.directory, "judging.json"), "utf8"),
    ),
  );
  for (const packet of book.packets)
    await putJudgment(f, packet.blindId, judgmentResponse(f, packet.blindId));
  const sealed = f.benchmark.sealJudgments();
  assert.equal(sealed.judgments!.accepted, 1);
  assert.deepEqual(
    (await judgmentArchive(f)).judgments.map((j) => j.status).sort(),
    ["accepted", "incomplete"],
  );
  const native = await prepareJudgments(t, 1, 1, true);
  const responses = native.book.packets.map((p) =>
    judgmentResponse(native, p.blindId),
  );
  responses[0]!.output!.label = "valid";
  responses[1]!.output!.label = "near-miss";
  responses[1]!.output!.claims[0]!.judgement = "refuted";
  for (let i = 0; i < responses.length; i++)
    await putJudgment(native, native.book.packets[i]!.blindId, responses[i]);
  native.benchmark.sealJudgments();
  assert.deepEqual(
    (await judgmentArchive(native)).judgments.map((j) => j.status),
    ["invalid", "accepted"],
  );
});

test("benchmark scoring freezes exact cases families seed and judging before writes and preserves legacy intake", async (t) => {
  const legacy = await prepare(t);
  assert.throws(() => legacy.benchmark.score(), /declared before freezing/);
  const f = await prepare(t, 2, 1, false, true, true);
  assert.throws(() => f.benchmark.score(), /must be sealed/);
  const scoring = f.plan.scoring!;
  for (const change of [
    { scoring: { ...scoring, cases: scoring.cases.slice(1) } },
    { scoring: { ...scoring, cases: [scoring.cases[0], scoring.cases[0]] } },
    {
      scoring: {
        ...scoring,
        cases: [
          ...scoring.cases.slice(1),
          { ...scoring.cases[0], id: "ForeignCase" },
        ],
      },
    },
    { scoring: { ...scoring, seed: "missing" } },
    { scoring: { ...scoring, resamples: 127 } },
    { scoring: { ...scoring, confidenceLevel: 1 } },
    { scoring: { ...scoring, qualityGate: "passed" } },
    { judging: undefined },
    {
      cases: f.plan.cases.map((c, i) =>
        i ? c : { ...c, labels: { ...c.labels, expectedDefects: [] } },
      ),
    },
  ]) {
    const target = path.join(f.operator, randomUUID());
    assert.throws(() =>
      freezeReviewBenchmark(f.cases[0]!.root, { ...f.plan, ...change }, target),
    );
    await assert.rejects(stat(target), { code: "ENOENT" });
  }
});
test("benchmark scoring binds every paired repetition and keeps common frozen labels and unknown probabilities", async (t) => {
  const f = await prepareJudgments(t, 3, 2, false, true);
  for (const packet of f.book.packets) {
    const trial = f.manifest.trials.find((r) => r.blindId === packet.blindId)!;
    const value = judgmentResponse(f, packet.blindId);
    value.output!.label =
      trial.caseIndex === 0
        ? "defect"
        : trial.caseIndex === 1
          ? "valid"
          : "near-miss";
    await putJudgment(f, packet.blindId, value);
  }
  f.benchmark.sealJudgments();
  const report = reviewBenchmarkScoreReportSchema.parse(
    f.benchmark.score(true),
  );
  assert.equal(report.scoringReady, true);
  assert.equal(report.protocolDigest, f.reference.sha256);
  assert.equal(report.collectionDigest, f.benchmark.status().collectionDigest);
  assert.equal(
    report.judgmentsDigest,
    f.benchmark.status().judgments!.archiveDigest,
  );
  assert.deepEqual(report.accounting, {
    plannedTrials: 12,
    selectedPairs: 6,
    completedTrials: 12,
    retainedClaims: 0,
    unscoredClaims: 0,
    missingJudgments: 0,
    rejectedJudgments: 0,
    unresolvedClaimJudgments: 0,
    labelDisagreements: 0,
    unknownJudgeLabels: 0,
    unexpectedFamilyClaims: 0,
    declaredClaimProbabilities: 0,
    unknownClaimProbabilities: 0,
  });
  assert.equal(report.paired.aggregate.selected, 6);
  assert.equal(report.paired.aggregate.clusters, 1);
  assert.equal(report.paired.aggregate.repeatedClusters, 1);
  for (const arm of [
    report.paired.aggregate.arms.a,
    report.paired.aggregate.arms.b,
  ]) {
    assert.equal(arm.precision.value, null);
    assert.deepEqual(arm.materialDefectRecall, {
      numerator: 0,
      denominator: 2,
      value: 0,
    });
    assert.deepEqual(arm.falseAlarmRate, {
      numerator: 0,
      denominator: 2,
      value: 0,
    });
    assert.deepEqual(arm.nearMissFalseAlarmRate, {
      numerator: 0,
      denominator: 2,
      value: 0,
    });
  }
  assert.deepEqual(f.benchmark.score(true), report);
  const summary = reviewBenchmarkScoreSummarySchema.parse(f.benchmark.score());
  noPrivate(JSON.stringify(summary), f);
  assert.equal(
    JSON.stringify(summary).includes(
      report.paired.input.protocol.trials[0]!.id,
    ),
    false,
  );
  assert.equal(summary.artifactBindingsChecked, true);
  assert.equal(summary.pairingBoundToManifest, true);
  assert.equal(summary.claimsVerified, false);
  assert.equal(summary.labelsVerified, false);
  assert.equal(summary.hostIsolationVerified, false);
  assert.equal(summary.qualityAssessed, false);
  assert.equal(summary.paired.qualityGate, "not-assessed");
});
test("benchmark scoring derives claim errors and false alarms from sealed source-bound dispositions without choosing favorable labels", async (t) => {
  const f = await prepareJudgments(t, 3, 1, true, true);
  for (const packet of f.book.packets) {
    const trial = f.manifest.trials.find((r) => r.blindId === packet.blindId)!;
    const value = judgmentResponse(f, packet.blindId);
    value.output!.label =
      trial.caseIndex === 0
        ? "defect"
        : trial.caseIndex === 1
          ? "valid"
          : "near-miss";
    value.output!.claims[0]!.judgement = trial.caseIndex
      ? "refuted"
      : trial.armIndex === 0
        ? "supported"
        : "wrong-mechanism";
    await putJudgment(f, packet.blindId, value);
  }
  f.benchmark.sealJudgments();
  const score = reviewBenchmarkScoreReportSchema.parse(f.benchmark.score(true));
  assert.equal(score.scoringReady, true);
  assert.equal(score.accounting.retainedClaims, 6);
  assert.equal(score.paired.aggregate.arms.a.precision.value, 1 / 3);
  assert.equal(score.paired.aggregate.arms.b.precision.value, 0);
  assert.equal(score.paired.aggregate.arms.a.materialDefectRecall.value, 1);
  assert.equal(score.paired.aggregate.arms.b.materialDefectRecall.value, 0);
  for (const arm of [
    score.paired.aggregate.arms.a,
    score.paired.aggregate.arms.b,
  ]) {
    assert.equal(arm.findings, 3);
    assert.equal(arm.falseAlarmRate.value, 1);
    assert.equal(arm.nearMissFalseAlarmRate.value, 1);
    assert.equal(arm.unknownProbabilities, 3);
    assert.equal(arm.properScores.brier, null);
  }
  assert.equal(
    score.paired.aggregate.differences.find((r) => r.metric === "precision")!
      .differenceBMinusA,
    -1 / 3,
  );
});
test("benchmark scoring retains missing interrupted rejected unknown and conflicting sealed slots in conservative denominators", async (t) => {
  const missing = await prepare(t, 1, 1, false, true, true);
  await runTrial(t, missing, 0);
  missing.benchmark.collect();
  missing.benchmark.prepareJudging();
  missing.benchmark.sealJudgments();
  const partial = reviewBenchmarkScoreReportSchema.parse(
    missing.benchmark.score(true),
  );
  assert.equal(partial.scoringReady, false);
  assert.equal(partial.accounting.plannedTrials, 2);
  assert.equal(partial.accounting.completedTrials, 1);
  assert.equal(partial.accounting.missingJudgments, 2);
  assert.equal(partial.paired.aggregate.incompletePairs, 1);
  assert.equal(
    partial.paired.aggregate.missingObservations.a +
      partial.paired.aggregate.missingObservations.b,
    1,
  );
  for (const arm of [
    partial.paired.aggregate.arms.a,
    partial.paired.aggregate.arms.b,
  ])
    assert.equal(arm.materialDefectRecall.denominator, 1);
  const interrupted = await prepare(t, 1, 1, true, true, true);
  const torn = await runTrial(t, interrupted, 0, "native");
  await runTrial(t, interrupted, 1, "native");
  const bytes = await readFile(torn, "utf8");
  await writeFile(
    torn,
    bytes.slice(0, bytes.lastIndexOf("\n", bytes.length - 2) + 1) + '{"torn":',
  );
  interrupted.benchmark.collect();
  interrupted.benchmark.prepareJudging();
  interrupted.benchmark.sealJudgments();
  const prefix = interrupted.benchmark.score();
  assert.equal(prefix.scoringReady, false);
  assert.equal(prefix.accounting.retainedClaims, 2);
  assert.equal(prefix.accounting.unscoredClaims, 1);
  assert.equal(prefix.accounting.completedTrials, 1);
  assert.equal(
    prefix.paired.aggregate.arms.a.findings +
      prefix.paired.aggregate.arms.b.findings,
    1,
  );
  assert.equal(
    prefix.paired.aggregate.missingObservations.a +
      prefix.paired.aggregate.missingObservations.b,
    0,
  );
  for (const mode of [
    "missing",
    "malformed",
    "unresolved",
    "conflicting-label",
    "foreign",
  ] as const) {
    const f = await prepareJudgments(t, 1, 1, true, true);
    for (let i = 0; i < f.book.packets.length; i++) {
      const id = f.book.packets[i]!.blindId;
      if (i === 0 && mode === "missing") continue;
      const value = judgmentResponse(f, id);
      if (i === 0 && mode === "unresolved") {
        value.output!.label = "unresolved";
        value.output!.claims[0]!.judgement = "unresolved";
      }
      if (i === 0 && mode === "conflicting-label") {
        value.output!.label = "valid";
        value.output!.claims[0]!.judgement = "refuted";
      }
      if (i === 0 && mode === "foreign")
        value.assignmentDigest = "0".repeat(64);
      await putJudgment(
        f,
        id,
        i === 0 && mode === "malformed" ? { malformed: true } : value,
      );
    }
    f.benchmark.sealJudgments();
    const score = reviewBenchmarkScoreReportSchema.parse(
      f.benchmark.score(true),
    );
    assert.equal(score.scoringReady, false, mode);
    assert.equal(score.accounting.retainedClaims, 2, mode);
    assert.equal(score.accounting.unresolvedClaimJudgments, 1, mode);
    assert.equal(
      score.paired.aggregate.arms.a.findings +
        score.paired.aggregate.arms.b.findings,
      2,
      mode,
    );
    assert.equal(
      score.paired.aggregate.arms.a.supported +
        score.paired.aggregate.arms.b.supported,
      1,
      mode,
    );
    assert.equal(
      score.accounting.labelDisagreements,
      mode === "conflicting-label" ? 1 : 0,
    );
  }
});
test("benchmark scoring rejects changed seals and every reached artifact rather than trusting stored verdicts", async (t) => {
  for (const mode of [
    "manifest",
    "journal",
    "collection",
    "judging",
    "response",
    "archive",
    "permission",
  ] as const) {
    const f = await prepareJudgments(t, 1, 1, false, true);
    for (const p of f.book.packets)
      await putJudgment(f, p.blindId, judgmentResponse(f, p.blindId));
    const responsePath = f.benchmark.judgeSetup(
      f.book.packets[0]!.blindId,
    ).file;
    f.benchmark.sealJudgments();
    assert.equal(f.benchmark.score().scoringReady, true);
    const relative =
      mode === "manifest"
        ? "manifest.json"
        : mode === "journal"
          ? `journals/${f.manifest.trials[0]!.trialId}.jsonl`
          : mode === "collection"
            ? "collection.json"
            : mode === "judging"
              ? "judging.json"
              : mode === "archive"
                ? "judgments-sealed.json"
                : null;
    const file = relative
      ? path.join(f.reference.directory, relative)
      : responsePath;
    if (mode === "permission") await chmod(file, 0o644);
    else if (mode === "archive") {
      const archive = await judgmentArchive(f);
      archive.judgments[0]!.status = "foreign";
      await privateJson(file, archive);
    } else await writeFile(file, (await readFile(file)) + " ");
    assert.throws(() => f.benchmark.score(), Error, mode);
  }
});
test("benchmark scoring is operator-only through CLI while anonymous MCP worker commands reject scoring and retain incomplete exit status", async (t) => {
  const f = await prepare(t, 1, 1, false, true, true);
  for (let i = 0; i < f.manifest.trials.length; i++) await runTrial(t, f, i);
  f.benchmark.collect();
  f.benchmark.prepareJudging();
  f.benchmark.sealJudgments();
  const args = [
    "review-benchmark-score",
    "--root",
    f.cases[0]!.root,
    "--benchmark",
    `${f.reference.directory}#sha256=${f.reference.sha256}`,
  ];
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    maxBuffer: 1048576,
  });
  assert.equal(result.status, 2, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), f.benchmark.score());
  const detailed = spawnSync(process.execPath, [cli, ...args, "--detailed"], {
    encoding: "utf8",
    maxBuffer: 1048576,
  });
  assert.equal(detailed.status, 2, detailed.stderr);
  assert.deepEqual(JSON.parse(detailed.stdout), f.benchmark.score(true));
  for (const input of [
    { operation: "score" },
    { operation: "status", scoring: true },
  ]) {
    assert.throws(() =>
      f.benchmark.workerCommand(input, false, f.manifest.trials[0]!.trialId),
    );
    assert.throws(() =>
      f.benchmark.judgeWorkerCommand(
        input,
        false,
        f.manifest.trials[0]!.blindId,
      ),
    );
  }
  const client = new Client({ name: "original-scoring-worker", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          cli,
          "serve",
          "--root",
          f.cases[0]!.root,
          "--benchmark",
          `${f.reference.directory}#sha256=${f.reference.sha256}`,
          "--trial",
          f.manifest.trials[0]!.trialId,
        ],
        stderr: "pipe",
      }),
    );
    const response = await client.callTool({
      name: "review_benchmark",
      arguments: { operation: "score" },
    });
    assert.equal(response.isError, true);
  } finally {
    await client.close();
  }
});

test("benchmark scoring rejects multiple completed claims and keeps unexpected families unresolved instead of selecting a favorable claim", async (t) => {
  const multiple = await prepare(t, 1, 1, true, true, true);
  for (let i = 0; i < multiple.manifest.trials.length; i++)
    await runTrial(
      t,
      multiple,
      i,
      "native",
      undefined,
      undefined,
      undefined,
      i ? 1 : 2,
    );
  multiple.benchmark.collect();
  multiple.benchmark.prepareJudging();
  const book = reviewBenchmarkJudgingSchema.parse(
    JSON.parse(
      await readFile(
        path.join(multiple.reference.directory, "judging.json"),
        "utf8",
      ),
    ),
  );
  for (const p of book.packets)
    await putJudgment(
      multiple,
      p.blindId,
      judgmentResponse(multiple, p.blindId),
    );
  multiple.benchmark.sealJudgments();
  assert.equal(
    book.packets.flatMap((p) => p.outputs.flatMap((o) => o.candidates)).length,
    3,
  );
  assert.throws(() => multiple.benchmark.score(), /at most one claim/);
  const wrongFamily = await prepare(
    t,
    1,
    1,
    true,
    true,
    true,
    "authorization-tenancy",
  );
  for (let i = 0; i < wrongFamily.manifest.trials.length; i++)
    await runTrial(t, wrongFamily, i, "native");
  wrongFamily.benchmark.collect();
  wrongFamily.benchmark.prepareJudging();
  for (const trial of wrongFamily.manifest.trials)
    await putJudgment(
      wrongFamily,
      trial.blindId,
      judgmentResponse(wrongFamily, trial.blindId),
    );
  wrongFamily.benchmark.sealJudgments();
  const score = wrongFamily.benchmark.score();
  assert.equal(score.scoringReady, false);
  assert.equal(score.accounting.unexpectedFamilyClaims, 2);
  assert.equal(score.accounting.unresolvedClaimJudgments, 2);
  assert.equal(score.accounting.retainedClaims, 2);
  assert.equal(score.paired.aggregate.arms.a.precision.value, 0);
  assert.equal(score.paired.aggregate.arms.b.precision.value, 0);
});

test("sealed benchmark claim probabilities come from original reviewer candidates preserve exact zero one and unknown losses and never promote quality", async (t) => {
  const f = await prepareJudgments(t, 3, 1, true, true, [
    0,
    1,
    0.8,
    0.2,
    1,
    null,
  ]);
  for (const packet of f.book.packets) {
    const trial = f.manifest.trials.find((r) => r.blindId === packet.blindId)!;
    const value = judgmentResponse(f, packet.blindId);
    value.output!.label =
      trial.caseIndex === 0
        ? "defect"
        : trial.caseIndex === 1
          ? "valid"
          : "near-miss";
    value.output!.claims[0]!.judgement =
      trial.caseIndex === 0 ? "supported" : "refuted";
    await putJudgment(f, packet.blindId, value);
  }
  f.benchmark.sealJudgments();
  const score = reviewBenchmarkScoreReportSchema.parse(f.benchmark.score(true));
  assert.equal(score.scoringReady, true);
  assert.equal(score.accounting.declaredClaimProbabilities, 5);
  assert.equal(score.accounting.unknownClaimProbabilities, 1);
  assert.equal(score.accounting.retainedClaims, 6);
  assert.equal(score.probabilitiesAvailable, true);
  assert.equal(
    score.probabilitySource,
    "sealed-host-declared-uncalibrated-claim-probability",
  );
  const a = score.paired.aggregate.arms.a,
    b = score.paired.aggregate.arms.b;
  assert.equal(a.findings, 3);
  assert.equal(b.findings, 3);
  assert.equal(a.properScores.scored, 3);
  assert.equal(b.properScores.scored, 2);
  assert.ok(Math.abs(a.properScores.brier! - 0.88) < 1e-14);
  assert.ok(Math.abs(b.properScores.brier! - 0.02) < 1e-14);
  assert.equal(a.properScores.infiniteLogLoss, 2);
  assert.equal(a.properScores.negativeLogLikelihood, null);
  assert.equal(b.properScores.infiniteLogLoss, 0);
  assert.ok(
    Math.abs(b.properScores.negativeLogLikelihood! - -Math.log(0.8) / 2) <
      1e-14,
  );
  assert.equal(a.unknownProbabilities, 0);
  assert.equal(b.unknownProbabilities, 1);
  assert.equal(a.falseAlarmRate.value, 1);
  assert.equal(b.falseAlarmRate.value, 1);
  assert.equal(a.nearMissFalseAlarmRate.value, 1);
  assert.equal(b.nearMissFalseAlarmRate.value, 1);
  assert.equal(score.calibratedConfidence, false);
  assert.equal(score.claimsVerified, false);
  assert.equal(score.hostIsolationVerified, false);
  assert.equal(score.paired.qualityGate, "not-assessed");
  const command = spawnSync(
    process.execPath,
    [
      cli,
      "review-benchmark-score",
      "--root",
      f.cases[0]!.root,
      "--benchmark",
      f.reference.directory + "#sha256=" + f.reference.sha256,
      "--detailed",
    ],
    { encoding: "utf8", timeout: 10000, maxBuffer: 1048576 },
  );
  assert.equal(command.status, 0, command.stderr);
  assert.deepEqual(JSON.parse(command.stdout), score);
});
test("anonymous benchmark judge packets withhold all prior candidate metadata across outputs claims and native receipts while preserving source and opaque slot binding", async (t) => {
  const f = await prepareJudgments(t, 1, 1, true, true, [0.731234, 0.731234]);
  const packets = f.manifest.trials.map((r) =>
    reviewBenchmarkJudgePacketSchema.parse(
      f.benchmark.judgeWorkerCommand({ operation: "packet" }, true, r.blindId),
    ),
  );
  assert.deepEqual(
    f.book.packets[0]!.outputs[0]!.candidates,
    f.book.packets[1]!.outputs[0]!.candidates,
  );
  assert.notEqual(
    packets[0]!.claims[0]!.claimId,
    packets[1]!.claims[0]!.claimId,
  );
  for (const packet of packets) {
    const candidates = [
      ...packet.claims.map((c) => c.candidate),
      ...packet.evidence.outputs.flatMap((o) => o.candidates),
      ...packet.evidence.native.map((n) => n.candidate),
    ];
    assert.equal(candidates.length, 3);
    for (const candidate of candidates) {
      assert.deepEqual(Object.keys(candidate), [
        "family",
        "claim",
        "trigger",
        "consequence",
        "evidenceGaps",
        "citations",
      ]);
      for (const name of [
        "id",
        "severity",
        "confidence",
        "attribution",
        "fixScope",
      ])
        assert.equal(Object.hasOwn(candidate, name), false, name);
      assert.equal(candidate.citations[0]!.quote, source.trimEnd());
    }
    assert.equal(Object.hasOwn(packet.evidence.native[0]!, "run"), false);
    assert.equal(Object.hasOwn(packet.evidence.native[0]!, "recipe"), false);
    assert.equal(
      Object.hasOwn(packet.evidence.native[0]!.observations, "behavior"),
      false,
    );
    assert.equal(
      Object.hasOwn(packet.evidence.native[0]!.observations, "counts"),
      false,
    );
    assert.equal(packet.evidence.native[0]!.observations.cases.length, 3);
    assert.equal(JSON.stringify(packet).includes("0.731234"), false);
    assert.equal(
      JSON.stringify(packet).includes("OriginalReviewerTargetIdentity"),
      false,
    );
    assert.equal(
      packet.evidence.native[0]!.observations.cases.filter(
        (c) => c.role === "trigger" && c.actual !== c.expected,
      ).length,
      1,
    );
  }
  const first = f.manifest.trials[0]!,
    client = new Client({
      name: "original-confidence-blind-judge",
      version: "1",
    });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          cli,
          "serve",
          "--root",
          f.cases[0]!.root,
          "--benchmark",
          f.reference.directory + "#sha256=" + f.reference.sha256,
          "--judge",
          first.blindId,
          "--detailed",
          "--allow-review-source",
        ],
        stderr: "pipe",
      }),
    );
    const result = await client.callTool({
      name: "review_benchmark",
      arguments: { operation: "packet" },
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, packets[0]);
    const denied = await client.callTool({
      name: "review_benchmark",
      arguments: { operation: "score", confidence: 0.99 },
    });
    assert.equal(denied.isError, true);
  } finally {
    await client.close();
  }
});
test("sealed probability bindings reject changed retained candidates and foreign judgment predictions without accepting numerical overrides or losing incomplete slots", async (t) => {
  const f = await prepareJudgments(t, 1, 1, true, true, [0.6, 0.6]);
  for (const packet of f.book.packets) {
    const value = judgmentResponse(f, packet.blindId);
    (
      value.output!.claims[0] as unknown as Record<string, unknown>
    ).probability = 0.99;
    await putJudgment(f, packet.blindId, value);
  }
  f.benchmark.sealJudgments();
  const score = f.benchmark.score(true);
  assert.equal(score.scoringReady, false);
  assert.equal(score.accounting.rejectedJudgments, 2);
  assert.equal(score.accounting.declaredClaimProbabilities, 2);
  for (const arm of [
    score.paired.aggregate.arms.a,
    score.paired.aggregate.arms.b,
  ]) {
    assert.equal(arm.findings, 1);
    assert.equal(arm.precision.value, 0);
    assert.equal(arm.properScores.scored, 0);
    assert.equal(arm.properScores.unscoredFindings, 1);
  }
  const file = path.join(f.reference.directory, "judging.json"),
    original = await readFile(file);
  try {
    const changed = JSON.parse(original.toString());
    changed.packets[0].outputs[0].candidates[0].confidence.probability = 0.1;
    await writeFile(file, JSON.stringify(changed));
    assert.throws(() => f.benchmark.score(true), /judging artifact disagrees/);
  } finally {
    await writeFile(file, original);
  }
  assert.deepEqual(f.benchmark.score(true), score);
  const partial = await prepare(t, 1, 1, true, true, true);
  const confidence = {
    profile: "declared-claim-support-probability-v1" as const,
    event: "supported-in-scope-actionable" as const,
    probability: 0.6,
    calibratedConfidence: false as const,
  };
  const torn = await runTrial(
    t,
    partial,
    0,
    "native",
    undefined,
    undefined,
    undefined,
    1,
    confidence,
  );
  const bytes = await readFile(torn, "utf8");
  await writeFile(
    torn,
    bytes.slice(0, bytes.lastIndexOf("\n", bytes.length - 2) + 1) + '{"torn":',
  );
  partial.benchmark.collect();
  partial.benchmark.prepareJudging();
  partial.benchmark.sealJudgments();
  const incomplete = partial.benchmark.score(true);
  assert.equal(incomplete.accounting.retainedClaims, 1);
  assert.equal(incomplete.accounting.unscoredClaims, 1);
  assert.equal(incomplete.accounting.declaredClaimProbabilities, 0);
  assert.equal(incomplete.accounting.unknownClaimProbabilities, 0);
  assert.equal(incomplete.paired.aggregate.selected, 1);
  assert.equal(
    incomplete.paired.aggregate.arms.a.findings +
      incomplete.paired.aggregate.arms.b.findings,
    0,
  );
  assert.equal(incomplete.probabilitiesAvailable, false);
});
