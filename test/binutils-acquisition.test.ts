import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const repository = fileURLToPath(new URL("../../", import.meta.url));
const { acquisitionPlan, safeRelative, pinnedSnapshot, bytePin } = await import(
  pathToFileURL(
    path.join(
      repository,
      "scripts/producer-qualification/binutils-acquisition-plan.mjs",
    ),
  ).href
);
const root = path.join(repository, "scripts/producer-qualification") + path.sep;
const recipe = JSON.parse(readFileSync(root + "binutils.v1.json", "utf8"));
const preparation = JSON.parse(
  readFileSync(root + "binutils-apt-index-preparation.v1.json", "utf8"),
);
const changed = (edit: (value: typeof recipe) => void) => {
  const next = structuredClone(recipe);
  edit(next);
  return next;
};
test("actual original acquisition plan partitions every350output and348download without changing source declarations", () => {
  const before = JSON.stringify(recipe);
  const plan: {
    downloads: { id: string }[];
    operations: { file: string }[];
    counts: Record<string, number>;
    downloadBytes: number;
    bundleBytes: number;
    [key: string]: unknown;
  } = acquisitionPlan(recipe, preparation);
  assert.equal(plan.downloads.length, 348);
  assert.equal(plan.operations.length, 350);
  assert.equal(plan.downloadBytes, 798581244);
  assert.equal(plan.bundleBytes, 807041299);
  assert.equal(new Set(plan.downloads.map((x) => x.id)).size, 348);
  assert.equal(new Set(plan.operations.map((x) => x.file)).size, 350);
  assert.equal(
    Object.values(plan.counts).reduce((a, b) => a + b),
    350,
  );
  for (const key of [
    "compilationExecuted",
    "originalPackageBuildExecuted",
    "bundleAcquisitionExecuted",
    "completeInputBundleReacquisitionVerified",
    "fullCompilerSdkBootstrapClosureVerified",
    "gateAComplete",
    "inferenceInvoked",
    "fieldEvaluationExecuted",
  ])
    assert.equal(plan[key], false);
  assert.equal(JSON.stringify(recipe), before);
});
test("snapshot allowlist is exact at scheme host path identifier and suffix boundaries", () => {
  const good = "https://snapshot.debian.org/file/" + "a".repeat(40);
  assert.equal(pinnedSnapshot(good), good);
  for (const bad of [
    good + "\n",
    good + "\r\n",
    good + "\u2028",
    good + "\u2029",
    good + "/x",
    good + "?x=y",
    good + "#fragment",
    good.replace("snapshot.debian.org", "snapshot.debian.org.evil.example"),
    good.replace("https:", "http:"),
    good.replace("https://", "https://user@"),
    good.replace("a".repeat(40), "A".repeat(40)),
  ])
    assert.throws(() => pinnedSnapshot(bad));
});
test("literal archive paths reject traversal absolute paths and decoding ambiguities without rewriting epoch names", () => {
  for (const bad of [
    "/tmp/x",
    "../x",
    "a/../x",
    "a//b",
    "a/./b",
    "C:/x",
    "a\\b",
    "a\0b",
    "",
  ])
    assert.throws(() => safeRelative(bad));
  assert.equal(
    safeRelative("apt-archives/binutils/gcc_4%3a12_amd64.deb"),
    "apt-archives/binutils/gcc_4%3a12_amd64.deb",
  );
  assert.equal(safeRelative("literal%2fvalue"), "literal%2fvalue");
});
test("a coherent pin change cannot reuse the original preparation record", () => {
  assert.throws(
    () =>
      acquisitionPlan(
        changed((r: typeof recipe) => (r.files[0].sha256 = "b".repeat(64))),
        preparation,
      ),
    /preparation record is stale/,
  );
  assert.throws(
    () =>
      acquisitionPlan(
        changed((r: typeof recipe) =>
          r.files.push(structuredClone(r.files[0])),
        ),
        preparation,
      ),
    /Duplicate original/,
  );
});
test("two regenerated indexes cannot claim the same output or invent an uncaptured release", () => {
  assert.throws(
    () =>
      acquisitionPlan(
        changed(
          (r: typeof recipe) =>
            (r.inputOrigins.aptIndexes[1].retainedPackagesFile =
              r.inputOrigins.aptIndexes[0].retainedPackagesFile),
        ),
        preparation,
      ),
    /repeated acquisition output/,
  );
  assert.throws(
    () =>
      acquisitionPlan(
        changed(
          (r: typeof recipe) =>
            (r.inputOrigins.aptIndexes[0].inReleaseFile = "missing"),
        ),
        preparation,
      ),
    /signed release is missing/,
  );
});
test("transform canonical bytes compressed input pins image and output remain bound to the original preparation", () => {
  for (const edit of [
    (r: typeof recipe) =>
      (r.inputOrigins.aptIndexes[0].canonicalPackagesPayload.sha256 =
        "b".repeat(64)),
    (r: typeof recipe) =>
      r.inputOrigins.aptIndexes[0].downloadedPackagesXz.bytes++,
    (r: typeof recipe) => (r.image = "unselected-image"),
  ])
    assert.throws(() => acquisitionPlan(changed(edit), preparation));
});
test("developer signer remains separate from archive keyring and fixed to its regular member", () => {
  for (const edit of [
    (r: typeof recipe) =>
      (r.inputOrigins.sourceSignerKeyring.isAptArchiveKeyring = true),
    (r: typeof recipe) =>
      (r.inputOrigins.sourceSignerKeyring.archiveMember = "usr/share/other"),
    (r: typeof recipe) =>
      (r.inputOrigins.sourceSignerKeyring.sourcePackage.version = "2022.12.25"),
  ])
    assert.throws(() => acquisitionPlan(changed(edit), preparation));
});
test("empty generated locks cannot become downloads or suppress an original output", () => {
  assert.throws(() =>
    acquisitionPlan(
      changed((r: typeof recipe) =>
        r.inputOrigins.emptyLocallyGeneratedFiles.pop(),
      ),
      preparation,
    ),
  );
  assert.throws(
    () =>
      acquisitionPlan(
        changed(
          (r: typeof recipe) =>
            (r.files.find(
              (x: { file: string }) => x.file === "apt-lists/lock",
            ).snapshotFileUrl =
              "https://snapshot.debian.org/file/" + "a".repeat(40)),
        ),
        preparation,
      ),
    /Downloaded object is empty/,
  );
});
test("byte bounds reject unsafe limits and malformed hashes at valid adjacent boundaries", () => {
  assert.deepEqual(bytePin({ bytes: 0, sha256: "0".repeat(64) }), {
    bytes: 0,
    sha256: "0".repeat(64),
  });
  assert.equal(
    bytePin({ bytes: 67108864, sha256: "0".repeat(64) }).bytes,
    67108864,
  );
  for (const bytes of [-1, 67108865, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => bytePin({ bytes, sha256: "0".repeat(64) }));
  assert.throws(() => bytePin({ bytes: 1, sha256: "0".repeat(63) }));
  assert.throws(() => bytePin({ bytes: 1, sha256: "0".repeat(64) + "\n" }));
});

test("original preparation schema is required before returning a usable input declaration", () => {
  const unsupported = structuredClone(preparation);
  unsupported.schemaVersion = 2;
  assert.throws(() => acquisitionPlan(recipe, unsupported));
  assert.throws(() =>
    acquisitionPlan(
      changed((value: typeof recipe) => {
        value.schemaVersion = 2;
      }),
      preparation,
    ),
  );
});
