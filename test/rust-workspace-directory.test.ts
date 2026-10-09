import assert from "node:assert/strict";
import { mkdir, realpath, symlink, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fixture } from "./helpers.js";
import { rustWorkspaceTemporaryBase } from "../src/rust-workspace-directory.js";
test("Rust workspace accepts a trusted temporary-directory alias and resolves its actual native build parent", async (t) => {
  const root = await fixture(t, {
    "retained.marker": "original caller-owned marker\n",
  });
  const target = path.join(root, "actual"),
    alias = path.join(root, "alias");
  await mkdir(target);
  await symlink(
    target,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  let resolved: string | undefined;
  await assert.doesNotReject(async () => {
    resolved = await rustWorkspaceTemporaryBase(alias);
  }, "The engine temporary directory may have a valid OS alias");
  assert.equal(resolved, await realpath(target));
  assert.equal(await rustWorkspaceTemporaryBase(target), resolved);
  assert.equal(
    await readFile(path.join(root, "retained.marker"), "utf8"),
    "original caller-owned marker\n",
  );
});
test("Rust workspace refuses missing relative and non-directory temporary inputs without replacing caller-owned files", async (t) => {
  const root = await fixture(t, { regular: "original bytes\n" });
  for (const value of [
    undefined,
    "",
    "relative",
    path.relative(process.cwd(), root) || ".",
    path.join(root, "regular"),
    path.join(root, "missing"),
  ])
    await assert.rejects(rustWorkspaceTemporaryBase(value));
  assert.equal(
    await readFile(path.join(root, "regular"), "utf8"),
    "original bytes\n",
  );
});
