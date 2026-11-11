import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { promisify } from "node:util";
import { parseAllDocuments } from "yaml";
import { z } from "zod";
import { kotlinRead } from "../dist/src/kotlin-io.js";
import { terraformExtensionsProvider as provider } from "../dist/src/terraform-extensions-contract.js";
import {
  readRandomReleaseProof,
  randomPreparedIdentity,
  randomPreparedFileNames,
  randomReleaseSignaturePolicy,
} from "../dist/src/terraform-release-signature.js";
import {
  readTerraformSignatureCases,
  validateTerraformSignatureReceipt,
} from "./verify-terraform-signature-installed.mjs";
const repository = fileURLToPath(new URL("../", import.meta.url));
const invoke = promisify(execFile),
  hash = (body) => createHash("sha256").update(body).digest("hex");
const manifestSchema = z.strictObject({
  preparedProvider: z.literal(provider.address),
  version: z.literal(provider.version),
  archiveSha256: z.literal(provider.archiveSha256),
  memberCount: z.literal(provider.members.length),
  releaseSignatureVerified: z.literal(true),
  providerRoot: z.string().min(1),
  proofSha256: z.string().regex(/^[a-f0-9]{64}$/),
  scope: z.literal("selected-release-checksum-signature"),
  keyOwnerTrustEstablished: z.literal(false),
  publisherAndLicenseClosureVerified: z.literal(false),
});
function strictJson(body) {
  const text = new globalThis.TextDecoder("utf-8", { fatal: true }).decode(
      body,
    ),
    value = JSON.parse(text),
    docs = parseAllDocuments(text, {
      strict: true,
      uniqueKeys: true,
      prettyErrors: false,
    });
  assert.ok(
    docs.length === 1 && !docs[0].errors.length && !docs[0].warnings.length,
    "Signature preparation JSON is ambiguous",
  );
  return value;
}
export function validateTerraformSignaturePreparationManifest(value, root) {
  assert.ok(path.isAbsolute(root));
  const manifest = manifestSchema.parse(value);
  assert.equal(
    manifest.providerRoot,
    path.join(
      root,
      ".checktrail/terraform-extensions-signed-tools",
      manifest.proofSha256,
    ),
  );
  return manifest;
}
export async function readTerraformSignaturePreparation(
  file,
  source = repository,
) {
  assert.ok(path.isAbsolute(file));
  assert.equal(await realpath(file), file);
  const root = await realpath(source),
    body = await kotlinRead(file, 64 * 1024),
    manifest = validateTerraformSignaturePreparationManifest(
      strictJson(body),
      root,
    ),
    qualified = manifest.providerRoot;
  assert.equal(await realpath(qualified), qualified);
  const info = await lstat(qualified);
  assert.ok(info.isDirectory() && !info.isSymbolicLink());
  assert.deepEqual(
    (await readdir(qualified)).sort(),
    randomPreparedFileNames(manifest.proofSha256),
  );
  const reference = readRandomReleaseProof(qualified, manifest.proofSha256);
  assert.ok(reference);
  const identityBody = await kotlinRead(
      path.join(qualified, "identity.json"),
      64 * 1024,
    ),
    identity = strictJson(identityBody);
  assert.ok(
    [
      "operator-prepared-artifact",
      "https://releases.hashicorp.com/terraform-provider-random/3.9.1/" +
        provider.archive,
    ].includes(identity.archiveSource),
  );
  assert.deepEqual(
    identity,
    randomPreparedIdentity(identity.archiveSource, reference),
  );
  const cohort = [];
  for (const pin of randomReleaseSignaturePolicy.payloads) {
    const content = await kotlinRead(path.join(qualified, pin.path), pin.bytes);
    assert.equal(content.length, pin.bytes);
    assert.equal(hash(content), pin.sha256);
    cohort.push({ ...pin });
  }
  cohort.push({
    path: "identity.json",
    bytes: identityBody.length,
    sha256: hash(identityBody),
  });
  const proof = await kotlinRead(
    path.join(qualified, "release-signature-proof.json"),
    256 * 1024,
  );
  assert.equal(hash(proof), manifest.proofSha256);
  cohort.push({
    path: "release-signature-proof.json",
    bytes: proof.length,
    sha256: hash(proof),
  });
  return { manifest, reference, cohort, manifestSha256: hash(body) };
}
export async function verifyTerraformSignatureContainer(file) {
  const prepared = await readTerraformSignaturePreparation(file),
    cases = await readTerraformSignatureCases();
  const identity = strictJson(
    await kotlinRead(
      path.join(repository, ".checktrail/infra-tools-runtime/identity.json"),
      64 * 1024,
    ),
  );
  const image = identity.image,
    task = identity.task;
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  assert.match(task, /^[a-z][a-z0-9-]{0,80}$/);
  const [observed] = JSON.parse(
    execFileSync("docker", ["image", "inspect", image], { encoding: "utf8" }),
  );
  assert.equal(observed.Id, image);
  assert.equal(observed.Config.Labels["checktrail.task"], task);
  const cache = execFileSync("npm", ["config", "get", "cache"], {
    encoding: "utf8",
  }).trim();
  assert.ok(path.isAbsolute(cache));
  assert.equal(await realpath(cache), cache);
  const sourceRoot = await realpath(repository),
    qualified =
      "/workspace/" +
      path
        .relative(sourceRoot, prepared.manifest.providerRoot)
        .split(path.sep)
        .join("/"),
    pin = prepared.manifest.proofSha256;
  const abort = new globalThis.AbortController(),
    interrupted = () => abort.abort(),
    cleanup = [];
  process.once("SIGTERM", interrupted);
  process.once("SIGINT", interrupted);
  function removeOwned(name, role) {
    const list = () =>
      execFileSync(
        "docker",
        ["container", "ls", "-aq", "--filter", "name=^/" + name + "$"],
        { encoding: "utf8" },
      ).trim();
    for (const id of list().split("\n").filter(Boolean)) {
      const [entry] = JSON.parse(
        execFileSync("docker", ["container", "inspect", id], {
          encoding: "utf8",
        }),
      );
      assert.equal(entry.Name, "/" + name);
      assert.equal(entry.Config.Labels["checktrail.task"], task);
      assert.equal(entry.Image, image);
      execFileSync("docker", ["container", "rm", "-f", id], { stdio: "pipe" });
    }
    assert.equal(list(), "", "Owned signature container remains");
    cleanup.push({ role, containerAbsent: true });
  }
  async function run(role, args) {
    const name =
      "checktrail-terraform-signature-" +
      randomUUID().replaceAll("-", "") +
      "-" +
      role;
    try {
      const result = await invoke(
        "docker",
        [
          "run",
          "--rm",
          "--init",
          "--name",
          name,
          "--label",
          "checktrail.task=" + task,
          "--network",
          "none",
          "--read-only",
          "--user",
          "1000:1000",
          "--cpus",
          "2",
          "--memory",
          "3g",
          "--pids-limit",
          "256",
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,exec,size=2048m",
          "--mount",
          `type=bind,src=${sourceRoot},target=/workspace,readonly`,
          "--mount",
          `type=bind,src=${cache},target=/prepared-cache,readonly`,
          "--env",
          "npm_config_cache=/tmp/npm-cache",
          "--workdir",
          "/workspace",
          image,
          ...args,
        ],
        {
          encoding: "utf8",
          timeout: 1200000,
          maxBuffer: 4 * 1024 * 1024,
          signal: abort.signal,
        },
      );
      process.stderr.write(result.stderr);
      return JSON.parse(result.stdout);
    } finally {
      removeOwned(name, role);
    }
  }
  try {
    const source = validateTerraformSignatureReceipt(
      await run("source", [
        "node",
        "scripts/verify-terraform-signature-installed.mjs",
        "source",
        qualified,
        pin,
      ]),
      cases,
      "source",
    );
    const installed = validateTerraformSignatureReceipt(
      await run("installed", [
        "/bin/sh",
        "-c",
        'node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache > /tmp/terraform-signature-cache.json && node scripts/verify-terraform-signature-installed.mjs installed "$1" "$2"',
        "terraform-signature-installed",
        qualified,
        pin,
      ]),
      cases,
      "installed",
    );
    assert.deepEqual(
      await readTerraformSignaturePreparation(file),
      prepared,
      "Signed provider preparation changed during acceptance",
    );
    return {
      schemaVersion: 1,
      profile: "random-operator-pinned-release-checksum-signature",
      preparation: {
        manifestSha256: prepared.manifestSha256,
        reference: prepared.reference,
        cohort: prepared.cohort,
      },
      caseManifestSha256: cases.sha256,
      requiredCaseNames: cases.requiredCaseNames,
      source,
      installed,
      cleanup,
      runtime: {
        image,
        maxConcurrentContainers: 1,
        uid: 1000,
        cpus: 2,
        memoryMiB: 3072,
        pids: 256,
        temporaryFilesystemMiB: 2048,
        network: "none",
        rootFilesystemReadonly: true,
        sourceMountReadonly: true,
        preparedCacheReadonly: true,
      },
      complete: true,
      keyOwnerTrustEstablished: false,
      keyValidityAssessed: false,
      fullArtifactClosureClaimed: false,
      gateAComplete: false,
    };
  } finally {
    process.removeListener("SIGTERM", interrupted);
    process.removeListener("SIGINT", interrupted);
  }
}
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  assert.equal(
    process.argv.length,
    3,
    "Pass the absolute signed provider preparation manifest path",
  );
  process.stdout.write(
    JSON.stringify(await verifyTerraformSignatureContainer(process.argv[2])) +
      "\n",
  );
}
