import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import inputs from "./context-runtime-proof-ci-inputs.json" with { type: "json" };
import { requestPinnedArtifactBytes } from "./request-pinned-artifact.mjs";
import { prepareContextRuntimeProof } from "./prepare-context-runtime-proof.mjs";
import { contextRuntimeAttestationPolicy as policy } from "../dist/src/context-runtime-attestation.js";
import { readContextRuntimeProofInput } from "../dist/src/context-runtime-proof.js";

export const contextRuntimeCiInputs = inputs;
export function verifyContextCiBytes(raw, expected) {
  assert.equal(
    raw.length,
    expected.bytes,
    "Pinned CI input byte count differs",
  );
  assert.equal(
    createHash("sha256").update(raw).digest("hex"),
    expected.sha256,
    "Pinned CI input digest differs",
  );
  return raw;
}
export function requireContextCiRuntime(actual) {
  assert.deepEqual(
    actual,
    inputs.runtime,
    "Selected context proof CI runtime differs",
  );
}
const directory = (value) => {
  assert.ok(
    path.isAbsolute(value) &&
      path.normalize(value) === value &&
      !/[\r\n#\0]/u.test(value),
    "Canonical CI preparation path required",
  );
  const stat = lstatSync(value);
  assert.ok(
    stat.isDirectory() && !stat.isSymbolicLink(),
    "Regular CI preparation directory required",
  );
  assert.equal(
    realpathSync(value),
    value,
    "Linked CI preparation directory forbidden",
  );
};
export function extractContextCiMember(archive, archivePin, member) {
  verifyContextCiBytes(
    readContextRuntimeProofInput(archive, 32 * 1024 * 1024),
    archivePin,
  );
  assert.match(
    member.member,
    /^gh_2\.102\.1_linux_arm64\/(?:bin\/gh|LICENSE)$/u,
  );
  assert.ok(
    Number.isSafeInteger(member.bytes) &&
      member.bytes > 0 &&
      member.bytes <= 64 * 1024 * 1024,
  );
  // The verified archive is read to stdout; no archive path is extracted to disk.
  const raw = execFileSync("/usr/bin/tar", ["-xOzf", archive, member.member], {
    timeout: 15000,
    maxBuffer: member.bytes + 1,
    stdio: ["ignore", "pipe", "pipe"],
  });
  verifyContextCiBytes(
    readContextRuntimeProofInput(archive, 32 * 1024 * 1024),
    archivePin,
  );
  return verifyContextCiBytes(raw, member);
}
export async function prepareContextRuntimeProofCi(root) {
  requireContextCiRuntime({
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
  });
  directory(root);
  assert.equal(inputs.schemaVersion, 1);
  assert.equal(inputs.scope, "selected-context-runtime-proof-ci");
  assert.equal(inputs.githubCli.version, "2.102.1");
  assert.equal(
    inputs.githubCli.archive.url,
    "https://github.com/cli/cli/releases/download/v2.102.1/gh_2.102.1_linux_arm64.tar.gz",
  );
  assert.equal(
    inputs.githubCli.checksums.url,
    "https://github.com/cli/cli/releases/download/v2.102.1/gh_2.102.1_checksums.txt",
  );
  assert.equal(
    inputs.runtimeArchive.url,
    "https://github.com/tree-sitter/tree-sitter/releases/download/v0.27.1/web-tree-sitter.tar.gz",
  );
  assert.deepEqual(
    {
      name: inputs.runtimeArchive.name,
      bytes: inputs.runtimeArchive.bytes,
      sha256: inputs.runtimeArchive.sha256,
    },
    policy.release,
  );
  const verification = path.join(root, "attestation-verified.json"),
    trustedRoot = path.join(root, "sigstore-trusted-root.jsonl");
  verifyContextCiBytes(
    readContextRuntimeProofInput(
      verification,
      policy.retainedVerification.bytes,
    ),
    policy.retainedVerification,
  );
  verifyContextCiBytes(
    readContextRuntimeProofInput(trustedRoot, policy.trustedRoot.bytes),
    policy.trustedRoot,
  );
  const downloads = path.join(root, "inputs"),
    toolDirectory = path.join(root, "github-cli");
  await mkdir(downloads, { mode: 0o700 });
  await mkdir(toolDirectory, { mode: 0o700 });
  directory(downloads);
  directory(toolDirectory);
  const selected = [
    inputs.githubCli.archive,
    inputs.githubCli.checksums,
    inputs.runtimeArchive,
  ];
  const results = await Promise.allSettled(
    selected.map(async (asset) => {
      const raw = await requestPinnedArtifactBytes(
        { asset: asset.url, bytes: asset.bytes },
        {
          signal: globalThis.AbortSignal.timeout(120000),
          maxArtifactBytes: 32 * 1024 * 1024,
        },
      );
      verifyContextCiBytes(raw, asset);
      const file = path.join(downloads, asset.name);
      await writeFile(file, raw, { flag: "wx", mode: 0o400 });
      return file;
    }),
  );
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
  const archive = path.join(downloads, inputs.githubCli.archive.name),
    checksums = path.join(downloads, inputs.githubCli.checksums.name);
  const checksumText = readContextRuntimeProofInput(
    checksums,
    inputs.githubCli.checksums.bytes,
  ).toString("utf8");
  const lines = checksumText
    .split("\n")
    .filter((line) => line.endsWith("  " + inputs.githubCli.archive.name));
  assert.deepEqual(lines, [inputs.githubCli.checksums.selectedLine]);
  assert.equal(
    lines[0],
    inputs.githubCli.archive.sha256 + "  " + inputs.githubCli.archive.name,
  );
  const gh = path.join(toolDirectory, "gh"),
    license = path.join(toolDirectory, "LICENSE");
  await writeFile(
    gh,
    extractContextCiMember(
      archive,
      inputs.githubCli.archive,
      inputs.githubCli.executable,
    ),
    { flag: "wx", mode: 0o500 },
  );
  await chmod(gh, 0o500);
  await writeFile(
    license,
    extractContextCiMember(
      archive,
      inputs.githubCli.archive,
      inputs.githubCli.license,
    ),
    { flag: "wx", mode: 0o400 },
  );
  const runtimeArchive = path.join(downloads, inputs.runtimeArchive.name);
  const proof = await prepareContextRuntimeProof({
    archive: runtimeArchive,
    verification,
    trustedRoot,
    gh,
    output: path.join(root, "proofs"),
  });
  assert.equal(
    proof.proof.nativeVerification.tool.sha256,
    inputs.githubCli.executable.sha256,
  );
  const result = {
    schemaVersion: 1,
    state: "prepared-context-runtime-proof-ci",
    scope: inputs.scope,
    proof: proof.reference,
    verifier: {
      version: inputs.githubCli.version,
      ...inputs.githubCli.executable,
    },
    runtimeArchive: inputs.runtimeArchive,
    toolNotice: inputs.githubCli.license,
    toolPublisherSignatureVerified: false,
    fullProducerBuildClosureVerified: false,
    grammarSignaturesVerified: false,
    completeLicenseClosureVerified: false,
    ownerCurrentStatusVerified: false,
    gateAComplete: false,
  };
  await writeFile(
    path.join(root, "PREPARATION.v1.json"),
    JSON.stringify(result) + "\n",
    { flag: "wx", mode: 0o400 },
  );
  const values = {
    CHECKTRAIL_CONTEXT_RELEASE_PROOF:
      proof.proofPath + "#sha256=" + proof.reference.sha256,
    CHECKTRAIL_CONTEXT_PROOF_TEST_ARCHIVE: runtimeArchive,
    CHECKTRAIL_CONTEXT_PROOF_TEST_GH: gh,
    CHECKTRAIL_CONTEXT_PROOF_TEST_EVIDENCE: path.join(root, "native29"),
    CHECKTRAIL_CONTEXT_RUNTIME_PROOF_CI_ROOT: root,
  };
  return { result, environment: values };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  assert.equal(
    process.argv.length,
    3,
    "Pass one owned absolute CI preparation directory",
  );
  const root = process.argv[2],
    prepared = await prepareContextRuntimeProofCi(root),
    env = { ...process.env, ...prepared.environment };
  let final;
  for (const [phase, args] of [
    ["routing", ["--test", "dist/test/context-runtime-proof-ci.test.js"]],
    ["qualified", ["scripts/verify-context-runtime-proof-ci.mjs"]],
  ]) {
    try {
      const raw = execFileSync(process.execPath, args, {
        env,
        timeout: 600000,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      await writeFile(path.join(root, phase + ".stdout.log"), raw, {
        flag: "wx",
        mode: 0o400,
      });
      if (phase === "qualified") final = raw;
    } catch (error) {
      await writeFile(
        path.join(root, phase + ".stdout.log"),
        error.stdout ?? "",
        { flag: "wx", mode: 0o400 },
      );
      await writeFile(
        path.join(root, phase + ".stderr.log"),
        error.stderr ?? String(error),
        { flag: "wx", mode: 0o400 },
      );
      throw error;
    }
  }
  process.stdout.write(final);
}
