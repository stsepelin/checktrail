import { Buffer } from "node:buffer";
// Operator-only composition of bounded existing audits. No legal or build verdict.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

export const provenanceFamilies = Object.freeze([
  "random-provider",
  "scala2",
  "fantomas",
  "context-runtime",
]);
const names = Object.freeze([
  "native-provenance-adapter.mjs",
  "native-provenance-audit-child.mjs",
  "audit-dependencies.mjs",
  "audit-selected-artifact-evidence.mjs",
  "pango-complete-text-binding.mjs",
]);
const here = fileURLToPath(new URL("./", import.meta.url));
export const provenanceHash = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const exact = (value, keys) =>
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort(),
    "Exact provenance fields required",
  );
const digest = (value) => assert.match(value, /^[a-f0-9]{64}$/u);
const canonical = async (value) => {
  assert.equal(typeof value, "string");
  assert.ok(path.isAbsolute(value));
  assert.equal(
    await realpath(value),
    value,
    "Canonical provenance path required",
  );
  return value;
};
async function provenanceBytes(file, maximum = 1024 * 1024) {
  await canonical(file);
  const fd = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const a = await fd.stat();
    assert.ok(
      a.isFile() && a.size > 0 && a.size <= maximum,
      "Bounded regular provenance file required",
    );
    const bytes = Buffer.alloc(a.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const row = await fd.read(bytes, used, bytes.length - used, null);
      if (!row.bytesRead) break;
      used += row.bytesRead;
    }
    const b = await fd.stat();
    assert.ok(
      used === a.size &&
        a.dev === b.dev &&
        a.ino === b.ino &&
        a.size === b.size &&
        a.mtimeMs === b.mtimeMs &&
        a.ctimeMs === b.ctimeMs,
      "Provenance file changed or grew during capture",
    );
    return bytes.subarray(0, used);
  } finally {
    await fd.close();
  }
}
async function provenanceTree(root) {
  await canonical(root);
  const files = [];
  let bytes = 0;
  const visit = async (local, depth) => {
    assert.ok(depth <= 12, "Provenance tree depth exhausted");
    for (const name of (await readdir(path.join(root, local))).sort()) {
      assert.ok(!/[\\\0]/u.test(name) && name !== "." && name !== "..");
      const relative = path.posix.join(local, name),
        file = path.join(root, relative),
        info = await lstat(file);
      assert.ok(!info.isSymbolicLink(), "Provenance tree cannot follow links");
      if (info.isDirectory()) await visit(relative, depth + 1);
      else {
        assert.ok(files.length < 4096, "Provenance file inventory exhausted");
        const body = await provenanceBytes(file, 64 * 1024 * 1024);
        bytes += body.length;
        assert.ok(
          bytes <= 128 * 1024 * 1024,
          "Provenance tree byte bound exhausted",
        );
        files.push({
          file: relative,
          bytes: body.length,
          sha256: provenanceHash(body),
          mode: info.mode & 0o777,
        });
      }
    }
  };
  await visit("", 0);
  assert.ok(files.length > 0, "Empty provenance tree");
  return {
    files: files.length,
    bytes,
    sha256: provenanceHash(JSON.stringify(files)),
  };
}
function validateProvenancePolicy(value) {
  exact(value, [
    "schemaVersion",
    "profile",
    "runtime",
    "coordinator",
    "engine",
    "npm",
    "artifacts",
    "proofs",
    "journal",
    "limits",
  ]);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.profile, "selected-native-provenance-composition-v1");
  exact(value.runtime, [
    "node",
    "platform",
    "architecture",
    "executable",
    "npm",
  ]);
  exact(value.runtime.npm, ["file", "sha256"]);
  assert.ok(path.isAbsolute(value.runtime.npm.file));
  digest(value.runtime.npm.sha256);
  for (const pin of [value.coordinator, value.runtime.executable]) {
    exact(pin, ["file", "sha256"]);
    assert.ok(path.isAbsolute(pin.file));
    digest(pin.sha256);
  }
  for (const field of ["node", "platform", "architecture"])
    assert.equal(typeof value.runtime[field], "string");
  for (const field of ["engine", "npm", "artifacts"]) {
    exact(value[field], ["root", "identity"]);
    assert.ok(path.isAbsolute(value[field].root));
    exact(value[field].identity, ["files", "bytes", "sha256"]);
    digest(value[field].identity.sha256);
    assert.ok(
      Number.isSafeInteger(value[field].identity.files) &&
        value[field].identity.files > 0 &&
        Number.isSafeInteger(value[field].identity.bytes) &&
        value[field].identity.bytes > 0,
    );
  }
  assert.deepEqual(
    value.proofs.map((row) => row.family),
    provenanceFamilies,
    "Every selected family needs exactly one ordered disposition",
  );
  for (const proof of value.proofs) {
    if (proof.selection === "unselected") exact(proof, ["family", "selection"]);
    else {
      exact(proof, ["family", "selection", "root", "sha256", "identity"]);
      exact(proof.identity, ["files", "bytes", "sha256"]);
      digest(proof.identity.sha256);
      assert.equal(proof.selection, "operator-pinned");
      assert.ok(path.isAbsolute(proof.root));
      digest(proof.sha256);
    }
  }
  assert.ok(path.isAbsolute(value.journal));
  for (const { root } of [value.engine, value.npm, value.artifacts])
    assert.ok(
      value.journal !== root && !value.journal.startsWith(root + path.sep),
      "Journal must stay outside captured inputs",
    );
  exact(value.limits, ["auditTimeoutMs", "auditOutputBytes"]);
  assert.ok(
    Number.isInteger(value.limits.auditTimeoutMs) &&
      value.limits.auditTimeoutMs >= 1 &&
      value.limits.auditTimeoutMs <= 30000,
  );
  assert.ok(
    Number.isInteger(value.limits.auditOutputBytes) &&
      value.limits.auditOutputBytes >= 1024 &&
      value.limits.auditOutputBytes <= 1024 * 1024,
  );
  return value;
}

async function npmCliIdentity(file) {
  const actual = await canonical(file);
  return {
    file: actual,
    sha256: provenanceHash(await provenanceBytes(actual, 1024 * 1024)),
  };
}
async function resolveNpmIdentity(selected) {
  if (selected) return npmCliIdentity(selected);
  const candidates = [
    path.join(
      path.dirname(process.execPath),
      "node_modules/npm/bin/npm-cli.js",
    ),
    path.resolve(
      path.dirname(process.execPath),
      "../lib/node_modules/npm/bin/npm-cli.js",
    ),
  ];
  if (process.env.npm_execpath && path.isAbsolute(process.env.npm_execpath))
    candidates.push(process.env.npm_execpath);
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    try {
      const real = await realpath(
        path.join(directory, process.platform === "win32" ? "npm.cmd" : "npm"),
      );
      candidates.push(
        real.endsWith(".js")
          ? real
          : path.join(path.dirname(real), "node_modules/npm/bin/npm-cli.js"),
      );
    } catch (error) {
      if (!["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) throw error;
    }
  }
  for (const file of candidates) {
    try {
      return await npmCliIdentity(await realpath(file));
    } catch (error) {
      if (!["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) throw error;
    }
  }
  throw new Error(
    "Operator npm CLI unavailable; select its canonical file explicitly",
  );
}
export async function recheckProvenanceRuntimeFiles(runtime) {
  const executable = {
    file: await canonical(runtime.executable.file),
    sha256: provenanceHash(
      await provenanceBytes(runtime.executable.file, 256 * 1024 * 1024),
    ),
  };
  assert.deepEqual(
    executable,
    runtime.executable,
    "Selected Node executable changed during observation",
  );
  assert.deepEqual(
    await npmCliIdentity(runtime.npm.file),
    runtime.npm,
    "Inspection runtime changed during observation",
  );
}
export async function createNativeProvenanceBundle({
  engineRoot,
  npmRoot,
  artifactRoot,
  npmCliFile,
  proofs = provenanceFamilies.map((family) => ({
    family,
    selection: "unselected",
  })),
  journal,
  limits = { auditTimeoutMs: 15000, auditOutputBytes: 1024 * 1024 },
}) {
  proofs = await Promise.all(
    proofs.map(async (proof) =>
      proof.selection === "unselected"
        ? proof
        : {
            ...proof,
            root: await canonical(proof.root),
            identity: await provenanceTree(proof.root),
          },
    ),
  );
  const executable = await canonical(process.execPath);
  const npm = await resolveNpmIdentity(npmCliFile);
  const coordinatorFile = fileURLToPath(import.meta.url);
  const policy = validateProvenancePolicy({
    schemaVersion: 1,
    profile: "selected-native-provenance-composition-v1",
    runtime: {
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      npm,
      executable: {
        file: executable,
        sha256: provenanceHash(
          await provenanceBytes(executable, 256 * 1024 * 1024),
        ),
      },
    },
    coordinator: {
      file: coordinatorFile,
      sha256: provenanceHash(
        await provenanceBytes(coordinatorFile, 2 * 1024 * 1024),
      ),
    },
    engine: {
      root: await canonical(engineRoot),
      identity: await provenanceTree(engineRoot),
    },
    npm: {
      root: await canonical(npmRoot),
      identity: await provenanceTree(npmRoot),
    },
    artifacts: {
      root: await canonical(artifactRoot),
      identity: await provenanceTree(artifactRoot),
    },
    proofs,
    journal,
    limits,
  });
  await canonical(path.dirname(journal));
  const contents = new Map();
  for (const name of names)
    contents.set(
      name,
      await provenanceBytes(path.join(here, name), 2 * 1024 * 1024),
    );
  const npmScript = await provenanceBytes(
    path.join(npmRoot, "scripts/audit-dependencies.mjs"),
    2 * 1024 * 1024,
  );
  assert.equal(
    provenanceHash(npmScript),
    provenanceHash(contents.get("audit-dependencies.mjs")),
    "Npm capsule must use the actual pinned first-party auditor",
  );
  contents.set("policy.json", Buffer.from(JSON.stringify(policy)));
  const manifest = {
    schemaVersion: 1,
    id: "external.native-provenance",
    version: "1.0.0",
    description:
      "Selected provenance audit composition; full build and notice closure remains unqualified",
    runtime: "node",
    entry: "native-provenance-adapter.mjs",
    files: [...contents].map(([name, bytes]) => ({
      path: name,
      sha256: provenanceHash(bytes),
    })),
    markers: ["native-provenance.project"],
    checks: [
      {
        id: "observations",
        kind: "analysis",
        description:
          "Reconcile selected audit and operator proof observations without promoting unresolved closure",
        failOn: "error",
        scope: { extensions: [], names: ["native-provenance.project"] },
      },
    ],
  };
  return {
    policy,
    manifest,
    bytes: Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        kind: "checktrail-executable-bundle",
        manifestBase64: Buffer.from(JSON.stringify(manifest)).toString(
          "base64",
        ),
        files: [...contents].map(([name, body]) => ({
          path: name,
          base64: body.toString("base64"),
        })),
      }),
    ),
  };
}
async function appendProvenanceEvent(file, event) {
  const parent = await lstat(await canonical(path.dirname(file)));
  assert.ok(parent.isDirectory());
  const fd = await open(
    file,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_APPEND |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o600,
  );
  try {
    const info = await fd.stat();
    const row = JSON.stringify(event) + "\n";
    assert.ok(
      info.isFile() && info.size + Buffer.byteLength(row) <= 1024 * 1024,
      "Bounded private provenance journal required",
    );
    await fd.appendFile(row);
    await fd.sync();
  } finally {
    await fd.close();
  }
}
const unknowns = provenanceFamilies.map((family) => ({
  family,
  dimension: "complete-producer-and-original-notice-closure",
  state: "unverified",
}));
export async function composeNativeProvenance(
  input,
  temporary,
  signal,
  selectedPolicy,
  bundleRoot,
) {
  const policy = validateProvenancePolicy(selectedPolicy);
  const runId = randomUUID(),
    runtime = {
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      npm: null,
      executable: null,
    };
  const receipt = {
    schemaVersion: 1,
    scope: policy.profile,
    runId,
    sourceFingerprint: input.sourceFingerprint,
    sourceFingerprintScope:
      "engine-invocation-identity-not-project-file-coverage",
    operatorPolicySha256: provenanceHash(JSON.stringify(policy)),
    coordinator: policy.coordinator,
    runtime,
    inputs: {},
    audits: [],
    proofs: [],
    unresolved: unknowns.map((row) => ({ ...row })),
    state: "incomplete",
    rawOutputRetentionComplete: true,
    legalComplianceAssessed: false,
    cryptographicVerificationExecutedByCoordinator: false,
    fullCompilerSdkBootstrapClosureVerified: false,
    completeOriginalNoticeClosureVerified: false,
    gateAComplete: false,
  };
  let journalAdmitted = false,
    rawOutputBytes = 0;
  try {
    runtime.npm = await npmCliIdentity(policy.runtime.npm.file);
    runtime.executable = {
      file: await canonical(process.execPath),
      sha256: provenanceHash(
        await provenanceBytes(
          await canonical(process.execPath),
          256 * 1024 * 1024,
        ),
      ),
    };
    assert.deepEqual(
      runtime,
      policy.runtime,
      "Operator runtime identity changed",
    );
    assert.equal(
      provenanceHash(
        await provenanceBytes(policy.coordinator.file, 2 * 1024 * 1024),
      ),
      policy.coordinator.sha256,
      "Operator coordinator source changed",
    );
    for (const field of ["engine", "npm", "artifacts"]) {
      const identity = await provenanceTree(policy[field].root);
      assert.deepEqual(
        identity,
        policy[field].identity,
        "Operator " + field + " input identity changed",
      );
      receipt.inputs[field] = identity;
    }
    for (const name of [
      "audit-dependencies.mjs",
      "audit-selected-artifact-evidence.mjs",
      "pango-complete-text-binding.mjs",
    ])
      assert.equal(
        provenanceHash(
          await provenanceBytes(path.join(bundleRoot, name), 2 * 1024 * 1024),
        ),
        provenanceHash(
          await provenanceBytes(path.join(here, name), 2 * 1024 * 1024),
        ),
        "Actual first-party audit source changed: " + name,
      );
    const journalParent = await lstat(
      await canonical(path.dirname(policy.journal)),
    );
    if (process.platform === "win32") {
      const acl = await import(
        pathToFileURL(path.join(policy.engine.root, "windows-task-access.js"))
          .href
      );
      acl.ensureWindowsTaskAccess(
        path.dirname(policy.journal),
        "directory",
        false,
      );
    } else
      assert.ok(
        journalParent.uid === process.getuid() &&
          (journalParent.mode & 0o777) === 0o700,
        "Private operator-owned provenance journal directory required",
      );
    let journalCreated = false;
    try {
      const initial = await open(policy.journal, "wx", 0o600);
      await initial.close();
      journalCreated = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (process.platform === "win32") {
      const acl = await import(
        pathToFileURL(path.join(policy.engine.root, "windows-task-access.js"))
          .href
      );
      acl.ensureWindowsTaskAccess(policy.journal, "file", journalCreated);
    } else {
      const info = await lstat(policy.journal);
      assert.ok(
        info.isFile() &&
          !info.isSymbolicLink() &&
          info.uid === process.getuid() &&
          (info.mode & 0o777) === 0o600,
        "Private operator-owned provenance journal file required",
      );
    }
    journalAdmitted = true;
    await appendProvenanceEvent(policy.journal, {
      runId,
      state: "coordinator-started",
      sourceFingerprint: input.sourceFingerprint,
    });
    const runner = await import(
      pathToFileURL(path.join(policy.engine.root, "runner.js")).href
    );
    for (const phase of [
      "npm-production",
      "npm-development",
      "selected-artifact-evidence",
    ]) {
      signal?.throwIfAborted();
      const request = {
        schemaVersion: 1,
        runId,
        phase,
        journal: policy.journal,
        root: phase.startsWith("npm") ? policy.npm.root : policy.artifacts.root,
        sourceFingerprint: input.sourceFingerprint,
        npmCli: policy.runtime.npm,
        auditorSha256: provenanceHash(
          await provenanceBytes(
            path.join(
              bundleRoot,
              phase.startsWith("npm")
                ? "audit-dependencies.mjs"
                : "audit-selected-artifact-evidence.mjs",
            ),
            2 * 1024 * 1024,
          ),
        ),
      };
      const requestFile = path.join(temporary, phase + ".json");
      await writeFile(requestFile, JSON.stringify(request), {
        flag: "wx",
        mode: 0o600,
      });
      const processResult = await runner.runProcess(
        temporary,
        {
          executable: process.execPath,
          args: [
            path.join(bundleRoot, "native-provenance-audit-child.mjs"),
            requestFile,
          ],
          cwd: ".",
          env: {
            PATH: process.env.PATH ?? "",
            NODE_OPTIONS: "",
            TZ: "UTC",
          },
        },
        {
          timeoutMs: policy.limits.auditTimeoutMs,
          maxOutputBytes: policy.limits.auditOutputBytes,
          captureRawOutput: true,
          signal,
        },
      );
      const witness = {
        phase,
        state: "execution-incomplete",
        auditorSha256: request.auditorSha256,
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        timedOut: processResult.timedOut,
        cancelled: processResult.cancelled,
        truncated: processResult.truncated,
        outputBytes: processResult.outputBytes,
        stdoutSha256: provenanceHash(processResult.stdout),
        stderrSha256: provenanceHash(processResult.stderr),
        stdout: processResult.stdout,
        stderr: processResult.stderr,
        ...(processResult.error ? { error: processResult.error } : {}),
      };
      receipt.audits.push(witness);
      if (processResult.truncated) receipt.rawOutputRetentionComplete = false;
      rawOutputBytes +=
        Buffer.byteLength(witness.stdout) + Buffer.byteLength(witness.stderr);
      if (rawOutputBytes > 256 * 1024) {
        witness.stdout = "";
        witness.stderr = "";
        receipt.rawOutputRetentionComplete = false;
        throw new Error("Coordinator raw observation retention exhausted");
      }
      assert.ok(
        !processResult.error &&
          !processResult.signal &&
          !processResult.timedOut &&
          !processResult.cancelled &&
          !processResult.truncated,
        "Audit native execution incomplete: " + phase,
      );
      assert.ok(
        processResult.stdout.length > 0,
        "Audit returned no structured observation: " + phase,
      );
      const report = JSON.parse(processResult.stdout);
      if (phase.startsWith("npm")) {
        assert.equal(
          report.provenance,
          "installed-metadata-and-lockfile-audit",
        );
        assert.equal(report.schemaVersion, phase === "npm-production" ? 1 : 2);
        assert.equal(
          report.scope,
          phase === "npm-production"
            ? "production-npm-dependencies"
            : "production-and-development-npm-dependencies",
        );
        assert.ok(Array.isArray(report.gaps) && Array.isArray(report.packages));
        assert.equal(report.complete, report.gaps.length === 0);
        assert.equal(processResult.exitCode, report.complete ? 0 : 2);
        assert.equal(
          report.lockedPackageCount,
          report.installedPackageCount +
            report.platformInapplicableCount +
            report.optionalAbsentCount,
        );
        if (phase === "npm-development")
          assert.equal(report.completeNativeArtifactClosure, false);
        Object.assign(witness, {
          state: report.complete ? "consistent-within-npm-scope" : "incomplete",
          lockedPackageCount: report.lockedPackageCount,
          inspectedPackageCount: report.packages.length,
          gaps: report.gaps.length,
        });
      } else {
        assert.equal(processResult.exitCode, 0);
        assert.equal(report.schemaVersion, 1);
        assert.equal(report.evidenceConsistent, true);
        assert.ok(report.files >= 4 && report.retainedReferences > 0);
        for (const name of [
          "cryptographicVerificationPerformedByAudit",
          "nativeAcceptanceAssessed",
          "gateAComplete",
          "qualityAssessed",
        ])
          assert.equal(report[name], false);
        Object.assign(witness, {
          state: "consistent-observations-only",
          files: report.files,
          retainedReferences: report.retainedReferences,
        });
      }
      await appendProvenanceEvent(policy.journal, {
        runId,
        phase,
        state: "audit-observed",
        witness,
      });
    }
    for (const proof of policy.proofs) {
      signal?.throwIfAborted();
      if (proof.selection === "unselected") {
        receipt.proofs.push({
          family: proof.family,
          state: "unselected",
          nativeVerificationObservedByCoordinator: false,
        });
        continue;
      }
      const proofObservation = {
        family: proof.family,
        state: "admission-incomplete",
        nativeVerificationObservedByCoordinator: false,
      };
      receipt.proofs.push(proofObservation);
      await canonical(proof.root);
      assert.deepEqual(
        await provenanceTree(proof.root),
        proof.identity,
        "Selected proof root identity changed",
      );
      let reference;
      if (proof.family === "random-provider") {
        const api = await import(
          pathToFileURL(
            path.join(policy.engine.root, "terraform-release-signature.js"),
          ).href
        );
        reference = api.readRandomReleaseProof(proof.root, proof.sha256);
      } else if (proof.family === "scala2") {
        const api = await import(
          pathToFileURL(
            path.join(policy.engine.root, "scala2-release-signature.js"),
          ).href
        );
        const archive = path.join(proof.root, api.scala2ReleaseArchiveFilename);
        reference = api.scala2ReleaseSignature(
          archive,
          await provenanceBytes(archive, 64 * 1024 * 1024),
          proof.sha256,
        );
      } else if (proof.family === "fantomas") {
        const api = await import(
          pathToFileURL(
            path.join(policy.engine.root, "fsharp-format-release-signature.js"),
          ).href
        );
        reference = api.readFsharpReleaseProof(proof.root, proof.sha256);
      } else {
        const api = await import(
          pathToFileURL(
            path.join(policy.engine.root, "context-runtime-proof.js"),
          ).href
        );
        reference = api.readContextRuntimeProof(
          path.join(proof.root, "proof.json"),
          proof.sha256,
        ).reference;
      }
      assert.ok(
        reference,
        "Selected proof cannot downgrade to unverified mode",
      );
      assert.deepEqual(
        await provenanceTree(proof.root),
        proof.identity,
        "Selected proof root changed during admission",
      );
      Object.assign(proofObservation, {
        state: "operator-pinned-scope-reconciled",
        reference,
      });
    }
    assert.equal(receipt.audits.length, 3);
    assert.deepEqual(
      receipt.proofs.map((row) => row.family),
      provenanceFamilies,
    );
    for (const field of ["engine", "npm", "artifacts"])
      assert.deepEqual(
        await provenanceTree(policy[field].root),
        receipt.inputs[field],
        "Provenance input changed during observation",
      );
    assert.equal(
      provenanceHash(
        await provenanceBytes(policy.coordinator.file, 2 * 1024 * 1024),
      ),
      policy.coordinator.sha256,
      "Operator coordinator changed during observation",
    );
    await recheckProvenanceRuntimeFiles(policy.runtime);
  } catch (error) {
    receipt.state = "error";
    receipt.error = String(error).slice(0, 2048);
  }
  for (const phase of [
    "npm-production",
    "npm-development",
    "selected-artifact-evidence",
  ])
    if (!receipt.audits.some((row) => row.phase === phase))
      receipt.audits.push({
        phase,
        state: "unrun",
        reason: "earlier-incomplete-observation",
      });
  for (const family of provenanceFamilies)
    if (!receipt.proofs.some((row) => row.family === family))
      receipt.proofs.push({
        family,
        state: "unrun",
        reason: "earlier-incomplete-observation",
        nativeVerificationObservedByCoordinator: false,
      });
  assert.equal(receipt.audits.length, 3);
  assert.deepEqual(
    receipt.proofs.map((row) => row.family),
    provenanceFamilies,
  );
  if (journalAdmitted)
    await appendProvenanceEvent(policy.journal, {
      runId,
      state: "coordinator-terminal",
      receiptSha256: provenanceHash(JSON.stringify(receipt)),
      auditAttempts: receipt.audits.filter((row) => row.state !== "unrun")
        .length,
      proofDispositions: receipt.proofs.length,
      outcome: receipt.state,
    });
  return receipt;
}
