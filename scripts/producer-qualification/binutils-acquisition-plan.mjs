import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { registryImageIdentity } from "./binutils-image-identity.mjs";

const emptySha = createHash("sha256").update("").digest("hex");
const hash = (value) => createHash("sha256").update(value).digest("hex");
export function safeRelative(value) {
  assert.ok(typeof value === "string" && value.length > 0);
  assert.ok(!/[\\\0:]/u.test(value));
  assert.ok(
    value.split("/").every((part) => part && part !== "." && part !== ".."),
  );
  return value;
}
export function pinnedSnapshot(value) {
  assert.match(value, /^https:\/\/snapshot\.debian\.org\/file\/[a-f0-9]{40}$/u);
  return value;
}
export function bytePin(row, maximum = 64 * 1024 ** 2) {
  assert.ok(
    Number.isSafeInteger(row.bytes) && row.bytes >= 0 && row.bytes <= maximum,
  );
  assert.match(row.sha256, /^[a-f0-9]{64}$/u);
  return { bytes: row.bytes, sha256: row.sha256 };
}

/** Pure data planning. No executable, filesystem, network or image is opened. */
export function acquisitionPlan(recipe, preparation) {
  assert.equal(recipe.schemaVersion, 1);
  assert.equal(recipe.profile, "original-debian-binutils-2.40-2-build-v1");
  assert.deepEqual(recipe.command, [
    "dpkg-buildpackage",
    "-b",
    "-us",
    "-uc",
    "--jobs=4",
  ]);
  assert.equal(recipe.sourceFilesPatched, false);
  assert.equal(recipe.originalBuildChecksDisabled, false);
  assert.equal(recipe.originalDefaultTargetsDisabled, false);
  assert.equal(recipe.inputAuthenticationDisabled, false);
  assert.equal(preparation.schemaVersion, 1);
  assert.equal(preparation.inputProfile, recipe.profile);
  assert.equal(preparation.selectedImage, recipe.image);
  assert.equal(recipe.platform, "linux/amd64");
  assert.equal(preparation.allPinnedCompressedIndexesExactlyRegenerated, true);
  const files = new Map();
  for (const row of recipe.files) {
    safeRelative(row.file);
    assert.ok(!files.has(row.file), "Duplicate original pinned file");
    files.set(row.file, bytePin(row));
  }
  assert.equal(files.size, 350, "Changed frozen input inventory");
  const serialization = recipe.files.map(({ file, bytes, sha256 }) => ({
    file,
    bytes,
    sha256,
  }));
  const pinsSha = hash(JSON.stringify(serialization));
  assert.equal(
    pinsSha,
    preparation.selectedInputPinsSha256,
    "Original preparation record is stale",
  );
  const operations = [];
  const downloads = [];
  const claimed = new Set();
  const consume = (file) => {
    assert.ok(
      files.has(file) && !claimed.has(file),
      "Missing or repeated acquisition output: " + file,
    );
    claimed.add(file);
    return files.get(file);
  };
  const download = (id, pin, url) => {
    safeRelative(id);
    bytePin(pin);
    assert.ok(pin.bytes > 0, "Downloaded object is empty");
    assert.ok(
      !downloads.some((row) => row.id === id),
      "Duplicate download object",
    );
    const row = { id, ...bytePin(pin), url: pinnedSnapshot(url) };
    downloads.push(row);
    return row;
  };
  for (const row of recipe.files) {
    if (row.snapshotFileUrl !== undefined) {
      const pin = consume(row.file);
      operations.push({
        kind: "copy-original-download",
        file: row.file,
        input: download(row.file, pin, row.snapshotFileUrl).id,
        ...pin,
      });
    }
  }
  const origins = recipe.inputOrigins;
  assert.equal(origins.aptIndexes.length, 3);
  for (const [index, row] of origins.aptIndexes.entries()) {
    assert.ok(
      files.has(row.inReleaseFile) && claimed.has(row.inReleaseFile),
      "Original signed release is missing",
    );
    assert.equal(
      row.inReleaseSnapshotFileUrl,
      recipe.files.find((file) => file.file === row.inReleaseFile)
        .snapshotFileUrl,
    );
    const pin = consume(row.retainedPackagesFile);
    assert.deepEqual(
      bytePin(row.downloadedPackagesXz),
      bytePin(preparation.freshCompressedInputs[index]),
    );
    assert.deepEqual(
      bytePin(row.canonicalPackagesPayload),
      bytePin(preparation.canonicalPayloads[index]),
    );
    assert.deepEqual(
      { file: row.retainedPackagesFile, ...pin },
      {
        file: preparation.regeneratedPinnedIndexes[index].file,
        ...bytePin(preparation.regeneratedPinnedIndexes[index]),
      },
    );
    const input = download(
      "preparation/index-" + index + ".xz",
      row.downloadedPackagesXz,
      row.downloadedPackagesXz.snapshotFileUrl,
    );
    bytePin(row.canonicalPackagesPayload);
    assert.ok(row.canonicalPackagesPayload.bytes > 0);
    operations.push({
      kind: "original-apt-store-transform",
      file: row.retainedPackagesFile,
      input: input.id,
      inRelease: row.inReleaseFile,
      canonicalPayload: bytePin(row.canonicalPackagesPayload),
      ...pin,
    });
  }
  const signer = origins.sourceSignerKeyring;
  assert.equal(signer.sourcePackage.package, "debian-keyring");
  assert.equal(signer.sourcePackage.version, "2022.12.24");
  assert.equal(signer.archiveMember, "usr/share/keyrings/debian-keyring.gpg");
  assert.equal(signer.isAptArchiveKeyring, false);
  const keyring = consume(signer.retainedFile);
  operations.push({
    kind: "extract-fixed-regular-keyring-member",
    file: signer.retainedFile,
    input: download(
      "preparation/debian-keyring_2022.12.24_all.deb",
      signer.sourcePackage,
      signer.snapshotFileUrl,
    ).id,
    member: signer.archiveMember,
    ...keyring,
  });
  assert.deepEqual([...origins.emptyLocallyGeneratedFiles].sort(), [
    "apt-archives/binutils/lock",
    "apt-lists/lock",
  ]);
  for (const file of origins.emptyLocallyGeneratedFiles) {
    const pin = consume(file);
    assert.deepEqual(pin, { bytes: 0, sha256: emptySha });
    operations.push({ kind: "generate-empty-lock", file, ...pin });
  }
  assert.deepEqual(
    [...claimed].sort(),
    [...files.keys()].sort(),
    "Unclassified original input",
  );
  assert.equal(downloads.length, 348);
  assert.equal(operations.length, 350);
  const downloadBytes = downloads.reduce((sum, row) => sum + row.bytes, 0);
  const bundleBytes = [...files.values()].reduce(
    (sum, row) => sum + row.bytes,
    0,
  );
  assert.ok(downloadBytes < 1024 ** 3 && bundleBytes < 1024 ** 3);
  const counts = Object.fromEntries(
    [
      "copy-original-download",
      "original-apt-store-transform",
      "extract-fixed-regular-keyring-member",
      "generate-empty-lock",
    ].map((kind) => [
      kind,
      operations.filter((row) => row.kind === kind).length,
    ]),
  );
  assert.deepEqual(Object.values(counts), [344, 3, 1, 2]);
  return {
    schemaVersion: 1,
    profile: "original-binutils-public-input-acquisition-v1",
    selectedInputPinsSha256: pinsSha,
    transform: {
      image: recipe.image,
      platform: recipe.platform,
      preparationObjectSha256: hash(JSON.stringify(preparation)),
      observedImageId: preparation.observedImageId,
      toolIdentities: globalThis.structuredClone(
        preparation.imageProvidedToolAndArchiveKeyringIdentities,
      ),
    },
    downloads,
    operations,
    counts,
    downloadBytes,
    bundleBytes,
    limits: {
      workers: 4,
      perFileMs: 180000,
      transformMs: 120000,
      retainedBytes: 2 * 1024 ** 3,
    },
    compilationExecuted: false,
    originalPackageBuildExecuted: false,
    bundleAcquisitionExecuted: false,
    completeInputBundleReacquisitionVerified: false,
    fullCompilerSdkBootstrapClosureVerified: false,
    gateAComplete: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  };
}

export async function loadAcquisitionPlan() {
  const directory = fileURLToPath(new URL("./", import.meta.url));
  const { identifyFile, validateInputs } =
    await import("../qualify-binutils-producer.mjs");
  const sources = [
    fileURLToPath(import.meta.url),
    path.join(directory, "binutils.v1.json"),
    path.join(directory, "binutils-apt-index-preparation.v1.json"),
    path.join(directory, "../qualify-binutils-producer.mjs"),
    path.join(directory, "binutils-image-identity.v1.json"),
    path.join(directory, "binutils-image-identity.mjs"),
  ].map((file) => path.resolve(file));
  const before = await Promise.all(
    sources.map((file) => identifyFile(file, 1048576)),
  );
  const recipeBytes = await readFile(sources[1]);
  const preparationBytes = await readFile(sources[2]);
  assert.equal(hash(recipeBytes), before[1].sha256);
  assert.equal(hash(preparationBytes), before[2].sha256);
  const recipe = JSON.parse(recipeBytes.toString("utf8"));
  const preparation = JSON.parse(preparationBytes.toString("utf8"));
  await validateInputs(directory, recipe.controllerFiles);
  const plan = acquisitionPlan(recipe, preparation);
  const imageRecord = JSON.parse(await readFile(sources[4], "utf8"));
  plan.transform.registryIdentity = registryImageIdentity(
    imageRecord,
    recipe.image,
  );
  const after = await Promise.all(
    sources.map((file) => identifyFile(file, 1048576)),
  );
  assert.deepEqual(after, before, "Planning inputs changed");
  return {
    ...plan,
    planningSourceIdentities: before,
    planningInputsUnchanged: true,
    physicalControllerPinsVerified: true,
    remoteAvailabilityVerified: false,
    actualModuleLoadsTraced: false,
  };
}

async function main(args) {
  assert.deepEqual(args, ["--plan-only"]);
  process.stdout.write(JSON.stringify(await loadAcquisitionPlan()) + "\n");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main(process.argv.slice(2));
  } catch {
    process.stderr.write(
      "Original binutils input plan is invalid or unavailable\n",
    );
    process.exitCode = 2;
  }
}
