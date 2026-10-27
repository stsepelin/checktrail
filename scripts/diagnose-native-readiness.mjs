// Diagnostic branch only. Original synthetic assertions run unchanged.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
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
const originalSource = "ee3b449c843caf6f5c18858aaf447eeaca7184dc";
const changed = execFileSync(
  "git",
  ["diff", "--name-only", originalSource + "...HEAD"],
  { cwd: root, encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean)
  .sort();
assert.deepEqual(changed, [
  ".github/workflows/ci.yml",
  "scripts/diagnose-native-readiness.mjs",
]);
assert.equal(process.versions.node, process.env.DIAGNOSTIC_NODE);
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
    id: "privacy",
    file: "dist/test/gate-lifecycle-platforms.test.js",
    name: "lifecycle-platforms privacy acceptance",
  },
  {
    id: "python",
    file: "dist/test/gate-context-python.test.js",
    name: "context-python lifecycle acceptance",
  },
  {
    id: "go",
    file: "dist/test/go-matrix.test.js",
    name: "native Go target matrices compile and link cross targets while retaining host tests and unavailable foreign execution",
  },
];
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
        timeout: 240000,
        maxBuffer: 4 * 1048576,
      },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    );
  });
  const output = result.stdout + result.stderr;
  const passed = !result.error && /^# pass 1$/m.test(output);
  const problem = output
    .split("\n")
    .findIndex((line) => /^not ok /m.test(line));
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
    failureExcerpt: passed
      ? null
      : output
          .split("\n")
          .slice(Math.max(0, problem), Math.max(0, problem) + 20)
          .join("\n")
          .slice(0, 2000),
  };
  results.push(row);
  process.stdout.write(JSON.stringify({ diagnosticProgress: row }) + "\n");
}
let restored;
try {
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
  const logger = `\nimport { appendFileSync as originalDiagnosticAppend, statSync as originalDiagnosticStat } from "node:fs";\nconst originalDiagnosticFile = ${JSON.stringify(traceFile)};\nexport function originalDiagnosticEvent(event) { try { if (originalDiagnosticStat(originalDiagnosticFile).size < 8 * 1048576) originalDiagnosticAppend(originalDiagnosticFile, JSON.stringify({pid:process.pid,node:process.versions.node,...event})+"\\n"); } catch {} }\nfunction originalDiagnosticError(error) { return {message:String(error?.message ?? error).slice(0,240),code:typeof error?.code === "string" ? error.code : null}; }\nexport async function processSnapshot(pid) { const start=performance.now();try { const rows=await originalDiagnosticProcessSnapshot(pid);if(performance.now()-start>100)originalDiagnosticEvent({operation:"snapshot",selected:pid===undefined?null:typeof pid==="number"?1:pid.length,elapsedMs:performance.now()-start,rows:rows.length});return rows;}catch(error){originalDiagnosticEvent({operation:"snapshot-error",selected:pid===undefined?null:typeof pid==="number"?1:pid.length,elapsedMs:performance.now()-start,...originalDiagnosticError(error)});throw error;} }\nexport async function stopDescendants(root,io,stopRoot) { const start=performance.now();try{return await originalDiagnosticStopDescendants(root,io,stopRoot);}catch(error){originalDiagnosticEvent({operation:"stop-descendants-error",elapsedMs:performance.now()-start,...originalDiagnosticError(error)});throw error;} }\n`;
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
  for (let wave = 1; wave <= 4; wave++)
    await Promise.all(cases.map((item) => run(item, "traced", wave)));
} finally {
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
      diagnostic: "original-native-readiness",
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
  results.length === 15 && results.every((row) => row.passed) ? 0 : 1;
