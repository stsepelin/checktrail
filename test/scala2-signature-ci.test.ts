import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import {
  scala2ReleaseArchiveFilename,
  scala2ReleaseSignatureReference,
} from "../src/scala2-release-signature.js";
const installed = () =>
  import(
    new URL(
      "../../scripts/verify-scala2-signature-installed.mjs",
      import.meta.url,
    ).href
  );
const container = () =>
  import(
    new URL(
      "../../scripts/verify-scala2-signature-container.mjs",
      import.meta.url,
    ).href
  );
async function cases() {
  return (await installed()).readScala2SignatureCases();
}
function nativeRows() {
  return [
    { id: "qualified-broken", status: "failed", packetVersion: 2 },
    { id: "qualified-fixed", status: "passed", packetVersion: 2 },
    { id: "legacy-fixed", status: "passed", packetVersion: 1 },
    {
      id: "operator-capture-request-collision-borrowed-pin-packet-and-physical-afterchecks",
      passed: true,
    },
    { id: "actual-runner-refuses-coherent-wrong-policy", passed: true },
    { id: "cli-fixed", exitCode: 0 },
    { id: "cli-broken", exitCode: 1 },
    { id: "mcp-cannot-promote-authority-and-private-summary", passed: true },
  ];
}
const nativeReceipt = () => ({
  state: "complete-scoped-native-chain",
  packageRoot: "/synthetic/package",
  cases: nativeRows(),
  fullClosureVerified: false,
  gateAComplete: false,
});

test("Scala signature case inventory and native receipt require every ordered original outcome", async () => {
  const api = await installed(),
    inventory = await cases(),
    receipt = nativeReceipt();
  assert.deepEqual(
    api.validateScala2SignatureNativeReceipt(
      receipt,
      receipt.packageRoot,
      inventory,
    ),
    receipt,
  );
  const declaration = {
    schemaVersion: inventory.schemaVersion,
    requiredCaseIds: inventory.requiredCaseIds,
  };
  assert.deepEqual(
    api.parseScala2SignatureCases(JSON.stringify(declaration)),
    declaration,
  );
  for (const text of [
    JSON.stringify(declaration).replace("{", '{"schemaVersion":0,'),
    JSON.stringify(declaration).replace("{", '{"requiredCaseIds":[],'),
  ]) {
    assert.throws(() => api.parseScala2SignatureCases(text), /ambiguous/);
  }
  for (const ids of [
    [],
    inventory.requiredCaseIds.slice(1),
    [...inventory.requiredCaseIds].reverse(),
    [...inventory.requiredCaseIds, inventory.requiredCaseIds[0]],
    inventory.requiredCaseIds.map((id: string, index: number) =>
      index ? id : id + "-adjacent",
    ),
  ]) {
    assert.throws(() =>
      api.validateScala2SignatureCases({
        ...declaration,
        requiredCaseIds: ids,
      }),
    );
  }
  assert.throws(() =>
    api.validateScala2SignatureCases({ ...declaration, extra: true }),
  );
  for (const edit of [
    (value: ReturnType<typeof nativeReceipt>) => {
      value.cases.pop();
    },
    (value: ReturnType<typeof nativeReceipt>) => {
      value.cases.reverse();
    },
    (value: ReturnType<typeof nativeReceipt>) => {
      value.cases[1] = value.cases[0]!;
    },
    (value: ReturnType<typeof nativeReceipt>) => {
      value.cases[3]!.passed = false;
    },
    (value: ReturnType<typeof nativeReceipt>) => {
      value.cases[0]!.status = "passed";
    },
    (value: ReturnType<typeof nativeReceipt>) => {
      value.fullClosureVerified = true;
    },
    (value: ReturnType<typeof nativeReceipt>) => {
      value.gateAComplete = true;
    },
  ]) {
    const changed = structuredClone(receipt);
    edit(changed);
    assert.throws(() =>
      api.validateScala2SignatureNativeReceipt(
        changed,
        receipt.packageRoot,
        inventory,
      ),
    );
  }
  assert.throws(() =>
    api.validateScala2SignatureNativeReceipt(
      receipt,
      "/synthetic/other",
      inventory,
    ),
  );
});

test("Scala installed receipt preserves offline complete-cohort and limited-scope claims", async () => {
  const api = await installed(),
    inventory = await cases(),
    receipt = {
      state: "complete-scoped-installed-native-chain",
      installation: {
        offlineProductionInstall: true,
        lifecycleScriptsExecuted: false,
        productionDependencyLockSha256: "a".repeat(64),
      },
      installedPackage: "/synthetic/package",
      caseManifestSha256: inventory.sha256,
      matchingRuntimeModules: [
        "scala.js",
        "scala2.js",
        "scala2-runner.js",
        "scala2-evidence.js",
        "scala2-release-signature.js",
        "release-signature-proof.js",
      ].map((name) => ({ name, bytes: 2, sha256: "b".repeat(64) })),
      native: nativeReceipt(),
      harnessOutsideInstalledPackage: true,
      installedRuntimeEvaluated: true,
      installedCliEvaluated: true,
      installedMcpEvaluated: true,
      complete: true,
      fullArtifactClosureClaimed: false,
      keyOwnerTrustEstablished: false,
      keyValidityAssessed: false,
      distributionSignatureVerified: false,
      gateAComplete: false,
    };
  assert.deepEqual(
    api.validateScala2SignatureInstalledReceipt(receipt, inventory),
    receipt,
  );
  for (const edit of [
    (v: typeof receipt) => {
      v.installation.offlineProductionInstall = false;
    },
    (v: typeof receipt) => {
      v.installation.lifecycleScriptsExecuted = true;
    },
    (v: typeof receipt) => {
      v.matchingRuntimeModules.pop();
    },
    (v: typeof receipt) => {
      v.caseManifestSha256 = "0".repeat(64);
    },
    (v: typeof receipt) => {
      v.installedMcpEvaluated = false;
    },
    (v: typeof receipt) => {
      v.complete = false;
    },
    (v: typeof receipt) => {
      v.keyValidityAssessed = true;
    },
    (v: typeof receipt) => {
      v.distributionSignatureVerified = true;
    },
    (v: typeof receipt) => {
      v.fullArtifactClosureClaimed = true;
    },
  ]) {
    const changed = structuredClone(receipt);
    edit(changed);
    assert.throws(() =>
      api.validateScala2SignatureInstalledReceipt(changed, inventory),
    );
  }
});

test("Scala preparation manifest binds the literal sibling namespace and selected policy reference", async () => {
  const { validateScala2SignaturePreparationManifest: validate } =
      await container(),
    root = path.join(path.parse(process.cwd()).root, "synthetic", "repository"),
    pin = "a".repeat(64),
    archive = path.join(
      root,
      ".checktrail/scala-signed-tools",
      pin,
      scala2ReleaseArchiveFilename,
    );
  const manifest = {
    archive,
    proofSha256: pin,
    reference: scala2ReleaseSignatureReference(pin),
    operatorProofPinSelectionRequired: true,
    distributionSignatureVerified: false,
    completeArtifactAndNoticeClosureVerified: false,
  };
  assert.equal(
    validate(manifest, root).qualified,
    path.join(root, ".checktrail/scala-signed-tools", pin),
  );
  for (const edit of [
    (v: typeof manifest) => {
      v.archive = path.join(root, "elsewhere", scala2ReleaseArchiveFilename);
    },
    (v: typeof manifest) => {
      v.proofSha256 = "b".repeat(64);
    },
    (v: typeof manifest) => {
      v.reference.policySha256 = "0".repeat(64);
    },
    (v: typeof manifest) => {
      v.reference.signedSubjects.pop();
    },
    (v: typeof manifest) => {
      v.operatorProofPinSelectionRequired = false;
    },
    (v: typeof manifest) => {
      v.completeArtifactAndNoticeClosureVerified = true;
    },
  ]) {
    const changed = structuredClone(manifest);
    edit(changed);
    assert.throws(() => validate(changed, root));
  }
  assert.throws(() => validate({ ...manifest, extraAuthority: true }, root));
});

test("Scala signature CI carries prepared proof data to a serial same-image step after legacy acceptance", async () => {
  const workflow = parse(
    await readFile(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    ),
  );
  const job = workflow.jobs["scala-extensions-arm64"],
    steps = job.steps as { run?: string; env?: Record<string, string> }[];
  const signedPreparation =
    'mkdir "$SCALA2_SIGNATURE_INPUTS"\ncp docs/measurements/artifact-identities-2026-10-21/scala-public-key.asc docs/measurements/artifact-identities-2026-10-21/scala-compiler-2.13.18.jar.asc docs/measurements/artifact-identities-2026-10-21/scala-library-2.13.18.jar.asc docs/measurements/artifact-identities-2026-10-21/scala-reflect-2.13.18.jar.asc "$SCALA2_SIGNATURE_INPUTS/"\nnode scripts/prepare-scala2-tools.mjs --verify-release-signatures "$SCALA2_SIGNATURE_INPUTS" > "$CHECKTRAIL_SCALA2_PREPARATION_MANIFEST"\n';
  const commands = [
    "node scripts/prepare-scala2-tools.mjs",
    "node scripts/verify-scala2-signature-proof.mjs",
    signedPreparation,
    "node scripts/verify-scala-extensions-container.mjs",
    'node scripts/verify-scala2-signature-container.mjs "$CHECKTRAIL_SCALA2_PREPARATION_MANIFEST"',
  ];
  const indexes = commands.map((command) => {
    const found = steps.flatMap((step, index) =>
      step.run === command ? [index] : [],
    );
    assert.equal(found.length, 1, command);
    return found[0]!;
  });
  assert.deepEqual(
    [...indexes].sort((a, b) => a - b),
    indexes,
  );
  const preparation = steps[indexes[2]!]!,
    acceptance = steps[indexes[4]!]!;
  assert.equal(
    preparation.env!.SCALA2_SIGNATURE_INPUTS,
    "${{ runner.temp }}/scala2-signature-inputs",
  );
  assert.equal(
    preparation.env!.CHECKTRAIL_SCALA2_PREPARATION_MANIFEST,
    "${{ runner.temp }}/scala2-release-signature-preparation.json",
  );
  assert.equal(
    acceptance.env!.CHECKTRAIL_SCALA2_PREPARATION_MANIFEST,
    preparation.env!.CHECKTRAIL_SCALA2_PREPARATION_MANIFEST,
  );
  assert.deepEqual(job.env, {
    CHECKTRAIL_TEST_TASK: "ci-scala-extensions",
    CHECKTRAIL_SCALA_EXTENSIONS_IMAGE: "checktrail-scala-extensions:ci",
  });
  assert.equal(job["runs-on"], "ubuntu-24.04-arm");
  assert.equal(job["timeout-minutes"], 30);
});
