import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cp,
  readFile,
  realpath,
  writeFile,
  mkdir,
  symlink,
  link,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers.js";
const root = fileURLToPath(new URL("../../", import.meta.url));
const shards = await import(
  new URL("../../scripts/dotnet-generator-shards.mjs", import.meta.url).href
);
const api = await import(
  new URL("../../scripts/check-dotnet-generator-ci.mjs", import.meta.url).href
);
const loaded = await shards.loadGeneratorShards(root);
const mutationSources = await shards.captureGeneratorMutationSources(root);
const clone = <T>(value: T): T => structuredClone(value);
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const context = {
  repository: "synthetic/repository",
  runId: "123456",
  headSha: "a".repeat(40),
  checkoutSha: "e".repeat(40),
  jobId: "987654",
  jobAttempt: 1,
};
const engine = {
  schemaVersion: 1,
  fileCount: 2,
  bytes: 16,
  treeSha256: "c".repeat(64),
  manifestSha256: "d".repeat(64),
};
function evidence(rows: { file: string; name: string }[]) {
  const files = [...new Set(rows.map((row) => row.file))];
  return {
    required: rows.length,
    passed: rows.length,
    problems: [],
    complete: true,
    compiledEngine: {
      ...engine,
      afterTreeSha256: engine.treeSha256,
      afterManifestSha256: engine.manifestSha256,
      beforeAfterByteIdentitiesMatch: true,
    },
    ledger: {
      schemaVersion: 1,
      terminalEventCount: rows.length,
      events: rows.map((row, i) => ({
        sequence: i + 1,
        fileId: "file-" + files.indexOf(row.file),
        name: row.name,
        nameTruncated: false,
        kind: "test",
        outcome: "passed",
        durationMs: 1,
        required: true,
      })),
      truncated: false,
      files: files.map((file, i) => ({
        id: "file-" + i,
        stable: true,
        before: { state: "present", sha256: digest(file) },
        after: { state: "present", sha256: digest(file) },
      })),
      cases: rows.map((row, i) => ({
        fileId: "file-" + files.indexOf(row.file),
        name: row.name,
        outcome: "passed",
        terminalSequences: [i + 1],
      })),
    },
  };
}
function inputs(id: string) {
  const shard = shards.selectGeneratorShard(loaded.manifest, id);
  const files = shards
    .generatorShardHarnessPaths(loaded)
    .map((file: string) => ({
      file,
      bytes: Object.hasOwn(mutationSources, file)
        ? Buffer.byteLength(mutationSources[file])
        : file.length,
      sha256: Object.hasOwn(mutationSources, file)
        ? digest(mutationSources[file])
        : digest(file),
    }));
  const artifact = (file: string) =>
    files.find((row: { file: string }) => row.file === file)!.sha256;
  const role = (name: "baseline" | "source") => ({
    schemaVersion: 1,
    scope: "dotnet-generator-required-role-fragment",
    shard: id,
    role: name,
    context: clone(context),
    manifestSha256: loaded.manifestSha256,
    requirementsSha256: loaded.requirementsSha256,
    requiredCaseKeys: shard[name].map(shards.generatorCaseKey),
    evidence: evidence(shard[name]),
    fragmentComplete: true,
    wholeProfileQualification: false,
  });
  return {
    loaded: clone(loaded),
    mutationSources: clone(mutationSources),
    shardId: id,
    context: clone(context),
    runtime: {
      image: {
        selectedReference: "synthetic:qualified",
        observedImageId: "sha256:" + "a".repeat(64),
      },
      node: {
        version: "v22.23.2",
        platform: "linux",
        arch: "arm64",
        sha256: "b".repeat(64),
      },
      sdk: {
        version: "10.0.401",
        runtime: "10.0.12",
        byteVerified: true,
        pinsSha256: "f".repeat(64),
      },
    },
    baseline: role("baseline"),
    source: role("source"),
    installed:
      id === loaded.manifest.installedOwner
        ? {
            offlineProductionInstall: true,
            harnessOutsideInstalledPackage: true,
            profile: evidence(
              loaded.requirements[loaded.manifest.sourceProfile],
            ),
          }
        : null,
    guards: {
      schemaVersion: 1,
      profile: "dotnet-generator-extensions",
      scope: "dotnet-generator-mutation-fragment",
      shard: id,
      context: clone(context),
      manifestSha256: loaded.manifestSha256,
      requirementsSha256: loaded.requirementsSha256,
      fragmentComplete: true,
      wholeProfileQualification: false,
      mutantAndRestoredProcessesPerControl: 2,
      sourceRestored: true,
      callbacksUnchanged: true,
      fixturesUnchanged: true,
      expectedControlIds: [...shard.controls],
      nativeCompileProofIds: shard.controls.filter((item: string) =>
        loaded.manifest.nativeCompileControlIds.includes(item),
      ),
      callbacks: [
        {
          file: "gate-dotnet-generator-extensions.test.js",
          sha256: artifact(
            "dist/test/gate-dotnet-generator-extensions.test.js",
          ),
        },
      ],
      fixtures: [
        {
          file: "dotnet-generator-extensions-fixture.js",
          sha256: artifact("dist/test/dotnet-generator-extensions-fixture.js"),
        },
      ],
      controls: shard.controls.map((item: string) => {
        const definition = shards.generatorGuardDefinitions.find(
          (row: { id: string }) => row.id === item,
        );
        const binding = shards.resolveGeneratorMutation(
          definition,
          mutationSources["dist/src/" + definition.file],
        ).binding;
        return {
          ...binding,
          originalPassed: true,
          mutantCompiled: true,
          mutantFailedAssertion: true,
          restoredPassed: true,
          expressionsReplaced: 1,
          ...(definition.nativeSource
            ? { mutatedNativeObserverCompiled: true }
            : {}),
        };
      }),
    },
    harness: {
      files,
      sha256: digest(JSON.stringify(files)),
      beforeAfterByteIdentitiesMatch: true,
    },
    stageDurationMs: {},
    durationMs: 1,
  };
}

const ci = {
  repository: context.repository,
  runId: context.runId,
  runAttempt: 2,
  headSha: context.headSha,
  checkoutSha: context.checkoutSha,
  event: "pull_request",
};
const source = {
  schemaVersion: 1,
  profile: "native-consumer-current-source-frame-v1",
  commit: context.checkoutSha,
  gitTree: "f".repeat(40),
  sourceManifestSha256: "1".repeat(64),
  engineSha256: engine.treeSha256,
  engineManifestSha256: engine.manifestSha256,
  harnessSha256: "2".repeat(64),
  harnessManifestSha256: "3".repeat(64),
  inventorySha256: "4".repeat(64),
  inventoryScopeSha256: "5".repeat(64),
  requirementsSha256: loaded.requirementsSha256,
  packageManifestSha256: "6".repeat(64),
  packageLockSha256: "7".repeat(64),
  sourceFiles: 1,
  sourceBytes: 16,
  clean: true,
  hostAttestationPerformed: false,
  gateAComplete: false,
};
function cohort() {
  const first = inputs("0");
  const current = {
    loaded,
    harness: { files: first.harness.files, sha256: first.harness.sha256 },
    mutationSources,
  };
  const envelopes = shards.dotnetGeneratorShardIds.map((id: string) => {
    const value = inputs(id),
      number = Number(id);
    const ctx = { ...context, jobId: String(987654 + number) };
    value.context = ctx;
    value.baseline.context = ctx;
    value.source.context = ctx;
    value.guards.context = ctx;
    const fragment = shards.createGeneratorShardFragment(value);
    const start = api.createGeneratorCIStart({
      id,
      context: ctx,
      loaded,
      checkRunId: String(5000 + number),
      nonce: `00000000-0000-4000-8000-${String(number + 1).padStart(12, "0")}`,
    });
    return api.createGeneratorCIEnvelope(start, source, fragment, current);
  });
  const bindings = envelopes.map(
    (envelope: { producer: { shard: string } }) => {
      const start = envelope.producer,
        id = start.shard;
      return {
        id,
        start,
        finish: api.createGeneratorCIFinish(start, envelope, {
          id: String(8000 + Number(id)),
          name: api.generatorCIArtifactName(id, 1),
          digest: "8".repeat(64),
        }),
      };
    },
  );
  const outputs: Record<string, string> = {};
  for (const row of bindings) {
    const keys = api.generatorCIOutputKeys(row.id);
    outputs[keys.start] = JSON.stringify(row.start);
    outputs[keys.finish] = JSON.stringify(row.finish);
  }
  return {
    current,
    envelopes,
    bindings,
    plan: { selected: { [api.generatorCIJob]: true } },
    needs: { [api.generatorCIJob]: { result: "success", outputs } },
  };
}
function job(id: string, attempt = 1) {
  const number = Number(id);
  return {
    id: 987654 + number,
    run_id: Number(ci.runId),
    run_attempt: attempt,
    head_sha: ci.headSha,
    name: api.generatorCIJobName(id),
    check_run_url: `https://api.github.com/repos/${ci.repository}/check-runs/${5000 + number}`,
    status: "completed",
    conclusion: "success",
    created_at: "2026-01-01T00:00:00Z",
    started_at: "2026-01-01T00:01:00Z",
    completed_at: "2026-01-01T00:02:00Z",
    runner_id: 100 + number,
    runner_name: "synthetic-arm-" + id,
    labels: ["ubuntu-arm"],
    steps: [
      {
        name: "synthetic preserved compiler controls",
        number: 1,
        status: "completed",
        conclusion: "success",
        started_at: "2026-01-01T00:01:01Z",
        completed_at: "2026-01-01T00:01:59Z",
      },
    ],
  };
}
const run = () => ({
  id: Number(ci.runId),
  repository: { full_name: ci.repository },
  head_sha: ci.headSha,
  run_attempt: ci.runAttempt,
  event: ci.event,
  path: ".github/workflows/ci.yml",
  status: "in_progress",
});
function metadata(binding: ReturnType<typeof cohort>["bindings"][number]) {
  return {
    id: Number(binding.finish.artifact.id),
    name: binding.finish.artifact.name,
    digest: "sha256:" + binding.finish.artifact.digest,
    expired: false,
    size_in_bytes: 512,
    workflow_run: { id: Number(ci.runId), head_sha: ci.headSha },
  };
}
function observations(value: ReturnType<typeof cohort>) {
  return value.bindings.map(
    (binding: ReturnType<typeof cohort>["bindings"][number]) => {
      const original = job(binding.id),
        latest = {
          ...clone(original),
          id: original.id + 10000,
          run_attempt: 2,
          created_at: "2026-01-01T00:10:00Z",
        };
      return {
        ...api.bindGeneratorLatestExecution(binding, original, latest, ci),
        artifactId: binding.finish.artifact.id,
        artifactDigest: "sha256:" + binding.finish.artifact.digest,
      };
    },
  );
}

test("generator workflow identity keeps candidate head distinct from its checkout merge and selects a real numeric job ID", async () => {
  const environment = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: ci.repository,
    GITHUB_RUN_ID: ci.runId,
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_SHA: ci.checkoutSha,
    CHECKTRAIL_DOTNET_CANDIDATE_HEAD: ci.headSha,
    GITHUB_EVENT_NAME: "pull_request",
  };
  assert.deepEqual(api.generatorCIObservation(environment), ci);
  assert.notEqual(ci.headSha, ci.checkoutSha);
  api.requireGeneratorRun(run(), ci);
  assert.throws(
    () => api.requireGeneratorRun({ ...run(), head_sha: ci.checkoutSha }, ci),
    /candidate head/,
  );
  const target = { ...job("0", 2), status: "in_progress", conclusion: null };
  const rows = [
    ...Array.from({ length: 20 }, (_, i) => ({
      ...target,
      id: 100 + i,
      name: "other-" + i,
    })),
    target,
  ];
  const seen: string[] = [];
  const request = async (endpoint: string) => {
    seen.push(endpoint);
    if (endpoint === `runs/${ci.runId}`) return run();
    const page = Number(
      new URL("https://example.invalid/" + endpoint).searchParams.get("page"),
    );
    return {
      total_count: rows.length,
      jobs: rows.slice((page - 1) * 20, page * 20),
    };
  };
  const observed = await api.observeGeneratorProducer(request, ci, "0", "5000");
  assert.equal(observed.jobId, String(target.id));
  assert.notEqual(observed.jobId, "5000");
  assert.equal(observed.jobAttempt, 2);
  assert.equal(seen.filter((url) => url.includes("page=")).length, 2);
  await assert.rejects(
    api.observeGeneratorProducer(request, ci, "0", String(target.id)),
    /check run/,
  );
  const aliasRequest = async (endpoint: string) =>
    endpoint === `runs/${ci.runId}`
      ? run()
      : { total_count: 1, jobs: [job("0", 2)] };
  await assert.rejects(
    api.observeGeneratorProducer(aliasRequest, ci, "0", "5000"),
    /retained completed alias/,
  );
  await assert.rejects(
    api.observeGeneratorProducer(
      async (endpoint: string) =>
        endpoint === `runs/${ci.runId}`
          ? run()
          : {
              total_count: 1,
              jobs: [{ ...target, name: target.name + "-extra" }],
            },
      ci,
      "0",
      "5000",
    ),
    /exact generator job context/,
  );
});

test("generator START accepts a queued aggregate only with its exact active producer", async () => {
  for (const id of shards.dotnetGeneratorShardIds) {
    const target = { ...job(id, 2), status: "in_progress", conclusion: null };
    for (const statuses of [
      ["queued", "queued"],
      ["queued", "in_progress"],
      ["in_progress", "queued"],
    ]) {
      const seen: string[] = [];
      let reads = 0;
      const request = async (endpoint: string) => {
        seen.push(endpoint);
        if (endpoint === `runs/${ci.runId}`)
          return { ...run(), status: statuses[reads++] };
        assert.equal(
          endpoint,
          `runs/${ci.runId}/attempts/2/jobs?per_page=20&page=1`,
        );
        return { total_count: 1, jobs: [target] };
      };
      const result = await api.observeGeneratorProducer(
        request,
        ci,
        id,
        String(5000 + Number(id)),
      );
      assert.equal(result.jobId, String(target.id));
      assert.equal(result.jobAttempt, 2);
      assert.equal(reads, 2);
      assert.equal(seen.length, 3);
    }
    for (const variant of [
      "queued-job",
      "completed-job",
      "failed-job",
      "active-failure",
      "foreign-attempt",
      "foreign-head",
      "foreign-check-run",
      "cancelled-run",
      "waiting-run",
      "changed-attempt-after-job",
    ]) {
      const changed = clone(target);
      if (variant === "queued-job") changed.status = "queued";
      if (variant === "completed-job") changed.status = "completed";
      if (variant === "failed-job")
        Object.assign(changed, { status: "completed", conclusion: "failure" });
      if (variant === "active-failure")
        Object.assign(changed, { conclusion: "failure" });
      if (variant === "foreign-attempt") changed.run_attempt++;
      if (variant === "foreign-head") changed.head_sha = ci.checkoutSha;
      if (variant === "foreign-check-run") changed.check_run_url += "9";
      let reads = 0;
      await assert.rejects(
        api.observeGeneratorProducer(
          async (endpoint: string) => {
            if (endpoint === `runs/${ci.runId}`) {
              reads++;
              return {
                ...run(),
                status:
                  variant === "cancelled-run"
                    ? "cancelled"
                    : variant === "waiting-run"
                      ? "waiting"
                      : "queued",
                run_attempt:
                  variant === "changed-attempt-after-job" && reads === 2
                    ? 3
                    : 2,
              };
            }
            return { total_count: 1, jobs: [changed] };
          },
          ci,
          id,
          String(5000 + Number(id)),
        ),
        variant,
      );
    }
  }
});

test("generator metadata pagination rejects incomplete changing duplicate foreign and excessive inventories", async () => {
  const rows = Array.from({ length: 21 }, (_, i) => ({
    ...job("0"),
    id: 200 + i,
    name: "synthetic-" + i,
  }));
  for (const variant of [
    "short",
    "changed-total",
    "duplicate",
    "foreign-head",
    "foreign-run",
    "excess",
  ]) {
    const request = async (endpoint: string) => {
      const page = Number(
        new URL("https://example.invalid/" + endpoint).searchParams.get("page"),
      );
      const list = clone(rows.slice((page - 1) * 20, page * 20));
      if (variant === "short" && page === 1) list.pop();
      if (variant === "duplicate" && page === 2) list[0]!.id = rows[0]!.id;
      if (variant === "foreign-head") list[0]!.head_sha = "f".repeat(40);
      if (variant === "foreign-run") list[0]!.run_id++;
      return {
        total_count:
          variant === "excess"
            ? 201
            : variant === "changed-total" && page === 2
              ? 22
              : 21,
        jobs: list,
      };
    };
    await assert.rejects(
      api.listGeneratorJobs(request, `runs/${ci.runId}/jobs?filter=latest`, ci),
      variant,
    );
  }
});

test("generator metadata transport pins origin credentials redirects bytes deadlines and retry budgets", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  let calls = 0;
  const request = api.createGeneratorMetadataRequest({
    repository: ci.repository,
    token: "synthetic-token",
    fetchImpl: async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return ++calls === 1
        ? new Response("temporary", { status: 502 })
        : new Response('{"ok":true}');
    },
  });
  assert.deepEqual(await request(`runs/${ci.runId}`), { ok: true });
  assert.equal(calls, 2);
  assert.equal(seen[0]!.init.redirect, "error");
  assert.equal(
    (seen[0]!.init.headers as Record<string, string>).Authorization,
    "Bearer synthetic-token",
  );
  await assert.rejects(request("https://unrelated.invalid/actions/runs/1"));
  await assert.rejects(request("../runs/1"));
  await assert.rejects(request("runs/1/jobs?filter=all"));
  const oversized = api.createGeneratorMetadataRequest({
    repository: ci.repository,
    token: "synthetic-token",
    fetchImpl: async () => new Response(Buffer.alloc(4 * 1048576 + 1)),
  });
  await assert.rejects(oversized("runs/1"), /exceeds bound/);
  let failures = 0;
  const failed = api.createGeneratorMetadataRequest({
    repository: ci.repository,
    token: "synthetic-token",
    fetchImpl: async () => {
      failures++;
      return new Response("failure", { status: 503 });
    },
  });
  await assert.rejects(failed("runs/1"), /HTTP 503/);
  assert.equal(failures, 2);
  const budget = api.createGeneratorMetadataRequest({
    repository: ci.repository,
    token: "synthetic-token",
    fetchImpl: async () => new Response("{}"),
  });
  for (let i = 0; i < 40; i++) await budget("runs/1");
  await assert.rejects(budget("runs/1"), /budget exhausted/);
  const aborted = api.createGeneratorMetadataRequest({
    repository: ci.repository,
    token: "synthetic-token",
    deadlineMs: 10,
    fetchImpl: async (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener(
          "abort",
          () => reject(init.signal!.reason),
          { once: true },
        );
      }),
  });
  const keepAlive = setTimeout(() => {}, 50);
  try {
    await assert.rejects(aborted("runs/1"));
  } finally {
    clearTimeout(keepAlive);
  }
});

test("generator retained aliases preserve original execution IDs attempts and exact terminal execution metadata", () => {
  const value = cohort(),
    binding = value.bindings[0]!,
    original = job("0");
  const latest = {
    ...clone(original),
    id: original.id + 10000,
    run_attempt: 2,
    created_at: "2026-01-01T00:10:00Z",
    check_run_url:
      "https://api.github.com/repos/synthetic/repository/check-runs/999999",
  };
  const observed = api.bindGeneratorLatestExecution(
    binding,
    original,
    latest,
    ci,
  );
  assert.equal(observed.producerExecutionJobId, String(original.id));
  assert.equal(observed.producerExecutionAttempt, 1);
  assert.equal(observed.latestObservedJobId, String(latest.id));
  assert.equal(observed.aggregateAttempt, 2);
  assert.equal(observed.retainedAlias, true);
  for (const variant of [
    "failure",
    "pending",
    "fresh-times",
    "fresh-steps",
    "fresh-runner",
    "wrong-head",
    "wrong-context",
  ]) {
    const changed = clone(latest);
    if (variant === "failure") changed.conclusion = "failure";
    if (variant === "pending") changed.status = "in_progress";
    if (variant === "fresh-times") changed.started_at = "2026-01-01T00:11:00Z";
    if (variant === "fresh-steps")
      changed.steps[0]!.started_at = "2026-01-01T00:11:01Z";
    if (variant === "fresh-runner") changed.runner_id++;
    if (variant === "wrong-head") changed.head_sha = "0".repeat(40);
    if (variant === "wrong-context") changed.name = api.generatorCIJobName("1");
    assert.throws(
      () => api.bindGeneratorLatestExecution(binding, original, changed, ci),
      variant,
    );
  }
  const relabeled = clone(binding);
  relabeled.start.context.jobAttempt = 2;
  assert.throws(
    () =>
      api.bindGeneratorLatestExecution(
        relabeled,
        { ...original, run_attempt: 2 },
        latest,
        ci,
      ),
    /Fresh producer/,
  );
  assert.throws(
    () =>
      api.bindGeneratorLatestExecution(
        binding,
        { ...original, id: original.id + 1 },
        latest,
        ci,
      ),
    /Original execution ID/,
  );
});

test("generator START FINISH selection requires exact six outputs original nonce and current source", () => {
  const value = cohort();
  const selected = api.selectGeneratorProducerClaims({
    loaded,
    ci,
    source,
    plan: value.plan,
    needs: value.needs,
  });
  assert.equal(selected.length, 3);
  for (const variant of [
    "missing",
    "foreign",
    "noncanonical",
    "fresh-start-old-finish",
    "failed",
    "future",
    "wrong-source",
    "reused-artifact",
  ]) {
    const changed = clone(value.needs),
      key = api.generatorCIOutputKeys("0");
    if (variant === "missing")
      delete changed[api.generatorCIJob]!.outputs[key.finish];
    if (variant === "foreign")
      changed[api.generatorCIJob]!.outputs.extra = "{}";
    if (variant === "noncanonical")
      changed[api.generatorCIJob]!.outputs[key.start] += " ";
    if (variant === "fresh-start-old-finish") {
      const start = JSON.parse(
        changed[api.generatorCIJob]!.outputs[key.start]!,
      );
      start.nonce = "00000000-0000-4000-8000-999999999999";
      changed[api.generatorCIJob]!.outputs[key.start] = JSON.stringify(start);
    }
    if (variant === "failed") changed[api.generatorCIJob]!.result = "failure";
    if (variant === "future") {
      const start = JSON.parse(
        changed[api.generatorCIJob]!.outputs[key.start]!,
      );
      start.context.jobAttempt = 3;
      changed[api.generatorCIJob]!.outputs[key.start] = JSON.stringify(start);
    }
    if (variant === "wrong-source") {
      const finish = JSON.parse(
        changed[api.generatorCIJob]!.outputs[key.finish]!,
      );
      finish.sourceFrameSha256 = "0".repeat(64);
      changed[api.generatorCIJob]!.outputs[key.finish] = JSON.stringify(finish);
    }
    if (variant === "reused-artifact") {
      const finish = JSON.parse(
        changed[api.generatorCIJob]!.outputs[key.finish]!,
      );
      finish.artifact.id = value.bindings[1]!.finish.artifact.id;
      changed[api.generatorCIJob]!.outputs[key.finish] = JSON.stringify(finish);
    }
    assert.throws(
      () =>
        api.selectGeneratorProducerClaims({
          loaded,
          ci,
          source,
          plan: value.plan,
          needs: changed,
        }),
      variant,
    );
  }
  assert.deepEqual(
    api.selectGeneratorProducerClaims({
      loaded,
      ci,
      source,
      plan: { selected: { [api.generatorCIJob]: false } },
      needs: { [api.generatorCIJob]: { result: "skipped", outputs: {} } },
    }),
    [],
  );
  assert.throws(() =>
    api.selectGeneratorProducerClaims({
      loaded,
      ci,
      source,
      plan: { selected: { [api.generatorCIJob]: false } },
      needs: value.needs,
    }),
  );
});

test("generator artifact claims bind immutable ID digest repository run head and expiration", () => {
  const binding = cohort().bindings[0]!,
    valid = metadata(binding);
  api.requireGeneratorArtifactMetadata(valid, binding, ci);
  for (const variant of [
    "id",
    "name",
    "digest",
    "expired",
    "run",
    "head",
    "size",
  ]) {
    const changed = clone(valid);
    if (variant === "id") changed.id++;
    if (variant === "name") changed.name += "-extra";
    if (variant === "digest") changed.digest = "sha256:" + "0".repeat(64);
    if (variant === "expired") changed.expired = true;
    if (variant === "run") changed.workflow_run.id++;
    if (variant === "head") changed.workflow_run.head_sha = ci.checkoutSha;
    if (variant === "size") changed.size_in_bytes = 4 * 1048576 + 1;
    assert.throws(
      () => api.requireGeneratorArtifactMetadata(changed, binding, ci),
      variant,
    );
  }
});

test("generator API reconciliation accepts mixed retained successes but refuses an older success for latest failure", async () => {
  const value = cohort(),
    originals = value.bindings.map((row: { id: string }) => job(row.id));
  const latest = originals.map((row: ReturnType<typeof job>) => ({
    ...clone(row),
    id: row.id + 10000,
    run_attempt: 2,
    created_at: "2026-01-01T00:10:00Z",
  }));
  const makeRequest =
    (
      fail = false,
      aggregateStatus = "in_progress",
      producerStatus = "completed",
    ) =>
    async (endpoint: string) => {
      if (endpoint === `runs/${ci.runId}`)
        return { ...run(), status: aggregateStatus };
      if (endpoint.startsWith("artifacts/"))
        return metadata(
          value.bindings.find((row: { finish: { artifact: { id: string } } }) =>
            endpoint.endsWith(row.finish.artifact.id),
          )!,
        );
      const rows = endpoint.includes("filter=latest")
        ? clone(latest)
        : clone(originals);
      if (endpoint.includes("filter=latest")) {
        rows[0]!.status = producerStatus;
        if (fail) rows[0]!.conclusion = "failure";
      }
      return { total_count: rows.length, jobs: rows };
    };
  const observed = await api.observeGeneratorBindings(
    makeRequest(),
    value.bindings,
    ci,
  );
  assert.deepEqual(
    observed.map(
      (row: { producerExecutionAttempt: number }) =>
        row.producerExecutionAttempt,
    ),
    [1, 1, 1],
  );
  assert.deepEqual(
    await api.observeGeneratorBindings(
      makeRequest(false, "queued"),
      value.bindings,
      ci,
    ),
    observed,
  );
  for (const aggregateStatus of ["queued", "in_progress"]) {
    await assert.rejects(
      api.observeGeneratorBindings(
        makeRequest(true, aggregateStatus),
        value.bindings,
        ci,
      ),
      /Latest failure/,
    );
    for (const producerStatus of ["queued", "in_progress"])
      await assert.rejects(
        api.observeGeneratorBindings(
          makeRequest(false, aggregateStatus, producerStatus),
          value.bindings,
          ci,
        ),
        /completed/,
      );
  }
});

test("generator complete fan-in requires every preserved role and current immutable fragment", () => {
  const value = cohort(),
    observed = observations(value);
  const report = api.qualifyGeneratorCohort({
    loaded,
    ci,
    source,
    current: value.current,
    bindings: value.bindings,
    observations: observed,
    envelopes: value.envelopes,
  });
  assert.equal(report.wholeProfileQualification, true);
  assert.equal(report.gateAComplete, false);
  assert.equal(report.hostAttestationPerformed, false);
  assert.equal(report.baselineCaseKeys.length, 37);
  assert.equal(report.sourceCaseKeys.length, 9);
  assert.equal(report.installedCaseKeys.length, 9);
  assert.equal(report.mutationControlIds.length, 12);
  assert.equal(report.nativeCompileProofIds.length, 3);
  assert.ok(
    value.envelopes.every(
      (row: { wholeProfileQualification: boolean }) =>
        row.wholeProfileQualification === false,
    ),
  );
  for (const variant of [
    "missing",
    "duplicate",
    "stale-source",
    "changed-harness",
    "changed-control",
    "wrong-attempt",
    "foreign-field",
  ]) {
    const envelopes = clone(value.envelopes);
    if (variant === "missing") envelopes.pop();
    if (variant === "duplicate") envelopes[1] = clone(envelopes[0]!);
    if (variant === "stale-source")
      envelopes[0]!.source.sourceManifestSha256 = "0".repeat(64);
    if (variant === "changed-harness")
      envelopes[0]!.fragment.harness.files[0]!.sha256 = "0".repeat(64);
    if (variant === "changed-control")
      envelopes[0]!.fragment.guards.controls[0]!.mutantSha256 = "0".repeat(64);
    if (variant === "wrong-attempt")
      envelopes[0]!.producer.context.jobAttempt = 2;
    if (variant === "foreign-field")
      Object.assign(envelopes[0], {
        sourceText: "synthetic forbidden extra body",
      });
    assert.throws(
      () =>
        api.qualifyGeneratorCohort({
          loaded,
          ci,
          source,
          current: value.current,
          bindings: value.bindings,
          observations: observed,
          envelopes,
        }),
      variant,
    );
  }
  const direct = shards.aggregateGeneratorShardFragments({
    ...value.current,
    fragments: value.envelopes.map(
      (row: { fragment: unknown }) => row.fragment,
    ),
    contexts: Object.fromEntries(
      value.bindings.map((row: { id: string; start: { context: unknown } }) => [
        row.id,
        row.start.context,
      ]),
    ),
  });
  assert.equal(direct.cohortEvidenceComplete, true);
  assert.equal(direct.wholeProfileQualification, false);
});

test("generator downloaded fragments reuse strict readers and reject missing foreign linked or oversized members", async (t) => {
  const value = cohort(),
    directory = await realpath(await fixture(t, {}));
  for (let i = 0; i < value.bindings.length; i++) {
    const binding = value.bindings[i]!,
      parent = path.join(directory, binding.finish.artifact.name);
    await mkdir(parent);
    await writeFile(
      path.join(parent, `dotnet-generator-shard-${binding.id}.json`),
      JSON.stringify(value.envelopes[i]),
    );
  }
  const envelopes = await api.readGeneratorCIArtifacts(
    directory,
    value.bindings,
  );
  assert.equal(envelopes.length, 3);
  const binding = value.bindings[0]!,
    file = path.join(
      directory,
      binding.finish.artifact.name,
      `dotnet-generator-shard-${binding.id}.json`,
    ),
    bytes = await readFile(file);
  const extra = path.join(path.dirname(file), "foreign.json");
  await writeFile(extra, "{}");
  await assert.rejects(
    api.readGeneratorCIArtifacts(directory, value.bindings),
    /foreign generator fragment file/,
  );
  const { rm } = await import("node:fs/promises");
  await rm(extra);
  await rm(file);
  await symlink(
    path.join(
      directory,
      value.bindings[1]!.finish.artifact.name,
      "dotnet-generator-shard-1.json",
    ),
    file,
  );
  await assert.rejects(api.readGeneratorCIArtifacts(directory, value.bindings));
  await rm(file);
  const linked = path.join(directory, "link-target.json");
  await writeFile(linked, bytes);
  await link(linked, file);
  await assert.rejects(api.readGeneratorCIArtifacts(directory, value.bindings));
  await rm(file);
  await rm(linked);
  await writeFile(file, JSON.stringify({ synthetic: "x".repeat(1048576) }));
  await assert.rejects(api.readGeneratorCIArtifacts(directory, value.bindings));
  await writeFile(file, bytes);
  await rm(path.dirname(file), { recursive: true });
  await assert.rejects(
    api.readGeneratorCIArtifacts(directory, value.bindings),
    /Missing or foreign generator artifact directory/,
  );
});

test("generator START imports only metadata before dependencies or compiled project code exist", async (t) => {
  const directory = await fixture(t, {}),
    scripts = path.join(directory, "scripts");
  await mkdir(scripts);
  for (const file of [
    "check-dotnet-generator-ci.mjs",
    "dotnet-generator-shards.mjs",
    "consumer-native-acceptance-frame.mjs",
    "compiled-engine-evidence.mjs",
    "native-ci-artifact-storage.mjs",
  ])
    await cp(path.join(root, "scripts", file), path.join(scripts, file));
  const driver = path.join(directory, "import-start.mjs");
  await writeFile(
    driver,
    "import {generatorCIJob} from './scripts/check-dotnet-generator-ci.mjs';console.log(generatorCIJob);",
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [driver], {
    env,
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 65536,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), api.generatorCIJob);
});
