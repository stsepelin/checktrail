import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
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
  "533cd3c311de30ce505e99c776b41c583e1dc42981679d82d13626526a9c942f";
const obligations = [
  ...Array.from({ length: 6 }, (_, i) => "M" + i),
  "F1",
  ...Array.from({ length: 8 }, (_, i) => "R" + (i + 1)),
  ...Array.from({ length: 17 }, (_, i) => "E" + (i + 1)),
];
// These selected cases use separate controllers in their existing manifest profile.
// Pin the whole address: matching a name elsewhere is not a binding.
const alternateAcceptanceFiles = {
  "cpp-extensions": {
    privacy: "dist/test/cpp-extensions-surfaces.test.js",
    lifecycle: "dist/test/cpp-extensions-cancel.test.js",
  },
  "terraform-extensions": {
    privacy: "dist/test/terraform-extensions-surfaces.test.js",
    lifecycle: "dist/test/terraform-extensions-lifecycle.test.js",
  },
  "helm-extensions": {
    privacy: "dist/test/helm-extensions-surfaces.test.js",
    lifecycle: "dist/test/helm-extensions-lifecycle.test.js",
  },
};
// The native verifier refuses to select the aggregate mutation profile: each of
// its cases runs in every per-family cohort (verify-required-native-tests.mjs).
const controllerProfiles = {
  "mutation-runners": [
    "mutation-vitest",
    "mutation-jest",
    "mutation-pytest",
    "mutation-phpunit",
  ],
};
// These controllers take a profile's manifest rows through a dedicated selector
// rather than the generic native verifier. Each refuses the whole profile before
// any callback runs unless its rows equal the selected cases at their bound
// files, plus `extra` names in the default file. `selection` names the selected
// profile whose cases a per-family cohort must hold. An `ordered` selector
// compares the rows as written; the others compare them sorted. The .NET
// generator compares against its shard manifest, whose source partitions are
// exactly the selected cases. A `serialized` selector compares each row's JSON
// text, so its key order counts.
const mutationCohort = {
  controller: "scripts/verify-mutation-container.mjs",
  ordered: true,
  selection: "mutation-runners",
};
const dedicatedSelectors = {
  "cpp-extensions": {
    controller: "scripts/selected-clang-consumer-witness.mjs",
    ordered: false,
    serialized: true,
    extra: ["cpp-extensions compiler formatter analyzer acceptance"],
  },
  "dotnet-generator-extensions": {
    controller: "scripts/dotnet-generator-shards.mjs",
    ordered: false,
  },
  "scala-extensions": {
    controller: "scripts/scala-native-ci-phases.mjs",
    ordered: true,
  },
  "ruby-extensions": {
    controller: "scripts/ruby-extensions-acceptance-selection.mjs",
    ordered: true,
  },
  "consumer-impact": {
    controller: "scripts/consumer-runtime-evidence.mjs",
    ordered: true,
  },
  "multi-candidate-workflow": {
    controller: "scripts/review-runtime-evidence.mjs",
    ordered: true,
  },
  "confidence-provenance": {
    controller: "scripts/review-runtime-evidence.mjs",
    ordered: true,
  },
  "attempt-archives": {
    controller: "scripts/attempt-whole-evidence.mjs",
    ordered: true,
  },
  "lifecycle-platforms": {
    controller: "scripts/verify-lifecycle-platforms.mjs",
    ordered: true,
  },
  "tasks-matrix": {
    controller: "scripts/tasks-runtime-evidence.mjs",
    ordered: true,
  },
  "native-license-provenance": {
    controller: "scripts/native-provenance-runtime-evidence.mjs",
    ordered: true,
  },
  "resource-release-readiness": {
    controller: "scripts/verify-resource-release-readiness.mjs",
    ordered: true,
  },
  "independent-evaluation-protocol": {
    controller: "scripts/evaluation-runtime-evidence.mjs",
    ordered: true,
  },
  "mutation-vitest": mutationCohort,
  "mutation-jest": mutationCohort,
  "mutation-pytest": mutationCohort,
  "mutation-phpunit": mutationCohort,
};
// Other profiles a controller requires before it accepts the selected profile.
// Every cohort profile must hold 1 to `maxRows` rows (256 by default) without
// a repeated address. Then, by rule:
// - `rows`: the cohort's distinct addresses number exactly this many, which is
//   what a runner batch over those profiles reports as required;
// - `disjoint`: no address appears in two cohort profiles;
// - `outsideFile`: no cohort row is filed in this test file;
// - `preserved`: the cohort holds exactly its preserved baseline rows, which
//   the .NET shard manifest partitions;
// - `files`: every cohort row is filed in one of these test files;
// - `absentNames`: no cohort row has one of these names, which the controller
//   expects as unrequired callbacks in the batch's test files;
// - `fileOrder`: these files first appear in this order. The runner runs a
//   batch's files in the order they first appear, and the controller compares
//   their unrequired callbacks in that order;
// - `shards`: the runner admits each of this many shards (row index modulo
//   the count) on its own, so the row limit applies per shard, not to the
//   whole cohort.
// - `sha256`: the cohort's ordered file/name list has this canonical digest,
//   the exact list the controller's foundation module compares against.
const companionCohorts = [
  {
    profile: "tasks-matrix",
    controller: "scripts/tasks-runtime-evidence.mjs",
    cohort: ["mcp-tasks"],
    rows: 10,
    outsideFile: "dist/test/gate-tasks-matrix.test.js",
  },
  {
    profile: "dotnet-generator-extensions",
    controller: "scripts/dotnet-generator-shards.mjs",
    cohort: [
      "dotnet-build",
      "dotnet-test",
      "dotnet-generated",
      "dotnet-method",
    ],
    maxRows: 128,
    disjoint: true,
    preserved: true,
  },
  {
    profile: "consumer-impact",
    controller: "scripts/consumer-foundation-evidence.mjs",
    cohort: ["consumer-impact-foundation"],
    sha256: "e15c204ed472bffdc3feb1b29a4ab0a865f9863b40862266a3bd83c80876e2db",
  },
  {
    profile: "attempt-archives",
    controller: "scripts/attempt-foundation-evidence.mjs",
    cohort: ["attempt-journal-foundation"],
    sha256: "9e3bee327fd5dc23bd80b6feec2e94067c6103893f2dbf9e43054a921ed56539",
  },
  {
    profile: "attempt-archives",
    controller: "scripts/attempt-foundation-evidence.mjs",
    cohort: ["attempt-output-foundation"],
    sha256: "1ff71872718b3e140bec7a74563b9d67c73c6898943dbcacc58324e080b984f4",
  },
  {
    profile: "python-extensions",
    controller: "scripts/verify-python-extensions-container.mjs",
    cohort: ["python"],
    rows: 5,
  },
  {
    profile: "php-extensions",
    controller: "scripts/verify-php-extensions-container.mjs",
    cohort: ["php-tools", "php-review"],
    rows: 14,
  },
  {
    profile: "rust-extensions",
    controller: "scripts/verify-rust-extensions-container.mjs",
    cohort: ["rust", "rust-format", "clippy", "rust-tests", "rust-workspace"],
    rows: 39,
  },
  {
    profile: "assembly-laravel",
    controller: "scripts/verify-laravel-assembly-container.mjs",
    cohort: ["laravel-cache-runtime-bindings"],
    rows: 1,
  },
  {
    profile: "assembly-laravel",
    controller: "scripts/laravel-cache-runtime-evidence.mjs",
    cohort: ["laravel", "laravel-cache"],
    rows: 9,
    disjoint: true,
  },
  {
    profile: "assembly-django",
    controller: "scripts/verify-django-assembly-container.mjs",
    cohort: ["frameworks"],
    rows: 8,
  },
  {
    profile: "assembly-fastapi",
    controller: "scripts/verify-fastapi-assembly-container.mjs",
    cohort: ["frameworks"],
    rows: 8,
  },
  {
    profile: "assembly-nuxt",
    controller: "scripts/verify-nuxt-assembly-container.mjs",
    cohort: ["nuxt"],
    rows: 7,
  },
  // Containers that first run a preserved baseline batch through the generic
  // runner, which refuses a repeated pair within any one of its profiles. A
  // `disjoint` batch is compared with the sum of its profile lengths.
  ...[
    ["helm-extensions", "verify-helm-extensions-container", ["helm"]],
    [
      "confidence-provenance",
      "verify-confidence-provenance",
      ["review", "review-probe", "review-scoring"],
      true,
    ],
    [
      "dotnet-format-extensions",
      "verify-dotnet-format-extensions-container",
      ["dotnet-build", "dotnet-format", "dotnet-generated"],
      true,
    ],
    [
      "dotnet-fsharp-format",
      "verify-fsharp-format-container",
      ["dotnet-build", "dotnet-format"],
      true,
    ],
    [
      "jvm-analyzer-extensions",
      "verify-jvm-analyzer-extensions-container",
      ["java", "spotbugs", "detekt"],
      true,
    ],
    [
      "jvm-wrappers",
      "verify-jvm-wrappers-container",
      ["java", "maven", "gradle"],
      true,
    ],
    [
      "kotlin-extensions",
      "verify-kotlin-extensions-container",
      ["kotlin", "java"],
      true,
    ],
    [
      "kubernetes-extensions",
      "verify-kubernetes-extensions-container",
      ["kubeconform", "kustomize"],
      true,
    ],
    [
      "kustomize-extensions",
      "verify-kustomize-extensions-container",
      ["kubeconform", "kustomize"],
      true,
    ],
    [
      "scala-extensions",
      "verify-scala-extensions-container",
      ["scala", "java"],
      true,
    ],
    [
      "swift-extensions",
      "verify-swift-extensions-container",
      ["swift", "swift-tools"],
      true,
    ],
  ].map(([profile, script, cohort, disjoint]) => ({
    profile,
    controller: "scripts/" + script + ".mjs",
    cohort,
    ...(disjoint ? { disjoint } : {}),
  })),
  {
    profile: "cpp-extensions",
    controller: "scripts/verify-cpp-extensions-container.mjs",
    cohort: ["cpp-tools"],
    absentNames: [
      "C/C++ planning is data only and rejects undeclared CMake commands and missing source scope",
    ],
  },
  {
    profile: "terraform-extensions",
    controller: "scripts/verify-terraform-extensions-container.mjs",
    cohort: ["terraform"],
    absentNames: [
      "Terraform native process observer binds exact tool-collection and validation parent phases with native identity and current owned workspace",
      "Terraform native process observer rejects phase suffixes unrelated runner identities workspace aliases and processes that exit or change parent before admission",
      "Terraform native process observer resolves the installed engine symlink before exact parent matching",
      "Terraform planning reads all JSON module files without executing native tools and rejects empty provider module function duplicate and omitted scope",
    ],
    fileOrder: [
      "dist/test/terraform-reached.test.js",
      "dist/test/terraform.test.js",
    ],
  },
  // These package checks install the baseline into a fresh consumer with only
  // their listed test files, then run the whole profile there.
  ...[
    [
      "cpp-extensions",
      "cpp-tools",
      [
        "cpp-tools",
        "cpp-tools-lifecycle",
        "cpp-controls",
        "cpp-protocol",
        "cpp-tools-surfaces",
        "cpp-tools-cancel",
      ],
    ],
    [
      "helm-extensions",
      "helm",
      ["helm", "helm-scope", "helm-lifecycle", "helm-surfaces"],
    ],
    [
      "terraform-extensions",
      "terraform",
      [
        "terraform",
        "terraform-lifecycle",
        "terraform-reached",
        "terraform-surfaces",
      ],
    ],
  ].map(([profile, cohort, names]) => ({
    profile,
    controller: "scripts/verify-" + cohort + "-package.mjs",
    cohort: [cohort],
    files: names.map((name) => "dist/test/" + name + ".test.js"),
  })),
  // verify-ruby-tools-baseline.mjs refuses a repeated pair in the whole
  // baseline before it selects a shard. CI runs only its three shard phases;
  // its unsharded default mode, run without a phase, would also need the
  // whole list within the row limit. The eight preserved rows keep each shard
  // nonempty.
  {
    profile: "ruby-extensions",
    controller: "scripts/verify-ruby-tools-baseline.mjs",
    cohort: ["ruby-tools"],
    shards: 3,
  },
  // The Go workflow step validates all four profiles of its batch before it
  // runs any, so each selected profile depends on the other three.
  ...[
    ["go-extensions", "host-session-readiness"],
    ["host-session-readiness", "go-extensions"],
  ].map(([profile, other]) => ({
    profile,
    controller: ".github/workflows/ci.yml",
    cohort: [other, "go-installed-harness", "review-context-limits"],
  })),
  // review-context-limits runs in that batch, and its installed callback
  // requires nine passes from the whole profile.
  ...["go-extensions", "host-session-readiness"].map((profile) => ({
    profile,
    controller: "test/review-context-limits.test.ts",
    cohort: ["review-context-limits"],
    rows: 9,
  })),
  // The ARM64 Tasks runtime command runs this batch under `set -eu` before the
  // lifecycle and evaluation controllers, and the provenance command runs only
  // after that command succeeds.
  ...[
    "lifecycle-platforms",
    "independent-evaluation-protocol",
    "native-license-provenance",
  ].map((profile) => ({
    profile,
    controller: "scripts/verify-tasks-runtime-arm64.mjs",
    cohort: ["lifecycle-runtime-bindings"],
  })),
  // The lifecycle controller runs its platform's foundation batch, whose files
  // must belong to lifecycleHarnessFiles in lifecycle-runtime-evidence.mjs.
  // The installed lifecycle controller compares the batch receipt with the
  // sum of the two profile lengths.
  ...[
    ["posix-cleanup", "posix-owner"],
    ["windows-process", "physical-process-output"],
  ].map((cohort) => ({
    profile: "lifecycle-platforms",
    controller: "scripts/verify-lifecycle-platforms.mjs",
    cohort,
    disjoint: true,
    files: [
      "gate-lifecycle-platforms",
      "process-tree",
      "posix-owner",
      "runner",
      "process-output",
      "windows-contract",
      "windows-process",
      "windows-resource",
      "windows-workspace",
      "windows-resource-native",
    ].map((name) => "dist/test/" + name + ".test.js"),
  })),
];
const contextFamilies = [
  "python",
  "go",
  "php",
  "rust",
  "java",
  "kotlin",
  "scala",
  "csharp",
  "fsharp",
  "vb",
  "ruby",
  "swift",
  "c",
  "cpp",
  "hcl",
  "yaml",
];
// selectConsumerWitnessRequirements reads the broken, fixed and near-miss rows
// of every consumer witness family from `profiles`. The controller of each of
// them calls it, and so does the selected Clang consumer acceptance that the
// C++ controller dispatches. One family's missing row refuses every dependent.
const witnessProfiles = [
  "consumer-impact",
  "javascript-extensions",
  ...contextFamilies.map((family) => "context-" + family),
];
const sharedWitnessSelector = {
  controller: "scripts/consumer-witness-evidence.mjs",
  cases: ["broken", "fixed", "near-miss"],
  profiles: witnessProfiles,
  dependents: [...witnessProfiles, "cpp-extensions"],
};
// These controllers run a profile through the generic runner, which admits any
// row set, then require exactly `rows` required callbacks from it. An extra
// unselected row passes the runner but fails the count after running.
const rowCountControllers = Object.fromEntries(
  [
    [
      "scripts/verify-consumer-witness-profile.mjs",
      contextFamilies.map((family) => "context-" + family),
    ],
    ...contextFamilies
      .filter((family) => !["python", "go"].includes(family))
      .map((family) => [
        "scripts/verify-" + family + "-context-container.mjs",
        ["context-" + family],
      ]),
    [
      "scripts/verify-javascript-extensions-container.mjs",
      ["javascript-extensions"],
    ],
    ["scripts/verify-consumer-project-profile.mjs", ["javascript-extensions"]],
    ["scripts/verify-python-extensions-container.mjs", ["python-extensions"]],
    ["scripts/verify-php-extensions-container.mjs", ["php-extensions"]],
    ["scripts/verify-rust-extensions-container.mjs", ["rust-extensions"]],
    ["scripts/verify-jvm-wrappers-container.mjs", ["jvm-wrappers"]],
    ["scripts/verify-kotlin-extensions-container.mjs", ["kotlin-extensions"]],
    ["scripts/verify-scala-extensions-container.mjs", ["scala-extensions"]],
    [
      "scripts/verify-jvm-analyzer-extensions-container.mjs",
      ["jvm-analyzer-extensions"],
    ],
    [
      "scripts/verify-dotnet-format-extensions-container.mjs",
      ["dotnet-format-extensions"],
    ],
    ["scripts/verify-fsharp-format-container.mjs", ["dotnet-fsharp-format"]],
    ["scripts/verify-swift-extensions-container.mjs", ["swift-extensions"]],
    [
      "scripts/verify-kustomize-extensions-container.mjs",
      ["kustomize-extensions"],
    ],
    [
      "scripts/verify-kubernetes-extensions-container.mjs",
      ["kubernetes-extensions"],
    ],
    ["scripts/verify-laravel-assembly-container.mjs", ["assembly-laravel"]],
    ["scripts/verify-django-assembly-container.mjs", ["assembly-django"]],
    ["scripts/verify-fastapi-assembly-container.mjs", ["assembly-fastapi"]],
    ["scripts/verify-nuxt-assembly-container.mjs", ["assembly-nuxt"]],
    [
      "scripts/verify-vue-router-assembly-container.mjs",
      ["assembly-vue-router"],
    ],
    ["scripts/verify-confidence-provenance.mjs", ["confidence-provenance"]],
    [
      "scripts/verify-review-runtime-package.mjs",
      ["multi-candidate-workflow", "confidence-provenance"],
    ],
    [
      "scripts/verify-tasks-runtime-arm64.mjs",
      ["confidence-provenance", "lifecycle-platforms"],
    ],
    ["scripts/verify-consumer-impact-whole-package.mjs", ["consumer-impact"]],
    ["scripts/verify-lifecycle-platforms-package.mjs", ["lifecycle-platforms"]],
    [
      "scripts/verify-mutation-package.mjs",
      [
        "mutation-vitest",
        "mutation-jest",
        "mutation-pytest",
        "mutation-phpunit",
      ],
    ],
  ].map(([controller, profiles]) => [controller, { rows: 9, profiles }]),
);
// The installed acceptance callback in each of these profiles' selected test
// file runs the whole profile from a fresh package and requires exactly nine
// passes, so an extra row fails it. The callbacks of the profiles listed
// first assert no such count.
const uncountedInstalledProfiles = [
  "assembly-nuxt",
  "cpp-extensions",
  "helm-extensions",
  "native-license-provenance",
  "resource-release-readiness",
  "tasks-matrix",
  "terraform-extensions",
];
// verify-import-context-package.mjs installs these profiles into a fresh
// consumer with only these acceptance files, then runs the whole profile there.
const installedHarness = {
  controller: "scripts/verify-import-context-package.mjs",
  profiles: [
    "assembly-django",
    "assembly-fastapi",
    "assembly-laravel",
    "assembly-nuxt",
    "assembly-vue-router",
    "confidence-provenance",
    ...contextFamilies.map((family) => "context-" + family),
    "cpp-extensions",
    "dotnet-format-extensions",
    "dotnet-fsharp-format",
    "dotnet-generator-extensions",
    "helm-extensions",
    "host-session-readiness",
    "javascript-extensions",
    "jvm-analyzer-extensions",
    "jvm-wrappers",
    "kotlin-extensions",
    "kubernetes-extensions",
    "kustomize-extensions",
    "multi-candidate-workflow",
    "php-extensions",
    "python-extensions",
    "ruby-extensions",
    "rust-extensions",
    "scala-extensions",
    "swift-extensions",
    "terraform-extensions",
  ],
  files: [
    "import-context",
    "review-polyglot",
    "review-context-limits",
    "import-history",
    ...contextFamilies.map((family) => "gate-context-" + family),
    "gate-assembly-nuxt",
    "gate-javascript-extensions",
    "gate-rust-extensions",
    "gate-kotlin-extensions",
    "gate-jvm-analyzer-extensions",
    "gate-kubernetes-extensions",
    "gate-kustomize-extensions",
    "gate-dotnet-fsharp-format",
    "gate-dotnet-format-extensions",
    "gate-dotnet-generator-extensions",
    "gate-ruby-extensions",
    "gate-swift-extensions",
    "gate-helm-extensions",
    "helm-extensions-surfaces",
    "helm-extensions-lifecycle",
    "gate-terraform-extensions",
    "terraform-extensions-surfaces",
    "terraform-extensions-lifecycle",
    "gate-cpp-extensions",
    "cpp-extensions-surfaces",
    "cpp-extensions-cancel",
    "gate-confidence-provenance",
    "review-findings",
    "review-workflow-findings",
    "gate-multi-candidate-workflow",
    "gate-scala-extensions",
    "gate-jvm-wrappers",
    "gate-php-extensions",
    "gate-python-extensions",
    "gate-assembly-laravel",
    "gate-assembly-django",
    "gate-assembly-fastapi",
    "gate-assembly-vue-router",
    "gate-host-session-readiness",
  ].map((name) => "dist/test/" + name + ".test.js"),
};
// resolveRequirements in required-test-evidence.mjs runs a profile only when it
// holds 1 to 256 rows, each with a file path of at most 4096 characters. It
// resolves each path first, so a path component longer than the filesystem's
// 255-byte name limit fails there too.
const maxProfileRows = 256;
const maxFileCharacters = 4096;
const maxNameBytes = 255;
const resolvable = (file) =>
  file.length <= maxFileCharacters &&
  file.split("/").every((part) => Buffer.byteLength(part) <= maxNameBytes);
const genericRunner = "scripts/required-test-evidence.mjs";
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
  // These are declaration counts, separate from execution and acceptance.
  // Controller bindings address a case by its owning profile key as well as
  // file and name, and count occurrences: the native runner refuses a repeated
  // address. The legacy visibility report matches file and name in any profile.
  const sharedCases = new Map();
  const visibleCases = new Set();
  for (const [owner, rows] of Object.entries(current)) {
    assert.ok(
      Array.isArray(rows),
      "Required native manifests must contain arrays",
    );
    for (const row of rows) {
      assert.ok(
        row && typeof row === "object" && !Array.isArray(row),
        "Invalid required native case object",
      );
      assert.deepEqual(
        Object.keys(row).sort(),
        ["file", "name"],
        "Invalid required native case fields",
      );
      assert.match(
        row.file,
        /^dist\/test\/[a-z0-9-]+\.test\.js$/,
        "Invalid required native case file",
      );
      assert.ok(
        typeof row.name === "string" &&
          row.name.length > 0 &&
          row.name.length <= 512,
        "Invalid required native case name",
      );
      const address = canonical([owner, row.file, row.name]);
      sharedCases.set(address, (sharedCases.get(address) ?? 0) + 1);
      visibleCases.add(canonical([row.file, row.name]));
    }
  }
  let casesInSharedManifest = 0;
  const outsideSharedManifest = [];
  for (const profile of inventory.extensionProfiles) {
    const present = profile.acceptanceCases.filter((entry) =>
      visibleCases.has(canonical([profile.acceptanceFile, entry.name])),
    ).length;
    casesInSharedManifest += present;
    if (present !== profile.acceptanceCases.length)
      outsideSharedManifest.push({
        profile: profile.id,
        plannedCases: profile.acceptanceCases.length,
        casesInSharedManifest: present,
        casesOutsideSharedManifest: profile.acceptanceCases.length - present,
      });
  }
  const casesOutsideSharedManifest = outsideSharedManifest.reduce(
    (n, row) => n + row.casesOutsideSharedManifest,
    0,
  );
  assert.equal(
    casesInSharedManifest + casesOutsideSharedManifest,
    selectedCases,
  );
  const alternateBindings = [];
  const unresolvedBindings = [];
  let declaredFileBindings = 0;
  for (const profile of inventory.extensionProfiles) {
    for (const entry of profile.acceptanceCases) {
      const alternate = alternateAcceptanceFiles[profile.id]?.[entry.id];
      const file = alternate ?? profile.acceptanceFile;
      const binding = {
        profile: profile.id,
        caseId: entry.id,
        file,
        name: entry.name,
      };
      if (alternate) {
        const matches = (current[profile.id] ?? []).filter(
          (row) => row.name === entry.name,
        );
        if (matches.length === 1 && matches[0].file === file)
          alternateBindings.push(binding);
        else unresolvedBindings.push(binding);
      } else if (
        (controllerProfiles[profile.id] ?? [profile.id]).every(
          (owner) =>
            sharedCases.get(canonical([owner, file, entry.name])) === 1,
        )
      ) {
        declaredFileBindings++;
      } else unresolvedBindings.push(binding);
    }
  }
  assert.equal(
    declaredFileBindings + alternateBindings.length + unresolvedBindings.length,
    selectedCases,
    "Every selected case must have one binding disposition",
  );
  // A controller validates a profile's full row set, selected or not, before
  // running any of it: one refusal stops every case the profile would run.
  // The aggregate mutation profile is not a controller profile.
  const admissionProfiles = [
    ...new Set(
      inventory.extensionProfiles.flatMap(
        (profile) => controllerProfiles[profile.id] ?? [profile.id],
      ),
    ),
  ].sort();
  const address = (row) => canonical([row.file, row.name]);
  // The generic runner's own admission: 1 to `limit` rows, no repeated
  // file/name pair. The same pair in another profile is a separate requirement.
  const runnable = (rows, limit = maxProfileRows) =>
    Array.isArray(rows) &&
    rows.length > 0 &&
    rows.length <= limit &&
    rows.every((row) => resolvable(row.file)) &&
    new Set(rows.map(address)).size === rows.length;
  const cohortAdmitted = (entry) => {
    const lists = entry.cohort.map((owner) => current[owner]);
    const limit = entry.shards ? Infinity : entry.maxRows;
    if (!lists.every((rows) => runnable(rows, limit))) return false;
    const rows = lists.flat();
    if (
      entry.shards &&
      Array.from({ length: entry.shards }, (_, shard) =>
        rows.filter((_row, index) => index % entry.shards === shard),
      ).some((shard) => shard.length === 0 || shard.length > maxProfileRows)
    )
      return false;
    const firsts = (entry.fileOrder ?? []).map((file) =>
      rows.findIndex((row) => row.file === file),
    );
    if (
      firsts.some(
        (at, index) => at < 0 || (index > 0 && at < firsts[index - 1]),
      )
    )
      return false;
    const distinct = new Set(rows.map(address));
    if (entry.rows !== undefined && distinct.size !== entry.rows) return false;
    if (entry.disjoint && distinct.size !== rows.length) return false;
    if (rows.some((row) => row.file === entry.outsideFile)) return false;
    if (entry.files && rows.some((row) => !entry.files.includes(row.file)))
      return false;
    if (rows.some((row) => entry.absentNames?.includes(row.name))) return false;
    if (
      entry.preserved &&
      canonical([...distinct].sort()) !==
        canonical(
          entry.cohort
            .flatMap((owner) => baseline.value[owner])
            .map(address)
            .sort(),
        )
    )
      return false;
    return (
      entry.sha256 === undefined ||
      digest(canonical(rows.map((row) => [row.file, row.name]))) ===
        entry.sha256
    );
  };
  const witnessRowsPresent = sharedWitnessSelector.profiles.every((owner) => {
    const profile = inventory.extensionProfiles.find((p) => p.id === owner);
    return sharedWitnessSelector.cases.every((id) => {
      const entry = profile.acceptanceCases.find((row) => row.id === id);
      return (current[owner] ?? []).some(
        (row) => row.file === profile.acceptanceFile && row.name === entry.name,
      );
    });
  });
  const installedCountCallbacks = Object.fromEntries(
    inventory.extensionProfiles
      .filter((profile) => !uncountedInstalledProfiles.includes(profile.id))
      .map((profile) => [
        "test/gate-" + profile.id + ".test.ts",
        { rows: 9, profiles: controllerProfiles[profile.id] ?? [profile.id] },
      ]),
  );
  const admissionRefusals = [];
  for (const owner of admissionProfiles) {
    const rows = current[owner] ?? [];
    const refuse = (controller, reason) =>
      admissionRefusals.push({ profile: owner, controller, reason });
    if (new Set(rows.map(address)).size !== rows.length)
      refuse(genericRunner, "duplicate-address");
    if (rows.length === 0 || rows.length > maxProfileRows)
      refuse(genericRunner, "row-limit");
    if (rows.some((row) => !resolvable(row.file)))
      refuse(genericRunner, "address-limit");
    const selector = dedicatedSelectors[owner];
    if (selector) {
      const selection = selector.selection ?? owner;
      const profile = inventory.extensionProfiles.find(
        (p) => p.id === selection,
      );
      const key = selector.serialized ? (row) => JSON.stringify(row) : address;
      const expected = [
        ...profile.acceptanceCases.map((entry) =>
          key({
            file:
              alternateAcceptanceFiles[selection]?.[entry.id] ??
              profile.acceptanceFile,
            name: entry.name,
          }),
        ),
        ...(selector.extra ?? []).map((name) =>
          key({ file: profile.acceptanceFile, name }),
        ),
      ];
      const arranged = (list) => (selector.ordered ? list : [...list].sort());
      if (canonical(arranged(rows.map(key))) !== canonical(arranged(expected)))
        refuse(selector.controller, "selector-rows-differ");
    }
    for (const entry of companionCohorts)
      if (entry.profile === owner && !cohortAdmitted(entry))
        refuse(entry.controller, "companion-cohort-differs");
    if (!witnessRowsPresent && sharedWitnessSelector.dependents.includes(owner))
      refuse(sharedWitnessSelector.controller, "shared-selector-rows-differ");
    for (const [controller, rule] of Object.entries(rowCountControllers))
      if (rule.profiles.includes(owner) && rows.length !== rule.rows)
        refuse(controller, "row-count-differs");
    if (
      installedHarness.profiles.includes(owner) &&
      rows.some((row) => !installedHarness.files.includes(row.file))
    )
      refuse(installedHarness.controller, "installed-harness-differs");
    for (const [controller, rule] of Object.entries(installedCountCallbacks))
      if (rule.profiles.includes(owner) && rows.length !== rule.rows)
        refuse(controller, "installed-count-differs");
  }
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
      implementationDeclarations: {
        implemented: inventory.extensionProfiles.filter(
          (p) => p.implementationState === "implemented",
        ).length,
        pending: inventory.extensionProfiles.filter(
          (p) => p.implementationState === "pending",
        ).length,
      },
      selectedCaseBindings: {
        plannedCases: selectedCases,
        casesInSharedManifest,
        casesOutsideSharedManifest,
        outsideSharedManifest,
        alternateControllersAssessed: false,
        nativeExecutionAssessed: false,
      },
      controllerCaseBindings: {
        plannedCases: selectedCases,
        declaredFileBindings,
        alternateFileBindings: alternateBindings.length,
        unresolvedCases: unresolvedBindings.length,
        alternateBindings,
        unresolvedBindings,
        nativeExecutionAssessed: false,
      },
      controllerAdmission: {
        controllerProfiles: admissionProfiles.length,
        dedicatedSelectorProfiles: Object.keys(dedicatedSelectors).sort(),
        companionCohorts,
        sharedSelectors: [
          {
            controller: sharedWitnessSelector.controller,
            profiles: sharedWitnessSelector.profiles,
            dependents: sharedWitnessSelector.dependents,
          },
        ],
        rowCountControllers: Object.entries(rowCountControllers).map(
          ([controller, rule]) => ({ controller, ...rule }),
        ),
        installedCountCallbacks: Object.entries(installedCountCallbacks).map(
          ([controller, rule]) => ({ controller, ...rule }),
        ),
        maxProfileRows,
        maxFileCharacters,
        maxNameBytes,
        installedHarness,
        refusedProfiles: new Set(admissionRefusals.map((row) => row.profile))
          .size,
        refusals: admissionRefusals,
        nativeExecutionAssessed: false,
      },
      unresolvedFreezeDecisions: inventory.unresolvedFreezeDecisions.length,
      frozen: inventory.frozen,
      implementationAcceptanceAssessed: false,
      gateAComplete: false,
      qualityAssessed: false,
    }) + "\n",
  );
  if (
    process.argv[3] === "--require-frozen" &&
    (!inventory.frozen ||
      unresolvedBindings.length > 0 ||
      admissionRefusals.length > 0)
  )
    process.exitCode = 2;
} catch (error) {
  process.stderr.write(
    "Inventory audit failed: " + String(error.message) + "\n",
  );
  process.exitCode = 2;
}
