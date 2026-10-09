import { test } from "node:test";
import { hclBoundariesFixture } from "./review-hcl-boundaries-fixture.js";
test("context-hcl selected bindings guard acceptance", async (t) => {
  await hclBoundariesFixture(t);
});
