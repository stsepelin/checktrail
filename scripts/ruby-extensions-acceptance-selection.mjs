import assert from "node:assert/strict";
export const rubyExtensionCaseNames = [
  "broken",
  "fixed",
  "near-miss",
  "prerequisite",
  "stale",
  "empty",
  "privacy",
  "lifecycle",
  "installed",
].map((kind) => `ruby-extensions ${kind} acceptance`);
export function selectRubyExtensionAcceptance(requirements, mode, shard) {
  assert.ok(["source", "installed"].includes(mode));
  assert.ok(["all", "1", "2", "3"].includes(shard));
  assert.equal(requirements.length, rubyExtensionCaseNames.length);
  assert.equal(
    new Set(requirements.map((item) => item.name)).size,
    requirements.length,
  );
  assert.deepEqual(
    requirements.map((item) => item.name),
    rubyExtensionCaseNames,
  );
  assert.ok(
    requirements.every(
      (item) => item.file === "dist/test/gate-ruby-extensions.test.js",
    ),
  );
  const selected = requirements.filter(
    (item, index) =>
      (mode === "installed" ||
        item.name !== "ruby-extensions installed acceptance") &&
      (shard === "all" || index % 3 === Number(shard) - 1),
  );
  assert.ok(selected.length > 0);
  return selected;
}
