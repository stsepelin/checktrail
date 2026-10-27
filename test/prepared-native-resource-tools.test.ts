import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rename,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fixture } from "./helpers.js";
const headers =
  process.env.CHECKTRAIL_TEST_NODE_HEADERS ??
  path.resolve(
    path.dirname(await realpath(process.execPath)),
    "../include/node",
  );
const native = {
  skip: !["linux", "darwin"].includes(process.platform),
  timeout: 30000,
};
const tools = await import(
  new URL("../../scripts/prepared-native-resource-tools.mjs", import.meta.url)
    .href
);
async function prepared(t: Parameters<typeof fixture>[0]) {
  const root = await realpath(await fixture(t, {}));
  const result = await tools.prepareNativeResourceTools(
    root,
    await realpath(headers),
    undefined,
  );
  return { root: path.dirname(path.dirname(result.bundle)), result };
}
test(
  "prepared native resource tools retain exact compiler artifacts in a fresh private copy",
  native,
  async (t) => {
    const original = await prepared(t),
      before = await tools.capturePreparedResourceTools(
        original.root,
        await realpath(headers),
      );
    const destination = await realpath(await fixture(t, {}));
    const copy = await tools.prepareNativeResourceTools(
      destination,
      await realpath(headers),
      original.root,
    );
    assert.notEqual(copy.bundle, original.result.bundle);
    const after = await tools.capturePreparedResourceTools(
      path.join(destination, "tools"),
      await realpath(headers),
    );
    assert.deepEqual(after, before);
    assert.deepEqual(
      await tools.capturePreparedResourceTools(
        original.root,
        await realpath(headers),
      ),
      before,
    );
    for (const row of before.rows) {
      const file = path.join(destination, "tools", row.file);
      assert.deepEqual(await readFile(file), row.bytes);
      assert.equal((await lstat(file)).nlink, 1);
      assert.equal((await lstat(file)).mode & 0o077, 0);
    }
  },
);
test(
  "prepared native resource tools refuse incompatible or incomplete inputs before publishing any artifacts",
  native,
  async (t) => {
    const original = await prepared(t),
      source = original.root;
    const metadata = path.join(
        source,
        "counter/native-child-resource/build.json",
      ),
      binary = path.join(source, "observer/native-resource-observer/observer"),
      before = await readFile(metadata);
    const refuse = async (pattern: RegExp) => {
      const destination = await realpath(await fixture(t, {}));
      await assert.rejects(
        tools.prepareNativeResourceTools(
          destination,
          await realpath(headers),
          source,
        ),
        pattern,
      );
      assert.deepEqual(
        await readdir(destination),
        [],
        "Refusal must leave no partial bundle or observer",
      );
    };
    for (const [field, value, message] of [
      ["platform", "unselected", /strictly equal/],
      ["architecture", "unselected", /strictly equal/],
      ["sourceSha256", "0".repeat(64), /resource source differs/],
      ["preparedByNode", "0.0.0", /Node version differs/],
      [
        "preparedByNodeExecutableSha256",
        "0".repeat(64),
        /Node executable differs/,
      ],
      ["binarySha256", "0".repeat(64), /resource binary differs/],
      ["completeNativeArtifactClosure", true, /strictly equal/],
    ] as const) {
      try {
        const value_ = JSON.parse(before.toString("utf8"));
        value_[field] = value;
        await writeFile(metadata, JSON.stringify(value_));
        await refuse(message);
      } finally {
        await writeFile(metadata, before);
      }
    }
    const held = path.join(path.dirname(source), "held-observer");
    await rename(binary, held);
    try {
      await refuse(/artifacts differ/);
      await symlink(held, binary);
      try {
        await refuse(/artifacts differ|must not follow symlinks/);
      } finally {
        const { unlink } = await import("node:fs/promises");
        await unlink(binary);
      }
    } finally {
      await rename(held, binary);
    }
    const binaryBytes = await readFile(binary);
    try {
      await truncate(binary, 16 * 1048576 + 1);
      await refuse(/bounded regular/);
    } finally {
      await writeFile(binary, binaryBytes);
    }
    try {
      await chmod(source, 0o755);
      await refuse(/private and caller owned/);
    } finally {
      await chmod(source, 0o700);
    }
    const extra = path.join(source, "extra");
    await mkdir(extra);
    try {
      await refuse(/artifacts differ/);
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(extra, { recursive: true });
    }
    const destination = await realpath(await fixture(t, {}));
    await tools.prepareNativeResourceTools(
      destination,
      await realpath(headers),
      source,
    );
    assert.deepEqual(await readdir(destination), ["tools"]);
  },
);
