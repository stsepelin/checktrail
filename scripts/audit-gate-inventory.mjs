import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
const BASELINE =
  "04b2ba50cb1e4516d5472ff2412478b75ec5f5803de34d62fa4b78237a1d5568";
const SCOPE =
  "3ad99e799491038a3948f170c1436b4c7047c018dd22ae6400e01f423e968794";
const obligations = [
  ...Array.from({ length: 6 }, (_, i) => "M" + i),
  "F1",
  ...Array.from({ length: 8 }, (_, i) => "R" + (i + 1)),
  ...Array.from({ length: 17 }, (_, i) => "E" + (i + 1)),
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
function scopeIdentity(inventory) {
  const scope = globalThis.structuredClone(inventory);
  for (const key of [
    "frozen",
    "state",
    "unresolvedFreezeDecisions",
    "gateAComplete",
    "inferenceInvoked",
    "fieldEvaluationExecuted",
    "qualityAssessed",
    "scopeSha256",
  ])
    delete scope[key];
  for (const profile of scope.extensionProfiles) {
    delete profile.implementationState;
    delete profile.acceptanceState;
  }
  return digest(canonical(scope));
}
function unique(values, label) {
  assert.equal(new Set(values).size, values.length, label + " must be unique");
}
function read(root, relative) {
  const file = path.join(root, relative);
  assert.equal(
    realpathSync(file),
    file,
    "Inventory data must not cross a symlink",
  );
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    assert.ok(
      stat.isFile() && stat.size > 0 && stat.size <= 1024 * 1024,
      "Inventory data must be bounded regular files",
    );
    const bytes = readFileSync(fd);
    assert.ok(
      bytes.length <= 1024 * 1024,
      "Inventory data grew past its bound",
    );
    return { bytes, value: JSON.parse(bytes) };
  } finally {
    closeSync(fd);
  }
}
try {
  assert.ok(
    process.argv.length === 3 ||
      (process.argv.length === 4 && process.argv[3] === "--require-frozen"),
    "Usage: audit-gate-inventory.mjs ROOT [--require-frozen]",
  );
  const root = realpathSync(process.argv[2]);
  const inventory = read(root, "docs/gate-a-profiles.v1.json").value;
  const baseline = read(root, "docs/gate-a-native-baseline.v1.json");
  const current = read(root, "scripts/required-native-tests.json").value;
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.inventoryId, "gate-a-profiles-v1");
  assert.equal(
    digest(baseline.bytes),
    BASELINE,
    "Preserved baseline identity changed",
  );
  assert.equal(
    inventory.preservedNativeBaseline.sha256,
    BASELINE,
    "Baseline pointer changed",
  );
  assert.equal(
    inventory.preservedNativeBaseline.file,
    "docs/gate-a-native-baseline.v1.json",
  );
  assert.equal(
    inventory.preservedNativeBaseline.sourceFile,
    "scripts/required-native-tests.json",
  );
  assert.equal(inventory.preservedNativeBaseline.allNamedCasesRequired, true);
  assert.equal(
    inventory.preservedNativeBaseline.historicalReceiptsCertifyCurrentSource,
    false,
  );
  assert.match(inventory.sourceCommit, /^[a-f0-9]{40}$/);
  assert.deepEqual(
    [...inventory.requiredObligations].sort(),
    [...obligations].sort(),
    "Every original obligation remains required",
  );
  unique(inventory.requiredObligations, "Obligations");
  assert.equal(inventory.scopeSha256, SCOPE, "Selected scope identity changed");
  assert.equal(
    scopeIdentity(inventory),
    SCOPE,
    "Selected profiles or pins changed",
  );
  let preservedCases = 0;
  const uniqueCallbacks = new Set();
  for (const [profile, cases] of Object.entries(baseline.value)) {
    assert.ok(
      Array.isArray(cases) && cases.length > 0,
      "Baseline profile cannot be empty",
    );
    assert.ok(
      Array.isArray(current[profile]),
      "Required native profile was removed",
    );
    const identities = cases.map(canonical);
    unique(identities, "Required callback identities");
    for (const entry of cases) {
      assert.deepEqual(Object.keys(entry).sort(), ["file", "name"]);
      assert.match(entry.file, /^dist\/test\/[a-z0-9-]+\.test\.js$/);
      assert.ok(
        typeof entry.name === "string" &&
          entry.name.length > 0 &&
          entry.name.length <= 512,
      );
      assert.ok(
        current[profile].some(
          (candidate) => canonical(candidate) === canonical(entry),
        ),
        "Required native callback was removed or renamed",
      );
      preservedCases++;
      uniqueCallbacks.add(canonical(entry));
    }
  }
  for (const [tool, version] of Object.entries(inventory.toolVersions)) {
    assert.match(tool, /^[a-z0-9-]+$/);
    assert.match(
      version,
      tool === "mcp-protocol"
        ? /^\d{4}-\d{2}-\d{2}$/
        : /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.+-]+)?$/,
      "Tool versions must be exact",
    );
  }
  unique(
    inventory.runtimeProfiles.map((profile) => profile.id),
    "Runtime profiles",
  );
  for (const runtime of inventory.runtimeProfiles) {
    assert.ok(["linux", "darwin", "win32"].includes(runtime.platform));
    assert.ok(["arm64", "x64"].includes(runtime.architecture));
    assert.match(runtime.node, /^\d+\.\d+\.\d+$/);
    assert.equal(runtime.exactOsImageIdentityRequired, true);
  }
  unique(
    inventory.contextGrammarPins.map((pin) => pin.repository),
    "Grammar pins",
  );
  for (const pin of inventory.contextGrammarPins) {
    assert.match(
      pin.repository,
      /^https:\/\/github\.com\/[a-zA-Z0-9-]+\/[a-zA-Z0-9-]+$/,
    );
    assert.match(pin.commit, /^[a-f0-9]{40}$/);
    assert.ok(
      ["MIT", "Apache-2.0"].includes(pin.license),
      "A repository license label is only a selection prerequisite",
    );
  }
  unique(
    inventory.extensionProfiles.map((profile) => profile.id),
    "Extension profiles",
  );
  const mapped = new Set();
  let selectedCases = 0;
  for (const profile of inventory.extensionProfiles) {
    assert.match(profile.id, /^[a-z0-9-]+$/);
    assert.ok(profile.deliverable.length > 0);
    assert.match(
      profile.acceptanceFile,
      /^dist\/test\/gate-[a-z0-9-]+\.test\.js$/,
    );
    assert.ok(["pending", "implemented"].includes(profile.implementationState));
    assert.ok(
      ["not-measured", "receipts-declared"].includes(profile.acceptanceState),
    );
    for (const obligation of profile.obligations) {
      assert.ok(obligations.includes(obligation));
      mapped.add(obligation);
    }
    unique(profile.tools, "Profile tool dependencies");
    for (const tool of profile.tools)
      assert.ok(Object.hasOwn(inventory.toolVersions, tool));
    assert.ok(
      profile.runtime === "engine-matrix" ||
        inventory.runtimeProfiles.some(
          (runtime) => runtime.id === profile.runtime,
        ),
    );
    unique(
      profile.acceptanceCases.map((entry) => entry.id),
      "Planned acceptance cases",
    );
    for (const entry of profile.acceptanceCases) {
      assert.ok(
        typeof entry.name === "string" &&
          entry.name.length > 0 &&
          entry.name.length <= 512,
      );
      assert.ok(
        typeof entry.assertion === "string" && entry.assertion.length > 0,
      );
      selectedCases++;
    }
  }
  assert.deepEqual(
    [...mapped].sort(),
    [...obligations].sort(),
    "Required families lack a finite selection",
  );
  unique(
    inventory.unresolvedFreezeDecisions.map((entry) => entry.id),
    "Freeze decisions",
  );
  for (const decision of inventory.unresolvedFreezeDecisions)
    assert.ok(decision.id.length > 0 && decision.detail.length > 0);
  assert.equal(typeof inventory.frozen, "boolean");
  if (inventory.frozen)
    assert.equal(
      inventory.unresolvedFreezeDecisions.length,
      0,
      "Freeze decisions remain unresolved",
    );
  for (const key of [
    "gateAComplete",
    "inferenceInvoked",
    "fieldEvaluationExecuted",
    "qualityAssessed",
  ])
    assert.equal(
      inventory[key],
      false,
      "Selection metadata cannot assert acceptance or quality",
    );
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      inventoryConsistent: true,
      scopeSha256: SCOPE,
      preservedProfiles: Object.keys(baseline.value).length,
      preservedCases,
      preservedCaseCounting: "profile/file/name entries",
      uniquePreservedCallbacks: uniqueCallbacks.size,
      repeatedProfileEntries: preservedCases - uniqueCallbacks.size,
      selectedExtensionProfiles: inventory.extensionProfiles.length,
      plannedExtensionCases: selectedCases,
      unresolvedFreezeDecisions: inventory.unresolvedFreezeDecisions.length,
      frozen: inventory.frozen,
      implementationAcceptanceAssessed: false,
      gateAComplete: false,
      qualityAssessed: false,
    }) + "\n",
  );
  if (process.argv[3] === "--require-frozen" && !inventory.frozen)
    process.exitCode = 2;
} catch (error) {
  process.stderr.write(
    "Inventory audit failed: " + String(error.message) + "\n",
  );
  process.exitCode = 2;
}
