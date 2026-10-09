import { test } from "node:test";
import { nameBoundariesFixture } from "./review-name-boundaries-fixture.js";
for (const [profile, version] of [
  ["c", 20],
  ["cpp", 21],
  ["hcl", 22],
] as const)
  test(
    "context-" + profile + " declaration name bounds acceptance",
    async (t) => {
      await nameBoundariesFixture(t, version);
    },
  );
