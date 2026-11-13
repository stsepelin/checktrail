import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { terraformExtensionsProvider as provider } from "../src/terraform-extensions-contract.js";
const installed = () =>
  import(
    new URL(
      "../../scripts/verify-terraform-signature-installed.mjs",
      import.meta.url,
    ).href
  );
const container = () =>
  import(
    new URL(
      "../../scripts/verify-terraform-signature-container.mjs",
      import.meta.url,
    ).href
  );
function evidence(names: string[]) {
  const fingerprint = { state: "present", sha256: "a".repeat(64) };
  return {
    required: names.length,
    passed: names.length,
    complete: true,
    problems: [],
    ledger: {
      truncated: false,
      terminalEventCount: names.length,
      files: [
        {
          id: "file-1",
          before: fingerprint,
          after: { ...fingerprint },
          stable: true,
        },
      ],
      cases: names.map((name, index) => ({
        fileId: "file-1",
        name,
        outcome: "passed",
        terminalSequences: [index + 1],
      })),
      events: names.map((name, index) => ({
        sequence: index + 1,
        fileId: "file-1",
        name,
        nameTruncated: false,
        kind: "test",
        outcome: "passed",
        required: true,
      })),
    },
  };
}
test("Random signed-native inventory rejects absent duplicate reordered ambiguous and unrelated cases", async () => {
  const api = await installed(),
    cases = await api.readTerraformSignatureCases();
  const raw = {
    schemaVersion: cases.schemaVersion,
    file: cases.file,
    requiredCaseNames: cases.requiredCaseNames,
  };
  assert.deepEqual(api.parseTerraformSignatureCases(JSON.stringify(raw)), raw);
  for (const names of [
    [],
    cases.requiredCaseNames.slice(1),
    [...cases.requiredCaseNames].reverse(),
    [...cases.requiredCaseNames, cases.requiredCaseNames[0]],
    cases.requiredCaseNames.map((name: string, index: number) =>
      index ? name : name + " adjacent",
    ),
  ])
    assert.throws(() =>
      api.parseTerraformSignatureCases(
        JSON.stringify({ ...raw, requiredCaseNames: names }),
      ),
    );
  assert.throws(() =>
    api.parseTerraformSignatureCases(
      JSON.stringify({ ...raw, file: "dist/test/other.test.js" }),
    ),
  );
  assert.throws(
    () =>
      api.parseTerraformSignatureCases(
        JSON.stringify(raw).replace("{", '{"schemaVersion":0,'),
      ),
    /ambiguous/,
  );
});
test("Random signed-native receipts require exact passing terminal coverage with no skipped or stale event", async () => {
  const api = await installed(),
    cases = await api.readTerraformSignatureCases(),
    valid = evidence(cases.requiredCaseNames);
  assert.deepEqual(api.validateTerraformSignatureEvidence(valid, cases), valid);
  for (const change of [
    (v: typeof valid) => {
      v.passed--;
    },
    (v: typeof valid) => {
      v.ledger.events.pop();
    },
    (v: typeof valid) => {
      v.ledger.events.reverse();
    },
    (v: typeof valid) => {
      v.ledger.cases[1]!.terminalSequences = [1];
    },
    (v: typeof valid) => {
      v.ledger.events[0]!.outcome = "skipped";
    },
    (v: typeof valid) => {
      v.ledger.events[0]!.required = false;
    },
    (v: typeof valid) => {
      v.ledger.events[0]!.nameTruncated = true;
    },
    (v: typeof valid) => {
      v.ledger.files[0]!.after.sha256 = "b".repeat(64);
    },
    (v: typeof valid) => {
      v.ledger.files[0]!.stable = false;
    },
    (v: typeof valid) => {
      v.complete = false;
    },
  ]) {
    const changed = structuredClone(valid);
    change(changed);
    assert.throws(() => api.validateTerraformSignatureEvidence(changed, cases));
  }
  const receipt = {
    schemaVersion: 1,
    role: "source",
    caseManifestSha256: cases.sha256,
    acceptance: valid,
    complete: true,
    keyOwnerTrustEstablished: false,
    keyValidityAssessed: false,
    fullArtifactClosureClaimed: false,
    gateAComplete: false,
  };
  assert.deepEqual(
    api.validateTerraformSignatureReceipt(receipt, cases, "source"),
    receipt,
  );
  for (const patch of [
    { role: "installed" },
    { caseManifestSha256: "0".repeat(64) },
    { keyValidityAssessed: true },
    { fullArtifactClosureClaimed: true },
    { gateAComplete: true },
  ])
    assert.throws(() =>
      api.validateTerraformSignatureReceipt(
        { ...receipt, ...patch },
        cases,
        "source",
      ),
    );
});
test("Random signed preparation manifest requires the selected sibling cohort without widening signature scope", async () => {
  const { validateTerraformSignaturePreparationManifest: validate } =
      await container(),
    root = path.join(path.parse(process.cwd()).root, "synthetic", "repository"),
    pin = "a".repeat(64);
  const value = {
    preparedProvider: provider.address,
    version: provider.version,
    archiveSha256: provider.archiveSha256,
    memberCount: provider.members.length,
    releaseSignatureVerified: true,
    providerRoot: path.join(
      root,
      ".checktrail/terraform-extensions-signed-tools",
      pin,
    ),
    proofSha256: pin,
    scope: "selected-release-checksum-signature",
    keyOwnerTrustEstablished: false,
    publisherAndLicenseClosureVerified: false,
  };
  assert.deepEqual(validate(value, root), value);
  for (const patch of [
    { providerRoot: path.join(root, "elsewhere", pin) },
    { proofSha256: "b".repeat(64) },
    { memberCount: 1 },
    { archiveSha256: "0".repeat(64) },
    { releaseSignatureVerified: false },
    { keyOwnerTrustEstablished: true },
    { publisherAndLicenseClosureVerified: true },
    { extraAuthority: true },
  ])
    assert.throws(() => validate({ ...value, ...patch }, root));
});
test("Terraform CI enables signed source and installed controls only after legacy acceptance with isolated startup authority", async () => {
  const workflow = parse(
      await readFile(
        new URL("../../.github/workflows/ci.yml", import.meta.url),
        "utf8",
      ),
    ),
    job = workflow.jobs["terraform-extensions-arm64"],
    steps = job.steps as {
      run?: string;
      if?: string;
      env?: Record<string, string>;
    }[];
  const signedPreparation =
    'mkdir "$RANDOM_SIGNATURE_INPUTS"\ncp docs/measurements/artifact-identities-2026-10-21/provider-public-key.asc docs/measurements/artifact-identities-2026-10-21/provider-SHA256SUMS.txt docs/measurements/artifact-identities-2026-10-21/provider-SHA256SUMS.sig "$RANDOM_SIGNATURE_INPUTS/"\nnode scripts/prepare-terraform-extensions-runtime.mjs --verify-release-signature "$RANDOM_SIGNATURE_INPUTS" > "$CHECKTRAIL_RANDOM_PREPARATION_MANIFEST"\n';
  const commands = [
    "node scripts/prepare-terraform-extensions-runtime.mjs",
    signedPreparation,
    "node scripts/verify-terraform-extensions-container.mjs ${{ matrix.phase }}",
    'node scripts/verify-terraform-signature-container.mjs "$CHECKTRAIL_RANDOM_PREPARATION_MANIFEST"',
    "node scripts/cleanup-infra-tools-runtime.mjs",
  ];
  const indices = commands.map((command) => {
    const rows = steps.flatMap((step, index) =>
      step.run === command ? [index] : [],
    );
    assert.equal(rows.length, 1, command);
    return rows[0]!;
  });
  assert.deepEqual(
    [...indices].sort((a, b) => a - b),
    indices,
  );
  const prep = steps[indices[1]!]!,
    signed = steps[indices[3]!]!;
  assert.equal(prep.if, "${{ matrix.phase == 'acceptance' }}");
  assert.equal(signed.if, prep.if);
  assert.equal(
    prep.env!.RANDOM_SIGNATURE_INPUTS,
    "${{ runner.temp }}/random-signature-inputs",
  );
  assert.equal(
    prep.env!.CHECKTRAIL_RANDOM_PREPARATION_MANIFEST,
    "${{ runner.temp }}/random-release-signature-preparation.json",
  );
  assert.equal(
    signed.env!.CHECKTRAIL_RANDOM_PREPARATION_MANIFEST,
    prep.env!.CHECKTRAIL_RANDOM_PREPARATION_MANIFEST,
  );
  assert.equal(steps[indices[4]!]!.if, "always()");
  assert.deepEqual(job.env, {
    CHECKTRAIL_TEST_TASK: "ci-terraform-extensions-${{ matrix.phase }}",
  });
  assert.deepEqual(job.strategy.matrix.phase, [
    "baseline",
    "acceptance",
    "guards-1",
    "guards-2",
  ]);
  assert.equal(job.strategy["fail-fast"], false);
  assert.equal(job["timeout-minutes"], 45);
});
