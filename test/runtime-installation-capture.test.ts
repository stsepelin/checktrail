import assert from "node:assert/strict";
import { lstat, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

test("runtime installation capture uses fresh private receipts, restores environment on failure and refuses absent malformed oversized and linked evidence", async () => {
  const {
    withRuntimeInstallationCapture: capture,
    writeRuntimeInstallation: write,
  } = await import(
    new URL("../../scripts/runtime-installation-capture.mjs", import.meta.url)
      .href
  );
  const receiptName = "CHECKTRAIL_TASKS_INSTALL_RECEIPT",
    slotName = "CHECKTRAIL_TASKS_RUNTIME_SLOT";
  const previous = [process.env[receiptName], process.env[slotName]];
  process.env[receiptName] = "original inherited value";
  process.env[slotName] = "original inherited slot";
  let first = "";
  try {
    await capture(
      "tasks",
      { installed: false, slot: "original-selected-slot" },
      async ({ read }: { read(): Promise<unknown> }) => {
        first = process.env[receiptName]!;
        assert.equal(path.isAbsolute(first), true);
        assert.equal(path.basename(first), "installed.json");
        assert.equal(process.env[slotName], "original-selected-slot");
        if (process.platform !== "win32")
          assert.equal(
            Number((await lstat(path.dirname(first))).mode) & 0o077,
            0,
          );
        await assert.rejects(read(), { code: "ENOENT" });
        const packet = { original: "Unicode Καλημέρα", installed: true };
        assert.equal(await write("tasks", packet), true);
        assert.deepEqual(await read(), packet);
        await assert.rejects(write("tasks", packet), { code: "EEXIST" });
        await assert.rejects(
          write("tasks", { original: "x".repeat(4 * 1048576) }),
          /receipt byte bound/,
        );
        await assert.rejects(
          capture("tasks", { installed: false, slot: null }, async () => {}),
          /Concurrent runtime installation capture/,
        );
        for (const bytes of [
          Buffer.from("{"),
          Buffer.from("null"),
          Buffer.from("[]"),
          Buffer.from([
            0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d,
          ]),
          Buffer.from(JSON.stringify({ original: "x".repeat(4 * 1048576) })),
        ]) {
          await writeFile(first, bytes);
          await assert.rejects(read());
        }
        await rm(first);
        if (process.platform !== "win32") {
          const target = path.join(path.dirname(first), "original-target.json");
          await writeFile(target, JSON.stringify(packet));
          await symlink(target, first);
          await assert.rejects(read(), /must be regular/);
          assert.deepEqual(JSON.parse(await readFile(target, "utf8")), packet);
        }
      },
    );
    await assert.rejects(lstat(path.dirname(first)), { code: "ENOENT" });
    assert.equal(process.env[receiptName], "original inherited value");
    assert.equal(process.env[slotName], "original inherited slot");
    await assert.rejects(
      capture("tasks", { installed: false, slot: null }, async () => {
        assert.notEqual(process.env[receiptName], first);
        assert.equal(process.env[slotName], undefined);
        throw Error("original operation refusal");
      }),
      /original operation refusal/,
    );
    assert.equal(process.env[receiptName], "original inherited value");
    assert.equal(process.env[slotName], "original inherited slot");
    await capture(
      "tasks",
      { installed: true, slot: null },
      async ({ read }: { read(): Promise<unknown> }) => {
        assert.equal(process.env[receiptName], "original inherited value");
        assert.throws(() => read(), /Installed callback cannot create another/);
      },
    );
    delete process.env[receiptName];
    assert.equal(await write("tasks", { original: true }), false);
    await assert.rejects(
      capture(
        "tasks-adjacent",
        { installed: false, slot: null },
        async () => {},
      ),
      /Unknown runtime installation capture/,
    );
  } finally {
    for (const [index, name] of [receiptName, slotName].entries()) {
      const value = previous[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("source runtime admission binds retained installations to exact runtime engine harness and complete named cases", async () => {
  const { requireTasksRuntimeInstallation: requireTasks } = await import(
    new URL("../../scripts/tasks-runtime-evidence.mjs", import.meta.url).href
  );
  const { requireLifecycleRuntimeInstallation: requireLife } = await import(
    new URL("../../scripts/lifecycle-runtime-evidence.mjs", import.meta.url)
      .href
  );
  const rows = [{ name: "original first" }, { name: "original second" }];
  const complete = (required: typeof rows) => ({
    complete: true,
    required: required.length,
    passed: required.length,
    ledger: {
      truncated: false,
      cases: required.map((row) => ({ ...row, outcome: "passed" })),
    },
  });
  const runtime = {
    slot: null,
    platform: process.platform,
    node: process.versions.node,
    architecture: process.arch,
  };
  const engine = {
    schemaVersion: 1,
    fileCount: 2,
    bytes: 42,
    treeSha256: "c".repeat(64),
    manifestSha256: "d".repeat(64),
    beforeAfterByteIdentitiesMatch: true,
  };
  const source = {
    runtime,
    runtimeArtifactsSha256: engine.treeSha256,
    compiledEngine: engine,
    harnessSha256: "e".repeat(64),
    inputSources: [["original.js", "f".repeat(64)]],
  };
  const envelope = {
    schemaVersion: 1,
    offlineProductionInstall: true,
    lifecycleScriptsExecuted: false,
    harnessOutsideInstalledPackage: true,
    tarballSha256: "a".repeat(64),
    productionDependencyLockSha256: "b".repeat(64),
    harnessSha256: source.harnessSha256,
  };
  const foundations =
    process.platform === "win32"
      ? ["windows-process", "physical-process-output"]
      : ["posix-cleanup", "posix-owner"];
  const definitions = Object.fromEntries([
    ["lifecycle-platforms", rows],
    ...foundations.map((name, index) => [
      name,
      [{ name: "original foundation " + index }],
    ]),
  ]);
  const common = {
    ...source,
    installed: true,
    installedEvidence: null,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
    gateAComplete: false,
    gateATasksMatrixComplete: false,
  };
  const tasks = {
    ...envelope,
    profile: "tasks-runtime-foundation-installed-v1",
    evidence: {
      ...common,
      profile: "tasks-runtime-foundation-v1",
      profileEvidence: complete(rows),
    },
  };
  const life = {
    ...envelope,
    profile: "lifecycle-platforms-installed-v1",
    compiledEngine: engine,
    evidence: {
      ...common,
      ...complete(rows),
      profile: "lifecycle-platforms-runtime-v1",
      harnessInputsUnchanged: true,
      completionScope: "whole-profile-and-selected-platform-foundation",
      foundation: {
        ...complete(foundations.flatMap((name) => definitions[name]!)),
        profiles: foundations.map((profile) => ({
          profile,
          required: definitions[profile]!.length,
        })),
      },
    },
  };
  // These envelopes are metadata doubles. Native source/fresh callbacks remain
  // required separately; satisfying this unit does not qualify a platform.
  assert.equal(requireTasks(tasks, source, rows), tasks);
  assert.equal(requireLife(life, source, definitions), life);
  type Packet = ReturnType<typeof JSON.parse>;
  const commonMutations: Array<(packet: Packet) => void> = [
    (value) => {
      value.offlineProductionInstall = false;
    },
    (value) => {
      value.lifecycleScriptsExecuted = true;
    },
    (value) => {
      value.harnessOutsideInstalledPackage = false;
    },
    (value) => {
      value.tarballSha256 = "invalid";
    },
    (value) => {
      value.productionDependencyLockSha256 = "invalid";
    },
    (value) => {
      value.evidence.installed = false;
    },
    (value) => {
      value.evidence.installedEvidence = {};
    },
    (value) => {
      value.evidence.runtime.slot = "original-stale-slot";
    },
    (value) => {
      value.evidence.harnessSha256 = "0".repeat(64);
    },
    (value) => {
      value.evidence.inputSources[0][1] = "0".repeat(64);
    },
    (value) => {
      value.evidence.inferenceInvoked = true;
    },
  ];
  for (const [original, admit] of [
    [tasks, (value: Packet) => requireTasks(value, source, rows)],
    [life, (value: Packet) => requireLife(value, source, definitions)],
  ] as const) {
    for (const mutate of commonMutations) {
      const changed = structuredClone(original);
      mutate(changed);
      assert.throws(() => admit(changed));
    }
    for (const mutate of [
      (value: Packet) => {
        const p = value.evidence.profileEvidence ?? value.evidence;
        p.complete = false;
      },
      (value: Packet) => {
        const p = value.evidence.profileEvidence ?? value.evidence;
        p.ledger.cases.pop();
      },
      (value: Packet) => {
        const p = value.evidence.profileEvidence ?? value.evidence;
        p.ledger.cases[1].name = p.ledger.cases[0].name;
      },
      (value: Packet) => {
        const p = value.evidence.profileEvidence ?? value.evidence;
        p.ledger.cases[0].outcome = "skipped";
      },
      (value: Packet) => {
        const p = value.evidence.profileEvidence ?? value.evidence;
        p.ledger.truncated = true;
      },
    ]) {
      const changed = structuredClone(original);
      mutate(changed);
      assert.throws(() => admit(changed));
    }
  }
  for (const mutate of [
    (value: Packet) => {
      value.compiledEngine.treeSha256 = "0".repeat(64);
    },
    (value: Packet) => {
      value.evidence.compiledEngine.beforeAfterByteIdentitiesMatch = false;
    },
    (value: Packet) => {
      value.evidence.foundation.ledger.cases[0].outcome = "skipped";
    },
    (value: Packet) => {
      value.evidence.foundation.profiles.reverse();
    },
  ]) {
    const changed = structuredClone(life);
    mutate(changed);
    assert.throws(() => requireLife(changed, source, definitions));
  }
  const changed = structuredClone(tasks);
  changed.evidence.runtimeArtifactsSha256 = "0".repeat(64);
  assert.throws(() => requireTasks(changed, source, rows));
});
