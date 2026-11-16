import { readFile } from "node:fs/promises";
import process from "node:process";
import assert from "node:assert/strict";
import { runBaselinePhase } from "./preserved-baseline-evidence.mjs";

assert.equal(process.argv.length, 3, "Worker requires one private input file");
const input = JSON.parse(await readFile(process.argv[2], "utf8"));
process.chdir(input.root);
process.stdout.write(JSON.stringify(await runBaselinePhase(input)) + "\n");
