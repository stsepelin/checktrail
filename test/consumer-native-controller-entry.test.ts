import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { fixture } from "./helpers.js";
import { ensureWindowsTaskAccess } from "../src/windows-task-access.js";
const helper = new URL(
  "../../scripts/consumer-native-controller-entry.mjs",
  import.meta.url,
).href;
const hash = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
async function run(
  t: Parameters<typeof fixture>[0],
  program: string,
  maximum = 65536,
  file = "scripts/verify-consumer-runtime-arm64.mjs",
) {
  const root = await realpath(
      await fixture(t, {
        [file]: program,
        "run.mjs": `import{captureConsumerControllerEntry}from${JSON.stringify(helper)};const result=await captureConsumerControllerEntry(process.cwd(),{executable:process.execPath,args:[${JSON.stringify(file)},'original-argument']},process.cwd()+'/capture',${maximum});process.stdout.write(JSON.stringify(result)+'\\n');`,
      }),
    ),
    directory = path.join(root, "capture");
  await mkdir(directory, { mode: 0o700 });
  if (process.platform === "win32")
    ensureWindowsTaskAccess(directory, "directory", true);
  const result = spawnSync(process.execPath, [path.join(root, "run.mjs")], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 1048576,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return { root, directory, result, record: JSON.parse(result.stdout) };
}
test("fixed controller capture retains exact actual writes privately preserves argv callbacks and records module completion without inventing a process exit", async (t) => {
  const f = await run(
    t,
    "import assert from'node:assert/strict';assert.equal(process.argv[2],'original-argument');await new Promise(resolve=>process.stdout.write(Buffer.from('original-synthetic-private-output\\n'),resolve));process.stderr.write('original-synthetic-private-diagnostic\\n');",
  );
  assert.equal(f.record.complete, true);
  assert.equal(f.record.moduleCompleted, true);
  assert.equal(f.record.processExitObserved, false);
  assert.equal(f.record.nativeProcessStartAcknowledgementRetained, false);
  assert.equal(f.record.gateAComplete, false);
  assert.equal(
    f.result.stdout.includes("original-synthetic-private-output"),
    false,
  );
  for (const [stream, expected] of [
    ["stdout", "original-synthetic-private-output\n"],
    ["stderr", "original-synthetic-private-diagnostic\n"],
  ] as const) {
    const bytes = await readFile(f.record[stream].path);
    assert.equal(bytes.toString("utf8"), expected);
    assert.equal(f.record[stream].bytes, bytes.length);
    assert.equal(f.record[stream].observedBytes, bytes.length);
    assert.equal(f.record[stream].sha256, hash(bytes));
  }
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(f.directory, "controller-terminal.json"),
        "utf8",
      ),
    ).complete,
    true,
  );
});
test("fixed controller original errors explicit exits and nonzero requested exit codes retain prior bytes and cannot produce a qualifying terminal", async (t) => {
  for (const statement of [
    "throw Error('original-synthetic-controller-refusal');",
    "process.exit(0);",
    "process.exitCode=7;",
  ]) {
    const f = await run(
      t,
      "process.stdout.write('original-retained-prefix');" + statement,
    );
    assert.equal(f.record.complete, false);
    assert.equal(
      (await readFile(f.record.stdout.path)).toString("utf8"),
      "original-retained-prefix",
    );
    assert.equal(f.record.processExitObserved, false);
    if (statement.startsWith("throw"))
      assert.match(f.record.error, /original-synthetic-controller-refusal/);
    if (statement.startsWith("process.exit(")) {
      assert.equal(f.record.exitRequested, 0);
      assert.equal(f.record.moduleCompleted, false);
    }
    if (statement.includes("exitCode"))
      assert.equal(f.record.exitCodeRequested, 7);
  }
});
test("fixed controller output exhaustion stays sticky after a source catch and preserves only the actual bounded prefix", async (t) => {
  const f = await run(
    t,
    "try{process.stdout.write(Buffer.alloc(100,97));}catch{}",
    64,
  );
  assert.equal(f.record.moduleCompleted, true);
  assert.equal(f.record.complete, false);
  assert.equal(f.record.truncated, true);
  assert.match(f.record.captureError, /byte bound/);
  assert.equal(f.record.stdout.observedBytes, 100);
  assert.equal(f.record.stdout.bytes, 64);
  assert.deepEqual(await readFile(f.record.stdout.path), Buffer.alloc(64, 97));
});

test("native failure diagnostics retain bounded source-relative locations and controller status without raw native messages", async () => {
  const { consumerNativeFailureDiagnostic } = await import(helper);
  const root = path.resolve("/synthetic/operator"),
    secret = "synthetic-private-source-and-output";
  const error = Object.assign(new Error(secret), { code: "ERR_ASSERTION" });
  error.stack =
    secret +
    "\n    at check (" +
    path.join(root, "scripts/verify-synthetic-controller.mjs") +
    ":12:3)\n    at native (/outside/private-root/secret.js:1:2)";
  const diagnostic = consumerNativeFailureDiagnostic({
    stage: "controller-result",
    scopeId: "consumer-impact:ci-macos-node22",
    attemptId: "11111111-1111-4111-8111-111111111111",
    error,
    entry: {
      complete: false,
      moduleCompleted: false,
      error: error.stack,
      captureError: null,
      exitRequested: null,
      exitCodeRequested: 1,
      truncated: false,
      stdout: { bytes: 0 },
      stderr: { bytes: 1024 },
    },
    repository: root,
  });
  assert.equal(diagnostic.profile, "native-consumer-incomplete-diagnostic-v1");
  assert.equal(diagnostic.stage, "controller-result");
  assert.equal(diagnostic.errorCode, "ERR_ASSERTION");
  assert.deepEqual(diagnostic.errorLocations, [
    { file: "scripts/verify-synthetic-controller.mjs", line: 12, column: 3 },
  ]);
  assert.equal(diagnostic.controller.stderrBytes, 1024);
  assert.equal(diagnostic.controller.captureErrorPresent, false);
  for (const key of [
    "sourceOrRawOutputIncluded",
    "qualifiesNativeAcceptance",
    "gateAComplete",
  ])
    assert.equal(diagnostic[key], false);
  const raw = JSON.stringify(diagnostic);
  for (const hidden of [secret, root, "outside", "private-root"])
    assert.equal(raw.includes(hidden), false, hidden);
});
test("native diagnostic projection refuses arbitrary stages identifiers codes paths and nested private output", async () => {
  const { consumerNativeFailureDiagnostic } = await import(helper);
  const root = path.resolve("/synthetic/operator");
  const error = {
    name: "PrivateClass",
    code: "PRIVATE_CODE",
    message: "do-not-publish",
    stack:
      "do-not-publish\n    at x (" +
      path.join(root, "../other/scripts/private.mjs") +
      ":1:1)\n    at x (" +
      path.join(root, "scripts/../private.mjs") +
      ":1:1)\n    at x (" +
      path.join(root, "scripts/sentinel with spaces.mjs") +
      ":1:1)",
  };
  const result = consumerNativeFailureDiagnostic({
    stage: "private-stage",
    scopeId: "private/source:secret",
    attemptId: "secret",
    error,
    entry: {
      error: "source-do-not-publish",
      stdout: { bytes: "source-do-not-publish" },
    },
    repository: root,
  });
  assert.equal(result.stage, "unknown");
  assert.equal(result.scope, null);
  assert.equal(result.attemptId, null);
  assert.equal(result.errorName, "other");
  assert.equal(result.errorCode, null);
  assert.deepEqual(result.errorLocations, []);
  assert.equal(result.controller.stdoutBytes, null);
  assert.equal(result.controller.moduleCompleted, null);
  assert.equal(result.controller.captureErrorPresent, null);
  assert.equal(JSON.stringify(result).includes("do-not-publish"), false);
});
test("native diagnostic stack and frame ceilings remain bounded and diagnostic getters cannot replace a failure", async () => {
  const { consumerNativeFailureDiagnostic } = await import(helper),
    root = path.resolve("/synthetic/operator");
  const stack =
    "private-message\n" +
    Array.from(
      { length: 100 },
      (_, i) =>
        "    at check (" +
        path.join(root, "scripts/module-" + i + ".mjs") +
        ":" +
        (i + 1) +
        ":2)",
    ).join("\n");
  const result = consumerNativeFailureDiagnostic({
    stage: "normalize-capsule",
    scopeId: "consumer-impact:ci-macos-node22",
    attemptId: "11111111-1111-4111-8111-111111111111",
    error: { name: "Error", stack },
    entry: null,
    repository: root,
  });
  assert.equal(result.errorLocations.length, 8);
  assert.equal(Buffer.byteLength(JSON.stringify(result)) < 4096, true);
  const broken = Object.defineProperty({}, "stack", {
    get() {
      throw Error("private getter failure");
    },
  });
  const safe = consumerNativeFailureDiagnostic({
    stage: "normalize-capsule",
    error: broken,
    repository: root,
  });
  assert.deepEqual(safe.errorLocations, []);
  assert.equal(JSON.stringify(safe).includes("getter failure"), false);
});

test("failure diagnostics cannot become a successful native capsule even with a valid local transport envelope", async () => {
  const { consumerNativeFailureDiagnostic } = await import(helper);
  const { validateConsumerNativeCapsule } = await import(
    new URL(
      "../../scripts/consumer-native-acceptance-capsule.mjs",
      import.meta.url,
    ).href
  );
  const diagnostic = consumerNativeFailureDiagnostic({
    stage: "normalize-capsule",
    scopeId: "consumer-impact:ci-macos-node22",
    attemptId: "11111111-1111-4111-8111-111111111111",
    error: Error("synthetic failure"),
    repository: path.resolve("/synthetic/operator"),
    sourceBeforeSha256: "a".repeat(64),
  });
  assert.equal(diagnostic.sourceBeforeSha256, "a".repeat(64));
  assert.throws(
    () =>
      validateConsumerNativeCapsule(
        {
          ...diagnostic,
          ci: {
            kind: "local-operator-metadata",
            runId: null,
            runAttempt: null,
            job: null,
            metadataAttested: false,
          },
        },
        {},
        {},
      ),
    /native-consumer-scope-capsule-v1/,
  );
});
test("native diagnostic limits refuse late oversized or excessive stack candidates instead of leaking a private tail", async () => {
  const { consumerNativeFailureDiagnostic } = await import(helper),
    root = path.resolve("/synthetic/operator");
  const good =
    "    at check (" +
    path.join(root, "scripts/verify-synthetic-controller.mjs") +
    ":1:2)";
  for (const stack of [
    "x".repeat(32768) + "\n" + good,
    Array.from(
      { length: 64 },
      () => "    at outside (/foreign/private.mjs:1:2)",
    ).join("\n") +
      "\n" +
      good,
    "    at " +
      "x".repeat(4096) +
      " (" +
      path.join(root, "scripts/verify-synthetic-controller.mjs") +
      ":1:2)",
  ]) {
    const diagnostic = consumerNativeFailureDiagnostic({
      stage: "controller-result",
      error: { name: "Error", stack },
      repository: root,
      sourceBeforeSha256: "a".repeat(65),
    });
    assert.deepEqual(diagnostic.errorLocations, []);
    assert.equal(diagnostic.sourceBeforeSha256, null);
  }
});

test("fixed controller capture admits every exact mapped filename including the ARM64 runtime without broadening its native authority", async (t) => {
  const { consumerNativeProfiles, consumerNativeEntrypoint } = await import(
    new URL("../../scripts/consumer-native-entrypoints.mjs", import.meta.url)
      .href
  );
  const files = new Set<string>(
    consumerNativeProfiles
      .map(
        (profile: string) =>
          consumerNativeEntrypoint(profile, "native-linux-arm64-node22")[0],
      )
      .concat(
        consumerNativeEntrypoint("consumer-impact", "ci-linux-node22")[0],
      ),
  );
  assert.ok(files.has("scripts/verify-consumer-runtime-arm64.mjs"));
  assert.ok(files.has("scripts/verify-consumer-runtime.mjs"));
  for (const file of files) {
    const current = await run(
      t,
      "process.stdout.write('original-mapped-synthetic-controller');",
      65536,
      file,
    );
    assert.equal(current.record.complete, true, file);
    assert.equal(
      (await readFile(current.record.stdout.path)).toString(),
      "original-mapped-synthetic-controller",
    );
    assert.equal(current.record.processExitObserved, false);
  }
});

test("fixed controller capture refuses unmapped adjacent and noncanonical filenames before opening outputs or loading a module", async (t) => {
  const names = [
    "scripts/verify-unmapped-controller.mjs",
    "scripts/verify-consumer-runtime-arm65.mjs",
    "scripts/verify-consumer-runtime-arm64x.mjs",
    "scripts/verify-consumer-runtime-arm64.mjs-extra",
    "scripts/prefix-verify-consumer-runtime-arm64.mjs",
    "scripts/./verify-consumer-runtime-arm64.mjs",
    "scripts/other/../verify-consumer-runtime-arm64.mjs",
    "scripts\\verify-consumer-runtime-arm64.mjs",
    "/scripts/verify-consumer-runtime-arm64.mjs",
    "scripts/../scripts/verify-consumer-runtime-arm64.mjs",
  ];
  const root = await realpath(
    await fixture(t, {
      "scripts/verify-unmapped-controller.mjs":
        "import{writeFileSync}from'node:fs';writeFileSync('module-started','must-not-run');",
      "run.mjs": `import assert from'node:assert/strict';import{readdir,access}from'node:fs/promises';import{captureConsumerControllerEntry}from${JSON.stringify(helper)};for(const file of ${JSON.stringify(names)}){await assert.rejects(()=>captureConsumerControllerEntry(process.cwd(),{executable:process.execPath,args:[file]},process.cwd()+'/capture'),/Selected fixed native controller/);assert.deepEqual(await readdir('capture'),[]);}await assert.rejects(access('module-started'),{code:'ENOENT'});`,
    }),
  );
  const directory = path.join(root, "capture");
  await mkdir(directory, { mode: 0o700 });
  if (process.platform === "win32")
    ensureWindowsTaskAccess(directory, "directory", true);
  const result = spawnSync(process.execPath, [path.join(root, "run.mjs")], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 1048576,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
