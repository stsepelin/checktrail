import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  contextRuntimeInputIdentity,
  contextRuntimeProofClaims,
  contextRuntimeProofFiles,
  contextRuntimeVerificationArgs,
  deriveContextRuntimeBundle,
  encodeContextRuntimeProof,
  inspectContextRuntimeArchive,
  readContextRuntimeProof,
  readContextRuntimeProofCandidate,
  readContextRuntimeProofInput,
} from "../dist/src/context-runtime-proof.js";
import {
  contextRuntimeAttestationPolicy as policy,
  contextRuntimeAttestationPolicySha256,
  inspectContextNativeAttestation,
  parseContextAttestationJson,
} from "../dist/src/context-runtime-attestation.js";

const sameBytes = (before, after, label) =>
  assert.deepEqual(
    contextRuntimeInputIdentity(after),
    contextRuntimeInputIdentity(before),
    label + " changed during native verification",
  );
const native = (tool, args, cwd) => {
  const env = {
    ...process.env,
    GH_HOST: "github.com",
    GH_PROMPT_DISABLED: "1",
    GH_PAGER: "cat",
    NO_COLOR: "1",
  };
  delete env.GH_DEBUG;
  delete env.GH_FORCE_TTY;
  return spawnSync(tool, args, {
    cwd,
    env,
    timeout: 30000,
    maxBuffer: 262144,
    windowsHide: true,
  });
};
const canonicalDirectory = (directory, label) => {
  assert.ok(
    path.isAbsolute(directory) && path.normalize(directory) === directory,
    label + " canonical absolute path required",
  );
  const identity = lstatSync(directory);
  assert.ok(
    identity.isDirectory() && !identity.isSymbolicLink(),
    label + " regular directory required",
  );
  assert.equal(
    realpathSync(directory),
    directory,
    label + " linked directory forbidden",
  );
};
const createCanonicalDirectory = async (directory, label) => {
  canonicalDirectory(path.dirname(directory), label + " parent");
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  canonicalDirectory(directory, label);
};
export async function prepareContextRuntimeProof({
  archive,
  verification,
  trustedRoot,
  gh,
  output,
}) {
  for (const value of [archive, verification, trustedRoot, gh, output])
    assert.ok(
      typeof value === "string" && path.isAbsolute(value),
      "Explicit absolute operator input paths required",
    );
  const tool = realpathSync(gh);
  const toolBefore = readContextRuntimeProofInput(tool, 128 * 1024 * 1024);
  const toolVersion = native(tool, ["--version"], path.dirname(tool));
  assert.equal(
    toolVersion.error,
    undefined,
    "Native gh version process unavailable",
  );
  assert.equal(toolVersion.status, 0, "Native gh version process failed");
  const version = toolVersion.stdout.toString("utf8");
  assert.equal(
    version,
    "gh version 2.102.1 (2026-10-20)\nhttps://github.com/cli/cli/releases/tag/v2.102.1\n",
    "Reviewed native gh version differs",
  );
  const files = {
    archive: readContextRuntimeProofInput(archive, policy.release.bytes),
    originalVerification: readContextRuntimeProofInput(
      verification,
      policy.retainedVerification.bytes,
    ),
    trustedRoot: readContextRuntimeProofInput(
      trustedRoot,
      policy.trustedRoot.bytes,
    ),
  };
  inspectContextRuntimeArchive(files.archive);
  const bundle = deriveContextRuntimeBundle(files.originalVerification);
  assert.deepEqual(
    contextRuntimeInputIdentity(files.trustedRoot),
    { bytes: policy.trustedRoot.bytes, sha256: policy.trustedRoot.sha256 },
    "Trusted root pin differs",
  );
  await createCanonicalDirectory(output, "Proof output");
  const attempts = path.join(output, "attempts");
  let temporary,
    attempt,
    nativeAttempted = false,
    published = false;
  try {
    // No stage exists until the diagnostic namespace is a real canonical directory.
    await createCanonicalDirectory(attempts, "Native attempts");
    attempt = await mkdtemp(path.join(attempts, "native-"));
    canonicalDirectory(attempt, "Native attempt");
    temporary = await mkdtemp(path.join(output, ".prepare-"));
    canonicalDirectory(temporary, "Proof stage");
    const inputs = { ...files, bundle };
    for (const key of Object.keys(inputs))
      await writeFile(
        path.join(temporary, contextRuntimeProofFiles[key]),
        inputs[key],
        { flag: "wx", mode: 0o600 },
      );
    canonicalDirectory(output, "Proof output");
    canonicalDirectory(attempts, "Native attempts");
    canonicalDirectory(attempt, "Native attempt");
    canonicalDirectory(temporary, "Proof stage");
    const result = native(tool, contextRuntimeVerificationArgs, temporary);
    nativeAttempted = true;
    canonicalDirectory(output, "Proof output");
    canonicalDirectory(attempts, "Native attempts");
    canonicalDirectory(attempt, "Native attempt");
    await writeFile(
      path.join(attempt, "stdout.json"),
      result.stdout ?? Buffer.alloc(0),
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      path.join(attempt, "stderr.log"),
      result.stderr ?? Buffer.alloc(0),
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      path.join(attempt, "process.json"),
      JSON.stringify({
        status: result.status,
        signal: result.signal,
        error: result.error?.message ?? null,
        tool: contextRuntimeInputIdentity(toolBefore),
        argv: contextRuntimeVerificationArgs,
        nativeInputPins: Object.fromEntries(
          Object.entries(inputs).map(([key, value]) => [
            key,
            contextRuntimeInputIdentity(value),
          ]),
        ),
        projectCodeExecuted: false,
        localBundleAndTrustedRoot: true,
      }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    assert.equal(
      result.error,
      undefined,
      "Native verification process unavailable; raw attempt preserved",
    );
    assert.equal(
      result.signal,
      null,
      "Native verification process did not finish normally",
    );
    assert.equal(
      result.status,
      0,
      "Native attestation verification failed; raw attempt preserved",
    );
    // The native result is inspected only after the real process completed successfully.
    const inspected = inspectContextNativeAttestation(
      parseContextAttestationJson(result.stdout),
    );
    sameBytes(
      toolBefore,
      readContextRuntimeProofInput(tool, 128 * 1024 * 1024),
      "Native gh binary",
    );
    sameBytes(
      files.archive,
      readContextRuntimeProofInput(archive, policy.release.bytes),
      "Archive input",
    );
    sameBytes(
      files.originalVerification,
      readContextRuntimeProofInput(
        verification,
        policy.retainedVerification.bytes,
      ),
      "Original verification input",
    );
    sameBytes(
      files.trustedRoot,
      readContextRuntimeProofInput(trustedRoot, policy.trustedRoot.bytes),
      "Trusted root input",
    );
    for (const key of Object.keys(inputs))
      sameBytes(
        inputs[key],
        readContextRuntimeProofInput(
          path.join(temporary, contextRuntimeProofFiles[key]),
          key === "archive" ? policy.release.bytes : 262144,
        ),
        "Native cohort input " + key,
      );
    const complete = { ...inputs, nativeOutput: result.stdout };
    const candidate = {
      schemaVersion: 1,
      kind: "context-runtime-release-proof",
      policy,
      policySha256: contextRuntimeAttestationPolicySha256,
      scope: "selected-context-runtime-release",
      files: Object.fromEntries(
        Object.entries(complete).map(([key, value]) => [
          key,
          contextRuntimeInputIdentity(value),
        ]),
      ),
      nativeVerification: {
        tool: {
          name: "gh",
          version,
          ...contextRuntimeInputIdentity(toolBefore),
        },
        argv: contextRuntimeVerificationArgs,
        exitCode: 0,
        localBundleAndTrustedRoot: true,
        result: inspected,
      },
      runtimeAssets: policy.runtimeAssets,
      claims: contextRuntimeProofClaims,
    };
    const proof = encodeContextRuntimeProof(candidate, complete);
    const identity = contextRuntimeInputIdentity(proof);
    await writeFile(
      path.join(temporary, contextRuntimeProofFiles.nativeOutput),
      result.stdout,
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(path.join(temporary, "proof.json"), proof, {
      flag: "wx",
      mode: 0o600,
    });
    for (const name of [
      "proof.json",
      ...Object.values(contextRuntimeProofFiles),
    ])
      await chmod(path.join(temporary, name), 0o400);
    await chmod(temporary, 0o500);
    readContextRuntimeProofCandidate(
      path.join(temporary, "proof.json"),
      identity.sha256,
    );
    const destination = path.join(output, identity.sha256);
    let existing = false;
    try {
      lstatSync(destination);
      existing = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (existing)
      readContextRuntimeProof(
        path.join(destination, "proof.json"),
        identity.sha256,
      );
    else
      try {
        await rename(temporary, destination);
        published = true;
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
        readContextRuntimeProof(
          path.join(destination, "proof.json"),
          identity.sha256,
        );
      }
    const selected = readContextRuntimeProof(
      path.join(destination, "proof.json"),
      identity.sha256,
    );
    return {
      ...selected,
      proofPath: path.join(destination, "proof.json"),
      cacheHit: !published,
      attempt,
    };
  } finally {
    if (temporary && !published) {
      await chmod(temporary, 0o700).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      await rm(temporary, { recursive: true, force: true });
    }
    if (attempt && !nativeAttempted)
      await rm(attempt, { recursive: true, force: true });
  }
}
async function main() {
  const args = process.argv.slice(2),
    names = ["archive", "verification", "trusted-root", "gh", "output"];
  assert.equal(
    args.length,
    names.length * 2,
    "Required explicit archive, verification, trusted-root, gh and output options",
  );
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i],
      name = flag?.slice(2);
    assert.ok(
      flag?.startsWith("--") &&
        names.includes(name) &&
        !Object.hasOwn(values, name),
      "Unknown or duplicate preparer option",
    );
    values[name] = args[i + 1];
  }
  const result = await prepareContextRuntimeProof({
    archive: values.archive,
    verification: values.verification,
    trustedRoot: values["trusted-root"],
    gh: values.gh,
    output: values.output,
  });
  process.stdout.write(
    JSON.stringify({
      reference: result.reference,
      proofPath: result.proofPath,
      cacheHit: result.cacheHit,
      nativeAttempt: result.attempt,
      archiveLicenseMembershipVerified: false,
      completeLicenseClosureVerified: false,
      gateAComplete: false,
    }) + "\n",
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await main();
