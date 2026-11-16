import { readFile } from "node:fs/promises";
import process from "node:process";
import assert from "node:assert/strict";
import {
  runBaselinePhase,
  runFreshBaselineFromSourceCapture,
} from "./preserved-baseline-evidence.mjs";

assert.equal(process.argv.length, 3, "Worker requires one private input file");
const input = JSON.parse(await readFile(process.argv[2], "utf8"));
process.chdir(input.root);
assert.ok(
  input.mode === undefined || input.mode === "fresh-from-original-source",
  "Unknown preserved baseline worker mode",
);
assert.ok(
  input.mode !== undefined || input.sourceCapture === undefined,
  "A source capture requires explicit reuse admission",
);
const report =
  input.mode === "fresh-from-original-source"
    ? await runFreshBaselineFromSourceCapture(input)
    : await runBaselinePhase(input);
process.stdout.write(JSON.stringify(report) + "\n");
