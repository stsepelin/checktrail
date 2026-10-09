import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";
import {
  runRequiredProfiles,
  runRequiredTests,
} from "./required-test-evidence.mjs";
assert.ok(
  process.argv.length >= 3,
  "Pass one or more required native test profiles",
);
const profiles = JSON.parse(
  await readFile(
    new URL("./required-native-tests.json", import.meta.url),
    "utf8",
  ),
);
const fullSuite = process.argv[2] === "--full-suite";
const selection = process.argv.slice(fullSuite ? 3 : 2);
assert.ok(
  selection.length > 0,
  "Pass one or more required native test profiles",
);
assert.equal(new Set(selection).size, selection.length, "Duplicate profile");
for (const profile of selection) {
  assert.ok(
    Object.hasOwn(profiles, profile),
    "Unknown required native test profile",
  );
}
// node:test applies this timeout to the whole selected file, not each callback.
const timeoutMs =
  fullSuite || selection.includes("dotnet-method")
    ? 600000
    : selection.some((profile) =>
          [
            "dotnet-build",
            "gradle",
            "detekt",
            "kotlin",
            "scala",
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
            "go-extensions",
            "assembly-nuxt",
          ].includes(profile),
        )
      ? 300000
      : 120000;
// Retain the single-profile report used by installed acceptance harnesses.
const additionalFiles = fullSuite
  ? (await readdir(new URL("../dist/test/", import.meta.url)))
      .filter((name) => name.endsWith(".test.js"))
      .map((name) => new URL(`../dist/test/${name}`, import.meta.url))
  : [];
assert.ok(
  !fullSuite || additionalFiles.length > 0,
  "Compiled full suite is empty",
);
const report =
  selection.length === 1 && !fullSuite
    ? {
        profile: selection[0],
        ...(await runRequiredTests(profiles[selection[0]], { timeoutMs })),
      }
    : await runRequiredProfiles(profiles, selection, {
        timeoutMs,
        additionalFiles,
      });
process.stdout.write(JSON.stringify({ timeoutMs, ...report }) + "\n");
process.exitCode = report.complete ? 0 : 1;
