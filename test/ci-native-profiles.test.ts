import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
test("CI parallel .NET and Ruby matrices retain every original acceptance command and required callback exactly once", async () => {
  const root = new URL("../../", import.meta.url);
  const ci = parse(
    await readFile(new URL(".github/workflows/ci.yml", root), "utf8"),
  );
  const profiles = JSON.parse(
    await readFile(new URL("scripts/required-native-tests.json", root), "utf8"),
  );
  assert.equal(ci.jobs.dotnet.strategy["fail-fast"], false);
  assert.deepEqual(
    ci.jobs.dotnet.strategy.matrix.include.map(
      (entry: { script: string }) => entry.script,
    ),
    [
      "verify-dotnet-container.mjs",
      "verify-dotnet-build-container.mjs",
      "verify-dotnet-test-container.mjs",
      "verify-dotnet-format-container.mjs",
      "verify-dotnet-generated-container.mjs",
      "verify-dotnet-method-container.mjs",
    ],
  );
  const ruby = ci.jobs["ruby-tools"];
  assert.equal(ruby.strategy["fail-fast"], false);
  assert.equal(ruby.env.CHECKTRAIL_RUBY_TOOLS_PROFILE, "${{ matrix.profile }}");
  const members = ruby.strategy.matrix.profile as string[];
  assert.equal(new Set(members).size, members.length);
  const key = (entry: { file: string; name: string }) =>
    JSON.stringify([entry.file, entry.name]);
  const split = members.flatMap((member) => profiles[member].map(key));
  assert.equal(new Set(split).size, split.length);
  assert.deepEqual(
    split.toSorted(),
    profiles["ruby-tools"].map(key).toSorted(),
  );
  for (const step of [
    "verify-ruby-tools-container.mjs",
    "verify-ruby-tools-package.mjs",
  ]) {
    const code = await readFile(new URL("scripts/" + step, root), "utf8");
    assert.ok(code.includes("CHECKTRAIL_RUBY_TOOLS_PROFILE"));
    for (const member of members) assert.ok(code.includes('"' + member + '"'));
  }
});
