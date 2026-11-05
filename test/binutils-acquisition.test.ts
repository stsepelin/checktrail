import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const repository = fileURLToPath(new URL("../../", import.meta.url));
const {
  acquisitionPlan,
  loadAcquisitionPlan,
  safeRelative,
  pinnedSnapshot,
  bytePin,
} = await import(
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

const acquisitionSourceNames = [
  "binutils-acquisition-plan.mjs",
  "binutils.v1.json",
  "binutils-apt-index-preparation.v1.json",
  "../qualify-binutils-producer.mjs",
  "binutils-image-identity.v1.json",
  "binutils-image-identity.mjs",
  "binutils-prepare-inputs.py",
  "../acquire-binutils-inputs.mjs",
];

function acquisitionFixture(context: TestContext) {
  const temporary = realpathSync(
    mkdtempSync(path.join(tmpdir(), "checktrail-acquisition-sources-")),
  );
  context.after(() => rmSync(temporary, { recursive: true, force: true }));
  const directory = path.join(temporary, "producer-qualification");
  mkdirSync(directory);
  for (const name of acquisitionSourceNames) {
    const target = path.resolve(directory, name);
    if (name.endsWith(".json")) copyFileSync(path.join(root, name), target);
    else writeFileSync(target, "// Synthetic source identity fixture\n");
  }
  return directory;
}

test("current data-only acquisition binds its eight actual sources while leaving native controller admission separate", async () => {
  const plan = await loadAcquisitionPlan();
  assert.deepEqual(
    plan.planningSourceIdentities.map(
      (source: { file: string }) => source.file,
    ),
    acquisitionSourceNames,
  );
  assert.equal(plan.physicalAcquisitionSourcesVerified, true);
  assert.equal(plan.nativeBuildControllerPinsVerified, false);
  assert.equal(plan.planningInputsUnchanged, true);
  assert.equal(plan.compilationExecuted, false);
  assert.equal(plan.bundleAcquisitionExecuted, false);
  for (const source of plan.planningSourceIdentities) {
    assert.ok(source.bytes > 0 && source.bytes <= 1048576);
    assert.match(source.sha256, /^[a-f0-9]{64}$/);
  }
});

test("data-only acquisition accepts a complete source set without native observer or build-controller files", async (context) => {
  const directory = acquisitionFixture(context);
  const plan = await loadAcquisitionPlan(directory);
  assert.equal(plan.operations.length, recipe.files.length);
  assert.equal(plan.downloads.length, 348);
  assert.equal(plan.nativeBuildControllerPinsVerified, false);
  assert.equal(plan.physicalAcquisitionSourcesVerified, true);
});

test("data-only acquisition refuses a missing transform helper before returning a plan", async (context) => {
  const directory = acquisitionFixture(context);
  rmSync(path.join(directory, "binutils-prepare-inputs.py"));
  await assert.rejects(
    loadAcquisitionPlan(directory),
    (error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" &&
      error.path === path.join(directory, "binutils-prepare-inputs.py"),
  );
});

test(
  "data-only acquisition refuses a linked transform helper even when its bytes match",
  {
    skip:
      process.platform === "win32"
        ? "File symlink fixture requires POSIX permissions"
        : false,
  },
  async (context) => {
    const directory = acquisitionFixture(context);
    const helper = path.join(directory, "binutils-prepare-inputs.py");
    const body = readFileSync(helper);
    rmSync(helper);
    writeFileSync(path.join(directory, "authored-helper.data"), body);
    symlinkSync("authored-helper.data", helper);
    await assert.rejects(loadAcquisitionPlan(directory), /Linked path refused/);
  },
);

test("data-only acquisition refuses an oversized transform helper", async (context) => {
  const directory = acquisitionFixture(context);
  writeFileSync(
    path.join(directory, "binutils-prepare-inputs.py"),
    Buffer.alloc(1048577),
  );
  await assert.rejects(
    loadAcquisitionPlan(directory),
    /Input exceeds byte bound/,
  );
});
