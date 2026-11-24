import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fixture } from "./helpers.js";
const exec = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const script = path.join(repository, "scripts/audit-gate-inventory.mjs");
const files = [
  "docs/gate-a-profiles.v1.json",
  "docs/gate-a-native-baseline.v1.json",
  "scripts/required-native-tests.json",
];
interface NativeCase {
  file: string;
  name: string;
}
type RequiredNative = Record<string, NativeCase[]>;
interface SelectedInventory {
  requiredObligations: string[];
  extensionProfiles: {
    acceptanceCases: { id: string; name: string; assertion: string }[];
    implementationState: string;
    acceptanceState: string;
  }[];
  toolVersions: Record<string, string>;
  contextGrammarPins: { commit: string }[];
  preservedNativeBaseline: { sha256: string };
  frozen: boolean;
  gateAComplete: boolean;
}
async function source(t: TestContext) {
  return fixture(
    t,
    Object.fromEntries(
      await Promise.all(
        files.map(async (file) => [
          file,
          await readFile(path.join(repository, file), "utf8"),
        ]),
      ),
    ),
  );
}
async function alter<T>(root: string, file: string, edit: (input: T) => void) {
  const value = JSON.parse(await readFile(path.join(root, file), "utf8"));
  edit(value as T);
  await writeFile(path.join(root, file), JSON.stringify(value, null, 2) + "\n");
}
async function audit(root: string, requireFrozen = false) {
  try {
    const result = await exec(process.execPath, [
      script,
      root,
      ...(requireFrozen ? ["--require-frozen"] : []),
    ]);
    return { code: 0, ...result };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    return result;
  }
}
test("finite inventory audit preserves every original named native case without declaring implementation or quality acceptance", async (t) => {
  const root = await source(t);
  const result = await audit(root);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const baseline: RequiredNative = JSON.parse(
    await readFile(path.join(root, files[1]!), "utf8"),
  );
  assert.equal(report.preservedProfiles, Object.keys(baseline).length);
  assert.equal(
    report.preservedCases,
    Object.values(baseline).reduce((sum, cases) => sum + cases.length, 0),
  );
  assert.equal(report.inventoryConsistent, true);
  assert.equal(report.frozen, false);
  assert.equal(report.implementationAcceptanceAssessed, false);
  assert.equal(report.gateAComplete, false);
  assert.equal(report.qualityAssessed, false);
  const strict = await audit(root, true);
  assert.equal(strict.code, 2);
  assert.equal(JSON.parse(strict.stdout).frozen, false);
});
test("finite inventory rejects a removed or renamed native callback and coherent baseline replacement", async (t) => {
  for (const mode of [
    "removed",
    "renamed",
    "replaced-baseline",
    "repeated-profile-entry",
  ]) {
    const root = await source(t);
    await alter<RequiredNative>(root, files[2]!, (value) => {
      if (mode === "renamed") value["init-publication"]![0]!.name += " changed";
      else if (mode === "repeated-profile-entry")
        value["ruby-tools-cancellation"]!.shift();
      else value["init-publication"]!.shift();
    });
    if (mode === "replaced-baseline") {
      const changed = await readFile(path.join(root, files[2]!), "utf8");
      await writeFile(path.join(root, files[1]!), changed);
      await alter<SelectedInventory>(root, files[0]!, (value) => {
        value.preservedNativeBaseline.sha256 = createHash("sha256")
          .update(changed)
          .digest("hex");
      });
    }
    const result = await audit(root);
    assert.equal(result.code, 2);
    assert.match(
      result.stderr,
      mode === "replaced-baseline"
        ? /baseline identity changed/
        : /callback was removed or renamed/,
    );
  }
});
test("finite inventory rejects silently removed obligations profiles pins cases and floating tool versions", async (t) => {
  const edits = [
    (value: SelectedInventory) => value.requiredObligations.pop(),
    (value: SelectedInventory) => value.extensionProfiles.pop(),
    (value: SelectedInventory) =>
      value.extensionProfiles[0]!.acceptanceCases.pop(),
    (value: SelectedInventory) => {
      value.toolVersions.kotlin = "latest";
    },
    (value: SelectedInventory) => {
      value.toolVersions.vitest = "5.0.1";
    },
    (value: SelectedInventory) => {
      value.contextGrammarPins[0]!.commit = "0".repeat(40);
    },
  ];
  for (const edit of edits) {
    const root = await source(t);
    await alter<SelectedInventory>(root, files[0]!, edit);
    const result = await audit(root);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /obligation|scope|profiles or pins/i);
  }
});
test("finite inventory keeps pending freeze decisions and declared receipts separate from feature acceptance", async (t) => {
  const root = await source(t);
  await alter<SelectedInventory>(root, files[0]!, (value) => {
    value.extensionProfiles[0]!.implementationState = "implemented";
    value.extensionProfiles[0]!.acceptanceState = "receipts-declared";
  });
  const allowed = await audit(root);
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.equal(
    JSON.parse(allowed.stdout).implementationAcceptanceAssessed,
    false,
  );
  await alter<SelectedInventory>(root, files[0]!, (value) => {
    value.frozen = true;
  });
  const frozen = await audit(root);
  assert.equal(frozen.code, 2);
  assert.match(frozen.stderr, /Freeze decisions remain unresolved/);
  await alter<SelectedInventory>(root, files[0]!, (value) => {
    value.frozen = false;
    value.gateAComplete = true;
  });
  const claimed = await audit(root);
  assert.equal(claimed.code, 2);
  assert.match(claimed.stderr, /cannot assert acceptance or quality/);
});

test("finite inventory reports shared-manifest visibility without treating alternate controllers as missing native acceptance", async (t) => {
  const root = await source(t);
  const first = await audit(root);
  assert.equal(first.code, 0, first.stderr);
  const baseline = JSON.parse(first.stdout);
  const before = baseline.selectedCaseBindings;
  assert.equal(
    before.plannedCases,
    before.casesInSharedManifest + before.casesOutsideSharedManifest,
  );
  assert.equal(before.alternateControllersAssessed, false);
  assert.equal(before.nativeExecutionAssessed, false);
  assert.equal(
    before.outsideSharedManifest.some(
      (row: { profile: string }) => row.profile === "tasks-matrix",
    ),
    false,
  );
  assert.equal(
    baseline.implementationDeclarations.implemented +
      baseline.implementationDeclarations.pending,
    baseline.selectedExtensionProfiles,
  );
  await alter<RequiredNative>(root, files[2]!, (rows) => {
    delete rows["tasks-matrix"];
  });
  const removed = await audit(root);
  assert.equal(removed.code, 0, removed.stderr);
  const after = JSON.parse(removed.stdout);
  assert.equal(after.selectedCaseBindings.plannedCases, before.plannedCases);
  assert.equal(
    after.selectedCaseBindings.casesInSharedManifest,
    before.casesInSharedManifest - 9,
  );
  assert.equal(
    after.selectedCaseBindings.casesOutsideSharedManifest,
    before.casesOutsideSharedManifest + 9,
  );
  assert.deepEqual(
    after.selectedCaseBindings.outsideSharedManifest.find(
      (row: { profile: string }) => row.profile === "tasks-matrix",
    ),
    {
      profile: "tasks-matrix",
      plannedCases: 9,
      casesInSharedManifest: 0,
      casesOutsideSharedManifest: 9,
    },
  );
  assert.equal(after.implementationAcceptanceAssessed, false);
  assert.equal(after.gateAComplete, false);
  await alter<RequiredNative>(root, files[2]!, (rows) => {
    rows["original-empty-aggregate"] = [];
  });
  assert.equal((await audit(root)).code, 0);
  for (const value of [
    null,
    [{ file: "../outside.test.js", name: "OriginalForeignAddress" }],
    [{ file: "dist/test/foreign.test.js", name: null }],
  ]) {
    const raw = JSON.parse(await readFile(path.join(root, files[2]!), "utf8"));
    raw["original-empty-aggregate"] = value;
    await writeFile(path.join(root, files[2]!), JSON.stringify(raw));
    const invalid = await audit(root);
    assert.equal(invalid.code, 2);
    assert.match(
      invalid.stderr,
      /Required native manifests must contain arrays|Invalid required native case/,
    );
  }
});

// The same file and name under another profile key is a different manifest
// address: that profile's required set owns it, not the selected one.
test("finite inventory does not count a callback filed under another profile as a selected binding", async (t) => {
  const root = await source(t);
  const first = await audit(root);
  assert.equal(first.code, 0, first.stderr);
  const baseline = JSON.parse(first.stdout);
  const moved = JSON.parse(
    await readFile(path.join(root, files[2]!), "utf8"),
  ) as RequiredNative;
  const relocated = moved["tasks-matrix"]!;
  assert.equal(relocated.length, 9);
  await alter<RequiredNative>(root, files[2]!, (rows) => {
    rows.core!.push(...structuredClone(relocated));
  });
  const copied = await audit(root);
  assert.equal(copied.code, 0, copied.stderr);
  const near = JSON.parse(copied.stdout);
  assert.deepEqual(near.selectedCaseBindings, baseline.selectedCaseBindings);
  assert.deepEqual(
    near.controllerCaseBindings,
    baseline.controllerCaseBindings,
  );
  await alter<RequiredNative>(root, files[2]!, (rows) => {
    delete rows["tasks-matrix"];
  });
  const result = await audit(root);
  assert.equal(result.code, 0, result.stderr);
  const after = JSON.parse(result.stdout);
  assert.equal(
    after.selectedCaseBindings.casesInSharedManifest,
    baseline.selectedCaseBindings.casesInSharedManifest - 9,
  );
  assert.equal(
    after.controllerCaseBindings.declaredFileBindings,
    baseline.controllerCaseBindings.declaredFileBindings - 9,
  );
  assert.equal(
    after.controllerCaseBindings.unresolvedCases,
    baseline.controllerCaseBindings.unresolvedCases + 9,
  );
  assert.deepEqual(
    after.controllerCaseBindings.unresolvedBindings
      .filter((row: { profile: string }) => row.profile === "tasks-matrix")
      .map((row: { name: string }) => row.name)
      .sort(),
    relocated.map((row) => row.name).sort(),
  );
});

const alternateBindings = [
  ["cpp-extensions", "privacy", "cpp-extensions-surfaces"],
  ["cpp-extensions", "lifecycle", "cpp-extensions-cancel"],
  ["terraform-extensions", "privacy", "terraform-extensions-surfaces"],
  ["terraform-extensions", "lifecycle", "terraform-extensions-lifecycle"],
  ["helm-extensions", "privacy", "helm-extensions-surfaces"],
  ["helm-extensions", "lifecycle", "helm-extensions-lifecycle"],
] as const;

test("finite inventory resolves every separate privacy and lifecycle controller without asserting execution", async (t) => {
  const root = await source(t);
  const result = await audit(root);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const bindings = report.controllerCaseBindings;
  assert.deepEqual(
    bindings.alternateBindings,
    alternateBindings.map(([profile, caseId, file]) => ({
      profile,
      caseId,
      file: `dist/test/${file}.test.js`,
      name: `${profile} ${caseId} acceptance`,
    })),
  );
  assert.equal(bindings.alternateFileBindings, alternateBindings.length);
  assert.equal(
    bindings.declaredFileBindings + bindings.alternateFileBindings,
    bindings.plannedCases,
  );
  assert.equal(bindings.plannedCases, report.plannedExtensionCases);
  assert.equal(bindings.unresolvedCases, 0);
  assert.deepEqual(bindings.unresolvedBindings, []);
  assert.equal(bindings.nativeExecutionAssessed, false);
  assert.equal(report.gateAComplete, false);
  // An unrelated adjacent name must not make an exact existing binding ambiguous.
  await alter<RequiredNative>(root, files[2]!, (rows) => {
    for (const [profile, caseId, file] of alternateBindings)
      rows[profile]!.push({
        file: `dist/test/${file}.test.js`,
        name: `${profile} ${caseId} acceptance adjacent`,
      });
  });
  assert.deepEqual(
    JSON.parse((await audit(root)).stdout).controllerCaseBindings,
    bindings,
  );
});

for (const [profile, caseId, file] of alternateBindings) {
  test(`finite inventory refuses foreign or ambiguous ${profile} ${caseId} binding`, async (t) => {
    for (const mode of [
      "missing",
      "wrong-file",
      "default-file",
      "wrong-profile",
      "renamed",
      "duplicate",
      "ambiguous-file",
    ]) {
      const root = await source(t);
      const name = `${profile} ${caseId} acceptance`;
      await alter<RequiredNative>(root, files[2]!, (rows) => {
        const index = rows[profile]!.findIndex((row) => row.name === name);
        assert.ok(index >= 0);
        const row = rows[profile]![index]!;
        if (mode === "wrong-file") row.file = "dist/test/foreign.test.js";
        else if (mode === "default-file")
          row.file = `dist/test/gate-${profile}.test.js`;
        else if (mode === "renamed") row.name += " suffix";
        else if (mode === "duplicate") rows[profile]!.push({ ...row });
        else if (mode === "ambiguous-file")
          rows[profile]!.push({ ...row, file: "dist/test/foreign.test.js" });
        else {
          rows[profile]!.splice(index, 1);
          if (mode === "wrong-profile") rows["foreign-profile"] = [row];
        }
      });
      const result = await audit(root);
      assert.equal(result.code, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      const bindings = report.controllerCaseBindings;
      assert.equal(bindings.unresolvedCases, 1, mode);
      assert.equal(
        bindings.alternateFileBindings,
        alternateBindings.length - 1,
        mode,
      );
      assert.equal(
        bindings.declaredFileBindings +
          bindings.alternateFileBindings +
          bindings.unresolvedCases,
        bindings.plannedCases,
        mode,
      );
      assert.deepEqual(
        bindings.unresolvedBindings,
        [{ profile, caseId, file: `dist/test/${file}.test.js`, name }],
        mode,
      );
      assert.equal(report.gateAComplete, false);
    }
  });
}

test("finite inventory strict freeze refuses unresolved case bindings even when selection freeze is declared", async (t) => {
  const root = await source(t);
  await alter<SelectedInventory & { unresolvedFreezeDecisions: unknown[] }>(
    root,
    files[0]!,
    (value) => {
      value.frozen = true;
      value.unresolvedFreezeDecisions = [];
    },
  );
  const complete = await audit(root, true);
  assert.equal(complete.code, 0, complete.stderr);
  assert.equal(JSON.parse(complete.stdout).gateAComplete, false);
  for (const profile of ["tasks-matrix", "cpp-extensions"]) {
    await alter<RequiredNative>(root, files[2]!, (rows) => {
      delete rows[profile];
    });
    const incomplete = await audit(root, true);
    assert.equal(incomplete.code, 2);
    assert.ok(
      JSON.parse(incomplete.stdout).controllerCaseBindings.unresolvedCases > 0,
    );
  }
});
