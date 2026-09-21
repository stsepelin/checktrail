import { test } from "node:test";
import assert from "node:assert/strict";
import { sum } from "./sum.js";

test("adds signed integers", () => {
  assert.equal(sum(2, 3), 5);
  assert.equal(sum(-2, 3), 1);
  assert.equal(sum(0, 0), 0);
});
