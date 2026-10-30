import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  rm,
  symlink,
  rename,
} from "node:fs/promises";
import { Buffer } from "node:buffer";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
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
  const base = await realpath(
      await mkdtemp(
        path.join(os.tmpdir(), "checktrail-synthetic-capsule-artifacts-"),
      ),
    ),
    root = path.join(base, "download"),
    parent = root,
    name = "context-php--native-linux-arm64-node22.json",
    value = {
      scope: { id: scope.id },
      syntheticTransportOnly: true,
      nativeQualification: false,
      capsuleSha256: "a".repeat(64),
      attemptId: randomUUID(),
      ci: { runId: "1234", runAttempt: "2" },
    };
  await mkdir(parent);
  const file = path.join(parent, name);
  await writeFile(file, JSON.stringify(value));
  const binding = {
    job: "php-context-arm64",
    lane: "single",
    start: { runId: "1234", runAttempt: "2" },
    finish: {
      artifact: { name: "native-consumer-php-context-arm64-single-2" },
      capsules: [
        {
          scopeId: scope.id,
          sha256: value.capsuleSha256,
          attemptId: value.attemptId,
        },
      ],
    },
  };
  return { base, root, parent, file, value, binding };
}
test("sanitized capsule acquisition binds one exact retained producer artifact in the pinned flat download layout", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(
      await readConsumerNativeCapsuleArtifacts(f.root, [scope], [f.binding]),
      [f.value],
    );
    await assert.rejects(
      readConsumerNativeCapsuleArtifacts(
        f.root,
        [scope],
        [
          {
            ...f.binding,
            finish: {
              ...f.binding.finish,
              artifact: { name: "native-consumer-php-context-arm64-single-1" },
            },
          },
        ],
      ),
    );
    await assert.rejects(
      readConsumerNativeCapsuleArtifacts(f.root, [], [f.binding]),
    );
    await writeFile(
      f.file,
      JSON.stringify({
        ...f.value,
        scope: { id: "context-foreign:native-linux-arm64-node22" },
      }),
    );
    await assert.rejects(
      readConsumerNativeCapsuleArtifacts(f.root, [scope], [f.binding]),
      /Foreign/,
    );
    await writeFile(f.file, JSON.stringify(f.value));
    assert.equal(
      (await readConsumerNativeCapsuleArtifacts(f.root, [scope], [f.binding]))
        .length,
      1,
    );
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});
test("sanitized capsule acquisition refuses links nested artifacts oversized bodies and extra filenames rather than merging or silently excluding them", async () => {
  const f = await fixture();
  try {
    const target = path.join(f.base, "original.json");
    await rm(f.file);
    await writeFile(target, JSON.stringify(f.value));
    await symlink(
      target,
      f.file,
      process.platform === "win32" ? "file" : undefined,
    );
    await assert.rejects(
      readConsumerNativeCapsuleArtifacts(f.root, [scope], [f.binding]),
    );
    await rm(f.file);
    await rm(target);
    await mkdir(f.file);
    await assert.rejects(
      readConsumerNativeCapsuleArtifacts(f.root, [scope], [f.binding]),
    );
    await rm(f.file, { recursive: true });
    await writeFile(f.file, Buffer.alloc(1048577, 32));
    await assert.rejects(
      readConsumerNativeCapsuleArtifacts(f.root, [scope], [f.binding]),
    );
    await writeFile(f.file, JSON.stringify(f.value));
    const extra = path.join(f.parent, "unexpected.json");
    await writeFile(extra, "{}");
    await assert.rejects(
      readConsumerNativeCapsuleArtifacts(f.root, [scope], [f.binding]),
    );
    await rm(extra);
    assert.deepEqual(
      await readConsumerNativeCapsuleArtifacts(f.root, [scope], [f.binding]),
      [f.value],
    );
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("multiple exact claimed artifacts require distinct named directories while a missing latest artifact cannot turn into a single-artifact fallback", async () => {
  const f = await fixture();
  try {
    const php = path.join(f.root, f.binding.finish.artifact.name);
    await mkdir(php);
    await rename(f.file, path.join(php, path.basename(f.file)));
    const other = {
        id: "context-rust:native-linux-arm64-node22",
        acceptanceProfile: "context-rust",
        runtime: { id: "native-linux-arm64-node22" },
        families: ["rust"],
      },
      value = {
        ...f.value,
        scope: { id: other.id },
        attemptId: randomUUID(),
        capsuleSha256: "b".repeat(64),
        ci: { runId: "1234", runAttempt: "1" },
      },
      binding = {
        job: "rust-context-arm64",
        lane: "single",
        start: { runId: "1234", runAttempt: "1" },
        finish: {
          artifact: { name: "native-consumer-rust-context-arm64-single-1" },
          capsules: [
            {
              scopeId: other.id,
              sha256: value.capsuleSha256,
              attemptId: value.attemptId,
            },
          ],
        },
      },
      rust = path.join(f.root, binding.finish.artifact.name),
      file = path.join(rust, "context-rust--native-linux-arm64-node22.json");
    await mkdir(rust);
    await writeFile(file, JSON.stringify(value));
    const result = await readConsumerNativeCapsuleArtifacts(
      f.root,
      [scope, other],
      [f.binding, binding],
    );
    assert.deepEqual(
      result.map((row: { scope: { id: string } }) => row.scope.id).sort(),
      [scope.id, other.id].sort(),
    );
    await rm(rust, { recursive: true });
    await assert.rejects(
      readConsumerNativeCapsuleArtifacts(
        f.root,
        [scope, other],
        [f.binding, binding],
      ),
      /missing or foreign/,
    );
    await writeFile(
      path.join(f.root, "context-rust--native-linux-arm64-node22.json"),
      JSON.stringify(value),
    );
    await assert.rejects(
      readConsumerNativeCapsuleArtifacts(
        f.root,
        [scope, other],
        [f.binding, binding],
      ),
      /missing or foreign/,
    );
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("one shared Go producer artifact keeps both exact context scope files in the pinned single-artifact flat layout", async () => {
  const f = await fixture();
  try {
    await rm(f.file);
    const scopes = ["go", "python"].map((family) => ({
        id: "context-" + family + ":native-linux-arm64-node22",
        acceptanceProfile: "context-" + family,
        runtime: { id: "native-linux-arm64-node22" },
        families: [family],
      })),
      values = scopes.map((scope, index) => ({
        ...f.value,
        scope: { id: scope.id },
        attemptId: randomUUID(),
        capsuleSha256: String(index + 1).repeat(64),
      })),
      binding = {
        job: "go-workspaces-arm64",
        lane: "single",
        start: { runId: "1234", runAttempt: "2" },
        finish: {
          artifact: { name: "native-consumer-go-workspaces-arm64-single-2" },
          capsules: values.map((row) => ({
            scopeId: row.scope.id,
            sha256: row.capsuleSha256,
            attemptId: row.attemptId,
          })),
        },
      };
    for (const value of values)
      await writeFile(
        path.join(f.root, value.scope.id.replace(":", "--") + ".json"),
        JSON.stringify(value),
      );
    assert.equal(
      (await readConsumerNativeCapsuleArtifacts(f.root, scopes, [binding]))
        .length,
      2,
    );
    await rm(
      path.join(f.root, values[1]!.scope.id.replace(":", "--") + ".json"),
    );
    await assert.rejects(
      readConsumerNativeCapsuleArtifacts(f.root, scopes, [binding]),
    );
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});
