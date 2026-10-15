import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, realpath, symlink, readlink } from "node:fs/promises";
import path from "node:path";
import {
  mutationBoundedBytes,
  mutationDependencies,
  writeMutationCopy,
} from "../src/mutation-native-copy.js";
import { fixture } from "./helpers.js";
test("physical mutation snapshots enforce byte limits, preserve the selected tool cohort and relocate contained links", async (t) => {
  const root = await realpath(
    await fixture(t, {
      "subject.js": "original source",
      "node_modules/original/index.js": "original tool",
    }),
  );
  assert.equal(
    (await mutationBoundedBytes(root, "subject.js", 15)).toString(),
    "original source",
  );
  await assert.rejects(
    mutationBoundedBytes(root, "subject.js", 14),
    /byte bound/,
  );
  await assert.rejects(
    mutationBoundedBytes(root, "node_modules", 100),
    /byte bound/,
  );
  await symlink("original/index.js", path.join(root, "node_modules/alias.js"));
  const dependencies = await mutationDependencies(
      root,
      "node_modules",
      () => true,
    ),
    copy = await realpath(await fixture(t, {}));
  await writeMutationCopy(
    copy,
    new Map([["subject.js", Buffer.from("original source")]]),
    dependencies,
    () => true,
    { file: "subject.js", text: "original changed copy" },
  );
  assert.equal(
    await readFile(path.join(root, "subject.js"), "utf8"),
    "original source",
  );
  assert.equal(
    await readFile(path.join(copy, "subject.js"), "utf8"),
    "original changed copy",
  );
  assert.equal(
    await readlink(path.join(copy, "node_modules/alias.js")),
    "original/index.js",
  );
  assert.equal(
    (await mutationDependencies(copy, "node_modules", () => true)).fingerprint,
    dependencies.fingerprint,
  );
  await assert.rejects(
    mutationDependencies(root, "node_modules", () => false),
    /interrupted/,
  );
  await symlink("../subject.js", path.join(root, "node_modules/escape.js"));
  await assert.rejects(
    mutationDependencies(root, "node_modules", () => true),
    /selected closure/,
  );
});
