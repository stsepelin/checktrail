import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  fsharpNugetPolicy,
  fsharpReleasePackageFile,
  fsharpReleaseProofFile,
  readFsharpReleaseProof,
} from "../dist/src/fsharp-format-release-signature.js";
import { publishFsharpSignatureCohort } from "./prepare-fsharp-format-signature-proof.mjs";

export async function verifyFsharpSignaturePublication(qualifiedRoot, pin) {
  readFsharpReleaseProof(qualifiedRoot, pin);
  const archive = await readFile(
      path.join(qualifiedRoot, fsharpReleasePackageFile),
    ),
    proof = await readFile(path.join(qualifiedRoot, fsharpReleaseProofFile));
  const selected = new Map(
    await Promise.all(
      fsharpNugetPolicy.selected.map(async (p) => [
        p.file,
        await readFile(path.join(qualifiedRoot, p.file)),
      ]),
    ),
  );
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "checktrail-fsharp-publication-")),
  );
  try {
    const legacy = path.join(root, ".checktrail/fsharp-format-tools");
    await mkdir(legacy, { recursive: true });
    for (const p of fsharpNugetPolicy.selected)
      await copyFile(
        path.join(qualifiedRoot, p.file),
        path.join(legacy, p.file),
      );
    const unchanged = async () => {
      assert.deepEqual(
        (await readdir(legacy)).sort(),
        [...selected.keys()].sort(),
      );
      for (const [name, body] of selected)
        assert.deepEqual(await readFile(path.join(legacy, name)), body);
    };
    await assert.rejects(
      publishFsharpSignatureCohort(root, archive, selected, proof, {
        renameImpl: async () => {
          throw Error("synthetic publication rename failure");
        },
      }),
      /synthetic publication rename failure/u,
    );
    const parent = path.join(root, ".checktrail/fsharp-format-signed-tools");
    assert.deepEqual(await readdir(parent), []);
    await unchanged();
    const first = await publishFsharpSignatureCohort(
      root,
      archive,
      selected,
      proof,
    );
    assert.equal(first.reused, false);
    assert.equal(first.proofSha256, pin);
    const reused = await publishFsharpSignatureCohort(
      root,
      archive,
      selected,
      proof,
    );
    assert.equal(reused.reused, true);
    const selectedFile = path.join(
        first.formatterRoot,
        fsharpNugetPolicy.selected[1].file,
      ),
      saved = await readFile(selectedFile);
    try {
      const changed = Buffer.from(saved);
      changed[0] ^= 1;
      await writeFile(selectedFile, changed);
      await assert.rejects(
        publishFsharpSignatureCohort(root, archive, selected, proof),
      );
      assert.deepEqual(
        await readFile(selectedFile),
        changed,
        "Refuse corrupt cache without replacing it",
      );
    } finally {
      await writeFile(selectedFile, saved);
    }
    readFsharpReleaseProof(first.formatterRoot, pin);
    const missing = new Map(selected);
    missing.delete(fsharpNugetPolicy.selected[0].file);
    await assert.rejects(
      publishFsharpSignatureCohort(root, archive, missing, proof),
    );
    await unchanged();
    assert.deepEqual(await readdir(parent), [pin]);
    return {
      schemaVersion: 1,
      requiredCaseIds: [
        "rename-failure-no-partial-publication",
        "exact-cohort-reuse",
        "corrupt-physical-cache-refused",
        "missing-member-refused-before-publication",
      ],
      complete: true,
      legacyUnchanged: true,
      repositorySignatureScope: "dated-native-policy-observation",
      revocationFreshAtRuntime: false,
      gateAComplete: false,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assert.equal(process.argv.length, 4, "Pass QUALIFIED_ROOT PROOF_SHA256");
  console.log(
    JSON.stringify(
      await verifyFsharpSignaturePublication(
        await realpath(process.argv[2]),
        process.argv[3],
      ),
    ),
  );
}
