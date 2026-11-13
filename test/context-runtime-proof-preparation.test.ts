import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  contextRuntimeAttestationPolicy as policy,
  inspectContextNativeAttestation,
} from "../src/context-runtime-attestation.js";
import {
  contextRuntimeInputIdentity,
  contextRuntimeProofFiles,
  contextRuntimeVerificationArgs,
  encodeContextRuntimeProof,
  readContextRuntimeProof,
  type ContextRuntimeProof,
  type ContextRuntimeProofInputs,
} from "../src/context-runtime-proof.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const archive = process.env.CHECKTRAIL_CONTEXT_PROOF_TEST_ARCHIVE;
const gh =
  process.env.CHECKTRAIL_CONTEXT_PROOF_TEST_GH ?? "/opt/homebrew/bin/gh";
const nativeEvidence = process.env.CHECKTRAIL_CONTEXT_PROOF_TEST_EVIDENCE;
const unlock = (directory: string) => {
  if (
    !lstatSync(directory).isDirectory() ||
    lstatSync(directory).isSymbolicLink()
  )
    return;
  chmodSync(directory, 0o700);
  for (const entry of readdirSync(directory, { withFileTypes: true }))
    if (entry.isDirectory() && !entry.isSymbolicLink())
      unlock(path.join(directory, entry.name));
};
const preparer = path.join(
  repository,
  "scripts/prepare-context-runtime-proof.mjs",
);
const moduleUrl = new URL("../src/context-runtime-proof.js", import.meta.url)
  .href;
test(
  "context runtime offline proof preparation and coherent corruption controls",
  {
    skip:
      archive === undefined
        ? "explicit pinned public archive/native gh inputs unavailable"
        : false,
  },
  async (t) => {
    assert.ok(archive);
    const temporary = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), "ct-proof-native-")),
    );
    const verification = path.join(
      repository,
      "docs/measurements/context-runtime-0.27.1-2026-10-30/attestation-verified.json",
    );
    const trustedRoot = path.join(
      repository,
      "docs/measurements/artifact-identities-2026-10-21/sigstore-trusted-root.jsonl",
    );
    if (nativeEvidence)
      mkdirSync(nativeEvidence, { recursive: true, mode: 0o700 });
    const output = nativeEvidence
      ? path.join(realpathSync(nativeEvidence), "preparation")
      : path.join(temporary, "cohorts");
    const prepare = (destination = output, selectedTool = gh) =>
      spawnSync(
        process.execPath,
        [
          preparer,
          "--archive",
          archive,
          "--verification",
          verification,
          "--trusted-root",
          trustedRoot,
          "--gh",
          selectedTool,
          "--output",
          destination,
        ],
        { encoding: "utf8", timeout: 60000, maxBuffer: 262144 },
      );
    try {
      const first = prepare();
      assert.equal(first.status, 0, first.stderr);
      const prepared = JSON.parse(first.stdout) as {
        reference: { sha256: string };
        proofPath: string;
        cacheHit: boolean;
      };
      const selected = readContextRuntimeProof(
        prepared.proofPath,
        prepared.reference.sha256,
      );
      const cohort = path.dirname(prepared.proofPath);
      const inputs: ContextRuntimeProofInputs = {
        archive: readFileSync(
          path.join(cohort, contextRuntimeProofFiles.archive),
        ),
        originalVerification: readFileSync(
          path.join(cohort, contextRuntimeProofFiles.originalVerification),
        ),
        trustedRoot: readFileSync(
          path.join(cohort, contextRuntimeProofFiles.trustedRoot),
        ),
        bundle: readFileSync(
          path.join(cohort, contextRuntimeProofFiles.bundle),
        ),
        nativeOutput: readFileSync(
          path.join(cohort, contextRuntimeProofFiles.nativeOutput),
        ),
      };
      await t.test(
        "real native result binds both signed runtime members and explicit unsigned-license limits",
        () => {
          assert.equal(prepared.cacheHit, false);
          assert.equal(selected.proof.nativeVerification.exitCode, 0);
          assert.deepEqual(
            selected.proof.nativeVerification.argv,
            contextRuntimeVerificationArgs,
          );
          assert.deepEqual(selected.proof.runtimeAssets, policy.runtimeAssets);
          assert.equal(
            selected.proof.claims.runtimeEsmAndWasmArchiveMembershipVerified,
            true,
          );
          assert.equal(
            selected.proof.claims.archiveLicenseMembershipVerified,
            false,
          );
          assert.equal(
            selected.proof.claims.completeLicenseClosureVerified,
            false,
          );
          assert.equal(selected.proof.claims.grammarSignaturesVerified, false);
          assert.equal(Object.hasOwn(selected.reference, "proofPath"), false);
        },
      );
      await t.test(
        "complete identical atomic reuse preserves the previous namespace",
        () => {
          const before = readFileSync(prepared.proofPath);
          const second = prepare();
          assert.equal(second.status, 0, second.stderr);
          assert.equal(JSON.parse(second.stdout).cacheHit, true);
          assert.deepEqual(readFileSync(prepared.proofPath), before);
        },
      );
      await t.test(
        "coherent malformed policy and missing full-closure flags are refused",
        () => {
          for (const mutate of [
            (value: ContextRuntimeProof) => {
              value.policy = {
                ...policy,
                archiveRuntimeAssets: [
                  ...policy.archiveRuntimeAssets,
                  "LICENSE",
                ],
              };
            },
            (value: ContextRuntimeProof) => {
              Reflect.deleteProperty(value.claims, "producerBuildVerified");
            },
            (value: ContextRuntimeProof) => {
              value.nativeVerification.argv =
                value.nativeVerification.argv.slice(0, -2);
            },
          ]) {
            const value = structuredClone(selected.proof);
            mutate(value);
            assert.throws(() => encodeContextRuntimeProof(value, inputs));
          }
        },
      );
      await t.test(
        "verified timestamp UTC and offset spellings retain the same exact witness instant",
        () => {
          const output = JSON.parse(
            Buffer.from(inputs.nativeOutput).toString(),
          ) as [
            {
              verificationResult: {
                verifiedTimestamps: { timestamp: string }[];
              };
            },
          ];
          const original = JSON.parse(
            Buffer.from(inputs.originalVerification).toString(),
          ) as typeof output;
          output[0].verificationResult.verifiedTimestamps[0]!.timestamp =
            original[0].verificationResult.verifiedTimestamps[0]!.timestamp;
          const raw = Buffer.from(JSON.stringify(output)),
            near = structuredClone(selected.proof);
          near.files.nativeOutput = contextRuntimeInputIdentity(raw);
          near.nativeVerification.result =
            inspectContextNativeAttestation(output);
          assert.doesNotThrow(() =>
            encodeContextRuntimeProof(near, { ...inputs, nativeOutput: raw }),
          );
        },
      );
      await t.test(
        "verified timestamp fractional zeros are equivalent while changed sub-millisecond instants are refused",
        () => {
          for (const [fraction, accepted] of [
            ["000000000", true],
            ["000000001", false],
            ["0000000000000000001", false],
          ] as const) {
            const output = JSON.parse(
              Buffer.from(inputs.nativeOutput).toString(),
            ) as [
              {
                verificationResult: {
                  verifiedTimestamps: { timestamp: string }[];
                };
              },
            ];
            const row = output[0].verificationResult.verifiedTimestamps[0]!;
            assert.match(row.timestamp, /Z$/);
            row.timestamp = row.timestamp.replace(
              /(?:\.\d+)?Z$/,
              "." + fraction + "Z",
            );
            const raw = Buffer.from(JSON.stringify(output)),
              candidate = structuredClone(selected.proof);
            candidate.files.nativeOutput = contextRuntimeInputIdentity(raw);
            candidate.nativeVerification.result =
              inspectContextNativeAttestation(output);
            const encode = () =>
              encodeContextRuntimeProof(candidate, {
                ...inputs,
                nativeOutput: raw,
              });
            if (accepted) assert.doesNotThrow(encode);
            else assert.throws(encode, /verified timestamps differ/);
          }
        },
      );
      await t.test(
        "coherent wrong native certificate/source and output bundle are refused",
        () => {
          for (const field of [
            "sourceRepositoryDigest",
            "sourceRepositoryRef",
            "subjectAlternativeName",
            "issuer",
            "runnerEnvironment",
          ]) {
            const value = structuredClone(selected.proof),
              output = JSON.parse(
                Buffer.from(inputs.nativeOutput).toString(),
              ) as [
                {
                  verificationResult: {
                    signature: { certificate: Record<string, string> };
                  };
                },
              ];
            output[0].verificationResult.signature.certificate[field] = "wrong";
            const raw = Buffer.from(JSON.stringify(output));
            const changed = { ...inputs, nativeOutput: raw };
            value.files.nativeOutput = contextRuntimeInputIdentity(raw);
            assert.throws(
              () => encodeContextRuntimeProof(value, changed),
              new RegExp(field),
              field,
            );
          }
          const value = structuredClone(selected.proof),
            badBundle = Buffer.from("{}\n");
          value.files.bundle = contextRuntimeInputIdentity(badBundle);
          assert.throws(
            () =>
              encodeContextRuntimeProof(value, {
                ...inputs,
                bundle: badBundle,
              }),
            /Derived bundle differs/,
          );
          const output = JSON.parse(
            Buffer.from(inputs.nativeOutput).toString(),
          ) as [
            {
              verificationResult: {
                verifiedTimestamps: { timestamp: string }[];
              };
            },
          ];
          output[0].verificationResult.verifiedTimestamps[0]!.timestamp =
            "2026-01-01T00:00:00Z";
          const raw = Buffer.from(JSON.stringify(output)),
            changed = structuredClone(selected.proof);
          changed.files.nativeOutput = contextRuntimeInputIdentity(raw);
          changed.nativeVerification.result =
            inspectContextNativeAttestation(output);
          assert.throws(
            () =>
              encodeContextRuntimeProof(changed, {
                ...inputs,
                nativeOutput: raw,
              }),
            /verified timestamps differ/,
          );
        },
      );
      await t.test(
        "six-file reader rejects omitted/extra files and an inside-root parent link",
        () => {
          const copyRoot = path.join(temporary, "copy");
          mkdirSync(copyRoot);
          const copy = path.join(copyRoot, prepared.reference.sha256);
          cpSync(cohort, copy, { recursive: true });
          chmodSync(copy, 0o700);
          const native = path.join(copy, contextRuntimeProofFiles.nativeOutput);
          chmodSync(native, 0o600);
          rmSync(native);
          chmodSync(copy, 0o500);
          assert.throws(
            () =>
              readContextRuntimeProof(
                path.join(copy, "proof.json"),
                prepared.reference.sha256,
              ),
            /six-file proof cohort/,
          );
          chmodSync(copy, 0o700);
          writeFileSync(native, inputs.nativeOutput, { mode: 0o400 });
          writeFileSync(path.join(copy, "extra"), "extra", { mode: 0o400 });
          chmodSync(copy, 0o500);
          assert.throws(
            () =>
              readContextRuntimeProof(
                path.join(copy, "proof.json"),
                prepared.reference.sha256,
              ),
            /six-file proof cohort/,
          );
          const linked = path.join(temporary, "linked");
          symlinkSync(
            output,
            linked,
            process.platform === "win32" ? "junction" : "dir",
          );
          assert.throws(
            () =>
              readContextRuntimeProof(
                path.join(linked, prepared.reference.sha256, "proof.json"),
                prepared.reference.sha256,
              ),
            /Linked proof namespace/,
          );
        },
      );
      await t.test(
        "operator expected hash and read-only namespace are enforced",
        () => {
          assert.throws(
            () => readContextRuntimeProof(prepared.proofPath, "a".repeat(64)),
            /namespace/,
          );
          chmodSync(cohort, 0o700);
          try {
            assert.throws(
              () =>
                readContextRuntimeProof(
                  prepared.proofPath,
                  prepared.reference.sha256,
                ),
              /read-only/,
            );
          } finally {
            chmodSync(cohort, 0o500);
          }
        },
      );
      await t.test(
        "startup-selected public reference remains fixed after environment removal",
        () => {
          const result = spawnSync(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `import {selectedContextRuntimeProof} from ${JSON.stringify(moduleUrl)}; delete process.env.CHECKTRAIL_CONTEXT_RELEASE_PROOF; console.log(JSON.stringify(selectedContextRuntimeProof()));`,
            ],
            {
              env: {
                ...process.env,
                CHECKTRAIL_CONTEXT_RELEASE_PROOF:
                  prepared.proofPath + "#sha256=" + prepared.reference.sha256,
              },
              encoding: "utf8",
              timeout: 15000,
            },
          );
          assert.equal(result.status, 0, result.stderr);
          assert.deepEqual(JSON.parse(result.stdout), selected.reference);
        },
      );
      await t.test(
        "corrupt existing cache is refused without overwriting the prior proof",
        () => {
          chmodSync(
            path.join(cohort, contextRuntimeProofFiles.nativeOutput),
            0o600,
          );
          writeFileSync(
            path.join(cohort, contextRuntimeProofFiles.nativeOutput),
            "{}\n",
          );
          chmodSync(
            path.join(cohort, contextRuntimeProofFiles.nativeOutput),
            0o400,
          );
          const before = readFileSync(prepared.proofPath),
            bad = prepare();
          assert.notEqual(bad.status, 0);
          assert.match(bad.stderr, /Proof cohort bytes differ/);
          assert.deepEqual(readFileSync(prepared.proofPath), before);
          chmodSync(
            path.join(cohort, contextRuntimeProofFiles.nativeOutput),
            0o600,
          );
          writeFileSync(
            path.join(cohort, contextRuntimeProofFiles.nativeOutput),
            inputs.nativeOutput,
          );
          chmodSync(
            path.join(cohort, contextRuntimeProofFiles.nativeOutput),
            0o400,
          );
        },
      );
      const lifecycleOutput = (name: string) => {
        const target = path.join(temporary, "lifecycle-" + name);
        mkdirSync(target, { mode: 0o700 });
        const cloned = path.join(target, prepared.reference.sha256),
          publishedMode = lstatSync(cohort).mode & 0o777;
        cpSync(cohort, cloned, { recursive: true });
        chmodSync(cloned, publishedMode);
        assert.equal(lstatSync(cloned).mode & 0o222, 0);
        assert.equal(lstatSync(cloned).mode & 0o777, publishedMode);
        return target;
      };
      const preserveLifecycle = (
        name: string,
        destination: string,
        result: ReturnType<typeof prepare>,
      ) => {
        const files = readdirSync(destination).sort();
        if (nativeEvidence) {
          writeFileSync(
            path.join(nativeEvidence, "lifecycle-" + name + ".stderr.log"),
            result.stderr,
          );
          writeFileSync(
            path.join(nativeEvidence, "lifecycle-" + name + ".stdout.json"),
            result.stdout,
          );
          writeFileSync(
            path.join(nativeEvidence, "lifecycle-" + name + ".json"),
            JSON.stringify({
              status: result.status,
              signal: result.signal,
              files,
            }) + "\n",
          );
        }
        return files;
      };
      const previousUnchanged = (destination: string) =>
        assert.deepEqual(
          readContextRuntimeProof(
            path.join(destination, prepared.reference.sha256, "proof.json"),
            prepared.reference.sha256,
          ).reference,
          selected.reference,
        );
      await t.test(
        "preparation lifecycle refuses a linked output parent before creating outside directories",
        () => {
          const outside = path.join(temporary, "outside-parent");
          mkdirSync(outside);
          writeFileSync(path.join(outside, "sentinel"), "untouched");
          const linked = path.join(temporary, "output-parent-link");
          symlinkSync(
            outside,
            linked,
            process.platform === "win32" ? "junction" : "dir",
          );
          const result = prepare(path.join(linked, "new-output"));
          if (nativeEvidence)
            writeFileSync(
              path.join(nativeEvidence, "lifecycle-output-parent.json"),
              JSON.stringify({
                status: result.status,
                files: readdirSync(outside).sort(),
              }) + "\n",
            );
          assert.notEqual(result.status, 0);
          assert.deepEqual(readdirSync(outside).sort(), ["sentinel"]);
          assert.equal(
            readFileSync(path.join(outside, "sentinel"), "utf8"),
            "untouched",
          );
          assert.deepEqual(
            readContextRuntimeProof(
              prepared.proofPath,
              prepared.reference.sha256,
            ).reference,
            selected.reference,
          );
        },
      );
      await t.test(
        "preparation lifecycle refuses an attempts symlink without touching its outside target",
        () => {
          const target = lifecycleOutput("symlink"),
            outside = path.join(temporary, "outside");
          mkdirSync(outside);
          writeFileSync(path.join(outside, "sentinel"), "untouched");
          symlinkSync(
            outside,
            path.join(target, "attempts"),
            process.platform === "win32" ? "junction" : "dir",
          );
          const result = prepare(target),
            files = preserveLifecycle("symlink", target, result);
          if (nativeEvidence)
            writeFileSync(
              path.join(nativeEvidence, "lifecycle-symlink-outside.json"),
              JSON.stringify(readdirSync(outside).sort()) + "\n",
            );
          assert.notEqual(result.status, 0);
          assert.deepEqual(readdirSync(outside).sort(), ["sentinel"]);
          assert.equal(
            readFileSync(path.join(outside, "sentinel"), "utf8"),
            "untouched",
          );
          assert.equal(
            files.some((name) => name.startsWith(".prepare-")),
            false,
          );
          previousUnchanged(target);
        },
      );
      await t.test(
        "preparation lifecycle refuses a regular-file attempts namespace without a leaked stage",
        () => {
          const target = lifecycleOutput("file");
          writeFileSync(path.join(target, "attempts"), "occupied");
          const result = prepare(target),
            files = preserveLifecycle("file", target, result);
          assert.notEqual(result.status, 0);
          assert.equal(
            readFileSync(path.join(target, "attempts"), "utf8"),
            "occupied",
          );
          assert.equal(
            files.some((name) => name.startsWith(".prepare-")),
            false,
          );
          previousUnchanged(target);
        },
      );
      await t.test(
        "preparation lifecycle cleans its stage when attempt directory creation is denied",
        {
          skip:
            process.platform === "win32"
              ? "POSIX directory write permission control"
              : false,
        },
        () => {
          const target = lifecycleOutput("mkdir"),
            attempts = path.join(target, "attempts");
          mkdirSync(attempts, { mode: 0o500 });
          try {
            const result = prepare(target),
              files = preserveLifecycle("mkdir", target, result);
            assert.notEqual(result.status, 0);
            assert.equal(
              files.some((name) => name.startsWith(".prepare-")),
              false,
            );
            previousUnchanged(target);
          } finally {
            chmodSync(attempts, 0o700);
          }
        },
      );
      await t.test(
        "preparation lifecycle preserves a controlled nonzero native failure only inside the canonical output",
        {
          skip:
            process.platform === "win32"
              ? "POSIX failure-only executable fixture"
              : false,
        },
        () => {
          const target = lifecycleOutput("native-failure"),
            tool = path.join(temporary, "failure-only-gh");
          const version =
            "gh version 2.102.1 (2026-10-20)\nhttps://github.com/cli/cli/releases/tag/v2.102.1\n";
          writeFileSync(
            tool,
            "#!/usr/bin/env node\nif(process.argv[2]==='--version')process.stdout.write(" +
              JSON.stringify(version) +
              ");else{process.stderr.write('controlled nonzero native failure\\n');process.exitCode=23;}\n",
            { mode: 0o700 },
          );
          const result = prepare(target, tool),
            files = preserveLifecycle("native-failure", target, result);
          assert.notEqual(result.status, 0);
          assert.equal(
            files.some((name) => name.startsWith(".prepare-")),
            false,
          );
          const attempts = path.join(target, "attempts"),
            entries = readdirSync(attempts);
          assert.equal(entries.length, 1);
          const retained = path.join(attempts, entries[0]!);
          assert.equal(realpathSync(retained), retained);
          const receipt = JSON.parse(
            readFileSync(path.join(retained, "process.json"), "utf8"),
          ) as { status: number; signal: null };
          assert.equal(receipt.status, 23);
          assert.equal(receipt.signal, null);
          assert.equal(
            readFileSync(path.join(retained, "stderr.log"), "utf8"),
            "controlled nonzero native failure\n",
          );
          assert.deepEqual(
            files,
            [prepared.reference.sha256, "attempts"].sort(),
          );
          previousUnchanged(target);
          if (nativeEvidence)
            cpSync(
              retained,
              path.join(nativeEvidence, "lifecycle-retained-nonzero"),
              { recursive: true },
            );
        },
      );
      await t.test(
        "actual one-call native counterfactuals reject wrong artifact/workflow/source/signature",
        () => {
          const directory = path.join(temporary, "counterfactual");
          mkdirSync(directory);
          for (const key of ["archive", "bundle", "trustedRoot"] as const)
            writeFileSync(
              path.join(directory, contextRuntimeProofFiles[key]),
              inputs[key],
            );
          const controls: [string, (args: string[]) => string[]][] = [
            [
              "artifact",
              (args) => {
                const raw = Buffer.from(inputs.archive);
                raw[100] = raw[100]! ^ 1;
                writeFileSync(
                  path.join(directory, contextRuntimeProofFiles.archive),
                  raw,
                );
                return args;
              },
            ],
            [
              "workflow",
              (args) => {
                args[args.indexOf("--cert-identity") + 1] =
                  policy.certificateIdentity.replace(
                    "/release.yml",
                    "/wrong.yml",
                  );
                return args;
              },
            ],
            [
              "source",
              (args) => {
                args[args.indexOf("--source-ref") + 1] = "refs/tags/v0.27.2";
                return args;
              },
            ],
            [
              "signature",
              (args) => {
                const bundle = JSON.parse(
                  Buffer.from(inputs.bundle).toString(),
                ) as { dsseEnvelope: { signatures: { sig: string }[] } };
                const sig = bundle.dsseEnvelope.signatures[0]!;
                const raw = Buffer.from(sig.sig, "base64");
                raw[0] = raw[0]! ^ 1;
                sig.sig = raw.toString("base64");
                writeFileSync(
                  path.join(directory, contextRuntimeProofFiles.bundle),
                  JSON.stringify(bundle),
                );
                return args;
              },
            ],
          ];
          for (const [name, mutate] of controls) {
            writeFileSync(
              path.join(directory, contextRuntimeProofFiles.archive),
              inputs.archive,
            );
            writeFileSync(
              path.join(directory, contextRuntimeProofFiles.bundle),
              inputs.bundle,
            );
            const args = mutate([...contextRuntimeVerificationArgs]);
            const result = spawnSync(realpathSync(gh), args, {
              cwd: directory,
              env: {
                ...process.env,
                GH_HOST: "github.com",
                GH_PROMPT_DISABLED: "1",
                NO_COLOR: "1",
              },
              encoding: "utf8",
              timeout: 30000,
              maxBuffer: 262144,
            });
            if (nativeEvidence) {
              mkdirSync(nativeEvidence, { recursive: true });
              writeFileSync(
                path.join(nativeEvidence, name + ".stdout.json"),
                result.stdout,
              );
              writeFileSync(
                path.join(nativeEvidence, name + ".stderr.log"),
                result.stderr,
              );
              writeFileSync(
                path.join(nativeEvidence, name + ".process.json"),
                JSON.stringify({
                  status: result.status,
                  signal: result.signal,
                  args,
                  actualNativeCalls: 1,
                }) + "\n",
              );
            }
            assert.equal(result.error, undefined, name);
            assert.equal(result.signal, null, name);
            assert.notEqual(result.status, 0, name);
            const expected =
              name === "source"
                ? "Error: expected SourceRepositoryRef to be refs/tags/v0.27.2, got refs/tags/v0.27.1"
                : 'Error: verifying with issuer "sigstore.dev"';
            assert.equal(result.stderr.trim(), expected, name);
          }
        },
      );
    } finally {
      unlock(temporary);
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);
