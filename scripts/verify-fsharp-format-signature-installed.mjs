import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { parseAllDocuments } from "yaml";
import { kotlinRead } from "../dist/src/kotlin-io.js";
import { readFsharpReleaseProof } from "../dist/src/fsharp-format-release-signature.js";
import {
  installAcceptancePackage,
  runAcceptanceNpm,
} from "./install-acceptance-package.mjs";
const repository = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const hash = (body) => createHash("sha256").update(body).digest("hex");
const outcomes = {
  "qualified-broken": { status: "failed", packetVersion: 2 },
  "qualified-fixed": { status: "passed", packetVersion: 2 },
  "legacy-fixed": { status: "passed", packetVersion: 1 },
  "operator-capture-request-collision-borrowed-pin-packet-and-physical-afterchecks":
    { passed: true },
  "actual-runner-refuses-coherent-wrong-policy": { passed: true },
  "cli-fixed": { exitCode: 0 },
  "cli-broken": { exitCode: 1 },
  "mcp-cannot-promote-authority-and-private-summary": { passed: true },
};
export function parseFsharpSignatureCases(text) {
  assert.equal(typeof text, "string");
  assert.ok(Buffer.byteLength(text) > 0 && Buffer.byteLength(text) <= 8192);
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
    "requiredCaseIds",
    "schemaVersion",
  ]);
  assert.equal(value.schemaVersion, 1);
  assert.deepEqual(value.requiredCaseIds, Object.keys(outcomes));
  return value;
}
export async function readFsharpSignatureCases() {
  const body = await kotlinRead(
    fileURLToPath(
      new URL(
        "./fsharp-format-signature-native-cases.v1.json",
        import.meta.url,
      ),
    ),
    8192,
  );
  return {
    ...parseFsharpSignatureCases(body.toString("utf8")),
    sha256: hash(body),
  };
}
export function validateFsharpSignatureNativeReceipt(value, root, cases) {
  parseFsharpSignatureCases(
    JSON.stringify({
      schemaVersion: cases.schemaVersion,
      requiredCaseIds: cases.requiredCaseIds,
    }),
  );
  assert.deepEqual(Object.keys(value).sort(), [
    "cases",
    "fullClosureVerified",
    "gateAComplete",
    "packageRoot",
    "revocationFreshAtRuntime",
    "state",
  ]);
  assert.equal(value.state, "complete-scoped-native-chain");
  assert.equal(value.packageRoot, root);
  assert.equal(value.revocationFreshAtRuntime, false);
  assert.equal(value.fullClosureVerified, false);
  assert.equal(value.gateAComplete, false);
  assert.deepEqual(
    value.cases,
    cases.requiredCaseIds.map((id) => ({ id, ...outcomes[id] })),
  );
  return value;
}
export const fsharpSignatureRuntimeModules = [
  "fsharp-format.js",
  "fsharp-format-runner.js",
  "fsharp-format-evidence.js",
  "fsharp-format-contract.js",
  "fsharp-format-release-signature.js",
  "fsharp-format-pins.js",
  "release-signature-proof.js",
  "kotlin-io.js",
];
export async function observeFsharpSignatureRuntime(installed) {
  const rows = [];
  for (const name of fsharpSignatureRuntimeModules) {
    const source = await kotlinRead(
        path.join(repository, "dist/src", name),
        1024 * 1024,
      ),
      target = await kotlinRead(
        path.join(installed, "dist/src", name),
        1024 * 1024,
      );
    assert.deepEqual(target, source, "Installed runtime differs: " + name);
    rows.push({ name, bytes: source.length, sha256: hash(source) });
  }
  return rows;
}
export async function verifyFsharpSignatureInstalled(qualified, pin) {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "arm64");
  readFsharpReleaseProof(qualified, pin);
  const cases = await readFsharpSignatureCases(),
    cache = process.env.npm_config_cache;
  assert.ok(cache && path.isAbsolute(cache));
  assert.equal(await realpath(cache), cache);
  const temporary = await realpath(
    await mkdtemp(path.join(tmpdir(), "fsharp-signature-installed-")),
  );
  try {
    const packed = JSON.parse(
      runAcceptanceNpm(
        ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary],
        { cwd: repository, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      ),
    );
    assert.equal(packed.length, 1);
    assert.equal(path.basename(packed[0].filename), packed[0].filename);
    const tarball = path.join(temporary, packed[0].filename),
      consumer = path.join(temporary, "consumer"),
      installation = await installAcceptancePackage(
        repository,
        tarball,
        consumer,
        { cache },
      );
    const manifest = JSON.parse(
        await readFile(path.join(repository, "package.json"), "utf8"),
      ),
      installed = await realpath(
        path.join(consumer, "node_modules", manifest.name),
      );
    const before = await observeFsharpSignatureRuntime(installed);
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            "./verify-fsharp-format-signature-native.mjs",
            import.meta.url,
          ),
        ),
        installed,
        qualified,
        pin,
      ],
      { encoding: "utf8", timeout: 900000, maxBuffer: 4 * 1024 * 1024 },
    );
    process.stderr.write(result.stderr ?? "");
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const native = validateFsharpSignatureNativeReceipt(
      JSON.parse(result.stdout),
      installed,
      cases,
    );
    assert.deepEqual(await observeFsharpSignatureRuntime(installed), before);
    readFsharpReleaseProof(qualified, pin);
    const body = await kotlinRead(tarball, 32 * 1024 * 1024);
    assert.equal(installation.offlineProductionInstall, true);
    assert.equal(installation.lifecycleScriptsExecuted, false);
    return {
      schemaVersion: 1,
      state: "complete-scoped-installed-native-chain",
      installation,
      tarball: { bytes: body.length, sha256: hash(body) },
      installedPackage: installed,
      matchingRuntimeModules: before,
      caseManifestSha256: cases.sha256,
      native,
      harnessOutsideInstalledPackage: true,
      installedRuntimeEvaluated: true,
      installedCliEvaluated: true,
      installedMcpEvaluated: true,
      complete: true,
      revocationFreshAtRuntime: false,
      fullArtifactClosureClaimed: false,
      gateAComplete: false,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assert.equal(process.argv.length, 4, "Pass QUALIFIED_ROOT PROOF_SHA256");
  process.stdout.write(
    JSON.stringify(
      await verifyFsharpSignatureInstalled(process.argv[2], process.argv[3]),
    ) + "\n",
  );
}
