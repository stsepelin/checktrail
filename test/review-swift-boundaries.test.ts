import { test } from "node:test";
import { swiftBoundariesFixture } from "./review-swift-boundaries-fixture.js";
test(
  "context-swift selected bindings guard acceptance",
  swiftBoundariesFixture,
);
