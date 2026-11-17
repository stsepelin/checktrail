import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { parseAllDocuments } from "yaml";
import { kotlinRead } from "../dist/src/kotlin-io.js";
import { readFsharpReleaseProof } from "../dist/src/fsharp-format-release-signature.js";
import {
  fsharpSignatureRuntimeModules,
  readFsharpSignatureCases,
  validateFsharpSignatureNativeReceipt,
} from "./verify-fsharp-format-signature-installed.mjs";
const repository = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const hash = (body) => createHash("sha256").update(body).digest("hex");
export function parseFsharpSignaturePreparation(text) {
  assert.ok(Buffer.byteLength(text) > 0 && Buffer.byteLength(text) <= 16384);
  const value = JSON.parse(text),
    docs = parseAllDocuments(text, {
      strict: true,
      uniqueKeys: true,
      prettyErrors: false,
    });
  assert.ok(
    docs.length === 1 && !docs[0].errors.length && !docs[0].warnings.length,
  );
  assert.deepEqual(Object.keys(value).sort(), [
    "completeArtifactAndNoticeClosureVerified",
    "formatterRoot",
    "profile",
    "proofSha256",
    "repositorySignatureVerified",
    "reused",
    "revocationFreshAtRuntime",
    "sdkOriginalProducerVerified",
  ]);
  assert.equal(value.profile, "fantomas-core-default-v1");
  assert.match(value.proofSha256, /^[a-f0-9]{64}$/u);
  assert.equal(typeof value.reused, "boolean");
  assert.equal(value.repositorySignatureVerified, true);
  assert.equal(value.revocationFreshAtRuntime, false);
  assert.equal(value.sdkOriginalProducerVerified, false);
  assert.equal(value.completeArtifactAndNoticeClosureVerified, false);
  assert.equal(
    value.formatterRoot,
    path.join(
      repository,
      ".checktrail/fsharp-format-signed-tools",
      value.proofSha256,
    ),
  );
  return value;
}
export function validateFsharpAcceptanceCacheSubset(value, lockBody) {
  const lock = JSON.parse(lockBody.toString("utf8"));
  const expected = new Set(
    Object.entries(lock.packages)
      .filter(([name, entry]) => name && !entry.dev)
      .map(([, entry]) => entry.integrity),
  );
  assert.deepEqual(Object.keys(value).sort(), [
    "bytes",
    "historicalLocalPackageTarballsCopied",
    "lockSha256",
    "lockedRegistryTarballs",
    "registryMetadataCopied",
  ]);
  assert.ok(expected.size > 0);
  assert.equal(value.lockedRegistryTarballs, expected.size);
  assert.ok(Number.isSafeInteger(value.bytes) && value.bytes > 0);
  assert.equal(value.lockSha256, hash(lockBody));
  assert.equal(value.registryMetadataCopied, false);
  assert.equal(value.historicalLocalPackageTarballsCopied, false);
  return value;
}
export async function verifyFsharpSignatureContainer(manifestFile) {
  const manifest = parseFsharpSignaturePreparation(
    (await kotlinRead(manifestFile, 16384)).toString("utf8"),
  );
  readFsharpReleaseProof(manifest.formatterRoot, manifest.proofSha256);
  const selected =
    process.env.CHECKTRAIL_FSHARP_FORMAT_IMAGE ??
    "checktrail-fsharp-format:10.0.401";
  const image = execFileSync(
    "docker",
    ["image", "inspect", selected, "--format", "{{.Id}}"],
    { encoding: "utf8", timeout: 10000, maxBuffer: 65536 },
  ).trim();
  assert.match(image, /^sha256:[a-f0-9]{64}$/u);
  const cache = execFileSync("npm", ["config", "get", "cache"], {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 65536,
  }).trim();
  assert.ok(path.isAbsolute(cache));
  const cases = await readFsharpSignatureCases(),
    nonce = randomUUID(),
    name = "checktrail-fsharp-proof-chain-" + nonce;
  const files = [
    ...fsharpSignatureRuntimeModules.map((name) => "dist/src/" + name),
    "scripts/verify-fsharp-format-signature-native.mjs",
    "scripts/verify-fsharp-format-signature-installed.mjs",
    "scripts/verify-fsharp-format-signature-container.mjs",
    "scripts/fsharp-format-signature-native-cases.v1.json",
    "scripts/install-acceptance-package.mjs",
    "scripts/prepare-acceptance-cache-subset.mjs",
  ];
  const sourceRows = [];
  for (const file of files) {
    const body = await kotlinRead(path.join(repository, file), 1024 * 1024);
    sourceRows.push({ file, bytes: body.length, sha256: hash(body) });
  }
  const containerRoot =
    "/workspace/.checktrail/fsharp-format-signed-tools/" + manifest.proofSha256;
  const binding =
    "import{readFileSync}from'node:fs';import{createHash}from'node:crypto';const files=" +
    JSON.stringify(files) +
    ";process.stdout.write(JSON.stringify(files.map(file=>{const b=readFileSync(file);return{file,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')}}))+'\\n');";
  const args = [
    "run",
    "--rm",
    "--init",
    "--name",
    name,
    "--label",
    "checktrail.signature-nonce=" + nonce,
    ...(process.env.CHECKTRAIL_TEST_TASK
      ? ["--label", "checktrail.task=" + process.env.CHECKTRAIL_TEST_TASK]
      : []),
    "--platform",
    "linux/arm64",
    "--network",
    "none",
    "--read-only",
    "--user",
    "1000:1000",
    "--cpus",
    "2",
    "--memory",
    "2g",
    "--pids-limit",
    "256",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,exec,size=1536m",
    "--mount",
    `type=bind,src=${repository},target=/workspace,readonly`,
    "--mount",
    `type=bind,src=${cache},target=/prepared-cache,readonly`,
    "--env",
    "npm_config_cache=/tmp/npm-cache",
    "--workdir",
    "/workspace",
    image,
    "sh",
    "-c",
    'node --input-type=module -e "$1" && node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache && node scripts/verify-fsharp-format-signature-native.mjs /workspace "$2" "$3" && node scripts/verify-fsharp-format-signature-installed.mjs "$2" "$3"',
    "fsharp-proof-chain",
    binding,
    containerRoot,
    manifest.proofSha256,
  ];
  try {
    const result = spawnSync("docker", args, {
      encoding: "utf8",
      timeout: 900000,
      maxBuffer: 8 * 1024 * 1024,
    });
    process.stderr.write(result.stderr ?? "");
    process.stderr.write(result.stdout ?? "");
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.length, 4, result.stdout);
    assert.deepEqual(JSON.parse(lines[0]), sourceRows);
    const subset = JSON.parse(lines[1]),
      source = validateFsharpSignatureNativeReceipt(
        JSON.parse(lines[2]),
        "/workspace",
        cases,
      ),
      installed = JSON.parse(lines[3]);
    validateFsharpAcceptanceCacheSubset(
      subset,
      await kotlinRead(
        path.join(repository, "package-lock.json"),
        4 * 1024 * 1024,
      ),
    );
    assert.equal(installed.state, "complete-scoped-installed-native-chain");
    assert.equal(installed.caseManifestSha256, cases.sha256);
    assert.equal(installed.complete, true);
    assert.equal(installed.installation.offlineProductionInstall, true);
    assert.equal(installed.installation.lifecycleScriptsExecuted, false);
    assert.equal(installed.harnessOutsideInstalledPackage, true);
    assert.equal(installed.installedRuntimeEvaluated, true);
    assert.equal(installed.installedCliEvaluated, true);
    assert.equal(installed.installedMcpEvaluated, true);
    assert.equal(installed.revocationFreshAtRuntime, false);
    assert.equal(installed.fullArtifactClosureClaimed, false);
    assert.equal(installed.gateAComplete, false);
    validateFsharpSignatureNativeReceipt(
      installed.native,
      installed.installedPackage,
      cases,
    );
    assert.deepEqual(
      installed.matchingRuntimeModules,
      sourceRows
        .slice(0, fsharpSignatureRuntimeModules.length)
        .map(({ file, ...row }) => ({ name: path.basename(file), ...row })),
    );
    for (const row of sourceRows) {
      const body = await kotlinRead(
        path.join(repository, row.file),
        1024 * 1024,
      );
      assert.equal(body.length, row.bytes);
      assert.equal(hash(body), row.sha256);
    }
    readFsharpReleaseProof(manifest.formatterRoot, manifest.proofSha256);
    return {
      schemaVersion: 1,
      state: "complete-scoped-source-and-installed-native-chain",
      imageId: image,
      sourceRows,
      caseManifestSha256: cases.sha256,
      source,
      installed,
      complete: true,
      revocationFreshAtRuntime: false,
      fullArtifactClosureClaimed: false,
      gateAComplete: false,
    };
  } finally {
    const state = spawnSync("docker", ["container", "inspect", name], {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 65536,
    });
    assert.ifError(state.error);
    if (state.status === 0) {
      const [owned] = JSON.parse(state.stdout);
      assert.equal(owned.Image, image);
      assert.equal(owned.Config.Labels["checktrail.signature-nonce"], nonce);
      execFileSync("docker", ["container", "rm", "--force", owned.Id], {
        timeout: 10000,
        maxBuffer: 65536,
      });
      const absent = spawnSync("docker", ["container", "inspect", name], {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 65536,
      });
      assert.ifError(absent.error);
      assert.ok(
        absent.status === 1 &&
          /No such (?:object|container)/u.test(absent.stderr),
      );
    } else {
      assert.ok(
        state.status === 1 &&
          /No such (?:object|container)/u.test(state.stderr),
      );
    }
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assert.equal(process.argv.length, 3, "Pass absolute preparation JSON path");
  assert.ok(path.isAbsolute(process.argv[2]));
  process.stdout.write(
    JSON.stringify(await verifyFsharpSignatureContainer(process.argv[2])) +
      "\n",
  );
}
