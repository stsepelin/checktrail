import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { fixture } from "./helpers.js";

const exec = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const directory = "docs/measurements/artifact-identities-2026-10-21";
const indexName = "artifact-evidence-index.v1.json";
const script = path.join(
  repository,
  "scripts/audit-selected-artifact-evidence.mjs",
);
interface Entry {
  file: string;
  bytes: number;
  sha256: string;
}
interface Index {
  schemaVersion: number;
  observationsOnly: boolean;
  retainedReferences: number;
  files: Entry[];
  repositoryInputs: Entry[];
}
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function index(root: string): Promise<Index> {
  return JSON.parse(
    await readFile(path.join(root, directory, indexName), "utf8"),
  );
}
async function saveIndex(root: string, value: Index) {
  await writeFile(path.join(root, directory, indexName), JSON.stringify(value));
}
async function source(t: TestContext) {
  const root = await fixture(t, {});
  await cp(path.join(repository, directory), path.join(root, directory), {
    recursive: true,
  });
  for (const entry of (await index(root)).repositoryInputs) {
    const target = path.join(root, entry.file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(path.join(repository, entry.file)));
  }
  return root;
}
async function audit(root: string, extra: string[] = []) {
  try {
    const result = await exec(process.execPath, [script, root, ...extra]);
    return { code: 0, ...result };
  } catch (error) {
    return error as { code: number; stdout: string; stderr: string };
  }
}
async function reindex(root: string, name: string) {
  const value = await index(root);
  const entry = value.files.find((candidate) => candidate.file === name);
  assert.ok(entry);
  const bytes = await readFile(path.join(root, directory, name));
  entry.bytes = bytes.length;
  entry.sha256 = digest(bytes);
  await saveIndex(root, value);
}
test("artifact audit binds the retained byte and source graph without certifying native acceptance", async (t) => {
  const root = await source(t);
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { preinstall: "node -e 'process.exit(9)'" } }),
  );
  const result = await audit(root);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const declared = await index(root);
  assert.equal(report.files, declared.files.length);
  assert.equal(report.repositoryInputs, declared.repositoryInputs.length);
  assert.equal(report.retainedReferences, declared.retainedReferences);
  assert.equal(report.evidenceConsistent, true);
  for (const flag of [
    "cryptographicVerificationPerformedByAudit",
    "nativeAcceptanceAssessed",
    "gateAComplete",
    "qualityAssessed",
  ])
    assert.equal(report[flag], false);
  // The upstream source README has a different identity from the evidence README.
  const inputs = JSON.parse(
    await readFile(
      path.join(root, directory, "provider-rebuild-inputs.json"),
      "utf8",
    ),
  );
  const upstream = inputs.source.sourceFiles.find(
    (entry: Entry) => entry.file === "README.md",
  ) as Entry;
  const retained = declared.files.find((entry) => entry.file === "README.md");
  assert.ok(retained);
  assert.notEqual(upstream.sha256, retained.sha256);
});
test("artifact audit rejects changed notice bytes and accepts exact byte restoration", async (t) => {
  const root = await source(t);
  const file = path.join(root, directory, "provider-LICENSE.txt");
  const original = await readFile(file);
  const changed = Buffer.from(original);
  changed[0] = changed[0]! ^ 1;
  await writeFile(file, changed);
  const broken = await audit(root);
  assert.equal(broken.code, 2);
  assert.match(
    broken.stderr,
    /Evidence digest mismatch: provider-LICENSE\.txt/u,
  );
  await writeFile(file, original);
  assert.equal((await audit(root)).code, 0);
});
test("artifact audit preserves raw CRLF certificate bytes rather than accepting normalized text", async (t) => {
  const root = await source(t);
  const file = path.join(root, directory, "nuget-repository-certificates.txt");
  const original = await readFile(file);
  assert.ok(original.includes(Buffer.from("\r\n")));
  await writeFile(file, original.toString("utf8").replaceAll("\r\n", "\n"));
  const result = await audit(root);
  assert.equal(result.code, 2);
  assert.match(
    result.stderr,
    /Evidence byte count mismatch: nuget-repository-certificates\.txt/u,
  );
  await writeFile(file, original);
  assert.equal((await audit(root)).code, 0);
});
test("artifact audit refuses a rehashed notice when its retained reference is stale", async (t) => {
  const root = await source(t);
  await writeFile(
    path.join(root, directory, "provider-LICENSE.txt"),
    "changed notice\n",
  );
  await reindex(root, "provider-LICENSE.txt");
  const result = await audit(root);
  assert.equal(result.code, 2);
  assert.match(
    result.stderr,
    /Retained input byte count mismatch: random-provider\.json/u,
  );
});
test("artifact audit rejects stale source bytes and stale source declarations separately", async (t) => {
  for (const mode of ["source-bytes", "record-binding"] as const) {
    const root = await source(t);
    const declared = await index(root);
    const input = declared.repositoryInputs[0]!;
    if (mode === "source-bytes")
      await writeFile(path.join(root, input.file), "stale source\n");
    else {
      const recordName = "scala2.json";
      const file = path.join(root, directory, recordName);
      const record = JSON.parse(await readFile(file, "utf8"));
      record.repositoryInputs[0].sha256 = "0".repeat(64);
      await writeFile(file, JSON.stringify(record));
      await reindex(root, recordName);
    }
    const result = await audit(root);
    assert.equal(result.code, 2, mode);
    assert.match(
      result.stderr,
      mode === "source-bytes"
        ? /Evidence byte count mismatch/u
        : /Stale record source binding/u,
    );
  }
});
test("artifact audit refuses completion claims even with a coherent file index", async (t) => {
  const root = await source(t);
  const file = path.join(root, directory, "scala2.json");
  const record = JSON.parse(await readFile(file, "utf8"));
  record.completeArtifactAndNoticeClosureVerified = true;
  await writeFile(file, JSON.stringify(record));
  await reindex(root, "scala2.json");
  const result = await audit(root);
  assert.equal(result.code, 2);
  assert.match(
    result.stderr,
    /Static artifact observations cannot promote completeArtifactAndNoticeClosureVerified/u,
  );
});
test("artifact audit detects a removed retained reference after its record is rehashed", async (t) => {
  const root = await source(t);
  const file = path.join(root, directory, "scala2.json");
  const record = JSON.parse(await readFile(file, "utf8"));
  record.observations.retainedDistributionNotices.pop();
  await writeFile(file, JSON.stringify(record));
  await reindex(root, "scala2.json");
  const result = await audit(root);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Retained-reference graph changed/u);
});
test("artifact audit rejects missing, empty, unindexed and oversized files", async (t) => {
  for (const mode of ["missing", "empty", "unindexed", "oversized"] as const) {
    const root = await source(t);
    if (mode === "missing")
      await rm(path.join(root, directory, "provider-LICENSE.txt"));
    if (mode === "empty")
      await writeFile(path.join(root, directory, "provider-LICENSE.txt"), "");
    if (mode === "unindexed")
      await writeFile(
        path.join(root, directory, "unexpected.txt"),
        "unindexed\n",
      );
    if (mode === "oversized")
      await writeFile(
        path.join(root, directory, "provider-LICENSE.txt"),
        Buffer.alloc(2 * 1024 * 1024 + 1),
      );
    const result = await audit(root);
    assert.equal(result.code, 2, mode);
    assert.match(
      result.stderr,
      mode === "oversized" || mode === "empty"
        ? /File bound or type violated: provider-LICENSE\.txt/u
        : /Unindexed or missing evidence files/u,
    );
  }
});
test(
  "artifact audit rejects symlinked notice leaves and parent directories",
  {
    skip:
      process.platform === "win32" ? "Requires POSIX symlink fixtures" : false,
  },
  async (t) => {
    for (const mode of ["leaf", "parent"] as const) {
      const root = await source(t);
      if (mode === "leaf") {
        const file = path.join(root, directory, "provider-LICENSE.txt");
        const outside = path.join(root, "outside.txt");
        await cp(file, outside);
        await rm(file);
        await symlink(outside, file);
      } else {
        const file = path.join(root, directory, "provider-notices");
        const outside = path.join(root, "outside-notices");
        await cp(file, outside, { recursive: true });
        await rm(file, { recursive: true });
        await symlink(outside, file);
      }
      const result = await audit(root);
      assert.equal(result.code, 2, mode);
      assert.match(result.stderr, /Evidence crosses a symlink/u);
    }
  },
);
test("artifact audit rejects an empty index, duplicate paths, traversal and malformed arguments", async (t) => {
  for (const mode of ["empty", "duplicate", "traversal", "argument"] as const) {
    const root = await source(t);
    const value = await index(root);
    if (mode === "empty") value.files = [];
    if (mode === "duplicate") value.files.push(value.files[0]!);
    if (mode === "traversal") value.files[0]!.file = "../outside.txt";
    if (mode !== "argument") await saveIndex(root, value);
    const result = await audit(root, mode === "argument" ? ["--execute"] : []);
    assert.equal(result.code, 2, mode);
    if (mode === "duplicate")
      assert.match(result.stderr, /contains a duplicate path/u);
    if (mode === "traversal")
      assert.match(result.stderr, /Noncanonical relative evidence path/u);
    if (mode === "argument")
      assert.match(result.stderr, /Usage: audit-selected-artifact-evidence/u);
  }
});

test("artifact audit accepts bounded added data and rejects reached total-byte and JSON-depth limits", async (t) => {
  for (const mode of ["bounded", "total-bytes", "json-depth"] as const) {
    const root = await source(t);
    const value = await index(root);
    const additions: { file: string; bytes: Buffer }[] = [];
    if (mode === "total-bytes") {
      // The audit reads the index, retained files and repository inputs once.
      // Include all three before choosing filler so this control reaches the
      // byte ceiling without first exceeding the independent file-count limit.
      // Appending the filler metadata only increases the reached byte total.
      let remaining =
        8 * 1024 * 1024 -
        value.files.reduce((total, file) => total + file.bytes, 0) -
        value.repositoryInputs.reduce((total, file) => total + file.bytes, 0) -
        Buffer.byteLength(JSON.stringify(value)) +
        1;
      assert.ok(remaining > 0);
      for (let i = 0; remaining > 0; i += 1) {
        const bytes = Math.min(remaining, 2 * 1024 * 1024);
        additions.push({
          file: `synthetic-${i}.txt`,
          bytes: Buffer.alloc(bytes, "x"),
        });
        remaining -= bytes;
      }
      assert.ok(value.files.length + additions.length <= 256);
    } else {
      let nested: unknown = "original synthetic data";
      for (let i = 0; i < (mode === "bounded" ? 16 : 80); i += 1)
        nested = { child: nested };
      additions.push({
        file: "synthetic-nested.json",
        bytes: Buffer.from(JSON.stringify(nested)),
      });
    }
    for (const addition of additions) {
      await writeFile(
        path.join(root, directory, addition.file),
        addition.bytes,
      );
      value.files.push({
        file: addition.file,
        bytes: addition.bytes.length,
        sha256: digest(addition.bytes),
      });
    }
    await saveIndex(root, value);
    const result = await audit(root);
    assert.equal(result.code, mode === "bounded" ? 0 : 2, result.stderr);
    if (mode === "total-bytes")
      assert.match(result.stderr, /Total evidence byte bound exceeded/u);
    if (mode === "json-depth")
      assert.match(result.stderr, /Evidence JSON structural bound exceeded/u);
  }
});

test("artifact audit rejects nested completion inference and field-evaluation claims after rehashing", async (t) => {
  for (const flag of [
    "gateAComplete",
    "qualityAssessed",
    "inferenceInvoked",
    "fieldEvaluationExecuted",
  ]) {
    const root = await source(t);
    const file = "synthetic-nested-claims.json";
    const value = await index(root);
    const writeClaim = async (enabled: boolean) => {
      const bytes = Buffer.from(
        JSON.stringify({
          scope: "original synthetic claim control",
          details: { [flag]: enabled, [flag + "Control"]: true },
        }),
      );
      await writeFile(path.join(root, directory, file), bytes);
      const declared = { file, bytes: bytes.length, sha256: digest(bytes) };
      const position = value.files.findIndex((entry) => entry.file === file);
      if (position < 0) value.files.push(declared);
      else value.files[position] = declared;
      await saveIndex(root, value);
    };
    await writeClaim(true);
    const rejected = await audit(root);
    assert.equal(rejected.code, 2, flag);
    assert.ok(
      rejected.stderr.includes("Static evidence cannot promote " + flag),
      rejected.stderr,
    );
    await writeClaim(false);
    const restored = await audit(root);
    assert.equal(restored.code, 0, restored.stderr);
  }
});

function compressedNotice(bytes: Uint8Array) {
  const compressed = gzipSync(bytes);
  return {
    bytes: bytes.length,
    sha256: digest(bytes),
    gzipBytes: compressed.length,
    gzipSha256: digest(compressed),
    originalBytesGzipBase64: compressed.toString("base64"),
  };
}
async function noticeSource(t: TestContext, notices: unknown[]) {
  const root = await source(t);
  const name = "random-provider.json";
  const target = path.join(root, directory, name);
  const record = JSON.parse(await readFile(target, "utf8"));
  record.syntheticOriginalNoticeControls = notices;
  await writeFile(target, JSON.stringify(record));
  await reindex(root, name);
  return root;
}
test("artifact evidence verifies lossless compressed original notices while retaining incomplete attribution", async (t) => {
  const bytes = Buffer.from(
    "Original synthetic copyright\nLicense text\n",
    "utf8",
  );
  const baseline = await audit(repository);
  assert.equal(baseline.code, 0, baseline.stderr);
  const before = JSON.parse(baseline.stdout);
  const root = await noticeSource(t, [compressedNotice(bytes)]);
  const result = await audit(root);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(
    report.compressedOriginalNoticeObjects,
    before.compressedOriginalNoticeObjects + 1,
  );
  assert.equal(
    report.decompressedOriginalNoticeBytes,
    before.decompressedOriginalNoticeBytes + bytes.length,
  );
  assert.equal(report.gateAComplete, false);
  assert.equal(report.qualityAssessed, false);
  assert.equal(report.nativeAcceptanceAssessed, false);
});
test("artifact evidence refuses malformed ambiguous and altered compressed original notices", async (t) => {
  const original = compressedNotice(Buffer.from("Original synthetic notice\n"));
  for (const mode of [
    "encoding",
    "compressed-digest",
    "digest",
    "size",
    "ambiguous",
    "stream",
  ]) {
    const changed = { ...original } as Record<string, unknown>;
    if (mode === "encoding")
      changed.originalBytesGzipBase64 = original.originalBytesGzipBase64 + " ";
    if (mode === "compressed-digest") changed.gzipSha256 = "f".repeat(64);
    if (mode === "digest") changed.sha256 = "f".repeat(64);
    if (mode === "size") changed.gzipBytes = original.gzipBytes + 1;
    if (mode === "ambiguous") changed.originalBytesBase64 = "eA==";
    if (mode === "stream") {
      const invalid = Buffer.from("Original synthetic non-gzip bytes");
      changed.originalBytesGzipBase64 = invalid.toString("base64");
      changed.gzipSha256 = digest(invalid);
      changed.gzipBytes = invalid.length;
    }
    const result = await audit(await noticeSource(t, [changed]));
    assert.equal(result.code, 2, mode);
    assert.match(result.stderr, /original notice/i, mode);
  }
});
test("artifact evidence stops compressed expansion at its declared output boundary", async (t) => {
  const oversized = compressedNotice(Buffer.alloc(65536, "x"));
  oversized.bytes = 1;
  const result = await audit(await noticeSource(t, [oversized]));
  assert.equal(result.code, 2);
  assert.match(result.stderr, /exceeds its declared expansion bound/);
});
test("artifact evidence bounds cumulative decompressed notice bytes separately from indexed bytes", async (t) => {
  const notice = compressedNotice(Buffer.alloc(2 * 1024 * 1024, "x"));
  const result = await audit(
    await noticeSource(
      t,
      Array.from({ length: 5 }, () => ({ ...notice })),
    ),
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Total original notice byte bound exceeded/);
});

function uncompressedNotice(bytes: Uint8Array) {
  return {
    bytes: bytes.length,
    sha256: digest(bytes),
    originalBytesBase64: Buffer.from(bytes).toString("base64"),
  };
}
test("artifact evidence verifies exact uncompressed original notice bytes without normalizing text", async (t) => {
  const bytes = Buffer.from("Original synthetic notice\r\n", "utf8");
  const baseline = await audit(repository);
  assert.equal(baseline.code, 0, baseline.stderr);
  const before = JSON.parse(baseline.stdout);
  const result = await audit(
    await noticeSource(t, [uncompressedNotice(bytes)]),
  );
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(
    report.uncompressedOriginalNoticeObjects,
    before.uncompressedOriginalNoticeObjects + 1,
  );
  assert.equal(
    report.compressedOriginalNoticeObjects,
    before.compressedOriginalNoticeObjects,
  );
  assert.equal(
    report.originalNoticeBytes,
    before.originalNoticeBytes + bytes.length,
  );
  assert.equal(report.gateAComplete, false);
  assert.equal(report.qualityAssessed, false);
  assert.equal(report.nativeAcceptanceAssessed, false);
});
test("artifact evidence refuses reindexed uncompressed notices with wrong bytes hashes sizes or encoding", async (t) => {
  const bytes = Buffer.from("Original synthetic notice\r\n");
  const original = uncompressedNotice(bytes);
  for (const mode of [
    "changed-bytes",
    "normalized-text",
    "digest",
    "size",
    "encoding",
    "empty",
    "ambiguous",
  ]) {
    const changed = { ...original } as Record<string, unknown>;
    if (mode === "changed-bytes")
      changed.originalBytesBase64 = Buffer.alloc(bytes.length, "x").toString(
        "base64",
      );
    if (mode === "normalized-text")
      changed.originalBytesBase64 = Buffer.from(
        bytes.toString().replaceAll("\r\n", "\n"),
      ).toString("base64");
    if (mode === "digest") changed.sha256 = "f".repeat(64);
    if (mode === "size") changed.bytes = bytes.length + 1;
    if (mode === "encoding")
      changed.originalBytesBase64 = original.originalBytesBase64 + " ";
    if (mode === "empty") changed.originalBytesBase64 = "";
    if (mode === "ambiguous") Object.assign(changed, compressedNotice(bytes));
    const result = await audit(await noticeSource(t, [changed]));
    assert.equal(result.code, 2, mode);
    assert.match(result.stderr, /original notice/i, mode);
  }
});
test("artifact evidence shares one original notice budget across plain and compressed bytes", async (t) => {
  const bytes = Buffer.alloc(32 * 1024, "x");
  const baseline = await audit(repository);
  assert.equal(baseline.code, 0, baseline.stderr);
  const before = JSON.parse(baseline.stdout);
  let fill = 8 * 1024 * 1024 - before.originalNoticeBytes - bytes.length + 1;
  assert.ok(fill > 0);
  const encoded: ReturnType<typeof compressedNotice>[] = [];
  while (fill > 0) {
    const length = Math.min(fill, 2 * 1024 * 1024);
    encoded.push(compressedNotice(Buffer.alloc(length, "x")));
    fill -= length;
  }
  const root = await noticeSource(t, [
    ...encoded,
    uncompressedNotice(Buffer.from("Original synthetic near miss\n")),
  ]);
  const nearMiss = await audit(root);
  assert.equal(nearMiss.code, 0, nearMiss.stderr);
  const refused = await audit(
    await noticeSource(t, [...encoded, uncompressedNotice(bytes)]),
  );
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /Total original notice byte bound exceeded/);
});

async function changedLicenseReferences(t: TestContext, mode: string) {
  const root = await source(t);
  const name = "provider-c-root-sdk-and-generator-replays.json";
  const file = path.join(root, directory, name);
  const value = JSON.parse(await readFile(file, "utf8"));
  const references =
    value.cBuildDependencyNotices.literalCommonLicenseReferences;
  if (mode === "offset") references.references[0][1]++;
  if (mode === "omission") references.references.pop();
  if (mode === "duplicate")
    references.references.push([...references.references[0]]);
  if (mode === "counts")
    references.counts["resolved-captured-shared-license-bytes"]++;
  if (mode === "denominator") references.noticeObjectsScanned++;
  if (mode === "prefix") {
    const missing = references.references.find(
      (row: unknown[]) => row[5] === "unresolved-literal-reference",
    );
    assert.ok(missing);
    const captured =
      value.cBuildDependencyNotices.pinnedBaselineSharedLicenseFiles.find(
        (row: { imagePath: string }) =>
          row.imagePath === "/usr/share/common-licenses/GPL-2",
      );
    assert.ok(captured);
    missing[3] = captured.imagePath;
    missing[5] = "resolved-captured-shared-license-bytes";
    missing[6] = captured.sha256;
    missing[7] = captured.bytes;
  }
  await writeFile(file, JSON.stringify(value));
  await reindex(root, name);
  const wrapperName = "provider-fiat-wrapper-source-rebuilds.json";
  const wrapperFile = path.join(root, directory, wrapperName);
  const wrapper = JSON.parse(await readFile(wrapperFile, "utf8"));
  const reference =
    wrapper.cRootCompilerAndWholeGeneratorFollowUp.retainedInputs.find(
      (entry: Entry) => entry.file === name,
    );
  assert.ok(reference);
  const changedBytes = await readFile(file);
  reference.bytes = changedBytes.length;
  reference.sha256 = digest(changedBytes);
  await writeFile(wrapperFile, JSON.stringify(wrapper));
  await reindex(root, wrapperName);
  return root;
}
test("artifact evidence rederives literal shared license references from exact original notice offsets and filenames", async () => {
  const result = await audit(repository);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout).literalCommonLicenseReferences;
  const record = JSON.parse(
    await readFile(
      path.join(
        repository,
        directory,
        "provider-c-root-sdk-and-generator-replays.json",
      ),
      "utf8",
    ),
  ).cBuildDependencyNotices.literalCommonLicenseReferences;
  assert.equal(report.references, record.references.length);
  assert.deepEqual(report.counts, record.counts);
  assert.equal(report.noticeObjectsScanned, record.noticeObjectsScanned);
  assert.ok(
    record.references.some(
      (row: unknown[]) =>
        row[2] === "/usr/share/common-licenses/GPL-2.0" &&
        row[5] === "unresolved-literal-reference",
    ),
  );
});
test("artifact evidence refuses reindexed omitted duplicated shifted or prefix-guessed shared license references", async (t) => {
  for (const mode of [
    "offset",
    "omission",
    "duplicate",
    "counts",
    "denominator",
    "prefix",
  ]) {
    const result = await audit(await changedLicenseReferences(t, mode));
    assert.equal(result.code, 2, mode);
    assert.match(result.stderr, /Literal license/, mode);
  }
});
