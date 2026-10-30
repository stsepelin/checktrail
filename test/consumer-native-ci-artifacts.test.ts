import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { Buffer } from "node:buffer";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
const { readConsumerNativeCapsuleArtifacts } = await import(
  new URL("../../scripts/consumer-native-ci-artifacts.mjs", import.meta.url)
    .href
);
const scope = {
  id: "context-php:native-linux-arm64-node22",
  acceptanceProfile: "context-php",
  runtime: { id: "native-linux-arm64-node22" },
  families: ["php"],
};
async function fixture() {
  const root = await realpath(
      await mkdtemp(
        path.join(os.tmpdir(), "checktrail-synthetic-capsule-artifacts-"),
      ),
    ),
    parent = path.join(root, "native-consumer-php-context-arm64-single-2"),
    name = "context-php--native-linux-arm64-node22.json",
    value = {
      scope: { id: scope.id },
      syntheticTransportOnly: true,
      nativeQualification: false,
    };
  await mkdir(parent);
  const file = path.join(parent, name);
  await writeFile(file, JSON.stringify(value));
  return { root, parent, file, value };
}
test("sanitized capsule acquisition reads exact separate job/current-attempt filenames as transport only", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(
      await readConsumerNativeCapsuleArtifacts(f.root, [scope], "2"),
      [f.value],
    );
    await assert.rejects(
      readConsumerNativeCapsuleArtifacts(f.root, [scope], "1"),
    );
    await assert.rejects(readConsumerNativeCapsuleArtifacts(f.root, [], "2"));
    await writeFile(
      f.file,
      JSON.stringify({
        ...f.value,
        scope: { id: "context-foreign:native-linux-arm64-node22" },
      }),
    );
    await assert.rejects(
      readConsumerNativeCapsuleArtifacts(f.root, [scope], "2"),
      /Foreign/,
    );
    await writeFile(f.file, JSON.stringify(f.value));
    assert.equal(
      (await readConsumerNativeCapsuleArtifacts(f.root, [scope], "2")).length,
      1,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("sanitized capsule acquisition refuses links nested artifacts oversized bodies and extra filenames rather than merging or silently excluding them", async () => {
  const f = await fixture();
  try {
    const target = path.join(f.root, "original.json");
    await rm(f.file);
    await writeFile(target, JSON.stringify(f.value));
    await symlink(
      target,
      f.file,
      process.platform === "win32" ? "file" : undefined,
    );
    await assert.rejects(
      readConsumerNativeCapsuleArtifacts(f.root, [scope], "2"),
    );
    await rm(f.file);
    await rm(target);
    await mkdir(f.file);
    await assert.rejects(
      readConsumerNativeCapsuleArtifacts(f.root, [scope], "2"),
    );
    await rm(f.file, { recursive: true });
    await writeFile(f.file, Buffer.alloc(1048577, 32));
    await assert.rejects(
      readConsumerNativeCapsuleArtifacts(f.root, [scope], "2"),
    );
    await writeFile(f.file, JSON.stringify(f.value));
    const extra = path.join(f.parent, "unexpected.json");
    await writeFile(extra, "{}");
    await assert.rejects(
      readConsumerNativeCapsuleArtifacts(f.root, [scope], "2"),
    );
    await rm(extra);
    assert.deepEqual(
      await readConsumerNativeCapsuleArtifacts(f.root, [scope], "2"),
      [f.value],
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
