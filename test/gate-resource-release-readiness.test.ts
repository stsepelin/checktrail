import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertResourcePackageLayout,
  releaseToolsAvailable,
  resourcePrerequisiteControl,
  resourceMeasurementsAvailable,
  resourceRejectedControl,
  resourceFixedControl,
  resourceNearMissControl,
  resourcePrivacyControl,
  resourceLifecycleControl,
  resourceInstalledControl,
} from "./resource-release-fixture.js";
const native = {
  skip:
    !resourceMeasurementsAvailable &&
    "Selected native resource prerequisites unavailable",
  timeout: 300000,
};
test("resource-release-readiness broken acceptance", native, (t) =>
  resourceRejectedControl(t, "broken"),
);
test(
  "resource-release-readiness fixed acceptance",
  native,
  resourceFixedControl,
);
test(
  "resource-release-readiness prerequisite acceptance",
  {
    skip:
      !releaseToolsAvailable && "Pinned synthetic upgrade tools not prepared",
    // The offline install alone allows 180s, alongside independent tool-tree
    // corruption and cache controls. Preserve those individual command limits.
    timeout: process.platform === "win32" ? 300000 : 120000,
  },
  resourcePrerequisiteControl,
);
test("resource-release-readiness stale acceptance", native, (t) =>
  resourceRejectedControl(t, "stale"),
);
test("resource-release-readiness empty acceptance", native, (t) =>
  resourceRejectedControl(t, "empty"),
);

test(
  "resource-release-readiness near-miss acceptance",
  {
    skip:
      !releaseToolsAvailable && "Pinned synthetic upgrade tools not prepared",
    // Three offline installations and fresh CLI/library/MCP phases retain
    // their individual command ceilings within this platform observation bound.
    timeout: process.platform === "win32" ? 300000 : 180000,
  },
  resourceNearMissControl,
);
test(
  "resource-release-readiness privacy acceptance",
  { timeout: 180000 },
  resourcePrivacyControl,
);
test(
  "resource-release-readiness lifecycle acceptance",
  { timeout: 180000 },
  resourceLifecycleControl,
);
test(
  "resource-release-readiness installed acceptance",
  {
    skip:
      (!resourceMeasurementsAvailable || !releaseToolsAvailable) &&
      "Selected resource/upgrade prerequisites unavailable",
    timeout: 420000,
  },
  resourceInstalledControl,
);

test("resource package layout permits exactly the six product provenance scripts and rejects operator material and adjacent paths", () => {
  const productScripts = [
    "scripts/native-provenance-coordinator.mjs",
    "scripts/native-provenance-adapter.mjs",
    "scripts/native-provenance-audit-child.mjs",
    "scripts/audit-dependencies.mjs",
    "scripts/audit-selected-artifact-evidence.mjs",
    "scripts/pango-complete-text-binding.mjs",
  ];
  const files = [
    "dist/src/index.js",
    "dist/src/cli.js",
    "package.json",
    "README.md",
    "docs/scripts/usage.md",
    "docs/reports.md",
    ".checktrail.md",
    "test-guide.md",
    "scripts-guide.md",
    ...productScripts,
  ].map((path) => ({ path }));
  assert.doesNotThrow(() => assertResourcePackageLayout(files));
  assert.doesNotThrow(() => assertResourcePackageLayout([...files].reverse()));
  for (const path of [
    "scripts/operator-only.mjs",
    "scripts/native-provenance-coordinator.mjs.map",
    "scripts/native-provenance-coordinator-extra.mjs",
    "scripts/pango-complete-text-binding.mjs/extra",
    "scripts/nested/operator-only.mjs",
    "test/fixtures/.env",
    "reports/review.json",
    "research_notes/credentials.json",
    ".checktrail/credentials.json",
    ".checktrail/.env",
  ])
    assert.throws(
      () => assertResourcePackageLayout([...files, { path }]),
      (error: unknown) => {
        assert.ok(error instanceof assert.AssertionError);
        assert.ok(
          error.message.includes(`Unapproved resource package path: ${path}`),
        );
        return true;
      },
    );
  for (const path of [
    "./scripts/operator-only.mjs",
    "scripts/../operator-only.mjs",
    "scripts//operator-only.mjs",
    "scripts\\operator-only.mjs",
    "/scripts/operator-only.mjs",
    "C:scripts/operator-only.mjs",
  ])
    assert.throws(
      () => assertResourcePackageLayout([...files, { path }]),
      (error: unknown) => {
        assert.ok(error instanceof assert.AssertionError);
        assert.ok(
          error.message.includes(`Noncanonical resource package path: ${path}`),
        );
        return true;
      },
    );
  for (const path of productScripts)
    assert.throws(
      () =>
        assertResourcePackageLayout(files.filter((file) => file.path !== path)),
      /Resource package provenance script set differs/,
    );
  assert.throws(
    () => assertResourcePackageLayout([...files, { path: productScripts[0]! }]),
    /Resource package provenance script set differs/,
  );
  for (const path of ["dist/src/index.js", "dist/src/cli.js"])
    assert.throws(
      () =>
        assertResourcePackageLayout(files.filter((file) => file.path !== path)),
      (error: unknown) => {
        assert.ok(error instanceof assert.AssertionError);
        assert.ok(
          error.message.includes(`Missing resource package entry: ${path}`),
        );
        return true;
      },
    );
});
