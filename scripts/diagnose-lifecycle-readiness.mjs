// Diagnostic branch only. Do not merge this instrumentation or workflow.
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
const file = path.resolve("dist/test/lifecycle-platforms-fixture.js");
const trace =
  process.env.CHECKTRAIL_LIFECYCLE_DIAGNOSTIC_FILE ??
  (process.env.RUNNER_TEMP
    ? path.join(process.env.RUNNER_TEMP, "checktrail-ci145-phase.jsonl")
    : undefined);
assert.ok(trace && path.isAbsolute(trace));
const backup = trace + ".original";
const mode = process.argv[2];
assert.ok(["install", "finish"].includes(mode));
if (mode === "finish") {
  try {
    if (existsSync(trace)) process.stdout.write(readFileSync(trace));
  } finally {
    if (existsSync(backup)) {
      writeFileSync(file, readFileSync(backup));
      unlinkSync(backup);
    }
  }
} else {
  assert.equal(existsSync(backup), false);
  assert.equal(existsSync(trace), false);
  const original = readFileSync(file);
  let source = original.toString("utf8");
  const replace = (before, after) => {
    assert.equal(source.split(before).length, 2, "Exact diagnostic address");
    source = source.replace(before, after);
  };
  source =
    'import { appendFileSync as privateAppend } from "node:fs";\nconst privateTrace = value => privateAppend(' +
    JSON.stringify(trace) +
    ',JSON.stringify({...value,stage:process.env.CHECKTRAIL_LIFECYCLE_INSTALLED==="1"?"installed":"source"})+"\\n");\n' +
    source;
  replace(
    "const observe = async () => await lifecycleWait(async () => {",
    'const observe = async () => { const sequence=(globalThis.__privateLifecycleSequence??0)+1;globalThis.__privateLifecycleSequence=sequence;privateTrace({phase:"observe-start",sequence,at:Date.now()});try{const value=await lifecycleWait(async () => {',
  );
  replace(
    "    });\n    const identities =",
    '    });privateTrace({phase:"observe-ready",sequence,at:Date.now()});return value;}catch(error){privateTrace({phase:"observe-failed",sequence,at:Date.now(),code:error.code??null});throw error;}};\n    const identities =',
  );
  const caught = "    void running.catch(() => { });";
  replace(
    caught,
    caught +
      '\n    const privateSequence=(globalThis.__privateLifecycleSequence??0)+1;void running.then(value=>{const report=value?.structuredContent??value;privateTrace({phase:"execution-completed",sequence:privateSequence,at:Date.now(),outcome:report?.outcome??null,isError:value?.isError??null,checks:(report?.checks??[]).map(c=>({status:c.status,errorCodes:(c.processes??[]).map(p=>p.errorCode??null),timedOut:(c.processes??[]).map(p=>p.timedOut??false)}))});},error=>privateTrace({phase:"execution-rejected",sequence:privateSequence,at:Date.now(),code:error?.code??null}));',
  );
  writeFileSync(backup, original, { flag: "wx", mode: 0o600 });
  writeFileSync(trace, "", { flag: "wx", mode: 0o600 });
  writeFileSync(file, source);
  appendFileSync(
    trace,
    JSON.stringify({
      phase: "instrumentation-installed",
      sourceFilesChanged: false,
      assertionsChanged: false,
      deadlinesChanged: false,
    }) + "\n",
  );
}
