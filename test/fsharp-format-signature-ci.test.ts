import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { parse } from "yaml";
import { createHash } from "node:crypto";
import { fsharpPacketSchema } from "../src/fsharp-format-contract.js";
const repository = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);
const helpers = await import(
  new URL(
    "../../scripts/verify-fsharp-format-signature-installed.mjs",
    import.meta.url,
  ).href
);
const container = await import(
  new URL(
    "../../scripts/verify-fsharp-format-signature-container.mjs",
    import.meta.url,
  ).href
);
test("Fsharp signed case manifest refuses missing/duplicate/reordered/unknown cases and ambiguous JSON", async () => {
  const body = await readFile(
      path.join(
        repository,
        "scripts/fsharp-format-signature-native-cases.v1.json",
      ),
      "utf8",
    ),
    manifest = helpers.parseFsharpSignatureCases(body);
  for (const ids of [
    manifest.requiredCaseIds.slice(1),
    [...manifest.requiredCaseIds, manifest.requiredCaseIds[0]],
    [...manifest.requiredCaseIds].reverse(),
    [...manifest.requiredCaseIds, "invented"],
  ])
    assert.throws(() =>
      helpers.parseFsharpSignatureCases(
        JSON.stringify({ ...manifest, requiredCaseIds: ids }),
      ),
    );
  assert.throws(() =>
    helpers.parseFsharpSignatureCases(
      body.replace(
        '"schemaVersion": 1',
        '"schemaVersion": 1, "schemaVersion": 1',
      ),
    ),
  );
  assert.throws(() => helpers.parseFsharpSignatureCases(" ".repeat(8193)));
});
test("Fsharp native admission requires the complete exact mixed-outcome family, no skips or broad claims", async () => {
  const cases = await helpers.readFsharpSignatureCases(),
    value = {
      state: "complete-scoped-native-chain",
      packageRoot: "/synthetic/package",
      revocationFreshAtRuntime: false,
      fullClosureVerified: false,
      gateAComplete: false,
      cases: cases.requiredCaseIds.map((id: string, index: number) => ({
        id,
        ...(index < 3
          ? {
              status: index === 0 ? "failed" : "passed",
              packetVersion: index === 2 ? 1 : 2,
            }
          : index === 5 || index === 6
            ? { exitCode: index === 5 ? 0 : 1 }
            : { passed: true }),
      })),
    };
  assert.equal(
    helpers.validateFsharpSignatureNativeReceipt(
      value,
      "/synthetic/package",
      cases,
    ),
    value,
  );
  for (const edit of [
    (v: typeof value) => {
      v.cases.pop();
    },
    (v: typeof value) => {
      v.cases.reverse();
    },
    (v: typeof value) => {
      v.cases[1] = v.cases[0];
    },
    (v: typeof value) => {
      v.gateAComplete = true;
    },
    (v: typeof value) => {
      v.revocationFreshAtRuntime = true;
    },
    (v: typeof value) => {
      v.cases[0]!.status = "passed";
    },
  ]) {
    const changed = structuredClone(value);
    edit(changed);
    assert.throws(() =>
      helpers.validateFsharpSignatureNativeReceipt(
        changed,
        "/synthetic/package",
        cases,
      ),
    );
  }
  assert.throws(() =>
    helpers.validateFsharpSignatureNativeReceipt(
      { ...value, skipped: 1 },
      "/synthetic/package",
      cases,
    ),
  );
});
test("Fsharp container manifest is bound to its exact sibling cache with explicit false wider scope", () => {
  const pin = "1".repeat(64),
    value = {
      profile: "fantomas-core-default-v1",
      formatterRoot: path.join(
        repository,
        ".checktrail/fsharp-format-signed-tools",
        pin,
      ),
      proofSha256: pin,
      reused: false,
      repositorySignatureVerified: true,
      revocationFreshAtRuntime: false,
      sdkOriginalProducerVerified: false,
      completeArtifactAndNoticeClosureVerified: false,
    };
  assert.deepEqual(
    container.parseFsharpSignaturePreparation(JSON.stringify(value)),
    value,
  );
  for (const change of [
    { formatterRoot: "/synthetic/unbound" },
    { proofSha256: "A".repeat(64) },
    { repositorySignatureVerified: false },
    { revocationFreshAtRuntime: true },
    { completeArtifactAndNoticeClosureVerified: true },
    { unknown: true },
  ])
    assert.throws(() =>
      container.parseFsharpSignaturePreparation(
        JSON.stringify({ ...value, ...change }),
      ),
    );
});
test("Fsharp packet generated schema remains the exact strict legacy-v1/qualified-v2 union", async () => {
  const generated = JSON.parse(
    await readFile(
      path.join(repository, "schemas/fsharp-format-packet.schema.json"),
      "utf8",
    ),
  );
  assert.equal(
    JSON.stringify(generated),
    JSON.stringify(z.toJSONSchema(fsharpPacketSchema)),
  );
  assert.equal(generated.anyOf.length, 2);
  for (const option of generated.anyOf)
    assert.equal(option.additionalProperties, false);
  assert.equal(generated.anyOf[0].properties.version.const, 1);
  assert.equal(generated.anyOf[1].properties.version.const, 2);
  assert.equal(
    Object.hasOwn(generated.anyOf[0].properties, "releaseSignatureProof"),
    false,
  );
  assert.ok(generated.anyOf[1].required.includes("releaseSignatureProof"));
});
test("Fsharp wrapper admits the actual locked-cache receipt contract and rejects missing, foreign or widened data", async () => {
  const lockBody = Buffer.from(
    JSON.stringify({
      packages: {
        "": {},
        "node_modules/first": { integrity: "synthetic-first" },
        "node_modules/second": { integrity: "synthetic-second" },
        "node_modules/dev": { dev: true, integrity: "synthetic-dev" },
      },
    }),
  );
  const value = {
    lockedRegistryTarballs: 2,
    bytes: 100,
    lockSha256: createHash("sha256").update(lockBody).digest("hex"),
    registryMetadataCopied: false,
    historicalLocalPackageTarballsCopied: false,
  };
  assert.equal(
    container.validateFsharpAcceptanceCacheSubset(value, lockBody),
    value,
  );
  for (const change of [
    { complete: true },
    { lockedRegistryTarballs: 1 },
    { lockedRegistryTarballs: 3 },
    { bytes: 0 },
    { lockSha256: "0".repeat(64) },
    { registryMetadataCopied: true },
    { historicalLocalPackageTarballsCopied: true },
  ])
    assert.throws(() =>
      container.validateFsharpAcceptanceCacheSubset(
        { ...value, ...change },
        lockBody,
      ),
    );
});
test("Fsharp signature CI prepares and admits one scoped manifest serially after unchanged legacy acceptance", async () => {
  const workflow = parse(
      await readFile(path.join(repository, ".github/workflows/ci.yml"), "utf8"),
    ),
    job = workflow.jobs["fsharp-format-arm64"];
  const preparation =
    'node scripts/prepare-fsharp-format-tools.mjs --archive "$PWD/.checktrail/fantomas.8.0.7.nupkg" --verify-repository-signature > "$CHECKTRAIL_FSHARP_FORMAT_PREPARATION_MANIFEST"';
  const publication =
    "node --input-type=module <<'NODE'\nimport { kotlinRead } from './dist/src/kotlin-io.js';\nimport { parseFsharpSignaturePreparation } from './scripts/verify-fsharp-format-signature-container.mjs';\nimport { verifyFsharpSignaturePublication } from './scripts/verify-fsharp-format-signature-proof.mjs';\nconst manifest = parseFsharpSignaturePreparation((await kotlinRead(process.env.CHECKTRAIL_FSHARP_FORMAT_PREPARATION_MANIFEST, 16384)).toString('utf8'));\nprocess.stdout.write(JSON.stringify(await verifyFsharpSignaturePublication(manifest.formatterRoot, manifest.proofSha256)) + '\\n');\nNODE\n";
  const signed =
    'node scripts/verify-fsharp-format-signature-container.mjs "$CHECKTRAIL_FSHARP_FORMAT_PREPARATION_MANIFEST"';
  function validate(job: {
    steps: { run?: string; env?: Record<string, string> }[];
    env: Record<string, string>;
    "runs-on": string;
    "timeout-minutes": number;
  }) {
    const commands = [
        "node scripts/verify-fsharp-format-container.mjs",
        preparation,
        publication,
        signed,
      ],
      indexes = commands.map((command) => {
        const found = job.steps.flatMap((step, index) =>
          step.run === command ? [index] : [],
        );
        assert.equal(found.length, 1, command);
        return found[0]!;
      });
    assert.deepEqual(
      [...indexes].sort((a, b) => a - b),
      indexes,
    );
    assert.equal(
      indexes[3]! - indexes[0]!,
      3,
      "One serial preparation, publication and acceptance sequence after legacy",
    );
    for (const index of indexes.slice(1))
      assert.deepEqual(job.steps[index]!.env, {
        CHECKTRAIL_FSHARP_FORMAT_PREPARATION_MANIFEST:
          "${{ runner.temp }}/fsharp-format-release-signature-preparation.json",
      });
    assert.deepEqual(job.env, {
      CHECKTRAIL_TEST_TASK: "ci-fsharp-format",
      CHECKTRAIL_FSHARP_FORMAT_IMAGE: "checktrail-fsharp-format:ci",
    });
    assert.equal(job["runs-on"], "ubuntu-24.04-arm");
    assert.equal(job["timeout-minutes"], 30);
    return indexes;
  }
  const indexes = validate(job);
  for (const change of [
    (v: typeof job) => {
      [v.steps[indexes[0]!], v.steps[indexes[3]!]] = [
        v.steps[indexes[3]!],
        v.steps[indexes[0]!],
      ];
    },
    (v: typeof job) => {
      v.steps[indexes[1]!].run = preparation.replace(
        " --verify-repository-signature",
        "",
      );
    },
    (v: typeof job) => {
      v.steps[indexes[2]!].run = publication.replace(
        "manifest.proofSha256",
        "'unbound'",
      );
    },
    (v: typeof job) => {
      delete v.steps[indexes[3]!].env;
    },
    (v: typeof job) => {
      v.env.CHECKTRAIL_FSHARP_FORMAT_RELEASE_PROOF_SHA256 =
        "unscoped-global-pin";
    },
  ]) {
    const changed = structuredClone(job);
    change(changed);
    assert.throws(() => validate(changed));
  }
});
