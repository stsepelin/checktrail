import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { fixture } from "./helpers.js";
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const dataRoot = fileURLToPath(
  new URL(
    "../../test/fixtures/release-signature/preparation/",
    import.meta.url,
  ),
);
async function setup(t: TestContext) {
  const root = await realpath(
    await fixture(t, { "package.json": '{"type":"module"}' }),
  );
  await mkdir(path.join(root, "scripts"));
  await mkdir(path.join(root, "dist/src"), { recursive: true });
  await symlink(
    path.join(sourceRoot, "node_modules"),
    path.join(root, "node_modules"),
    "dir",
  );
  const metadata = JSON.parse(
    await readFile(path.join(dataRoot, "metadata.json"), "utf8"),
  );
  for (const name of [
    "prepare-terraform-extensions-runtime.mjs",
    "release-signature-preparation.mjs",
  ])
    await cp(
      path.join(sourceRoot, "scripts", name),
      path.join(root, "scripts", name),
    );
  await writeFile(
    path.join(root, "scripts/request-pinned-artifact.mjs"),
    'export async function requestPinnedArtifactBytes(){throw Error("Synthetic preparation must remain offline")};\n',
  );
  await writeFile(
    path.join(root, "dist/src/terraform-extensions-contract.js"),
    "export const terraformExtensionsProvider=" +
      JSON.stringify(metadata.provider) +
      ";\n",
  );
  await writeFile(
    path.join(root, "dist/src/maven.js"),
    'import{createHash}from"node:crypto";export const mavenHash=bytes=>createHash("sha256").update(bytes).digest("hex");\n',
  );
  await cp(
    path.join(sourceRoot, "dist/src/release-signature-proof.js"),
    path.join(root, "dist/src/release-signature-proof.js"),
  );
  const original = await readFile(
    path.join(sourceRoot, "dist/src/terraform-release-signature.js"),
    "utf8",
  );
  const expression =
    /export const randomReleaseSignaturePolicy = \{[\s\S]*?^\};/mu;
  assert.equal(original.match(expression)?.length, 1);
  // Only synthetic literal pins change. Every proof reader and preparation gate is original.
  await writeFile(
    path.join(root, "dist/src/terraform-release-signature.js"),
    original.replace(
      expression,
      "export const randomReleaseSignaturePolicy = " +
        JSON.stringify(metadata.policy) +
        ";",
    ),
  );
  const inputs = path.join(root, "inputs");
  await cp(dataRoot, inputs, { recursive: true });
  return { root, inputs, metadata };
}
function run(root: string, inputs?: string) {
  return spawnSync(
    process.execPath,
    [
      path.join(root, "scripts/prepare-terraform-extensions-runtime.mjs"),
      ...(inputs ? ["--verify-release-signature", inputs] : []),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        CHECKTRAIL_TERRAFORM_RANDOM_ARCHIVE: path.join(
          root,
          "inputs/synthetic-provider.zip",
        ),
      },
      encoding: "utf8",
      timeout: 30000,
    },
  );
}
async function snapshot(directory: string) {
  const result = [];
  for (const name of (await readdir(directory)).sort()) {
    const file = path.join(directory, name),
      info = await stat(file);
    result.push({
      name,
      bytes: (await readFile(file)).toString("base64"),
      mode: info.mode,
      mtimeMs: info.mtimeMs,
    });
  }
  return result;
}
test("Random native preparation atomically publishes and revalidates the exact five-file signed cohort while preserving legacy", async (t) => {
  if (process.platform === "win32")
    return t.skip("Native GPG preparation is selected on POSIX hosts");
  const { root, inputs } = await setup(t),
    legacy = run(root);
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(JSON.parse(legacy.stdout).releaseSignatureVerified, false);
  const prior = await snapshot(
    path.join(root, ".checktrail/terraform-extensions-tools"),
  );
  assert.equal(prior.length, 4);
  const first = run(root, inputs);
  assert.equal(first.status, 0, first.stderr);
  const record = JSON.parse(first.stdout);
  assert.equal(record.releaseSignatureVerified, true);
  assert.equal(record.keyOwnerTrustEstablished, false);
  assert.equal(record.publisherAndLicenseClosureVerified, false);
  assert.equal(
    record.providerRoot,
    path.join(
      root,
      ".checktrail/terraform-extensions-signed-tools",
      record.proofSha256,
    ),
  );
  const cohort = await snapshot(record.providerRoot);
  assert.equal(cohort.length, 5);
  const again = run(root, inputs);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).proofSha256, record.proofSha256);
  assert.deepEqual(await snapshot(record.providerRoot), cohort);
  assert.deepEqual(
    await snapshot(path.join(root, ".checktrail/terraform-extensions-tools")),
    prior,
  );
  const identityPath = path.join(record.providerRoot, "identity.json"),
    originalIdentity = await readFile(identityPath, "utf8");
  await writeFile(
    identityPath,
    originalIdentity.replace("{", '{"schemaVersion":2,'),
  );
  const ambiguous = await snapshot(record.providerRoot),
    ambiguousReuse = run(root, inputs);
  assert.notEqual(
    ambiguousReuse.status,
    0,
    "An ambiguous existing identity cannot be reused as an exact qualified cohort",
  );
  assert.deepEqual(await snapshot(record.providerRoot), ambiguous);
  await writeFile(identityPath, originalIdentity);
  await writeFile(
    path.join(record.providerRoot, "LICENSE.txt"),
    "synthetic changed retained payload\n",
  );
  const corrupted = await snapshot(record.providerRoot),
    refused = run(root, inputs);
  assert.notEqual(refused.status, 0);
  assert.deepEqual(await snapshot(record.providerRoot), corrupted);
  assert.deepEqual(
    await snapshot(path.join(root, ".checktrail/terraform-extensions-tools")),
    prior,
  );
});
test("Random signed publication failure or invalid signature leaves the prior valid legacy cohort untouched", async (t) => {
  if (process.platform === "win32")
    return t.skip("Native GPG preparation is selected on POSIX hosts");
  const { root, inputs, metadata } = await setup(t),
    initial = run(root);
  assert.equal(initial.status, 0, initial.stderr);
  const legacy = path.join(root, ".checktrail/terraform-extensions-tools"),
    before = await snapshot(legacy);
  const source = path.join(
      root,
      "scripts/prepare-terraform-extensions-runtime.mjs",
    ),
    original = await readFile(source, "utf8");
  assert.equal(
    original.split("await rename(temporary, destination);").length,
    2,
  );
  await writeFile(
    source,
    original.replace(
      "await rename(temporary, destination);",
      'throw new Error("Synthetic publication failure before rename");',
    ),
  );
  const failed = run(root, inputs);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Synthetic publication failure/u);
  assert.deepEqual(await snapshot(legacy), before);
  assert.deepEqual(
    await readdir(
      path.join(root, ".checktrail/terraform-extensions-signed-tools"),
    ),
    [],
  );
  await writeFile(source, original);
  const signature = path.join(inputs, "provider-SHA256SUMS.sig"),
    body = await readFile(signature);
  body[20] = body[20]! ^ 1;
  await writeFile(signature, body);
  // Rebind only the synthetic fixture input hash so the altered signature reaches
  // the actual native crypto gate instead of failing the earlier hash check.
  const policyFile = path.join(root, "dist/src/terraform-release-signature.js");
  const policySource = await readFile(policyFile, "utf8");
  const { createHash } = await import("node:crypto");
  await writeFile(
    policyFile,
    policySource.replace(
      metadata.policy.signatures[0].signature.sha256,
      createHash("sha256").update(body).digest("hex"),
    ),
  );
  const invalid = run(root, inputs);
  assert.notEqual(invalid.status, 0);
  assert.match(
    invalid.stderr,
    /Native detached-signature verification did not complete/u,
  );
  assert.deepEqual(await snapshot(legacy), before);
  assert.deepEqual(
    await readdir(
      path.join(root, ".checktrail/terraform-extensions-signed-tools"),
    ),
    [],
  );
});
