import { test } from "node:test";
import { cBoundariesFixture } from "./review-c-boundaries-fixture.js";
test("context-c selected bindings guard acceptance", async (t) => {
  await cBoundariesFixture(t);
});
