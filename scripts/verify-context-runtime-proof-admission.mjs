import assert from "node:assert/strict";
import process from "node:process";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

const root =
  process.env.CHECKTRAIL_CONTEXT_TARGET_ROOT ??
  fileURLToPath(new URL("../", import.meta.url));
assert.ok(path.isAbsolute(root));
const selected = process.env.CHECKTRAIL_CONTEXT_RELEASE_PROOF;
assert.match(selected ?? "", /^\/[^\n]+\/proof\.json#sha256=[a-f0-9]{64}$/);

const sameFile = (a, b) =>
  ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every(
    (key) => a[key] === b[key],
  );
async function originalCohort(directory) {
  assert.equal(
    await realpath(directory),
    directory,
    "Canonical original proof directory required",
  );
  const before = await lstat(directory, { bigint: true });
  assert.ok(
    before.isDirectory() &&
      !before.isSymbolicLink() &&
      (before.mode & 0o222n) === 0n,
  );
  const names = [
    "proof.json",
    "web-tree-sitter.tar.gz",
    "attestation-verified.json",
    "sigstore-trusted-root.jsonl",
    "attestation.bundle.jsonl",
    "native-verification.json",
  ].sort();
  assert.deepEqual((await readdir(directory)).sort(), names);
  const rows = [];
  for (const name of names) {
    const file = path.join(directory, name);
    assert.equal(
      await realpath(file),
      file,
      "Linked original proof member forbidden",
    );
    const identity = await lstat(file, { bigint: true });
    assert.ok(
      identity.isFile() &&
        !identity.isSymbolicLink() &&
        identity.nlink === 1n &&
        identity.size > 0n &&
        identity.size <= 2n * 1024n * 1024n &&
        (identity.mode & 0o222n) === 0n,
      "Bounded read-only original proof member required",
    );
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      assert.ok(sameFile(identity, await handle.stat({ bigint: true })));
      const bytes = Buffer.alloc(Number(identity.size) + 1);
      let count = 0;
      while (count < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          count,
          bytes.length - count,
          null,
        );
        if (!bytesRead) break;
        count += bytesRead;
      }
      assert.equal(
        BigInt(count),
        identity.size,
        "Original proof member grew or truncated",
      );
      assert.ok(
        sameFile(identity, await handle.stat({ bigint: true })) &&
          sameFile(identity, await lstat(file, { bigint: true })),
      );
      assert.equal(await realpath(file), file);
      rows.push([name, bytes.subarray(0, count), identity]);
    } finally {
      await handle.close();
    }
  }
  assert.deepEqual((await readdir(directory)).sort(), names);
  assert.ok(sameFile(before, await lstat(directory, { bigint: true })));
  for (const [name, , identity] of rows)
    assert.ok(
      sameFile(
        identity,
        await lstat(path.join(directory, name), { bigint: true }),
      ),
    );
  assert.equal(await realpath(directory), directory);
  return rows;
}

const owned = await mkdtemp(
  path.join(await realpath(tmpdir()), "context-proof-admission-"),
);
let destination;
try {
  const [file, digest] = selected.split("#sha256=");
  destination = path.join(owned, digest);
  assert.equal(path.basename(path.dirname(file)), digest);
  const rows = await originalCohort(path.dirname(file));
  assert.equal(
    createHash("sha256")
      .update(rows.find(([name]) => name === "proof.json")[1])
      .digest("hex"),
    digest,
  );
  await mkdir(destination, { mode: 0o700 });
  for (const [name, bytes] of rows)
    await writeFile(path.join(destination, name), bytes, {
      flag: "wx",
      mode: 0o444,
    });
  await chmod(destination, 0o555);
  const proofFile = path.join(destination, "proof.json");
  assert.equal(await realpath(proofFile), proofFile);
  assert.equal(path.dirname(destination), owned);
  // Capture authority only after constructing a fresh, owned copy. The input is read only.
  process.env.CHECKTRAIL_CONTEXT_RELEASE_PROOF =
    proofFile + "#sha256=" + digest;
  const {
    createReviewContext,
    parseReviewContext,
    receiveReview,
    reviewContextSchema,
  } = await import(pathToFileURL(path.join(root, "dist/src/review.js")).href);
  const directory = await mkdtemp(
    path.join(await realpath(tmpdir()), "context-admission-source-"),
  );
  try {
    await writeFile(
      path.join(directory, "first.py"),
      "def first(value):\n    return value + 1\n",
    );
    await writeFile(
      path.join(directory, "second.py"),
      "def second(value):\n    return value * 2\n",
    );
    const context = await createReviewContext(directory, {
      schemaVersion: 6,
      track: "snapshot",
      currentSource: "working-tree",
      files: ["first.py", "second.py"],
      supportFiles: [],
      topics: [],
    });
    assert.equal(context.analysis.state, "collected");
    assert.ok(context.analysis.runtimeArtifactProof);
    const assessment = (digest) => ({
      schemaVersion: 2,
      contextDigest: digest,
      reviewer: { kind: "human", name: "synthetic-unreviewed-fixture" },
      createdAt: "2026-01-01T00:00:00Z",
      usage: {
        inputTokens: null,
        outputTokens: null,
        elapsedMs: null,
        costUSD: null,
      },
      files: context.files.map(({ path: file }) => ({
        path: file,
        disposition: "not-reviewed",
        note: "Synthetic transport and admission control; no review performed",
      })),
      observations: [],
    });
    const baseline = await receiveReview(
      directory,
      context,
      assessment(context.contextDigest),
    );
    assert.equal(baseline.freshness, "current");
    assert.equal(baseline.coverage.declaredNotReviewed, 2);
    assert.equal(baseline.coverage.declaredReviewed, 0);
    const forged = globalThis.structuredClone(context);
    forged.analysis.runtimeArtifactProof.sha256 = "0".repeat(64);
    const canonical = reviewContextSchema.parse(forged);
    const body = { ...canonical };
    delete body.contextDigest;
    canonical.contextDigest = createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex");
    assert.throws(
      () => parseReviewContext(canonical),
      /runtime proof differs from operator authority/,
    );
    const bytes = await readFile(proofFile);
    const changed = Uint8Array.from(bytes);
    changed[0] ^= 1;
    await chmod(proofFile, 0o644);
    await writeFile(proofFile, changed);
    await chmod(proofFile, 0o444);
    await assert.rejects(
      () =>
        receiveReview(directory, context, assessment(context.contextDigest)),
      /Operator-selected proof SHA differs/,
      "Actual final receipt must revalidate the physical selected proof",
    );
    await chmod(proofFile, 0o644);
    await writeFile(proofFile, bytes);
    await chmod(proofFile, 0o444);
    await assert.rejects(
      () =>
        receiveReview(
          directory,
          canonical,
          assessment(canonical.contextDigest),
        ),
      /runtime proof differs from operator authority/,
    );
    process.stdout.write(
      JSON.stringify({
        state: "passed-final-context-proof-admission",
        documents: 2,
        declaredReviewed: 0,
        coherentForgedReferenceRefused: true,
        physicalProofChangeRefusedAtReceipt: true,
        modelCalls: 0,
      }) + "\n",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
} finally {
  try {
    if (destination)
      await chmod(destination, 0o755).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
  } finally {
    await rm(owned, { recursive: true, force: true });
  }
}
