import { test } from "node:test";
import { yamlBoundariesFixture } from "./review-yaml-boundaries-fixture.js";
test("context-yaml selected bindings guard acceptance", async (t) => {
  await yamlBoundariesFixture(t);
});
