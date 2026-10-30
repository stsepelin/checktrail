import { test } from "node:test";
import {
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
