import { test } from "node:test";
import { cppBoundariesFixture } from "./review-cpp-boundaries-fixture.js";
test("context-cpp selected bindings guard acceptance", async (t) => {
  await cppBoundariesFixture(t);
});
