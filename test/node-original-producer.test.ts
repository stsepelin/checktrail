import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { URL } from "node:url";
import { parse } from "yaml";
const profile = await import(
  new URL(
    "../../scripts/producer-qualification/node-original-profile.mjs",
    import.meta.url,
  ).href
);
const transport = await import(
  new URL(
    "../../scripts/producer-qualification/node-original-transport.mjs",
    import.meta.url,
  ).href
);
const controller = await import(
  new URL("../../scripts/qualify-node-original-producer.mjs", import.meta.url)
    .href
);
const catalog = profile.nodeOriginalCatalog();
const terminal = {
  exitCode: 0,
  signal: null,
  error: null,
  reason: null,
  stopError: null,
};
function manifest() {
  return {
    schemaVersion: 1,
    packageJsonSha256: catalog.docCache.packageJsonSha256,
    lockSha256: catalog.docCache.lockSha256,
    lockGitBlob: catalog.docCache.lockGitBlob,
    artifacts: profile.nodeOriginalInputRows().slice(1),
  };
}
test("Original Node freezes the direct XZ identity all145 public inputs and unchanged three commands", () => {
  const rows = profile.nodeOriginalInputRows();
  assert.equal(rows.length, 145);
  assert.equal(
    rows.reduce((sum: number, row: { bytes: number }) => sum + row.bytes, 0),
    50918581,
  );
  assert.deepEqual(
    catalog.originalCommands.map((row: { argv: string[] }) => row.argv),
    [["./configure"], ["make", "-j4"], ["make", "test-only"]],
  );
  const altered = profile.nodeOriginalCatalog();
  altered.limits.workSeconds--;
  assert.throws(
    () => profile.requireNodeOriginalCatalog(altered),
    /defaults or limits differ/u,
  );
  rows[0].sha256 = "0".repeat(64);
  assert.equal(
    profile.nodeOriginalInputRows()[0].sha256,
    "720894f323e5c1ac24968eb2676660c90730d715cb7f090be71a668662a17c37",
  );
});

test("Original Node doc manifest admits reordered exact rows and refuses missing duplicate foreign and mismatched locks", () => {
  const valid = manifest();
  valid.artifacts.reverse();
  profile.inspectNodeDocArchiveManifest(valid);
  for (const mutate of [
    (v: ReturnType<typeof manifest>) => {
      v.artifacts.pop();
    },
    (v: ReturnType<typeof manifest>) => {
      v.artifacts[1] = v.artifacts[0];
    },
    (v: ReturnType<typeof manifest>) => {
      v.lockSha256 = "0".repeat(64);
    },
    (v: ReturnType<typeof manifest>) => {
      v.artifacts[0].file = "docs/../foreign.tgz";
    },
    (v: ReturnType<typeof manifest>) => {
      v.artifacts[0].sha256 = "0".repeat(64);
    },
    (v: ReturnType<typeof manifest>) => {
      v.artifacts[0].bytes++;
    },
  ]) {
    const value = manifest();
    mutate(value);
    assert.throws(() => profile.inspectNodeDocArchiveManifest(value));
  }
});

test("Original Node environment keeps compiler and upstream defaults and only routes the owned npm cache", () => {
  const valid = { PATH: "/usr/bin", npm_config_cache: "/work/npm-cache" };
  profile.requireNodeOriginalEnvironment(valid);
  for (const added of [
    { CC: "gcc" },
    { CXX: "g++" },
    { CI_SKIP_TESTS: "" },
    { FLAKY_TESTS: "skip" },
    { npm_config_audit: "false" },
    { NPM_CONFIG_CACHE: "/work/npm-cache" },
  ])
    assert.throws(() =>
      profile.requireNodeOriginalEnvironment({ ...valid, ...added }),
    );
});

test("Original Node exact image tool and ordered Python admission rejects adjacent body and higher priority selectors", () => {
  const tools = catalog.tools.map((row: object) => ({ ...row, mode: 0o755 }));
  profile.inspectNodeImageTools(tools);
  const wrong = structuredClone(tools);
  wrong[0].sha256 = "0".repeat(64);
  assert.throws(() => profile.inspectNodeImageTools(wrong), /body differs/u);
  const python = catalog.tools.find(
    (row: { role: string }) => row.role === "tool-python3",
  );
  const rows = catalog.pythonCandidatesInOrder.map((candidate: string) => ({
    candidate,
    executable: candidate === "python3.11",
    canonicalPath: candidate === "python3.11" ? python.canonicalPath : null,
    bytes: candidate === "python3.11" ? python.bytes : null,
    sha256: candidate === "python3.11" ? python.sha256 : null,
  }));
  assert.equal(
    profile.inspectNodePythonSelection(rows).candidate,
    "python3.11",
  );
  rows[0] = {
    ...rows[0],
    executable: true,
    canonicalPath: "/foreign/python",
    bytes: 1,
    sha256: "0".repeat(64),
  };
  assert.throws(
    () => profile.inspectNodePythonSelection(rows),
    /different Python/u,
  );
});

test("Original Node selected build completion remains distinct from failed original upstream tests", () => {
  const stages = Object.fromEntries(
    ["configure", "build", "upstream-tests"].map((key) => [
      key,
      { invoked: true, terminalObserved: true, ...terminal },
    ]),
  );
  stages["upstream-tests"]!.exitCode = 1;
  const output = {
    file: "out/Release/node",
    bytes: 1024 ** 3,
    sha256: "c".repeat(64),
    mode: 0o755,
  };
  const bindings = {
    coldSourceMatched: true,
    imageAndToolsStable: true,
    outputCustodyVerified: true,
  };
  const value = profile.classifyNodeOriginalCompletion(
    stages,
    output,
    bindings,
  );
  assert.equal(value.selectedOriginalNodeBuildCompletionVerified, true);
  assert.equal(value.originalTestCommandExitCode, 1);
  assert.equal(value.allUpstreamTestsPassed, false);
  assert.equal(value.gateAComplete, false);
  assert.equal(
    profile.classifyNodeOriginalCompletion(
      stages,
      { ...output, bytes: catalog.limits.observedWorkBytes + 1 },
      bindings,
    ).selectedOriginalNodeBuildCompletionVerified,
    false,
  );
  assert.equal(
    profile.classifyNodeOriginalCompletion(stages, output, {
      ...bindings,
      outputCustodyVerified: false,
    }).selectedOriginalNodeBuildCompletionVerified,
    false,
  );
  stages.build!.reason = "deadline" as never;
  assert.equal(
    profile.classifyNodeOriginalCompletion(stages, output, bindings)
      .selectedOriginalNodeBuildCompletionVerified,
    false,
  );
});

test("Original Node CLI refuses missing operator heavy-slot admission before body preparation", async () => {
  await assert.rejects(
    controller.mainNodeOriginal([
      "run",
      "/absent-inputs",
      "/absent-output",
      "/absent-doc",
      "/absent-startup",
    ]),
  );
  await assert.rejects(
    controller.mainNodeOriginal([
      "run",
      "/absent-inputs",
      "/absent-output",
      "/absent-doc",
      "/absent-startup",
      "--operator-trust-execution",
      "--wrong-heavy-slot",
    ]),
    /operator and heavy-slot admission/u,
  );
});

test("Original Node workflow binds one source-only acquisition and preserves original commands artifact and no cancellation", async () => {
  const raw = await readFile(
    new URL(
      "../../.github/workflows/upstream-node-original.yml",
      import.meta.url,
    ),
    "utf8",
  );
  const workflow = parse(raw);
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(workflow.on.push.branches, [
    "pr/upstream-producer/node-original-*",
  ]);
  const jobs = Object.values(workflow.jobs) as {
    "runs-on": string;
    steps: { run?: string; uses?: string; with?: { path?: string } }[];
  }[];
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!["runs-on"], "ubuntu-24.04");
  const commands = jobs[0]!.steps.flatMap((row) => (row.run ? [row.run] : []));
  assert.equal(
    commands.filter((row) => row.includes("acquire-node-original-inputs.mjs"))
      .length,
    1,
  );
  assert.ok(
    commands.some(
      (row) =>
        row.includes("--operator-trust-execution --coordinated-heavy-slot") &&
        row.includes("verify-observation"),
    ),
  );
  assert.ok(
    jobs[0]!.steps.some(
      (row) =>
        row.with?.path?.includes("exports-built/**") &&
        row.with.path.includes("source-members.jsonl"),
    ),
  );
  assert.ok(!raw.includes("npm ci") && !raw.includes("node-v22.16.0-linux"));
  assert.ok(Buffer.byteLength(raw) < 8192);
});

test("Original Node final admission preserves failed test outcomes and rejects incomplete cleanup clock source or controller exit", () => {
  const startup = {
    source: { gitHead: "1".repeat(40) },
    caller: { uid: 1001, gid: 1001 },
    ci: { GITHUB_RUN_ID: "123" },
  };
  const stages = Object.fromEntries(
    ["configure", "build", "upstream-tests"].map((selector) => [
      selector,
      {
        invoked: true,
        terminalObserved: true,
        ...terminal,
        exitCode: selector === "upstream-tests" ? 1 : 0,
      },
    ]),
  );
  const original = ["configure", "build", "upstream-tests"].map((selector) => ({
    kind: "original",
    selector,
    cleanup: { state: "absent" },
    secondaries: [],
    nativeState: {
      Status: "exited",
      Running: false,
      Pid: 0,
      StartedAt: "2026-01-01T00:00:01Z",
      FinishedAt: "2026-01-01T00:00:02Z",
      OOMKilled: false,
      Error: "",
      ExitCode: stages[selector]!.exitCode,
    },
    terminal: stages[selector],
  }));
  const receipt = {
    schemaVersion: 1,
    catalogSha256: profile.nodeOriginalCatalogSha256,
    state: "original-node-build-and-test-command-observed",
    ...startup,
    networkPolicy: transport.nodeOriginalNetworkPolicy,
    ownedClientsAndContainersCleaned: true,
    cleanupFailures: [],
    rawBytes: 100,
    elapsedSeconds: 20,
    completion: {
      selectedOriginalNodeBuildCompletionVerified: true,
      originalTestCommandCompleted: true,
      allUpstreamTestsPassed: false,
    },
    completeOriginalNoticeClosureVerified: false,
    gateAComplete: false,
    executions: original,
    originalStages: stages,
  };
  const result = controller.inspectNodeOriginalObservation(
    receipt,
    startup,
    "2",
  );
  assert.equal(result.originalCommandExitCodes[2].exitCode, 1);
  assert.equal(result.allUpstreamTestsPassed, false);
  assert.throws(
    () => controller.inspectNodeOriginalObservation(receipt, startup, "0"),
    /scoped exit was not observed/u,
  );
  for (const mutate of [
    (v: typeof receipt) => {
      v.elapsedSeconds = 7500;
    },
    (v: typeof receipt) => {
      v.ownedClientsAndContainersCleaned = false;
    },
    (v: typeof receipt) => {
      v.source.gitHead = "2".repeat(40);
    },
    (v: typeof receipt) => {
      v.executions[2]!.nativeState.ExitCode = 0;
    },
  ]) {
    const value = structuredClone(receipt);
    mutate(value);
    assert.throws(() =>
      controller.inspectNodeOriginalObservation(value, startup, "2"),
    );
  }
});
