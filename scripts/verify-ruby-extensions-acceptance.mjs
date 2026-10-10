import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";
import { runRequiredTests } from "./required-test-evidence.mjs";
import { selectRubyExtensionAcceptance } from "./ruby-extensions-acceptance-selection.mjs";
const mode = process.argv[2],
  shard = process.argv[3] ?? "all";
assert.equal(process.argv.length, 3 + (process.argv[3] === undefined ? 0 : 1));
assert.equal(
  process.env.CHECKTRAIL_RUBY_EXTENSIONS_INSTALLED === "1",
  mode === "installed",
);
const requirements = JSON.parse(
  await readFile(
    new URL("./required-native-tests.json", import.meta.url),
    "utf8",
  ),
)["ruby-extensions"];
const selected = selectRubyExtensionAcceptance(requirements, mode, shard);
const result = await runRequiredTests(selected, {
  timeoutMs: 1200000,
  isolatedCaseWorkers: 1,
});
process.stdout.write(
  JSON.stringify({
    profile: "ruby-extensions",
    acceptanceMode: mode,
    acceptanceShard: shard,
    fullRequiredInventory: requirements,
    fullSelectedInventory: selectRubyExtensionAcceptance(
      requirements,
      mode,
      "all",
    ),
    timeoutMs: 1200000,
    ...result,
  }) + "\n",
);
process.exitCode = result.complete ? 0 : 1;
