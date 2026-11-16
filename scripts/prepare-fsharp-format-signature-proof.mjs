import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { kotlinRead } from "../dist/src/kotlin-io.js";
import { fsharpSdkPins } from "../dist/src/fsharp-format-pins.js";
import {
  encodeFsharpReleaseProof,
  fsharpNugetPolicy,
  fsharpReleasePackageFile,
  fsharpReleaseProofFile,
  readFsharpReleaseProof,
  validateFsharpNugetOutput,
  validateFsharpReleaseProof,
} from "../dist/src/fsharp-format-release-signature.js";

const hash = (body) => createHash("sha256").update(body).digest("hex");
function requirePin(body, pin) {
  assert.ok(Buffer.isBuffer(body));
  assert.equal(body.length, pin.bytes);
  assert.equal(hash(body), pin.sha256);
}
function docker(args, timeout = 120000) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 256 * 1024,
  });
}
function selectedImage() {
  const image = JSON.parse(
    docker(["image", "inspect", fsharpNugetPolicy.image], 10000),
  );
  assert.equal(image.length, 1);
  assert.equal(image[0].Os, "linux");
  assert.equal(image[0].Architecture, "arm64");
  assert.ok(image[0].RepoDigests.includes(fsharpNugetPolicy.image));
  assert.match(image[0].Id, /^sha256:[a-f0-9]{64}$/u);
  return image[0].Id;
}
async function canonicalDirectory(directory) {
  const stat = await lstat(directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal(await realpath(directory), directory);
}
async function ensureDirectory(directory) {
  try {
    await mkdir(directory, { mode: 0o755 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await canonicalDirectory(directory);
}

// Explicit operator preparation only. No source/package code is imported or run.
// NuGet owns PKCS#7, trust-chain, timestamp and configured-online checks.
export async function verifyFsharpNugetSignature(repository, archive) {
  requirePin(archive, fsharpNugetPolicy.package);
  assert.equal(await realpath(repository), repository);
  const configFile = path.join(
    repository,
    "docs/measurements/artifact-identities-2026-10-21/nuget-verification.config",
  );
  assert.equal(await realpath(configFile), configFile);
  const config = await kotlinRead(configFile, fsharpNugetPolicy.config.bytes);
  requirePin(config, fsharpNugetPolicy.config);
  const imageId = selectedImage(),
    nonce = randomUUID(),
    name = "checktrail-fsharp-signature-" + nonce;
  const temporary = await mkdtemp(
    path.join(await realpath(tmpdir()), "checktrail-nuget-proof-"),
  );
  const pins = [...fsharpSdkPins, ...fsharpNugetPolicy.verifierPins];
  for (const pin of pins) assert.match(pin.file, /^[A-Za-z0-9._+/-]+$/u);
  const shell = [
    "set -eu",
    'observe() { for f do p=/usr/share/dotnet/$f; test "$(readlink -f "$p")" = "$p"; printf \'%s\\t%s\\t\' "$f" "$(stat -c %s "$p")"; sha256sum "$p" | cut -d \' \' -f 1; done; }',
    "printf 'CHECKTRAIL_NUGET_BEFORE\\n'",
    'observe "$@"',
    "printf 'CHECKTRAIL_NUGET_NATIVE\\n'",
    "set +e",
    "env -i " +
      Object.entries(fsharpNugetPolicy.environment)
        .map(([key, value]) => key + "=" + value)
        .join(" ") +
      " /usr/share/dotnet/dotnet " +
      fsharpNugetPolicy.arguments.join(" "),
    "status=$?",
    "set -e",
    "printf '\\nCHECKTRAIL_NUGET_AFTER\\n'",
    'observe "$@"',
    'exit "$status"',
  ].join("\n");
  let created = false;
  try {
    await writeFile(path.join(temporary, "fantomas.nupkg"), archive, {
      mode: 0o644,
      flag: "wx",
    });
    await writeFile(path.join(temporary, "nuget.config"), config, {
      mode: 0o644,
      flag: "wx",
    });
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
      "bridge",
      "--read-only",
      "--cpus",
      "2",
      "--memory",
      "2g",
      "--pids-limit",
      "128",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,exec,size=256m",
      "--tmpfs",
      "/home/nuget:rw,nosuid,nodev,size=64m",
      "--mount",
      `type=bind,src=${path.join(temporary, "fantomas.nupkg")},target=/artifact/fantomas.nupkg,readonly`,
      "--mount",
      `type=bind,src=${path.join(temporary, "nuget.config")},target=/policy/nuget.config,readonly`,
      "--entrypoint",
      "/bin/sh",
      imageId,
      "-c",
      shell,
      "checktrail-nuget",
      ...pins.map((pin) => pin.file),
    ];
    const startedAt = new Date().toISOString();
    created = true;
    const result = spawnSync("docker", args, {
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 256 * 1024,
    });
    const finishedAt = new Date().toISOString();
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(
      result.status,
      0,
      "Native NuGet signature verification failed: " +
        String(result.stderr).slice(-4000),
    );
    const beforeMarker = "CHECKTRAIL_NUGET_BEFORE\n",
      nativeMarker = "CHECKTRAIL_NUGET_NATIVE\n",
      afterMarker = "\nCHECKTRAIL_NUGET_AFTER\n";
    assert.ok(result.stdout.startsWith(beforeMarker));
    assert.equal(result.stdout.split(nativeMarker).length, 2);
    assert.equal(result.stdout.split(afterMarker).length, 2);
    const [before, nativeAndAfter] = result.stdout
      .slice(beforeMarker.length)
      .split(nativeMarker);
    const [stdout, after] = nativeAndAfter.split(afterMarker);
    const observe = (text) => {
      const rows = text
        .trimEnd()
        .split("\n")
        .map((line) => {
          const [file, bytes, sha256, ...extra] = line.split("\t");
          assert.equal(extra.length, 0);
          assert.match(bytes, /^[1-9][0-9]*$/u);
          return { file, bytes: Number(bytes), sha256 };
        });
      assert.deepEqual(
        rows,
        pins,
        "Selected SDK/verifier/root-store bytes differ",
      );
      return rows;
    };
    const beforeRows = observe(before),
      afterRows = observe(after),
      metadata = validateFsharpNugetOutput(stdout, result.stderr);
    assert.equal(selectedImage(), imageId);
    return encodeFsharpReleaseProof({
      observationKind: "new-native-preparation",
      image: fsharpNugetPolicy.image,
      imageId,
      platform: "linux/arm64",
      arguments: [...fsharpNugetPolicy.arguments],
      environment: { ...fsharpNugetPolicy.environment },
      network: "bridge",
      config: { ...fsharpNugetPolicy.config },
      verifierBefore: beforeRows.slice(fsharpSdkPins.length),
      verifierAfter: afterRows.slice(fsharpSdkPins.length),
      sdkBeforePinsSha256: hash(
        JSON.stringify(beforeRows.slice(0, fsharpSdkPins.length)),
      ),
      sdkAfterPinsSha256: hash(
        JSON.stringify(afterRows.slice(0, fsharpSdkPins.length)),
      ),
      startedAt,
      finishedAt,
      revocationModeConfigured: "online",
      revocationFreshAtRuntime: false,
      revocationResponsesRetained: false,
      exitCode: 0,
      signal: null,
      outputComplete: true,
      stdout,
      stderr: result.stderr,
      ...metadata,
    });
  } finally {
    try {
      if (created) {
        const state = spawnSync("docker", ["container", "inspect", name], {
          encoding: "utf8",
          timeout: 10000,
          maxBuffer: 64 * 1024,
        });
        assert.ifError(state.error);
        if (state.status === 0) {
          const [owned] = JSON.parse(state.stdout);
          assert.equal(owned.Image, imageId);
          assert.equal(
            owned.Config.Labels["checktrail.signature-nonce"],
            nonce,
          );
          docker(["container", "rm", "--force", owned.Id], 10000);
        } else
          assert.ok(
            state.status === 1 &&
              /No such (?:object|container)/u.test(state.stderr),
            "Container absence is unproved",
          );
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

// One rename to a previously absent immutable digest. Never replace legacy or a
// prior qualified cohort. Every incoming byte is checked before publication.
export async function publishFsharpSignatureCohort(
  repository,
  archive,
  selected,
  proof,
  { renameImpl = rename } = {},
) {
  assert.equal(await realpath(repository), repository);
  requirePin(archive, fsharpNugetPolicy.package);
  assert.ok(selected instanceof Map);
  assert.deepEqual(
    [...selected.keys()].sort(),
    fsharpNugetPolicy.selected.map((p) => p.file).sort(),
  );
  for (const pin of fsharpNugetPolicy.selected)
    requirePin(selected.get(pin.file), pin);
  const proofSha256 = hash(proof);
  validateFsharpReleaseProof(proof, proofSha256);
  const checktrail = path.join(repository, ".checktrail"),
    parent = path.join(checktrail, "fsharp-format-signed-tools"),
    output = path.join(parent, proofSha256);
  await ensureDirectory(checktrail);
  await ensureDirectory(parent);
  const exists = await lstat(output).then(
    () => true,
    (error) => {
      if (error.code !== "ENOENT") throw error;
      return false;
    },
  );
  if (exists) {
    readFsharpReleaseProof(output, proofSha256);
    return { formatterRoot: output, proofSha256, reused: true };
  }
  const pending = await mkdtemp(path.join(parent, ".pending-")),
    staged = path.join(pending, proofSha256);
  try {
    await mkdir(staged, { mode: 0o755 });
    const members = new Map([
      [fsharpReleasePackageFile, archive],
      ...selected,
      [fsharpReleaseProofFile, proof],
    ]);
    for (const [name, body] of members) {
      const file = path.join(staged, name);
      await writeFile(file, body, { flag: "wx", mode: 0o644 });
      await chmod(file, 0o644);
    }
    await chmod(staged, 0o755);
    readFsharpReleaseProof(staged, proofSha256);
    try {
      await renameImpl(staged, output);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      readFsharpReleaseProof(output, proofSha256);
    }
    readFsharpReleaseProof(output, proofSha256);
    return { formatterRoot: output, proofSha256, reused: false };
  } finally {
    await rm(pending, { recursive: true, force: true });
  }
}
