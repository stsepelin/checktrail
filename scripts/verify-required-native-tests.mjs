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
// node:test applies this timeout to the whole selected file, not each callback.
const timeoutMs =
  profile === "dotnet-method"
    ? 600000
    : [
          "dotnet-build",
          "gradle",
          "detekt",
          "maven",
          "dotnet-test",
          "dotnet-format",
          "dotnet-generated",
          "review-benchmark-multi",
          "ruby-tools",
          "ruby-tools-rubocop",
          "ruby-tools-assertions",
          "ruby-tools-evidence",
          "ruby-tools-lifecycle",
          "ruby-tools-defaults",
          "ruby-tools-surfaces",
          "ruby-tools-cancellation",
          "swift-tools",
        ].includes(profile)
      ? 300000
      : 120000;
const report = await runRequiredTests(profiles[profile], { timeoutMs });
process.stdout.write(JSON.stringify({ profile, timeoutMs, ...report }) + "\n");
process.exitCode = report.complete ? 0 : 1;
