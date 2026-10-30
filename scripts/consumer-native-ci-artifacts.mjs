import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { readdir, lstat, realpath, open } from "node:fs/promises";
import path from "node:path";
import {
  consumerNativeScopeJob,
  consumerNativeCapsuleFilename,
} from "./consumer-native-acceptance-capsule.mjs";
async function directory(filename) {
  assert.equal(await realpath(filename), filename);
  const stat = await lstat(filename);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
}
async function artifact(filename) {
  assert.equal(await realpath(filename), filename);
  const before = await lstat(filename, { bigint: true });
  assert.ok(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1n &&
      before.size > 0n &&
      before.size <= 1048576n,
  );
  const fd = await open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const initial = await fd.stat({ bigint: true });
    for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"])
      assert.equal(initial[field], before[field]);
    const parts = [];
    let total = 0;
    for (;;) {
      const bytes = Buffer.alloc(65536),
        read = await fd.read(bytes, 0, bytes.length, null);
      if (!read.bytesRead) break;
      total += read.bytesRead;
      assert.ok(total <= 1048576);
      parts.push(bytes.subarray(0, read.bytesRead));
    }
    const after = await fd.stat({ bigint: true }),
      linked = await lstat(filename, { bigint: true });
    for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
      assert.equal(after[field], before[field]);
      assert.equal(linked[field], before[field]);
    }
    assert.equal(BigInt(total), before.size);
    assert.equal(await realpath(filename), filename);
    return JSON.parse(Buffer.concat(parts, total).toString("utf8"));
  } finally {
    await fd.close();
  }
}
/** Downloaded sanitized capsules are bounded transport data, not native inode or host attestation. Keep per-artifact directories to expose duplicate scope uploads. */
export async function readConsumerNativeCapsuleArtifacts(
  root,
  selected,
  runAttempt,
) {
  assert.ok(path.isAbsolute(root));
  assert.match(runAttempt, /^[1-9][0-9]{0,8}$/);
  assert.ok(
    Array.isArray(selected) && selected.length > 0 && selected.length <= 26,
  );
  await directory(root);
  const names = await readdir(root),
    capsules = [];
  assert.ok(names.length > 0 && names.length <= selected.length);
  for (const name of names) {
    assert.match(name, /^native-consumer-[a-z0-9-]+$/);
    const parent = path.join(root, name);
    await directory(parent);
    const files = await readdir(parent);
    assert.ok(files.length > 0 && files.length <= selected.length);
    for (const filename of files) {
      assert.match(filename, /^[a-z-]+--[a-z0-9-]+\.json$/);
      const capsule = await artifact(path.join(parent, filename)),
        scope = selected.find((scope) => scope.id === capsule.scope?.id);
      assert.ok(scope, "Foreign native capsule artifact");
      assert.equal(filename, consumerNativeCapsuleFilename(scope));
      const job = consumerNativeScopeJob(scope),
        lane = job === "tasks-runtime" ? scope.runtime.id : "single";
      assert.equal(
        name,
        "native-consumer-" + job + "-" + lane + "-" + runAttempt,
      );
      capsules.push(capsule);
      assert.ok(capsules.length <= selected.length);
    }
  }
  return capsules;
}
