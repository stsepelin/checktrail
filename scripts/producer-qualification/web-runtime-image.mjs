// Developer-only COPY assembly identity, independent of historical publisher use.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
import {
  registryImageIdentity,
  validateObservedImage,
} from "./binutils-image-identity.mjs";
import {
  completeProcessObservation,
  validateNativeHost,
} from "./web-runtime-controller.mjs";
const record = JSON.parse(
  await readFile(
    new URL("./binutils-image-identity.v1.json", import.meta.url),
    "utf8",
  ),
);
export const baseIdentity = registryImageIdentity(record, record.selectedImage);
const acquisition = JSON.parse(
  await readFile(
    new URL("./web-runtime-acquisition.v1.json", import.meta.url),
    "utf8",
  ),
);
assert.equal(acquisition.baseImage, baseIdentity.selectedImage);
export const assemblyDockerfile = `FROM ${baseIdentity.selectedImage}\nCOPY overlay/ /\nLABEL checktrail.producer="web-runtime-v1"\nUSER 0\nENV PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"\nWORKDIR /work\nENTRYPOINT []\nCMD ["node"]\n`;
export const assemblyCommand = (iid, context) => [
  "build",
  "--pull=false",
  "--network=none",
  "--platform=linux/amd64",
  "--no-cache",
  "--iidfile",
  iid,
  context,
];
const digest = (value) =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
const keys = (value, expected) =>
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
const controls = [
  "buildReceipt",
  "iidFile",
  "baseInspection",
  "resultInspection",
  "dockerfile",
  "assemblyControl",
  "copyManifest",
  "authenticationReceipt",
];
function pin(row) {
  keys(row, ["file", "bytes", "sha256"]);
  assert.ok(
    path.isAbsolute(row.file) &&
      Number.isSafeInteger(row.bytes) &&
      row.bytes > 0 &&
      row.bytes <= 536870912 &&
      /^[a-f0-9]{64}$/u.test(row.sha256),
  );
}
export function inspectLocalIdentity(value) {
  keys(value, [
    ...controls,
    "inputs",
    "authentication",
    "baseRef",
    "baseImageId",
    "rootfsDiffIds",
    "baseRootfsDiffIds",
    "rawManifestConfigVerified",
  ]);
  assert.equal(value.baseRef, baseIdentity.selectedImage);
  assert.ok(
    [baseIdentity.manifestDigest, baseIdentity.configDigest].includes(
      value.baseImageId,
    ),
  );
  assert.equal(
    value.rawManifestConfigVerified,
    false,
    "Derived raw OCI bytes have not been independently exported",
  );
  for (const name of controls) pin(value[name]);
  assert.equal(value.inputs.length, acquisition.components.length);
  for (const component of acquisition.components) {
    const rows = value.inputs.filter((row) => row.id === component.name);
    assert.equal(rows.length, 1);
    const { id, ...row } = rows[0];
    assert.equal(id, component.name);
    pin(row);
    assert.equal(row.bytes, component.bytes);
    assert.equal(row.sha256, component.sha256);
  }
  for (const rows of [value.rootfsDiffIds, value.baseRootfsDiffIds])
    assert.ok(
      Array.isArray(rows) &&
        rows.length > 0 &&
        rows.length <= 128 &&
        rows.every(digest),
    );
  assert.deepEqual(value.baseRootfsDiffIds, baseIdentity.rootfsDiffIds);
  assert.ok(value.rootfsDiffIds.length > value.baseRootfsDiffIds.length);
  assert.deepEqual(
    value.rootfsDiffIds.slice(0, value.baseRootfsDiffIds.length),
    value.baseRootfsDiffIds,
  );
}
export async function verifyLocalIdentity(runtime, identify) {
  const value = runtime.local;
  inspectLocalIdentity(value);
  for (const name of controls) {
    const row = value[name];
    assert.deepEqual(
      await identify(row.file, name === "copyManifest" ? 2097152 : 1048576),
      { bytes: row.bytes, sha256: row.sha256 },
    );
  }
  assert.equal(value.authentication.length, acquisition.authentication.length);
  for (const expected of acquisition.authentication) {
    const rows = value.authentication.filter((row) => row.id === expected.file);
    assert.equal(rows.length, 1);
    const { id, ...row } = rows[0];
    assert.equal(id, expected.file);
    pin(row);
    assert.equal(row.bytes, expected.bytes);
    assert.equal(row.sha256, expected.sha256);
    assert.deepEqual(await identify(row.file), {
      bytes: row.bytes,
      sha256: row.sha256,
    });
  }
  const auth = JSON.parse(
    await readFile(value.authenticationReceipt.file, "utf8"),
  );
  assert.equal(auth.schemaVersion, 1);
  assert.equal(auth.proofs.length, 2);
  for (const name of ["node", "rust"]) {
    const rows = auth.proofs.filter((row) => row.name === name);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].signer, acquisition.signers[name]);
    assert.equal(rows[0].signatureVerified, true);
    assert.equal(completeProcessObservation(rows[0].attempt), true);
  }
  for (const { id, ...row } of value.inputs) {
    assert.ok(id);
    assert.deepEqual(await identify(row.file), {
      bytes: row.bytes,
      sha256: row.sha256,
    });
  }
  const receipt = JSON.parse(await readFile(value.buildReceipt.file, "utf8"));
  const base = JSON.parse(await readFile(value.baseInspection.file, "utf8"));
  const result = JSON.parse(
    await readFile(value.resultInspection.file, "utf8"),
  );
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.assemblyKind, "docker-build-copy-only-v1");
  assert.equal(completeProcessObservation(receipt.attempt), true);
  validateNativeHost(receipt.host);
  validateObservedImage(base, baseIdentity);
  assert.equal(base.Id, value.baseImageId);
  assert.equal(
    (await readFile(value.iidFile.file, "utf8")).trim(),
    runtime.imageId,
  );
  assert.equal(receipt.imageId, runtime.imageId);
  assert.equal(receipt.baseRef, value.baseRef);
  assert.equal(receipt.baseImageId, value.baseImageId);
  assert.deepEqual(receipt.rootfsDiffIds, value.rootfsDiffIds);
  assert.deepEqual(receipt.baseRootfsDiffIds, value.baseRootfsDiffIds);
  verifyObservedImage(runtime, result);
  for (const item of [base, result]) assert.ok(!item.Config.OnBuild?.length);
  assert.equal(result.Config.Entrypoint?.length ?? 0, 0);
  assert.deepEqual(result.Config.Cmd, ["node"]);
  assert.equal(result.Config.Labels["checktrail.producer"], "web-runtime-v1");
  assert.equal(receipt.addedLayerBytes, result.Size - base.Size);
  assert.ok(
    receipt.addedLayerBytes > 0 && receipt.addedLayerBytes <= 2147483648,
  );
  assert.equal(
    await readFile(value.dockerfile.file, "utf8"),
    assemblyDockerfile,
  );
  assert.deepEqual(
    receipt.command,
    assemblyCommand(value.iidFile.file, receipt.context),
  );
  assert.ok(path.isAbsolute(receipt.context));
  for (const flag of [
    "rawManifestConfigVerified",
    "registryPublished",
    "compilerExecuted",
    "projectHooksExecuted",
    "historicalPublisherConsumptionVerified",
    "sdkProducerBuildClosureVerified",
    "gateAComplete",
  ])
    assert.equal(receipt[flag], false);
  return {
    localDerivedImageId: runtime.imageId,
    baseRef: value.baseRef,
    baseRawManifestConfigVerified: true,
    rawManifestConfigVerified: false,
    daemonInspectVerified: true,
    historicalPublisherConsumptionVerified: false,
  };
}
export function verifyObservedImage(runtime, observed) {
  assert.equal(observed.Id, runtime.imageId);
  assert.equal(observed.Os, "linux");
  assert.equal(observed.Architecture, "amd64");
  if (runtime.kind === "registry")
    assert.ok(
      observed.RepoDigests.some(
        (ref) =>
          ref === runtime.imageRef ||
          ref === runtime.imageRef.replace(/^docker\.io\//u, ""),
      ),
    );
  else {
    assert.equal(runtime.kind, "local-derived");
    assert.equal(observed.RootFS.Type, "layers");
    assert.deepEqual(observed.RootFS.Layers, runtime.local.rootfsDiffIds);
  }
  return true;
}
