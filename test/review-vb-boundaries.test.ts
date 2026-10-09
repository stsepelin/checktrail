import { test } from "node:test";
import { vbBoundariesFixture } from "./review-vb-boundaries-fixture.js";
test("context-vb selected bindings guard acceptance", async (t) => {
  await vbBoundariesFixture(t);
});
