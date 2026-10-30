import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, open, realpath, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { captureCompiledEngine } from "./compiled-engine-evidence.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const gitID = (value) =>
  typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const git = (root, args) =>
  execFileSync(
    "git",
    [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      ...args,
    ],
    { cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1048576 },
  );
async function fileIdentity(filename) {
  assert.equal(
    await realpath(filename),
    filename,
    "Native acceptance source crosses a link",
  );
  const fd = await open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await fd.stat({ bigint: true });
    assert.ok(
      before.isFile() && before.size >= 0n && before.size <= 128n * 1048576n,
    );
    const digest = createHash("sha256");
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(65536),
        { bytesRead } = await fd.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      assert.ok(total <= 128 * 1048576);
      digest.update(chunk.subarray(0, bytesRead));
    }
    const after = await fd.stat({ bigint: true }),
      linked = await lstat(filename, { bigint: true });
    for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
      assert.equal(before[field], after[field]);
      assert.equal(after[field], linked[field]);
    }
    assert.equal(BigInt(total), before.size);
    return { bytes: total, sha256: digest.digest("hex") };
  } finally {
    await fd.close();
  }
}
export function validateConsumerNativeSourceFrame(frame) {
  assert.equal(frame?.schemaVersion, 1);
  assert.equal(frame.profile, "native-consumer-current-source-frame-v1");
  assert.ok(gitID(frame.commit) && gitID(frame.gitTree));
  for (const field of [
    "sourceManifestSha256",
    "engineSha256",
    "engineManifestSha256",
    "harnessSha256",
    "harnessManifestSha256",
    "inventorySha256",
    "inventoryScopeSha256",
    "requirementsSha256",
    "packageManifestSha256",
    "packageLockSha256",
  ])
    assert.ok(sha(frame[field]), "Missing native source frame " + field);
  assert.ok(
    Number.isSafeInteger(frame.sourceFiles) &&
      frame.sourceFiles > 0 &&
      frame.sourceFiles <= 20000,
  );
  assert.ok(
    Number.isSafeInteger(frame.sourceBytes) &&
      frame.sourceBytes > 0 &&
      frame.sourceBytes <= 1024 * 1048576,
  );
  assert.equal(frame.clean, true);
  assert.equal(frame.hostAttestationPerformed, false);
  assert.equal(frame.gateAComplete, false);
  return frame;
}
/** Observe the clean actual repository and compiled engine. Never infer a source frame from a CI label. */
export async function captureConsumerNativeSourceFrame(repository) {
  const root = await realpath(repository);
  assert.equal(path.resolve(repository), root);
  const commit = git(root, ["rev-parse", "HEAD"]).trim(),
    gitTree = git(root, ["rev-parse", "HEAD^{tree}"]).trim();
  assert.ok(gitID(commit) && gitID(gitTree));
  assert.equal(
    git(root, ["status", "--porcelain=v1", "--untracked-files=normal", "-z"]),
    "",
    "Native acceptance requires a clean current source tree",
  );
  const files = git(root, ["ls-files", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort();
  assert.ok(
    files.length > 0 &&
      files.length <= 20000 &&
      new Set(files).size === files.length,
  );
  let sourceBytes = 0;
  const sources = [];
  for (const file of files) {
    assert.ok(
      !path.isAbsolute(file) &&
        !/[\\:\0]/.test(file) &&
        file.split("/").every((part) => part && part !== "." && part !== ".."),
    );
    const value = await fileIdentity(path.join(root, file));
    sourceBytes += value.bytes;
    assert.ok(sourceBytes <= 1024 * 1048576);
    sources.push({ path: file, ...value });
  }
  const engine = await captureCompiledEngine(path.join(root, "dist/src"));
  const harness = await captureCompiledEngine(path.join(root, "dist/test"));
  const metadata = await Promise.all(
    [
      "docs/gate-a-profiles.v1.json",
      "scripts/required-native-tests.json",
      "package.json",
      "package-lock.json",
    ].map(async (file) => [file, await readFile(path.join(root, file))]),
  );
  assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), commit);
  assert.equal(git(root, ["rev-parse", "HEAD^{tree}"]).trim(), gitTree);
  assert.equal(
    git(root, ["status", "--porcelain=v1", "--untracked-files=normal", "-z"]),
    "",
    "Native acceptance source changed during observation",
  );
  for (const [file, bytes] of metadata) {
    const source = sources.find((source) => source.path === file);
    assert.ok(source, "Native source metadata is not tracked");
    assert.equal(source.bytes, bytes.length);
    assert.equal(
      source.sha256,
      hash(bytes),
      "Native source metadata changed during observation",
    );
  }
  const data = Object.fromEntries(metadata);
  return validateConsumerNativeSourceFrame({
    schemaVersion: 1,
    profile: "native-consumer-current-source-frame-v1",
    commit,
    gitTree,
    sourceManifestSha256: hash(JSON.stringify(sources)),
    sourceFiles: sources.length,
    sourceBytes,
    engineSha256: engine.treeSha256,
    engineManifestSha256: engine.manifestSha256,
    harnessSha256: harness.treeSha256,
    harnessManifestSha256: harness.manifestSha256,
    inventorySha256: hash(data["docs/gate-a-profiles.v1.json"]),
    inventoryScopeSha256: JSON.parse(
      data["docs/gate-a-profiles.v1.json"].toString("utf8"),
    ).scopeSha256,
    requirementsSha256: hash(data["scripts/required-native-tests.json"]),
    packageManifestSha256: hash(data["package.json"]),
    packageLockSha256: hash(data["package-lock.json"]),
    clean: true,
    hostAttestationPerformed: false,
    gateAComplete: false,
  });
}
/** Matrix transport may supply records, never authority to replace the independently captured target source. */
export function requireConsumerNativeSourceFrame(observed, expected) {
  validateConsumerNativeSourceFrame(observed);
  validateConsumerNativeSourceFrame(expected);
  assert.deepEqual(
    observed,
    expected,
    "Native consumer scope belongs to another source, engine, inventory or harness version",
  );
  return observed;
}
export function consumerNativeCIRunObservation(environment = process.env) {
  if (environment.GITHUB_ACTIONS !== "true")
    return {
      kind: "local-operator-metadata",
      runId: null,
      runAttempt: null,
      job: null,
      metadataAttested: false,
    };
  assert.match(environment.GITHUB_RUN_ID ?? "", /^[1-9][0-9]{0,20}$/);
  assert.match(environment.GITHUB_RUN_ATTEMPT ?? "", /^[1-9][0-9]{0,8}$/);
  assert.match(environment.GITHUB_JOB ?? "", /^[A-Za-z0-9_-]{1,128}$/);
  return {
    kind: "github-actions-run-metadata",
    runId: environment.GITHUB_RUN_ID,
    runAttempt: environment.GITHUB_RUN_ATTEMPT,
    job: environment.GITHUB_JOB,
    metadataAttested: false,
  };
}
