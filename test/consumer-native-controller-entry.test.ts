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
) {
  const root = await realpath(
      await fixture(t, {
        "scripts/verify-synthetic-controller.mjs": program,
        "run.mjs": `import{captureConsumerControllerEntry}from${JSON.stringify(helper)};const result=await captureConsumerControllerEntry(process.cwd(),{executable:process.execPath,args:['scripts/verify-synthetic-controller.mjs','original-argument']},process.cwd()+'/capture',${maximum});process.stdout.write(JSON.stringify(result)+'\\n');`,
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
