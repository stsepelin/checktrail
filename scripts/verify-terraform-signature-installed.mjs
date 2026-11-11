import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { parseAllDocuments } from "yaml";
import { kotlinRead } from "../dist/src/kotlin-io.js";
import {
  readRandomReleaseProof,
  randomReleaseProofEnvironment,
} from "../dist/src/terraform-release-signature.js";
import { copyInstalledPackages } from "../dist/test/tool-fixture.js";
import {
  assertLockedAcceptanceClient,
  installAcceptancePackage,
  runAcceptanceNpm,
} from "./install-acceptance-package.mjs";
import { runRequiredTests } from "./required-test-evidence.mjs";
const repository = fileURLToPath(new URL("../", import.meta.url));
const hash = (body) => createHash("sha256").update(body).digest("hex");
const expectedNames = [
  "Random signed native collector and final admission independently bind the externally selected proof and both payload members",
  "Random signed native CLI and MCP preserve actual mixed diagnostics and operator-only proof authority",
  "Random legacy native mode stays explicitly unverified and captured blank overrides a request proof",
];
const runtimeFiles = [
  "release-signature-proof.js",
  "terraform-release-signature.js",
  "terraform-extensions.js",
  "terraform-extensions-runner.js",
  "terraform-extensions-packet.js",
  "terraform-extensions-evidence.js",
];
export function parseTerraformSignatureCases(text) {
  assert.equal(typeof text, "string");
  assert.ok(
    Buffer.byteLength(text) > 0 && Buffer.byteLength(text) <= 16 * 1024,
  );
  const value = JSON.parse(text),
    docs = parseAllDocuments(text, {
      strict: true,
      uniqueKeys: true,
      prettyErrors: false,
    });
  assert.ok(
    docs.length === 1 && !docs[0].errors.length && !docs[0].warnings.length,
    "Signature case manifest JSON is ambiguous",
  );
  assert.deepEqual(Object.keys(value).sort(), [
    "file",
    "requiredCaseNames",
    "schemaVersion",
  ]);
  assert.equal(value.schemaVersion, 1);
  assert.equal(
    value.file,
    "dist/test/terraform-release-signature-native.test.js",
  );
  assert.deepEqual(value.requiredCaseNames, expectedNames);
  return value;
}
export async function readTerraformSignatureCases() {
  const body = await kotlinRead(
    fileURLToPath(
      new URL("./terraform-signature-native-cases.v1.json", import.meta.url),
    ),
    16 * 1024,
  );
  return {
    ...parseTerraformSignatureCases(body.toString("utf8")),
    sha256: hash(body),
  };
}
export function validateTerraformSignatureEvidence(value, cases) {
  assert.equal(value.complete, true);
  assert.deepEqual(value.problems, []);
  assert.equal(value.required, cases.requiredCaseNames.length);
  assert.equal(value.passed, value.required);
  assert.equal(value.ledger.truncated, false);
  assert.equal(value.ledger.terminalEventCount, value.required);
  assert.equal(value.ledger.events.length, value.required);
  assert.equal(value.ledger.cases.length, value.required);
  assert.deepEqual(
    value.ledger.cases.map((row) => row.name),
    cases.requiredCaseNames,
  );
  for (const [index, row] of value.ledger.cases.entries()) {
    assert.equal(row.outcome, "passed");
    assert.deepEqual(row.terminalSequences, [index + 1]);
    assert.equal(row.fileId, value.ledger.files[0].id);
  }
  assert.deepEqual(
    value.ledger.events.map((row) => row.name),
    cases.requiredCaseNames,
  );
  for (const [index, row] of value.ledger.events.entries()) {
    assert.equal(row.sequence, index + 1);
    assert.equal(row.fileId, value.ledger.files[0].id);
    assert.equal(row.kind, "test");
    assert.equal(row.outcome, "passed");
    assert.equal(row.nameTruncated, false);
    assert.equal(row.required, true);
  }
  assert.equal(value.ledger.files.length, 1);
  assert.equal(value.ledger.files[0].stable, true);
  assert.equal(value.ledger.files[0].before.state, "present");
  assert.deepEqual(value.ledger.files[0].before, value.ledger.files[0].after);
  return value;
}
export function validateTerraformSignatureReceipt(value, cases, role) {
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.role, role);
  assert.equal(value.caseManifestSha256, cases.sha256);
  assert.equal(value.complete, true);
  assert.equal(value.keyOwnerTrustEstablished, false);
  assert.equal(value.keyValidityAssessed, false);
  assert.equal(value.fullArtifactClosureClaimed, false);
  assert.equal(value.gateAComplete, false);
  validateTerraformSignatureEvidence(value.acceptance, cases);
  if (role === "installed") {
    assert.equal(value.installation.offlineProductionInstall, true);
    assert.equal(value.installation.lifecycleScriptsExecuted, false);
    assert.match(
      value.installation.productionDependencyLockSha256,
      /^[a-f0-9]{64}$/,
    );
    assert.equal(value.harnessOutsideInstalledPackage, true);
    assert.equal(value.productionGraphUntouchedByHarness, true);
    assert.deepEqual(
      value.matchingRuntimeModules.map((row) => row.name),
      runtimeFiles,
    );
  } else assert.equal(role, "source");
  return value;
}
async function observeRuntime(installed) {
  const rows = [];
  for (const name of runtimeFiles) {
    const source = await kotlinRead(
        path.join(repository, "dist/src", name),
        1024 * 1024,
      ),
      body = await kotlinRead(
        path.join(installed, "dist/src", name),
        1024 * 1024,
      );
    assert.deepEqual(body, source, "Installed runtime differs: " + name);
    rows.push({ name, bytes: body.length, sha256: hash(body) });
  }
  return rows;
}
async function runCases(file, qualified, pin, cases) {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "arm64");
  assert.equal(process.version, "v22.23.2");
  assert.equal(await realpath(qualified), qualified);
  assert.ok(readRandomReleaseProof(qualified, pin));
  const chosen = {
      CHECKTRAIL_RANDOM_RELEASE_PROOF_NATIVE: "1",
      CHECKTRAIL_TERRAFORM_EXTENSIONS_PROVIDER_ROOT: qualified,
      [randomReleaseProofEnvironment]: pin,
    },
    prior = {};
  for (const key of Object.keys(chosen)) {
    prior[key] = process.env[key];
    process.env[key] = chosen[key];
  }
  try {
    return validateTerraformSignatureEvidence(
      await runRequiredTests(
        cases.requiredCaseNames.map((name) => ({ file, name })),
        { timeoutMs: 180000 },
      ),
      cases,
    );
  } finally {
    for (const key of Object.keys(chosen)) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
}
export async function verifyTerraformSignature(role, qualified, pin) {
  assert.ok(["source", "installed"].includes(role));
  assert.ok(path.isAbsolute(qualified));
  assert.match(pin, /^[a-f0-9]{64}$/);
  const cases = await readTerraformSignatureCases(),
    base = {
      schemaVersion: 1,
      role,
      caseManifestSha256: cases.sha256,
      keyOwnerTrustEstablished: false,
      keyValidityAssessed: false,
      fullArtifactClosureClaimed: false,
      gateAComplete: false,
    };
  if (role === "source")
    return validateTerraformSignatureReceipt(
      {
        ...base,
        acceptance: await runCases(
          path.join(repository, cases.file),
          qualified,
          pin,
          cases,
        ),
        complete: true,
      },
      cases,
      role,
    );
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "arm64");
  assert.equal(process.version, "v22.23.2");
  const cache = process.env.npm_config_cache;
  assert.ok(cache && path.isAbsolute(cache));
  assert.equal(await realpath(cache), cache);
  const temporary = await mkdtemp(
    path.join(tmpdir(), "terraform-signature-installed-"),
  );
  try {
    const packed = JSON.parse(
      runAcceptanceNpm(
        ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
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
    const installed = await realpath(
        path.join(consumer, "node_modules/@stsepelin/checktrail"),
      ),
      before = await observeRuntime(installed),
      harness = path.join(temporary, "harness");
    await mkdir(path.join(harness, "dist/test"), { recursive: true });
    await symlink(
      path.join(installed, "dist/src"),
      path.join(harness, "dist/src"),
      "dir",
    );
    await cp(
      path.join(repository, "package.json"),
      path.join(harness, "package.json"),
    );
    for (const name of [
      "terraform-release-signature-native.test.js",
      "terraform-extensions-fixture.js",
      "helpers.js",
    ])
      await cp(
        path.join(repository, "dist/test", name),
        path.join(harness, "dist/test", name),
      );
    const client = JSON.parse(
      await readFile(
        path.join(
          repository,
          "node_modules/@modelcontextprotocol/client/package.json",
        ),
        "utf8",
      ),
    );
    await assertLockedAcceptanceClient(repository, client.version);
    await copyInstalledPackages(
      harness,
      ["@modelcontextprotocol/client"],
      path.join(repository, "node_modules"),
    );
    const acceptance = await runCases(
      path.join(harness, cases.file),
      qualified,
      pin,
      cases,
    );
    assert.deepEqual(
      await observeRuntime(installed),
      before,
      "Runtime changed during installed controls",
    );
    const body = await readFile(tarball);
    return validateTerraformSignatureReceipt(
      {
        ...base,
        installation,
        tarball: { bytes: body.length, sha256: hash(body) },
        matchingRuntimeModules: before,
        harnessOutsideInstalledPackage: true,
        productionGraphUntouchedByHarness: true,
        acceptance,
        complete: true,
      },
      cases,
      role,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  assert.equal(
    process.argv.length,
    5,
    "Pass source|installed, qualified provider root and proof SHA-256",
  );
  process.stdout.write(
    JSON.stringify(
      await verifyTerraformSignature(
        process.argv[2],
        process.argv[3],
        process.argv[4],
      ),
    ) + "\n",
  );
}
