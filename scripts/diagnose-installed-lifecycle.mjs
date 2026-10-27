// Diagnostic branch only. Original synthetic assertions run unchanged.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath, URL } from "node:url";
import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const originalSource = "c24eb8889e41dcf0f39d5e11d0bb07c1b0577776";
assert.equal(process.versions.node, "24.21.0");
const temporary = await mkdtemp(
  path.join(os.tmpdir(), "original-readiness-diagnostic-"),
);
const traceFile = path.join(temporary, "events.jsonl");
await writeFile(traceFile, "", { flag: "wx", mode: 0o600 });
const engine = await captureCompiledEngine(path.join(root, "dist/src"));
const originals = new Map();
async function patch(file, from, to) {
  const absolute = path.join(root, file);
  const bytes = await readFile(absolute);
  if (!originals.has(file)) originals.set(file, bytes);
  const text = bytes.toString("utf8");
  assert.equal(
    text.split(from).length,
    2,
    "Diagnostic anchor differs: " + file,
  );
  await writeFile(absolute, text.replace(from, to));
}
const cases = [
  {
    id: "installed",
    file: "dist/test/gate-lifecycle-platforms.test.js",
    name: "lifecycle-platforms installed acceptance",
  },
];
const cpuChildren = [],
  cpuExits = [];
const results = [];
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
async function run(item, phase, wave) {
  const started = performance.now();
  const pattern = "^" + item.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
  const result = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        "--test",
        "--test-reporter=tap",
        "--test-name-pattern=" + pattern,
        item.file,
      ],
      {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 330000,
        maxBuffer: 4 * 1048576,
      },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    );
  });
  const output = result.stdout + result.stderr;
  const passed = !result.error && /^# pass 1$/m.test(output);
  const row = {
    phase,
    wave,
    case: item.id,
    originalName: item.name,
    passed,
    exitCode: result.error?.code ?? 0,
    elapsedMs: performance.now() - started,
    readinessFailure: output.includes(
      "Original lifecycle body readiness was not observed",
    ),
    cleanupUnavailable: output.includes("PROCESS_TREE_CLEANUP_UNAVAILABLE"),
    failureExcerpt: passed ? null : output.slice(-10000),
  };
  results.push(row);
  process.stdout.write(JSON.stringify({ diagnosticProgress: row }) + "\n");
}
let restored;
try {
  await patch(
    "scripts/verify-lifecycle-platforms-package.mjs",
    "assert.equal(result.status, 0, (result.stdout + result.stderr).slice(-6000));",
    "let originalProblemSummary;try{originalProblemSummary=JSON.stringify(JSON.parse(result.stdout).problems);}catch{originalProblemSummary=(result.stdout+result.stderr).slice(-6000);}assert.equal(result.status,0,originalProblemSummary);",
  );
  for (let index = 0; index < 3; index++) {
    const child = spawn(
      process.execPath,
      ["-e", "process.send('ready');for(;;){}"],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    cpuChildren.push(child);
    const completed = once(child, "exit");
    void completed.catch(() => {});
    cpuExits.push(completed);
    const [ready] = await once(child, "message", {
      signal: globalThis.AbortSignal.timeout(20000),
    });
    assert.equal(ready, "ready");
  }
  for (const item of cases) await run(item, "unmodified", 0);
  const tree = "dist/src/process-tree.js";
  await patch(
    tree,
    "export async function processSnapshot(pid)",
    "async function originalDiagnosticProcessSnapshot(pid)",
  );
  await patch(
    tree,
    "export async function stopDescendants(root, io = nativeControl, stopRoot)",
    "async function originalDiagnosticStopDescendants(root, io = nativeControl, stopRoot)",
  );
  await patch(
    tree,
    "export function linuxProcessIdentity(pid, text)",
    "function originalDiagnosticLinuxIdentity(pid, text)",
  );
  const logger = String.raw`
import { appendFileSync as originalDiagnosticAppend, statSync as originalDiagnosticStat } from "node:fs";
const originalDiagnosticFile = ${JSON.stringify(traceFile)};
let originalNativeSnapshotDepth = 0;
export function originalDiagnosticEvent(event) {
  try {
    if (originalDiagnosticStat(originalDiagnosticFile).size < 8 * 1048576)
      originalDiagnosticAppend(originalDiagnosticFile, JSON.stringify({pid:process.pid,node:process.versions.node,...event})+"\n");
  } catch {}
}
function originalDiagnosticError(error) {
  return {message:String(error?.message ?? error).slice(0,240),code:typeof error?.code === "string" ? error.code : null};
}
export async function processSnapshot(pid) {
  const start=performance.now(); originalNativeSnapshotDepth++;
  try {
    const rows=await originalDiagnosticProcessSnapshot(pid);
    if(performance.now()-start>100)originalDiagnosticEvent({operation:"snapshot",selected:pid===undefined?null:typeof pid==="number"?1:pid.length,elapsedMs:performance.now()-start,rows:rows.length});
    return rows;
  } catch(error) {
    originalDiagnosticEvent({operation:"snapshot-error",selected:pid===undefined?null:typeof pid==="number"?1:pid.length,elapsedMs:performance.now()-start,...originalDiagnosticError(error)});
    throw error;
  } finally { originalNativeSnapshotDepth--; }
}
export async function stopDescendants(root,io,stopRoot) {
  const start=performance.now();
  try { return await originalDiagnosticStopDescendants(root,io,stopRoot); }
  catch(error) {
    if(io===undefined)originalDiagnosticEvent({operation:"stop-descendants-error",root,elapsedMs:performance.now()-start,...originalDiagnosticError(error)});
    throw error;
  }
}
export function linuxProcessIdentity(pid,text) {
  try { return originalDiagnosticLinuxIdentity(pid,text); }
  catch(error) {
    if(originalNativeSnapshotDepth>0) {
      const f=text.slice(text.lastIndexOf(") ")+2).trim().split(/\s+/);
      let presence="present";
      try { process.kill(pid,0); } catch(check) { presence=check.code??"unknown"; }
      originalDiagnosticEvent({operation:"native-linux-stat-error",targetPid:pid,state:f[0],parent:f[1],group:f[2],session:f[3],start:f[19],presence,message:String(error.message)});
    }
    throw error;
  }
}
`;
  const treeFile = path.join(root, tree);
  await writeFile(treeFile, (await readFile(treeFile, "utf8")) + logger);
  for (const file of [
    "dist/src/posix-owner.js",
    "dist/src/posix-owner-keeper.js",
    "dist/src/posix-target.js",
  ]) {
    const text = await readFile(path.join(root, file), "utf8");
    const matches = [
      ...text.matchAll(/import \{([^}]+)\} from "\.\/process-tree\.js";/g),
    ];
    assert.equal(matches.length, 1);
    await patch(
      file,
      matches[0][0],
      matches[0][0].replace("{", "{ originalDiagnosticEvent,"),
    );
  }
  await patch(
    "dist/src/posix-owner.js",
    ').catch(() => {\n                failure = "PROCESS_TREE_CLEANUP_UNAVAILABLE";',
    ').catch((error) => {\n                originalDiagnosticEvent({operation:"owner-stop-error",message:String(error?.message ?? error).slice(0,240)});\n                failure = "PROCESS_TREE_CLEANUP_UNAVAILABLE";',
  );
  await patch(
    "dist/src/posix-owner-keeper.js",
    'catch {\n        if (result)\n            result.errorCode = "PROCESS_TREE_CLEANUP_UNAVAILABLE";',
    'catch (error) {\n        originalDiagnosticEvent({operation:"keeper-complete-error",message:String(error?.message ?? error).slice(0,240)});\n        if (result)\n            result.errorCode = "PROCESS_TREE_CLEANUP_UNAVAILABLE";',
  );
  const targetText = await readFile(
    path.join(root, "dist/src/posix-target.js"),
    "utf8",
  );
  const targetCatches = [
    ...targetText.matchAll(
      /catch \{(\s+)result.errorCode = "PROCESS_TREE_CLEANUP_UNAVAILABLE";/g,
    ),
  ];
  assert.equal(targetCatches.length, 1);
  await patch(
    "dist/src/posix-target.js",
    targetCatches[0][0],
    targetCatches[0][0].replace(
      "catch {",
      'catch (error) { originalDiagnosticEvent({operation:"target-terminate-error",message:String(error?.message ?? error).slice(0,240)});',
    ),
  );
  const fixture = "dist/test/lifecycle-platforms-fixture.js";
  await patch(
    fixture,
    "    void running.catch(() => { });",
    '    void running.catch(() => { });\n    let originalReadinessTerminal = {state:"pending"};\n    void running.then(value => { const report=value?.structuredContent ?? value;originalReadinessTerminal={state:"fulfilled",outcome:report?.outcome,isError:value?.isError,checks:report?.checks?.map(check=>({status:check.status,reason:check.reason,executionError:check.execution?.errorCode}))}; }, error => { originalReadinessTerminal={state:"rejected",message:String(error?.message ?? error).slice(0,240)}; });',
  );
  await patch(
    fixture,
    "        const reached = await project.observe();",
    '        const reached = await project.observe().catch(error => { process.stderr.write(JSON.stringify({originalReadinessTerminal})+"\\n");throw error; });',
  );
  for (const file of originals.keys())
    execFileSync(process.execPath, ["--check", path.join(root, file)]);
  for (let wave = 1; wave <= 2; wave++)
    await Promise.all([
      run(cases[0], "traced-a", wave),
      run(cases[0], "traced-b", wave),
    ]);
} finally {
  for (const child of cpuChildren)
    if (child.exitCode === null && child.signalCode === null) child.kill();
  await Promise.all(cpuExits);
  for (const [file, bytes] of originals)
    await writeFile(path.join(root, file), bytes);
  for (const [file, bytes] of originals)
    assert.deepEqual(await readFile(path.join(root, file)), bytes);
  requireUnchangedCompiledEngine(
    engine,
    await captureCompiledEngine(path.join(root, "dist/src")),
  );
  restored = true;
  const events = (await readFile(traceFile, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const errors = events.filter((event) => event.operation.endsWith("error"));
  const slow = events.filter((event) => event.operation === "snapshot");
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      diagnostic: "original-installed-lifecycle",
      unrelatedCpuWorkers: 3,
      failurePresentationAdjusted: true,
      nativeQualificationAssessed: false,
      originalSource,
      platform: process.platform,
      architecture: process.arch,
      node: process.versions.node,
      osRelease: os.release(),
      configuredImageOS: process.env.ImageOS ?? null,
      configuredImageVersion: process.env.ImageVersion ?? null,
      originalAssertionsUnchanged: true,
      compiledInputsRestored: restored,
      originalEngineSha256: engine.treeSha256,
      results,
      nativeErrors: errors.slice(0, 200),
      nativeErrorsTruncated: errors.length > 200,
      slowSnapshots: slow.length,
      maximumSlowSnapshotMs: slow.length
        ? Math.max(...slow.map((event) => event.elapsedMs))
        : null,
      originalReadinessTerminalDetailsInFailedCaseOutputOnly: true,
      confirmedCause: null,
      selectedRuntimeQualified: false,
      gateAComplete: false,
      inferenceInvoked: false,
      fieldEvaluationExecuted: false,
    }) + "\n",
  );
  await rm(temporary, { recursive: true, force: true });
}
assert.equal(restored, true);
process.exitCode =
  results.length === 5 && results.every((row) => row.passed) ? 0 : 1;
