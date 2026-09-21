import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";
import { runRequiredTests } from "./required-test-evidence.mjs";
assert.equal(process.argv.length, 3, "Pass a required native test profile");
const profiles = JSON.parse(
  await readFile(
    new URL("./required-native-tests.json", import.meta.url),
    "utf8",
  ),
);
const profile = process.argv[2];
assert.ok(
  Object.hasOwn(profiles, profile),
  "Unknown required native test profile",
);
const report = await runRequiredTests(profiles[profile]);
process.stdout.write(JSON.stringify({ profile, ...report }) + "\n");
process.exitCode = report.complete ? 0 : 1;
