import { setPrivateFixtureAccess } from "./windows-private-fixture.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { createHash } from "node:crypto";
import {
  readFile,
  readdir,
  writeFile,
  mkdir,
  symlink,
  link,
  rm,
} from "node:fs/promises";
import path from "node:path";
import {
  initializeReviewEvaluationStorage,
  sealReviewEvaluationCaptures as seal,
  inspectSealedReviewEvaluationCaptures as replay,
  encodeReviewEvaluationArtifact,
  reviewEvaluationAttemptArtifactSchema,
  reviewEvaluationCaptureArtifactSchema,
} from "../src/review-evaluation-artifacts.js";
import { artifactFixture } from "./review-evaluation-artifacts-fixture.js";
import { fixture } from "./helpers.js";
const digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
async function setup(t: TestContext) {
  const root = await fixture(t, {
    "project/marker.txt": "Original capture project",
  });
  const project = path.join(root, "project"),
    store = path.join(root, "private-capture");
  await mkdir(store, { mode: 0o700 });
  return { project, store, ...(await artifactFixture(store)) };
}
async function archived(store: string) {
  return JSON.parse(
    await readFile(path.join(store, "captures.sealed.json"), "utf8"),
  );
}
async function rewrite(store: string, value: unknown) {
  const b = encodeReviewEvaluationArtifact(value);
  await writeFile(path.join(store, "captures.sealed.json"), b);
  return digest(b);
}
test("external capture artifacts retain every reached attempt and physical output with deterministic replay", async (t) => {
  const f = await setup(t),
    original = structuredClone(f.input),
    r = seal(f.project, f.store, f.input);
  assert.equal(r.physicalArtifactsVerified, true);
  assert.equal(r.retainedCaptureRecords, 18);
  assert.equal(r.retainedAttemptRecords, 36);
  assert.equal(r.plannedSlots, 18);
  assert.equal(r.missingBlobCount, 0);
  assert.deepEqual(replay(f.project, f.store, r.archiveSha256), r);
  assert.deepEqual(f.input, original);
  const a = await archived(f.store);
  assert.equal(a.blobs.length, f.blobs.size);
  for (const b of a.blobs)
    assert.equal(digest(Buffer.from(b.base64, "base64")), b.sha256);
  assert.equal(
    r.physicalBytes,
    [...f.blobs.values()].reduce((n, b) => n + b.length, 0),
  );
});
test("external capture artifacts reject changed body bytes before committing any archive and accept the original repair", async (t) => {
  const f = await setup(t),
    file = path.join(f.store, "blobs", f.output.sha256 + ".blob");
  await writeFile(file, "Original changed bytes");
  assert.throws(() => seal(f.project, f.store, f.input), /disagree/);
  assert.deepEqual((await readdir(f.store)).sort(), ["blobs"]);
  await writeFile(file, f.blobs.get(f.output.sha256)!);
  assert.equal(
    seal(f.project, f.store, f.input).physicalArtifactsVerified,
    true,
  );
});
test("external capture artifacts allow equal bodies and preserve invalid metadata rather than authenticating a digest", async (t) => {
  const f = await setup(t);
  assert.equal(new Set(f.input.captures.map((c) => c.output!.sha256)).size, 1);
  const id = f.input.captures[0]!.captureSha256,
    record = JSON.parse(f.blobs.get(id)!.toString());
  record.role = "reference";
  const b = encodeReviewEvaluationArtifact(record),
    next = digest(b);
  f.input.captures[0]!.captureSha256 = next;
  await writeFile(path.join(f.store, "blobs", next + ".blob"), b, {
    mode: 0o600,
  });
  const r = seal(f.project, f.store, f.input);
  assert.equal(r.physicalArtifactsVerified, false);
  assert.ok(r.issues.includes("capture-record-metadata"));
  assert.equal(r.retainedCaptureRecords, 17);
  assert.deepEqual(replay(f.project, f.store, r.archiveSha256), r);
});
test("external capture artifacts retain missing records and reached retries even when their capture is absent", async (t) => {
  const f = await setup(t);
  const absent = f.input.captures.shift()!;
  await rm(path.join(f.store, "blobs", absent.output!.sha256 + ".blob"));
  const r = seal(f.project, f.store, f.input);
  assert.equal(r.captureInventoryComplete, false);
  assert.equal(r.physicalArtifactsVerified, false);
  assert.equal(r.retainedAttemptRecords, 36);
  assert.equal(r.plannedSlots, 18);
  assert.equal(r.missingBlobCount, 1);
  assert.ok(r.issues.includes("missing-physical-artifact"));
  assert.deepEqual(replay(f.project, f.store, r.archiveSha256), r);
});
test("external capture artifacts retain truncation unknown counters and independent stream accounting gaps", async (t) => {
  for (const mode of [
    "truncated",
    "unknown",
    "sum",
    "retained-size",
    "observation",
  ]) {
    const root = await fixture(t, { "project/marker": "Original" });
    const store = path.join(root, "capture");
    await mkdir(store, { mode: 0o700 });
    const f = await artifactFixture(store, (a, i) => {
      if (i !== 0) return;
      if (mode === "truncated") a.stdout.truncated = true;
      else if (mode === "unknown") a.stderr.observedBytes = null;
      else if (mode === "sum") a.stderr.observedBytes = 2;
      else if (mode === "retained-size") a.stdout.retained.bytes--;
      else a.stdout.observedBytes = 1;
    });
    const r = seal(path.join(root, "project"), store, f.input);
    assert.equal(r.physicalArtifactsVerified, false, mode);
    assert.ok(
      r.issues.includes(
        (
          {
            truncated: "truncated-physical-output",
            unknown: "unknown-physical-output",
            sum: "attempt-output-accounting",
            "retained-size": "stream-retention-size",
            observation: "stream-observation-accounting",
          } as Record<string, string>
        )[mode]!,
      ),
    );
    assert.deepEqual(
      replay(path.join(root, "project"), store, r.archiveSha256),
      r,
    );
  }
});
test("external capture artifacts bind raw attempt metadata and retain malformed records without losing counts", async (t) => {
  for (const mode of ["metadata", "malformed", "schema"]) {
    const f = await setup(t);
    const first = f.input.metering.slots[0]!.attempts[0]!,
      old = first.recordSha256;
    const record = JSON.parse(f.blobs.get(old)!.toString());
    if (mode === "metadata") record.ordinal = 1;
    else if (mode === "schema")
      record.authorization = "OriginalPrivateCredentialCanary";
    const b =
        mode === "malformed"
          ? Buffer.from("{not-json")
          : encodeReviewEvaluationArtifact(record),
      id = digest(b);
    first.recordSha256 = id;
    await writeFile(path.join(f.store, "blobs", id + ".blob"), b, {
      mode: 0o600,
    });
    const r = seal(f.project, f.store, f.input);
    assert.equal(r.physicalArtifactsVerified, false, mode);
    assert.equal(r.retainedAttemptRecords, 35);
    assert.ok(
      r.issues.includes(
        mode === "metadata"
          ? "attempt-record-metadata"
          : "invalid-attempt-record",
      ),
    );
    assert.deepEqual(replay(f.project, f.store, r.archiveSha256), r);
  }
});
test("external capture artifacts enforce private files directories and project boundaries before writing", async (t) => {
  const f = await setup(t),
    file = path.join(f.store, "blobs", f.output.sha256 + ".blob");
  const initialized = path.join(path.dirname(f.store), "original-initialized");
  const result = initializeReviewEvaluationStorage(f.project, initialized);
  assert.equal(result.initialized, true);
  assert.equal(
    result.backend,
    process.platform === "win32" ? "windows-dacl" : "posix-mode",
  );
  assert.deepEqual(await readdir(initialized), ["blobs"]);
  await writeFile(
    path.join(initialized, "marker"),
    "Original preserved operator data",
    { mode: 0o600 },
  );
  assert.throws(
    () => initializeReviewEvaluationStorage(f.project, initialized),
    /EEXIST/,
  );
  assert.equal(
    await readFile(path.join(initialized, "marker"), "utf8"),
    "Original preserved operator data",
  );
  const forbidden = path.join(f.project, "original-refused");
  assert.throws(
    () => initializeReviewEvaluationStorage(f.project, forbidden),
    /outside/,
  );
  await assert.rejects(readFile(forbidden), { code: "ENOENT" });

  await setPrivateFixtureAccess(file, "file", false);
  assert.throws(() => seal(f.project, f.store, f.input), /private/);
  await setPrivateFixtureAccess(file, "file");
  await setPrivateFixtureAccess(
    path.join(f.store, "blobs"),
    "directory",
    false,
  );
  assert.throws(() => seal(f.project, f.store, f.input), /private/);
  await setPrivateFixtureAccess(path.join(f.store, "blobs"), "directory");
  await setPrivateFixtureAccess(f.store, "directory", false);
  assert.throws(() => seal(f.project, f.store, f.input), /private/);
  await setPrivateFixtureAccess(f.store, "directory");
  const inside = path.join(f.project, "private");
  await mkdir(inside, { mode: 0o700 });
  assert.throws(() => seal(f.project, inside, f.input), /outside/);
  assert.throws(() => seal(f.project, "relative", f.input), /absolute/);
  assert.deepEqual((await readdir(f.store)).sort(), ["blobs"]);
});
test("external capture artifacts refuse links aliases and special files while preserving their targets", async (t) => {
  for (const mode of ["symlink", "hardlink", "directory"]) {
    const f = await setup(t),
      file = path.join(f.store, "blobs", f.output.sha256 + ".blob"),
      target = path.join(f.store, "original-private");
    await writeFile(target, f.blobs.get(f.output.sha256)!, { mode: 0o600 });
    await rm(file);
    if (mode === "symlink") await symlink(target, file);
    else if (mode === "hardlink") await link(target, file);
    else await mkdir(file, { mode: 0o700 });
    assert.throws(() => seal(f.project, f.store, f.input));
    assert.equal(
      (await readFile(target)).equals(f.blobs.get(f.output.sha256)!),
      true,
    );
    assert.deepEqual((await readdir(f.store)).sort(), [
      "blobs",
      "original-private",
    ]);
  }
  const f = await setup(t),
    alias = f.store + "-alias";
  await symlink(f.store, alias);
  assert.throws(() => seal(f.project, alias, f.input), /private/);
});
test("external capture artifacts reject stale archives and malformed duplicate unused and omitted retained inventories", async (t) => {
  const f = await setup(t),
    r = seal(f.project, f.store, f.input),
    original = await archived(f.store);
  assert.throws(() => replay(f.project, f.store, "0".repeat(64)), /identity/);
  for (const mode of [
    "bytes",
    "duplicate",
    "unused",
    "omitted",
    "missing",
    "base64",
  ]) {
    const a = structuredClone(original);
    if (mode === "bytes")
      a.blobs[0].base64 = Buffer.from("Original replacement").toString(
        "base64",
      );
    else if (mode === "duplicate") a.blobs.push(a.blobs[0]);
    else if (mode === "unused") {
      const b = Buffer.from("Original unused");
      a.blobs.push({ sha256: digest(b), base64: b.toString("base64") });
    } else if (mode === "omitted") a.blobs.pop();
    else if (mode === "missing") a.missing.push(a.blobs[0].sha256);
    else a.blobs[0].base64 += "\n";
    const id = await rewrite(f.store, a);
    assert.throws(
      () => replay(f.project, f.store, id),
      /Sealed|Duplicate|Invalid/,
      mode,
    );
  }
  await rewrite(f.store, original);
  assert.deepEqual(replay(f.project, f.store, r.archiveSha256), r);
});
test("external capture artifacts seal once replay retained bytes and never resume or mutate incoming work", async (t) => {
  const f = await setup(t),
    r = seal(f.project, f.store, f.input),
    bytes = await readFile(path.join(f.store, "captures.sealed.json"));
  await rm(path.join(f.store, "blobs"), { recursive: true });
  assert.deepEqual(replay(f.project, f.store, r.archiveSha256), r);
  await mkdir(path.join(f.store, "blobs"), { mode: 0o700 });
  assert.throws(() => seal(f.project, f.store, f.input));
  assert.deepEqual(
    await readFile(path.join(f.store, "captures.sealed.json")),
    bytes,
  );
  assert.deepEqual((await readdir(f.store)).sort(), [
    "blobs",
    "captures.sealed.json",
  ]);
});
test("external capture artifacts keep physical validity distinct from empty reviews unknown usage and authenticity", async (t) => {
  const f = await setup(t);
  f.input.metering.slots[0]!.attempts[0]!.inputTokens = null;
  const r = seal(f.project, f.store, f.input);
  assert.equal(r.measurementAccountingComplete, false);
  assert.equal(r.physicalArtifactsVerified, false);
  assert.ok(r.issues.includes("attempt-record-metadata"));
  for (const k of [
    "collectorAuthenticityVerified",
    "actualAttemptsComplete",
    "hostIndependenceVerified",
    "claimTruthVerified",
    "qualityAssessed",
    "gateAClosed",
    "sourceIncluded",
    "privateIdentitiesIncluded",
    "inferenceInvoked",
  ] as const)
    assert.equal(r[k], false, k);
  const summary = JSON.stringify(r);
  for (const secret of [
    f.input.captures[0]!.caseId,
    f.input.captures[0]!.captureSha256,
    "Original externally",
    f.input.metering.slots[0]!.attempts[0]!.sessionId,
  ])
    assert.equal(summary.includes(secret), false);
});
test("external capture artifacts enforce strict raw record contracts and per-file and aggregate storage limits", async (t) => {
  assert.equal(
    reviewEvaluationAttemptArtifactSchema.safeParse({
      authorization: "OriginalPrivateCredentialCanary",
    }).success,
    false,
  );
  assert.equal(
    reviewEvaluationCaptureArtifactSchema.safeParse({}).success,
    false,
  );
  const f = await setup(t),
    file = path.join(f.store, "blobs", f.output.sha256 + ".blob");
  await writeFile(file, Buffer.alloc(4 * 1048576 + 1));
  assert.throws(() => seal(f.project, f.store, f.input), /bounded/);
  assert.deepEqual((await readdir(f.store)).sort(), ["blobs"]);
  // Distinct large reached outputs exceed the shared cap although each individual blob fits.
  const g = await setup(t);
  for (let i = 0; i < 5; i++) {
    const bytes = Buffer.alloc(4 * 1048576, i + 1),
      id = digest(bytes);
    await writeFile(path.join(g.store, "blobs", id + ".blob"), bytes, {
      mode: 0o600,
    });
    g.input.captures[i]!.output = { sha256: id, bytes: bytes.length };
  }
  assert.throws(() => seal(g.project, g.store, g.input), /bound/);
  assert.deepEqual((await readdir(g.store)).sort(), ["blobs"]);
});

test(
  "external capture artifacts repeat the same physical controls through a fresh offline production installation",
  { timeout: 120000 },
  async () => {
    if (process.env.CHECKTRAIL_EVALUATION_PROTOCOL_INSTALLED === "1") {
      const actual = await realpath(
        fileURLToPath(
          new URL("../src/review-evaluation-artifacts.js", import.meta.url),
        ),
      );
      assert.ok(
        actual.includes(path.join("node_modules", "@stsepelin", "checktrail")),
      );
      return;
    }
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const script = fileURLToPath(
      new URL(
        "../../scripts/verify-evaluation-protocol-package.mjs",
        import.meta.url,
      ),
    );
    const r = spawnSync(process.execPath, [script, "--artifacts"], {
      env,
      encoding: "utf8",
      timeout: 115000,
      maxBuffer: 4 * 1048576,
    });
    assert.equal(r.status, 0, (r.stderr + r.stdout).slice(0, 5000));
    const proof = JSON.parse(r.stdout);
    assert.equal(proof.offlineProductionInstall, true);
    assert.equal(proof.lifecycleScriptsExecuted, false);
    assert.equal(proof.harnessOutsideInstalledPackage, true);
    assert.equal(proof.profileEvidence.required, 13);
    assert.equal(proof.profileEvidence.passed, 13);
    assert.equal(proof.profileEvidence.complete, true);
  },
);
