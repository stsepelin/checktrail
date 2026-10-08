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
