import assert from "node:assert/strict";
import { test } from "node:test";
import { item } from "@synthetic/catalog-domain";

test("the installed package serializes a numeric quantity", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(item(2))), { quantity: 2 });
});
