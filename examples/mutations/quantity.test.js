import { test } from "node:test";
import assert from "node:assert/strict";
import { combine } from "./quantity.js";

test("combines two integer quantities", () => {
  assert.equal(combine(4, 7), 11);
});
