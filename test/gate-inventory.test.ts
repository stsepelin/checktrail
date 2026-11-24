import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
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
  // The legacy visibility report still finds the callback in another profile.
  assert.deepEqual(after.selectedCaseBindings, baseline.selectedCaseBindings);
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
  // An unrelated adjacent name must not make an exact existing binding
  // ambiguous. The generic verifier admits the extra Terraform and Helm rows;
  // the C++ selector admits no extra row but compares its rows sorted, so its
  // near miss is a reordering.
  const near = await frozen(t);
  await alter<RequiredNative>(near, files[2]!, (rows) => {
    rows["cpp-extensions"]!.reverse();
    for (const [profile, caseId, file] of alternateBindings)
      if (profile !== "cpp-extensions")
        rows[profile]!.push({
          file: `dist/test/${file}.test.js`,
          name: `${profile} ${caseId} acceptance adjacent 4127`,
        });
  });
  const admitted = await audit(near, true);
  assert.equal(admitted.code, 0, admitted.stdout);
  assert.deepEqual(
    JSON.parse(admitted.stdout).controllerCaseBindings,
    bindings,
  );
  assert.deepEqual(
    JSON.parse(admitted.stdout).controllerAdmission.refusals,
    [],
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

async function frozen(t: TestContext) {
  const root = await source(t);
  await alter<SelectedInventory & { unresolvedFreezeDecisions: unknown[] }>(
    root,
    files[0]!,
    (value) => {
      value.frozen = true;
      value.unresolvedFreezeDecisions = [];
    },
  );
  return root;
}
const unresolvedAddresses = (stdout: string) =>
  (
    JSON.parse(stdout).controllerCaseBindings.unresolvedBindings as {
      profile: string;
      caseId: string;
    }[]
  )
    .map((row) => row.profile + "/" + row.caseId)
    .sort();
const selectedCaseIds = async (profile: string) => {
  const inventory = JSON.parse(
    await readFile(path.join(repository, files[0]!), "utf8"),
  ) as {
    extensionProfiles: {
      id: string;
      acceptanceCases: { id: string; name: string }[];
    }[];
  };
  return inventory.extensionProfiles.find((row) => row.id === profile)!
    .acceptanceCases;
};

test("finite inventory pins the mutation controller cohorts the native verifier selects", async () => {
  const verifier = await readFile(
    path.join(repository, "scripts/verify-required-native-tests.mjs"),
    "utf8",
  );
  const audited = await readFile(script, "utf8");
  const list = (text: string, name: string) =>
    JSON.parse(
      new RegExp("const " + name + " = (\\[[^\\]]*\\])", "u")
        .exec(text)![1]!
        .replace(/,(\s*)\]$/u, "$1]"),
    ) as string[];
  const block = /"mutation-runners": (\[[^\]]*\])/u.exec(audited)![1]!;
  assert.deepEqual(
    JSON.parse(block.replace(/,(\s*)\]$/u, "$1]")),
    list(verifier, "mutationProfiles"),
  );
});

// Each broken case starts from a fresh frozen fixture, so the refusal can only
// come from the one address it removes or repeats.
test("finite inventory strict freeze refuses unresolved case bindings even when selection freeze is declared", async (t) => {
  const complete = await audit(await frozen(t), true);
  assert.equal(complete.code, 0, complete.stderr);
  assert.equal(JSON.parse(complete.stdout).gateAComplete, false);
  assert.deepEqual(unresolvedAddresses(complete.stdout), []);
  const mutation = (await selectedCaseIds("mutation-runners")).map(
    (row) => "mutation-runners/" + row.id,
  );
  const tasks = await selectedCaseIds("tasks-matrix");
  const broken: [string, (rows: RequiredNative) => void, string[]][] = [
    [
      "one per-family mutation cohort missing",
      (rows) => {
        delete rows["mutation-jest"];
      },
      mutation.slice().sort(),
    ],
    [
      "a declared address repeated in its own profile",
      (rows) => {
        rows["tasks-matrix"]!.push({ ...rows["tasks-matrix"]![0]! });
      },
      [],
    ],
    [
      "only the C++ privacy controller row missing",
      (rows) => {
        rows["cpp-extensions"] = rows["cpp-extensions"]!.filter(
          (row) =>
            row.file !== "dist/test/cpp-extensions-surfaces.test.js" ||
            row.name !== "cpp-extensions privacy acceptance",
        );
      },
      ["cpp-extensions/privacy"],
    ],
  ];
  for (const [label, edit, expected] of broken) {
    const root = await frozen(t);
    let repeated = "";
    await alter<RequiredNative>(root, files[2]!, (rows) => {
      repeated = rows["tasks-matrix"]![0]!.name;
      edit(rows);
    });
    const want =
      expected.length > 0
        ? expected
        : ["tasks-matrix/" + tasks.find((row) => row.name === repeated)!.id];
    const result = await audit(root, true);
    assert.equal(result.code, 2, label + ": " + result.stderr);
    assert.deepEqual(unresolvedAddresses(result.stdout), want, label);
  }
  const root = await frozen(t);
  await alter<RequiredNative>(root, files[2]!, (rows) => {
    delete rows["mutation-runners"];
  });
  const aggregate = await audit(root, true);
  assert.equal(aggregate.code, 0, aggregate.stderr);
  assert.deepEqual(unresolvedAddresses(aggregate.stdout), []);
  assert.deepEqual(
    JSON.parse(aggregate.stdout).selectedCaseBindings,
    JSON.parse(complete.stdout).selectedCaseBindings,
  );
});

interface AdmissionRefusal {
  profile: string;
  controller: string;
  reason: string;
}
const admissionRefusals = (stdout: string) =>
  JSON.parse(stdout).controllerAdmission.refusals as AdmissionRefusal[];
const genericRunner = "scripts/required-test-evidence.mjs";

test("finite inventory strict freeze refuses a profile its dedicated controller selector rejects", async (t) => {
  const complete = await audit(await frozen(t), true);
  assert.equal(complete.code, 0, complete.stderr);
  assert.deepEqual(admissionRefusals(complete.stdout), []);
  const clang = "scripts/selected-clang-consumer-witness.mjs";
  const tasks = "scripts/tasks-runtime-evidence.mjs";
  const broken: [string, (rows: RequiredNative) => void, AdmissionRefusal[]][] =
    [
      [
        "the unselected C++ compiler formatter analyzer row removed",
        (rows) => {
          rows["cpp-extensions"] = rows["cpp-extensions"]!.filter(
            (row) =>
              row.name !==
              "cpp-extensions compiler formatter analyzer acceptance",
          );
        },
        [
          {
            profile: "cpp-extensions",
            controller: clang,
            reason: "selector-rows-differ",
          },
        ],
      ],
      [
        "an adjacent C++ row added",
        (rows) => {
          rows["cpp-extensions"]!.push({
            file: "dist/test/cpp-extensions-surfaces.test.js",
            name: "cpp-extensions privacy acceptance adjacent 4127",
          });
        },
        [
          {
            profile: "cpp-extensions",
            controller: clang,
            reason: "selector-rows-differ",
          },
        ],
      ],
      [
        "two Tasks rows swapped",
        (rows) => {
          const list = rows["tasks-matrix"]!;
          [list[2], list[6]] = [list[6]!, list[2]!];
        },
        [
          {
            profile: "tasks-matrix",
            controller: tasks,
            reason: "selector-rows-differ",
          },
        ],
      ],
      [
        "the preserved MCP Tasks cohort grown",
        (rows) => {
          rows["mcp-tasks"]!.push({
            file: "dist/test/mcp-validation-tasks.test.js",
            name: "MCP Tasks companion row 6203",
          });
        },
        [
          {
            profile: "tasks-matrix",
            controller: tasks,
            reason: "companion-cohort-differs",
          },
        ],
      ],
      [
        "an adjacent .NET generator row added",
        (rows) => {
          rows["dotnet-generator-extensions"]!.push({
            file: "dist/test/gate-dotnet-generator-extensions.test.js",
            name: "dotnet-generator-extensions adjacent acceptance 9157",
          });
        },
        [
          {
            profile: "dotnet-generator-extensions",
            controller: "scripts/dotnet-generator-shards.mjs",
            reason: "selector-rows-differ",
          },
        ],
      ],
    ];
  for (const [label, edit, expected] of broken) {
    const root = await frozen(t);
    await alter<RequiredNative>(root, files[2]!, edit);
    const result = await audit(root, true);
    assert.equal(result.code, 2, label + ": " + result.stderr);
    assert.deepEqual(unresolvedAddresses(result.stdout), [], label);
    assert.deepEqual(admissionRefusals(result.stdout), expected, label);
  }
});

const canonicalRow = (row: NativeCase) => JSON.stringify([row.file, row.name]);
const diagnostic = {
  file: "dist/test/gate-helm-extensions.test.js",
  name: "helm-extensions diagnostic acceptance",
};
test("finite inventory strict freeze refuses a controller profile that repeats an unselected address", async (t) => {
  const repeated = await frozen(t);
  await alter<RequiredNative>(repeated, files[2]!, (rows) => {
    assert.equal(
      rows["helm-extensions"]!.filter(
        (row) => canonicalRow(row) === canonicalRow(diagnostic),
      ).length,
      1,
    );
    rows["helm-extensions"]!.push({ ...diagnostic });
  });
  const refused = await audit(repeated, true);
  assert.equal(refused.code, 2, refused.stderr);
  assert.deepEqual(unresolvedAddresses(refused.stdout), []);
  assert.deepEqual(admissionRefusals(refused.stdout), [
    {
      profile: "helm-extensions",
      controller: genericRunner,
      reason: "duplicate-address",
    },
  ]);
});
// The same address in a second controller profile is that profile's own
// requirement, and the aggregate mutation profile runs under no controller.
test("finite inventory strict freeze admits an address repeated across profiles or in the aggregate", async (t) => {
  const nearMisses: [string, (rows: RequiredNative) => void][] = [
    [
      "the Helm diagnostic row also filed under Terraform",
      (rows) => {
        rows["terraform-extensions"]!.push({ ...diagnostic });
      },
    ],
    [
      "a row repeated in the aggregate mutation profile",
      (rows) => {
        rows["mutation-runners"]!.push({ ...rows["mutation-runners"]![4]! });
      },
    ],
  ];
  for (const [label, edit] of nearMisses) {
    const root = await frozen(t);
    await alter<RequiredNative>(root, files[2]!, edit);
    const result = await audit(root, true);
    assert.equal(result.code, 0, label + ": " + result.stdout);
    assert.deepEqual(unresolvedAddresses(result.stdout), [], label);
    assert.deepEqual(admissionRefusals(result.stdout), [], label);
  }
});

interface ScopeProfile {
  id: string;
  acceptanceFile: string;
  acceptanceCases: { id: string; name: string }[];
}
interface Scope {
  extensionProfiles: ScopeProfile[];
}
interface CompanionCohort {
  profile: string;
  controller: string;
  cohort: string[];
  rows?: number;
  maxRows?: number;
  disjoint?: boolean;
  outsideFile?: string;
  preserved?: boolean;
  sha256?: string;
  files?: string[];
}
interface Admission {
  controllerProfiles: number;
  dedicatedSelectorProfiles: string[];
  companionCohorts: CompanionCohort[];
  sharedSelectors: {
    controller: string;
    profiles: string[];
    dependents: string[];
  }[];
  rowCountControllers: {
    controller: string;
    rows: number;
    profiles: string[];
  }[];
  maxProfileRows: number;
  maxFileCharacters: number;
  refusals: AdmissionRefusal[];
}
const admission = (stdout: string) =>
  JSON.parse(stdout).controllerAdmission as Admission;
const scriptModule = (name: string) =>
  import(new URL("../../scripts/" + name, import.meta.url).href);
const readScript = (name: string) =>
  readFile(path.join(repository, name), "utf8");
const readScope = async () =>
  JSON.parse(await readFile(path.join(repository, files[0]!), "utf8")) as Scope;
type Selector = (
  root: string,
  rows: RequiredNative,
  scope: Scope,
) => Promise<unknown> | void;
// Three controllers check their rows inline in a script that runs native tests
// on import, so their rule is pinned by its source text instead.
const inlineSelection = `assert.deepEqual(
  requirements,
  selection.acceptanceCases.map((item) => ({
    file: selection.acceptanceFile,
    name: item.name,
  })),
);`;
const inlineSelector =
  (id: string): Selector =>
  (_root, rows, scope) => {
    const selected = scope.extensionProfiles.find((row) => row.id === id)!;
    assert.deepEqual(
      rows[id],
      selected.acceptanceCases.map((item) => ({
        file: selected.acceptanceFile,
        name: item.name,
      })),
    );
  };
const mutationSelection = `  assert.deepEqual(
    inventory["mutation-" + family],
    frozen.acceptanceCases.map((c) => ({
      file: frozen.acceptanceFile,
      name: c.name,
    })),
  );`;
const mutationSelector =
  (family: string): Selector =>
  (_root, rows, scope) => {
    const frozen = scope.extensionProfiles.find(
      (row) => row.id === "mutation-runners",
    )!;
    assert.deepEqual(
      rows["mutation-" + family],
      frozen.acceptanceCases.map((c) => ({
        file: frozen.acceptanceFile,
        name: c.name,
      })),
    );
  };
const platforms = ["darwin", "linux", "win32"] as const;
const mutationFamilies = ["vitest", "jest", "pytest", "phpunit"];
const controllerSelectors: Record<
  string,
  { controller: string; select: Selector }
> = {
  "cpp-extensions": {
    controller: "scripts/selected-clang-consumer-witness.mjs",
    select: async (root) =>
      (
        await scriptModule("selected-clang-consumer-witness.mjs")
      ).selectSelectedClangRequirements(root),
  },
  "dotnet-generator-extensions": {
    controller: "scripts/dotnet-generator-shards.mjs",
    select: async (_root, rows) =>
      (
        await scriptModule("dotnet-generator-shards.mjs")
      ).validateGeneratorShardManifest(
        JSON.parse(await readScript("scripts/dotnet-generator-shards.v1.json")),
        rows,
      ),
  },
  "scala-extensions": {
    controller: "scripts/scala-native-ci-phases.mjs",
    select: async (_root, rows) =>
      (
        await scriptModule("scala-native-ci-phases.mjs")
      ).selectScalaExtensionSourceRequirements(rows["scala-extensions"]),
  },
  "ruby-extensions": {
    controller: "scripts/ruby-extensions-acceptance-selection.mjs",
    select: async (_root, rows) =>
      (
        await scriptModule("ruby-extensions-acceptance-selection.mjs")
      ).selectRubyExtensionAcceptance(rows["ruby-extensions"], "source", "all"),
  },
  "consumer-impact": {
    controller: "scripts/consumer-runtime-evidence.mjs",
    select: async (_root, rows, scope) =>
      (
        await scriptModule("consumer-runtime-evidence.mjs")
      ).selectConsumerRuntimeRequirements(rows, scope),
  },
  "multi-candidate-workflow": {
    controller: "scripts/review-runtime-evidence.mjs",
    select: async (_root, rows, scope) =>
      (
        await scriptModule("review-runtime-evidence.mjs")
      ).selectReviewRuntimeRequirements(
        rows,
        scope,
        "multi-candidate-workflow",
      ),
  },
  "confidence-provenance": {
    controller: "scripts/review-runtime-evidence.mjs",
    select: async (_root, rows, scope) =>
      (
        await scriptModule("review-runtime-evidence.mjs")
      ).selectReviewRuntimeRequirements(rows, scope, "confidence-provenance"),
  },
  "attempt-archives": {
    controller: "scripts/attempt-whole-evidence.mjs",
    select: async (_root, rows, scope) =>
      (
        await scriptModule("attempt-whole-evidence.mjs")
      ).selectAttemptWholeRequirements(rows, scope),
  },
  "lifecycle-platforms": {
    controller: "scripts/verify-lifecycle-platforms.mjs",
    select: async (root, rows, scope) => {
      await inlineSelector("lifecycle-platforms")(root, rows, scope);
      const { lifecycleFoundationSelection, lifecycleHarnessFiles } =
        await scriptModule("lifecycle-runtime-evidence.mjs");
      for (const platform of platforms)
        for (const profile of lifecycleFoundationSelection(platform)) {
          const list = rows[profile];
          assert.ok(Array.isArray(list) && list.length > 0);
          for (const row of list)
            assert.ok(lifecycleHarnessFiles.includes(row.file));
          assert.ok(runnable(list));
        }
    },
  },
  // The Tasks runtime runs on every platform, and Windows adds harness rows.
  "tasks-matrix": {
    controller: "scripts/tasks-runtime-evidence.mjs",
    select: async (_root, rows, scope) => {
      const { selectTasksRuntimeRequirements } = await scriptModule(
        "tasks-runtime-evidence.mjs",
      );
      for (const platform of platforms)
        selectTasksRuntimeRequirements(
          rows,
          scope.extensionProfiles.find((row) => row.id === "tasks-matrix"),
          platform,
        );
    },
  },
  "native-license-provenance": {
    controller: "scripts/native-provenance-runtime-evidence.mjs",
    select: async (_root, rows, scope) =>
      (
        await scriptModule("native-provenance-runtime-evidence.mjs")
      ).selectProvenanceRuntimeRequirements(rows, scope),
  },
  "resource-release-readiness": {
    controller: "scripts/verify-resource-release-readiness.mjs",
    select: inlineSelector("resource-release-readiness"),
  },
  "independent-evaluation-protocol": {
    controller: "scripts/evaluation-runtime-evidence.mjs",
    select: async (_root, rows, scope) =>
      (
        await scriptModule("evaluation-runtime-evidence.mjs")
      ).selectEvaluationRuntimeRequirements(rows, scope),
  },
  ...Object.fromEntries(
    mutationFamilies.map((family) => [
      "mutation-" + family,
      {
        controller: "scripts/verify-mutation-container.mjs",
        select: mutationSelector(family),
      },
    ]),
  ),
};
// Foundation modules export the exact companion lists their controllers
// compare before running.
const foundationSelectors: Record<string, (rows: RequiredNative) => unknown> = {
  "scripts/consumer-foundation-evidence.mjs": async (rows) =>
    (
      await scriptModule("consumer-foundation-evidence.mjs")
    ).selectConsumerFoundation(rows),
  "scripts/attempt-foundation-evidence.mjs": async (rows) => {
    const { selectAttemptFoundation } = await scriptModule(
      "attempt-foundation-evidence.mjs",
    );
    for (const platform of platforms) selectAttemptFoundation(rows, platform);
  },
};
const lifecycleFoundation = `        assert.ok(
          Array.isArray(profiles[profile]) && profiles[profile].length > 0,
          "Missing lifecycle platform foundation",
        );`;
const resolveSelection = `  assert.ok(
    Array.isArray(requirements) &&
      requirements.length > 0 &&
      requirements.length <= MAX_REQUIREMENTS,
  );`;
const runnable = (rows: NativeCase[] | undefined, limit = 256) =>
  Array.isArray(rows) &&
  rows.length > 0 &&
  rows.length <= limit &&
  rows.every((row) => row.file.length <= 4096) &&
  new Set(rows.map(canonicalRow)).size === rows.length;
// A copy of the count a container asserts on a runner batch over its cohort.
const cohortCountAdmits = (entry: CompanionCohort, rows: RequiredNative) => {
  const lists = entry.cohort.map((owner) => rows[owner]);
  if (!lists.every((list) => runnable(list))) return false;
  const all = lists.flat() as NativeCase[];
  const distinct = new Set(all.map(canonicalRow)).size;
  return (
    distinct === entry.rows && (!entry.disjoint || distinct === all.length)
  );
};
const admissionProfileIds = (scope: Scope) =>
  [
    ...new Set(
      scope.extensionProfiles.flatMap((row) =>
        row.id === "mutation-runners"
          ? mutationFamilies.map((family) => "mutation-" + family)
          : [row.id],
      ),
    ),
  ].sort();
const countPattern = (rows: number) =>
  new RegExp(
    `\\.(?:required|passed|length)(?:,\\s*|\\s*===\\s*)${rows}(?!\\d)`,
    "u",
  );

test("finite inventory pins the controller rules its admission copies from source text", async (t) => {
  for (const [script, key, text] of [
    [
      "scripts/verify-lifecycle-platforms.mjs",
      'profiles["lifecycle-platforms"];',
      inlineSelection,
    ],
    [
      "scripts/verify-resource-release-readiness.mjs",
      ')["resource-release-readiness"];',
      inlineSelection,
    ],
    [
      "scripts/verify-mutation-container.mjs",
      '.extensionProfiles.find((p) => p.id === "mutation-runners");',
      mutationSelection,
    ],
    [
      "scripts/required-test-evidence.mjs",
      "const MAX_REQUIREMENTS = 256;",
      resolveSelection,
    ],
    [
      "scripts/verify-lifecycle-platforms.mjs",
      "const foundationSelection = lifecycleFoundationSelection();",
      lifecycleFoundation,
    ],
  ] as const) {
    const source = await readScript(script);
    assert.equal(source.split(key).length, 2, script);
    assert.equal(source.split(text).length, 2, script);
  }
  const report = admission((await audit(await source(t))).stdout);
  assert.equal(report.maxProfileRows, 256);
  assert.equal(report.maxFileCharacters, 4096);
  assert.equal(
    (await readScript("scripts/required-test-evidence.mjs")).split(
      "file.length <= 4096 &&",
    ).length,
    2,
  );
  assert.equal(
    (await readScript("scripts/verify-lifecycle-platforms.mjs")).split(
      "lifecycleHarnessFiles.includes(row.file),",
    ).length,
    2,
  );
  const lifecycle = await scriptModule("lifecycle-runtime-evidence.mjs");
  const foundations = report.companionCohorts.filter(
    (row) => row.profile === "lifecycle-platforms",
  );
  assert.deepEqual(
    foundations.map((row) => row.cohort),
    [
      lifecycle.lifecycleFoundationSelection("linux"),
      lifecycle.lifecycleFoundationSelection("win32"),
    ],
  );
  for (const row of foundations)
    assert.deepEqual(
      row.files,
      (lifecycle.lifecycleHarnessFiles as string[]).filter((file) =>
        /^dist\/test\/[a-z0-9-]+\.test\.js$/u.test(file),
      ),
    );
  assert.deepEqual(
    (await readScript("scripts/verify-mutation-container.mjs")).match(
      /\["vitest", "jest", "pytest", "phpunit"\]/gu,
    )?.length,
    1,
  );
  // Each modelled count appears in its controller with the profiles it runs.
  for (const entry of report.rowCountControllers) {
    const text = await readScript(entry.controller);
    assert.ok(countPattern(entry.rows).test(text), entry.controller);
    for (const profile of entry.profiles)
      assert.ok(
        text.includes(profile) ||
          text.includes(JSON.stringify(profile.replace(/^mutation-/u, ""))),
        entry.controller + " " + profile,
      );
  }
  for (const entry of report.companionCohorts.filter(
    (row) => row.rows !== undefined && !(row.controller in foundationSelectors),
  )) {
    const text = await readScript(entry.controller);
    assert.ok(countPattern(entry.rows!).test(text), entry.controller);
    for (const profile of entry.cohort)
      assert.ok(
        text.includes(JSON.stringify(profile)),
        entry.controller + " " + profile,
      );
  }
});

// The .NET generator shard manifest partitions the preserved baseline rows of
// its four baseline profiles, so the audit can compare against the baseline.
test("finite inventory strict freeze refuses .NET generator baseline companions its shard selector rejects", async (t) => {
  const shards = JSON.parse(
    await readScript("scripts/dotnet-generator-shards.v1.json"),
  ) as { baselineProfiles: string[]; shards: { baseline: NativeCase[] }[] };
  const preserved = JSON.parse(
    await readFile(path.join(repository, files[1]!), "utf8"),
  ) as RequiredNative;
  assert.deepEqual(
    shards.shards.flatMap((row) => row.baseline.map(canonicalRow)).sort(),
    shards.baselineProfiles
      .flatMap((profile) => preserved[profile]!.map(canonicalRow))
      .sort(),
  );
  const refused = [
    {
      profile: "dotnet-generator-extensions",
      controller: "scripts/dotnet-generator-shards.mjs",
      reason: "companion-cohort-differs",
    },
  ];
  const cases: [string, (rows: RequiredNative) => void, AdmissionRefusal[]][] =
    [
      [
        "an unpartitioned dotnet-build row",
        (rows) => {
          rows["dotnet-build"]!.push({
            file: "dist/test/dotnet-build-surfaces.test.js",
            name: "dotnet-build unpartitioned companion 7243",
          });
        },
        refused,
      ],
      [
        "a dotnet-test row also filed under dotnet-method",
        (rows) => {
          rows["dotnet-method"]!.push({ ...rows["dotnet-test"]![2]! });
        },
        refused,
      ],
      [
        "baseline profiles reordered",
        (rows) => {
          rows["dotnet-build"]!.reverse();
          rows["dotnet-generated"]!.reverse();
        },
        [],
      ],
    ];
  for (const [label, edit, expected] of cases) {
    const root = await frozen(t);
    await alter<RequiredNative>(root, files[2]!, edit);
    const result = await audit(root, true);
    assert.equal(result.code, expected.length ? 2 : 0, label + result.stderr);
    assert.deepEqual(unresolvedAddresses(result.stdout), [], label);
    assert.deepEqual(admissionRefusals(result.stdout), expected, label);
  }
});

// Terraform's controllers count its rows relative to the manifest, so only the
// runner's own bounds can refuse a longer profile.
test("finite inventory strict freeze refuses a controller profile outside the native runner's row limit", async (t) => {
  const limit = (reason: string) => [
    { profile: "terraform-extensions", controller: genericRunner, reason },
  ];
  const pad = (size: number) => (rows: RequiredNative) => {
    const list = rows["terraform-extensions"]!;
    while (list.length < size)
      list.push({
        file: "dist/test/gate-terraform-extensions.test.js",
        name: "terraform-extensions padded row " + (8311 + list.length),
      });
    assert.equal(list.length, size);
  };
  const longFile = (length: number) => (rows: RequiredNative) => {
    rows["terraform-extensions"]!.push({
      file: "dist/test/" + "t".repeat(length - 18) + ".test.js",
      name: "terraform-extensions long address 7019",
    });
    assert.equal(rows["terraform-extensions"]!.at(-1)!.file.length, length);
  };
  const cases: [string, (rows: RequiredNative) => void, AdmissionRefusal[]][] =
    [
      ["256 rows", pad(256), []],
      ["257 rows", pad(257), limit("row-limit")],
      ["a 4096-character file", longFile(4096), []],
      ["a 4097-character file", longFile(4097), limit("address-limit")],
    ];
  for (const [label, edit, expected] of cases) {
    const root = await frozen(t);
    await alter<RequiredNative>(root, files[2]!, edit);
    const result = await audit(root, true);
    assert.equal(result.code, expected.length ? 2 : 0, label);
    assert.deepEqual(unresolvedAddresses(result.stdout), [], label);
    assert.deepEqual(admissionRefusals(result.stdout), expected, label);
  }
});

test("finite inventory strict freeze refuses every profile whose controller calls a shared selector one profile breaks", async (t) => {
  const shared = admission((await audit(await frozen(t))).stdout)
    .sharedSelectors[0]!;
  assert.equal(shared.controller, "scripts/consumer-witness-evidence.mjs");
  assert.equal(shared.profiles.length, 18);
  assert.deepEqual(shared.dependents, [...shared.profiles, "cpp-extensions"]);
  const broken = await frozen(t);
  await alter<RequiredNative>(broken, files[2]!, (rows) => {
    rows["context-python"] = rows["context-python"]!.filter(
      (row) => row.name !== "context-python near-miss acceptance",
    );
    assert.equal(rows["context-python"].length, 8);
  });
  const refused = await audit(broken, true);
  assert.equal(refused.code, 2);
  assert.deepEqual(unresolvedAddresses(refused.stdout), [
    "context-python/near-miss",
  ]);
  assert.deepEqual(
    admissionRefusals(refused.stdout),
    [...shared.dependents].sort().flatMap((profile) => [
      {
        profile,
        controller: shared.controller,
        reason: "shared-selector-rows-differ",
      },
      ...(profile === "context-python"
        ? [
            {
              profile,
              controller: "scripts/verify-consumer-witness-profile.mjs",
              reason: "row-count-differs",
            },
          ]
        : []),
    ]),
  );
  // The shared selector looks rows up by address, so their order is free.
  const near = await frozen(t);
  await alter<RequiredNative>(near, files[2]!, (rows) => {
    for (const profile of shared.profiles)
      if (profile.startsWith("context-")) rows[profile]!.reverse();
  });
  const admitted = await audit(near, true);
  assert.equal(admitted.code, 0, admitted.stdout);
  assert.deepEqual(admissionRefusals(admitted.stdout), []);
});

test("finite inventory strict freeze refuses an unselected row a controller's post-run count rejects", async (t) => {
  const adjacent = (profile: string) => (rows: RequiredNative) => {
    rows[profile]!.push({
      file: `dist/test/gate-${profile}.test.js`,
      name: `${profile} unselected acceptance 5821`,
    });
  };
  const counted = (profile: string, ...controllers: string[]) =>
    controllers.map((controller) => ({
      profile,
      controller: "scripts/" + controller,
      reason: "row-count-differs",
    }));
  const cases: [string, (rows: RequiredNative) => void, AdmissionRefusal[]][] =
    [
      [
        "an extra context-go row",
        adjacent("context-go"),
        counted("context-go", "verify-consumer-witness-profile.mjs"),
      ],
      [
        "an extra context-c row",
        adjacent("context-c"),
        counted(
          "context-c",
          "verify-consumer-witness-profile.mjs",
          "verify-c-context-container.mjs",
        ),
      ],
      [
        "an extra python-extensions row",
        adjacent("python-extensions"),
        counted("python-extensions", "verify-python-extensions-container.mjs"),
      ],
      [
        "an extra confidence-provenance row",
        adjacent("confidence-provenance"),
        [
          {
            profile: "confidence-provenance",
            controller: "scripts/review-runtime-evidence.mjs",
            reason: "selector-rows-differ",
          },
          ...counted(
            "confidence-provenance",
            "verify-confidence-provenance.mjs",
            "verify-review-runtime-package.mjs",
            "verify-tasks-runtime-arm64.mjs",
          ),
        ],
      ],
      [
        "context-go and python-extensions rows reordered",
        (rows) => {
          rows["context-go"]!.reverse();
          rows["python-extensions"]!.reverse();
        },
        [],
      ],
    ];
  for (const [label, edit, expected] of cases) {
    const root = await frozen(t);
    await alter<RequiredNative>(root, files[2]!, edit);
    const result = await audit(root, true);
    assert.equal(result.code, expected.length ? 2 : 0, label);
    assert.deepEqual(unresolvedAddresses(result.stdout), [], label);
    assert.deepEqual(admissionRefusals(result.stdout), expected, label);
  }
});

test("finite inventory strict freeze refuses companion cohorts a controller requires before it runs", async (t) => {
  const companion = (profile: string, controller: string) => ({
    profile,
    controller: "scripts/" + controller,
    reason: "companion-cohort-differs",
  });
  const grow = (profile: string) => (rows: RequiredNative) => {
    rows[profile]!.push({
      file: rows[profile]![0]!.file,
      name: `${profile} companion row 6203`,
    });
  };
  const cases: [string, (rows: RequiredNative) => void, AdmissionRefusal[]][] =
    [
      [
        "the python baseline grown",
        grow("python"),
        [
          companion(
            "python-extensions",
            "verify-python-extensions-container.mjs",
          ),
        ],
      ],
      [
        "the frameworks baseline grown",
        grow("frameworks"),
        [
          companion("assembly-django", "verify-django-assembly-container.mjs"),
          companion(
            "assembly-fastapi",
            "verify-fastapi-assembly-container.mjs",
          ),
        ],
      ],
      [
        "the consumer foundation reordered",
        (rows) => {
          rows["consumer-impact-foundation"]!.reverse();
        },
        [companion("consumer-impact", "consumer-foundation-evidence.mjs")],
      ],
      [
        "the attempt output foundation grown",
        grow("attempt-output-foundation"),
        [companion("attempt-archives", "attempt-foundation-evidence.mjs")],
      ],
      [
        "the posix-owner foundation removed",
        (rows) => {
          delete rows["posix-owner"];
        },
        [companion("lifecycle-platforms", "verify-lifecycle-platforms.mjs")],
      ],
      [
        "a Windows foundation row outside the lifecycle harness",
        (rows) => {
          rows["physical-process-output"]!.push({
            file: "dist/test/foreign-foundation.test.js",
            name: "physical-process-output foreign row 3391",
          });
        },
        [companion("lifecycle-platforms", "verify-lifecycle-platforms.mjs")],
      ],
      [
        "a laravel row also filed under laravel-cache",
        (rows) => {
          rows["laravel-cache"]!.push({ ...rows.laravel![1]! });
        },
        [companion("assembly-laravel", "laravel-cache-runtime-evidence.mjs")],
      ],
      // A runner batch counts an address shared by two of its profiles once.
      [
        "a php-review row also filed under php-tools, a posix-owner row under posix-cleanup",
        (rows) => {
          rows["php-tools"]!.push({ ...rows["php-review"]![3]! });
          rows["posix-cleanup"]!.push({ ...rows["posix-owner"]![2]! });
          rows.frameworks!.reverse();
        },
        [],
      ],
    ];
  for (const [label, edit, expected] of cases) {
    const root = await frozen(t);
    await alter<RequiredNative>(root, files[2]!, edit);
    const result = await audit(root, true);
    assert.equal(result.code, expected.length ? 2 : 0, label);
    assert.deepEqual(unresolvedAddresses(result.stdout), [], label);
    assert.deepEqual(admissionRefusals(result.stdout), expected, label);
  }
});

test("finite inventory strict freeze refuses a mutation cohort its container selector rejects", async (t) => {
  const cases: [string, (rows: RequiredNative) => void, AdmissionRefusal[]][] =
    [
      [
        "pytest cohort reordered",
        (rows) => {
          rows["mutation-pytest"]!.reverse();
        },
        [
          {
            profile: "mutation-pytest",
            controller: "scripts/verify-mutation-container.mjs",
            reason: "selector-rows-differ",
          },
        ],
      ],
      [
        "pytest row fields reordered",
        (rows) => {
          const { file, name } = rows["mutation-pytest"]![5]!;
          rows["mutation-pytest"]![5] = { name, file };
        },
        [],
      ],
    ];
  for (const [label, edit, expected] of cases) {
    const root = await frozen(t);
    await alter<RequiredNative>(root, files[2]!, edit);
    const result = await audit(root, true);
    assert.equal(result.code, expected.length ? 2 : 0, label);
    assert.deepEqual(admissionRefusals(result.stdout), expected, label);
  }
});

// The Tasks selector refuses an mcp-tasks row equal to one of its harness rows.
// The audit needs no separate rule: mcp-tasks must keep its ten preserved
// baseline rows and hold exactly ten, so a harness row can only replace a
// preserved one or make an eleventh.
test("finite inventory refuses every Tasks harness row filed in the preserved MCP Tasks cohort", async (t) => {
  const scope = await readScope();
  const manifest = JSON.parse(
    await readFile(path.join(repository, files[2]!), "utf8"),
  ) as RequiredNative;
  const preserved = (
    JSON.parse(
      await readFile(path.join(repository, files[1]!), "utf8"),
    ) as RequiredNative
  )["mcp-tasks"]!;
  const tasks = scope.extensionProfiles.find(
    (row) => row.id === "tasks-matrix",
  )!;
  const { selectTasksRuntimeRequirements } = await scriptModule(
    "tasks-runtime-evidence.mjs",
  );
  const own = new Set(
    [...preserved, ...manifest["tasks-matrix"]!].map(canonicalRow),
  );
  const harness = platforms.flatMap((platform) =>
    (
      selectTasksRuntimeRequirements(manifest, tasks, platform) as NativeCase[]
    ).filter((row) => !own.has(canonicalRow(row))),
  );
  assert.equal(new Set(harness.map(canonicalRow)).size, 10);
  const cohort = admission(
    (await audit(await source(t))).stdout,
  ).companionCohorts.find((row) => row.cohort.includes("mcp-tasks"))!;
  assert.equal(new Set(preserved.map(canonicalRow)).size, cohort.rows);
  const collision = harness.at(-1)!;
  assert.equal(collision.file, "dist/test/windows-task-access.test.js");
  for (const mode of ["replaced", "added"]) {
    const root = await frozen(t);
    await alter<RequiredNative>(root, files[2]!, (rows) => {
      if (mode === "replaced") rows["mcp-tasks"]![4] = { ...collision };
      else rows["mcp-tasks"]!.push({ ...collision });
    });
    const rows = JSON.parse(
      await readFile(path.join(root, files[2]!), "utf8"),
    ) as RequiredNative;
    assert.throws(
      () => selectTasksRuntimeRequirements(rows, tasks, "win32"),
      mode,
    );
    const result = await audit(root, true);
    assert.equal(result.code, 2, mode);
    if (mode === "replaced")
      assert.match(result.stderr, /callback was removed or renamed/);
    else
      assert.deepEqual(admissionRefusals(result.stdout), [
        {
          profile: "tasks-matrix",
          controller: "scripts/tasks-runtime-evidence.mjs",
          reason: "companion-cohort-differs",
        },
      ]);
  }
});

// Each variant edits many profiles at once; for every modelled rule the audit
// must refuse exactly the profiles whose real selector, or pinned copy of an
// inline rule, refuses the same manifest.
test("finite inventory selector admission agrees with every dedicated controller selector", async (t) => {
  const scope = await readScope();
  const witnessManifest = JSON.parse(
    await readScript("docs/gate-a-consumer-witnesses.v1.json"),
  );
  const { selectConsumerWitnessRequirements } = await scriptModule(
    "consumer-witness-evidence.mjs",
  );
  const shape = admission((await audit(await source(t))).stdout);
  const ids = Object.keys(controllerSelectors).sort();
  assert.deepEqual(shape.dedicatedSelectorProfiles, ids);
  // The .NET generator selector compares against its shard partitions; the
  // audit models it with the selected cases, so the two must stay equal.
  const shards = JSON.parse(
    await readScript("scripts/dotnet-generator-shards.v1.json"),
  ) as { shards: { source: NativeCase[] }[] };
  const generator = scope.extensionProfiles.find(
    (row) => row.id === "dotnet-generator-extensions",
  )!;
  assert.deepEqual(
    shards.shards.flatMap((row) => row.source.map(canonicalRow)).sort(),
    generator.acceptanceCases
      .map((row) =>
        canonicalRow({ file: generator.acceptanceFile, name: row.name }),
      )
      .sort(),
  );
  const shared = shape.sharedSelectors[0]!;
  const counted = [
    ...new Set(shape.rowCountControllers.flatMap((row) => row.profiles)),
  ];
  const cohortProfiles = [
    ...new Set(shape.companionCohorts.flatMap((row) => row.cohort)),
  ];
  interface Check {
    rule: string;
    profile: string;
    controller: string;
    reasons: string[];
    refuses: (root: string, rows: RequiredNative) => Promise<boolean>;
  }
  const throws = async (run: () => unknown) => {
    try {
      await run();
      return false;
    } catch {
      return true;
    }
  };
  const checks: Check[] = [
    ...ids.map((id) => ({
      rule: id,
      profile: id,
      controller: controllerSelectors[id]!.controller,
      reasons: ["selector-rows-differ", "companion-cohort-differs"],
      refuses: (root: string, rows: RequiredNative) =>
        throws(() =>
          controllerSelectors[id]!.select(root, structuredClone(rows), scope),
        ),
    })),
    // A cohort checked by the profile's own dedicated selector is covered above.
    ...shape.companionCohorts
      .filter(
        (row) =>
          controllerSelectors[row.profile]?.controller !== row.controller,
      )
      .map((entry) => {
        assert.ok(
          entry.controller in foundationSelectors || entry.rows !== undefined,
          entry.controller,
        );
        return entry;
      })
      .map((entry) => ({
        rule: entry.controller + " " + entry.cohort.join(","),
        profile: entry.profile,
        controller: entry.controller,
        reasons: ["companion-cohort-differs"],
        refuses: async (_root: string, rows: RequiredNative) =>
          entry.controller in foundationSelectors
            ? throws(() =>
                foundationSelectors[entry.controller]!(structuredClone(rows)),
              )
            : !cohortCountAdmits(entry, rows),
      })),
    ...shared.dependents.map((profile) => ({
      rule: shared.controller,
      profile,
      controller: shared.controller,
      reasons: ["shared-selector-rows-differ"],
      refuses: (_root: string, rows: RequiredNative) =>
        throws(() =>
          selectConsumerWitnessRequirements(
            witnessManifest,
            scope,
            structuredClone(rows),
          ),
        ),
    })),
    ...shape.rowCountControllers.flatMap((entry) =>
      entry.profiles.map((profile) => ({
        rule: entry.controller,
        profile,
        controller: entry.controller,
        reasons: ["row-count-differs"],
        refuses: async (_root: string, rows: RequiredNative) =>
          rows[profile]!.length !== entry.rows,
      })),
    ),
    ...admissionProfileIds(scope).map((profile) => ({
      rule: "row-limit",
      profile,
      controller: genericRunner,
      reasons: ["row-limit"],
      refuses: async (_root: string, rows: RequiredNative) => {
        const list = rows[profile] ?? [];
        return list.length === 0 || list.length > shape.maxProfileRows;
      },
    })),
    ...admissionProfileIds(scope).map((profile) => ({
      rule: "address-limit",
      profile,
      controller: genericRunner,
      reasons: ["address-limit"],
      refuses: async (_root: string, rows: RequiredNative) =>
        (rows[profile] ?? []).some(
          (row) => row.file.length > shape.maxFileCharacters,
        ),
    })),
  ];
  const pad = (size: number) => (rows: RequiredNative) => {
    const list = rows["terraform-extensions"]!;
    while (list.length < size)
      list.push({
        file: "dist/test/gate-terraform-extensions.test.js",
        name: "terraform-extensions padded row " + (8311 + list.length),
      });
  };
  const variants: [string, (rows: RequiredNative) => void][] = [
    ["as written", () => {}],
    [
      "reversed",
      (rows) => {
        for (const id of new Set([...ids, ...shared.profiles]))
          rows[id]!.reverse();
      },
    ],
    [
      "adjacent row",
      (rows) => {
        for (const id of new Set([...ids, ...counted]))
          rows[id]!.push({
            file: rows[id]![0]!.file,
            name: id + " adjacent acceptance 9157",
          });
      },
    ],
    [
      "field order swapped",
      (rows) => {
        for (const id of ids) {
          const { file, name } = rows[id]![3]!;
          rows[id]![3] = { name, file };
        }
      },
    ],
    [
      "first row repeated",
      (rows) => {
        for (const id of ids) rows[id]!.push({ ...rows[id]![0]! });
      },
    ],
    [
      "companion cohorts grown",
      (rows) => {
        for (const id of cohortProfiles)
          rows[id]!.push({
            file: rows[id]![0]!.file,
            name: id + " companion row 6203",
          });
      },
    ],
    [
      "companion cohorts reordered",
      (rows) => {
        for (const id of cohortProfiles) rows[id]!.reverse();
      },
    ],
    [
      "companion cohorts overlap",
      (rows) => {
        for (const entry of shape.companionCohorts)
          if (entry.cohort.length > 1)
            rows[entry.cohort[0]!]!.push({ ...rows[entry.cohort[1]!]![0]! });
      },
    ],
    [
      "witness row removed",
      (rows) => {
        rows["context-go"] = rows["context-go"]!.filter(
          (row) => row.name !== "context-go near-miss acceptance",
        );
      },
    ],
    ["at the row limit", pad(256)],
    ["past the row limit", pad(257)],
    [
      "file address past its limit",
      (rows) => {
        rows["terraform-extensions"]!.push({
          file: "dist/test/" + "t".repeat(4080) + ".test.js",
          name: "terraform-extensions long address 7019",
        });
      },
    ],
    [
      "foundation file outside the lifecycle harness",
      (rows) => {
        rows["physical-process-output"]!.push({
          file: "dist/test/foreign-foundation.test.js",
          name: "physical-process-output foreign row 3391",
        });
      },
    ],
  ];
  const outcomes = new Map<string, Set<boolean>>();
  for (const [label, edit] of variants) {
    const root = await source(t);
    await alter<RequiredNative>(root, files[2]!, edit);
    const rows = JSON.parse(
      await readFile(path.join(root, files[2]!), "utf8"),
    ) as RequiredNative;
    const result = await audit(root);
    assert.equal(result.code, 0, label + ": " + result.stderr);
    const report = admission(result.stdout);
    for (const check of checks) {
      const refused = await check.refuses(root, rows);
      const auditRefused = report.refusals.some(
        (row) =>
          row.profile === check.profile &&
          row.controller === check.controller &&
          check.reasons.includes(row.reason),
      );
      assert.equal(
        auditRefused,
        refused,
        `${label}: ${check.rule} ${check.profile}`,
      );
      if (!outcomes.has(check.rule)) outcomes.set(check.rule, new Set());
      outcomes.get(check.rule)!.add(refused);
    }
  }
  for (const [rule, seen] of outcomes)
    assert.deepEqual([...seen].sort(), [false, true], rule);
});

// A controller script that selects manifest rows with an exact count or an
// exact row set must be modelled by the admission audit. Scripts listed here
// carry such a rule for a profile no selected case runs under.
const unmodelledRowSelectors: Record<string, string> = {
  "scripts/ci-full-suite-shards.mjs":
    "partitions every manifest profile into CI full-suite shards",
  "scripts/task-archive-evidence.mjs":
    "counts the Task archive callbacks it reads from their test files",
  "scripts/verify-attempt-outputs.mjs":
    "counts the attempt output foundation, whose exact list attempt-foundation-evidence.mjs already pins",
  "scripts/verify-attempt-outputs-package.mjs":
    "counts the attempt output foundation, whose exact list attempt-foundation-evidence.mjs already pins",
  "scripts/verify-consumer-impact-package.mjs":
    "counts the consumer impact foundation, whose exact list consumer-foundation-evidence.mjs already pins",
  "scripts/verify-context-runtime-proof-ci.mjs":
    "counts the context-runtime-proof profile",
  "scripts/verify-jvm-java-warning-package.mjs":
    "runs one callback it names itself, not manifest rows",
  "scripts/verify-pyright-package.mjs": "counts the pyright profile",
};
const manifestReads =
  /required-native-tests\.json|verify-required-native-tests\.mjs|verify-consumer-witness-profile\.mjs|runRequiredTests|runRequiredProfiles/u;
const exactRowRules = [
  /\.(?:required|passed),\s*[1-9]\d*\s*[,)]/u,
  /\b(?:required|passed)\s*===\s*[1-9]\d*/u,
  /(?:\]|\brequirements)\.length(?:\s*===\s*|,\s*)[1-9]\d*/u,
  /\brequirements\.length,\s*[A-Za-z_$][\w$]*\.length/u,
  /\b(?:deepEqual|exactUnion)\(\s*(?:\w+\(\s*)?(?:requirements|profiles|inventory|rows|definitions|allSource)\b/u,
];
async function discoverRowSelectors(root: string) {
  const found: string[] = [];
  for (const name of (await readdir(path.join(root, "scripts"))).sort()) {
    if (!name.endsWith(".mjs") || name === "audit-gate-inventory.mjs") continue;
    const text = await readFile(path.join(root, "scripts", name), "utf8");
    if (
      (manifestReads.test(text) || /selection|runtime-evidence/u.test(name)) &&
      exactRowRules.some((rule) => rule.test(text))
    )
      found.push("scripts/" + name);
  }
  return found;
}
test("finite inventory admission models every controller that selects manifest rows by an exact rule", async (t) => {
  const shape = admission((await audit(await source(t))).stdout);
  const modelled = new Set([
    ...Object.values(controllerSelectors).map((row) => row.controller),
    ...shape.companionCohorts.map((row) => row.controller),
    ...shape.rowCountControllers.map((row) => row.controller),
  ]);
  const unmodelled = (found: string[]) =>
    found.filter(
      (name) => !modelled.has(name) && !(name in unmodelledRowSelectors),
    );
  const found = await discoverRowSelectors(repository);
  assert.deepEqual(unmodelled(found), []);
  // The discovery reaches every modelled controller, and no listed exception
  // is stale.
  assert.deepEqual(
    [...modelled].filter((name) => !found.includes(name)),
    [],
  );
  assert.deepEqual(
    Object.keys(unmodelledRowSelectors).filter((name) => !found.includes(name)),
    [],
  );
  const names = (await readdir(path.join(repository, "scripts"))).filter(
    (name) => name.endsWith(".mjs"),
  );
  const copy = await fixture(
    t,
    Object.fromEntries(
      await Promise.all(
        names.map(async (name) => [
          "scripts/" + name,
          await readScript("scripts/" + name),
        ]),
      ),
    ),
  );
  for (const [name, body] of [
    [
      "verify-zig-extensions-container.mjs",
      'const source = JSON.parse(run(["node", "scripts/verify-required-native-tests.mjs", "zig-extensions"]));\nassert.equal(source.required, 9);\n',
    ],
    [
      "verify-nim-extensions-container.mjs",
      'const source = JSON.parse(run(["node", "scripts/verify-required-native-tests.mjs", "nim-extensions"]));\nassert.equal(source.required, 9, "incomplete Nim profile");\n',
    ],
    [
      "zig-runtime-evidence.mjs",
      'export function selectZig(profiles, frozen) {\n  assert.deepEqual(\n    profiles["zig-extensions"],\n    frozen,\n  );\n}\n',
    ],
  ] as const) {
    await writeFile(path.join(copy, "scripts", name), body);
    assert.deepEqual(
      unmodelled(await discoverRowSelectors(copy)),
      ["scripts/" + name],
      name,
    );
    await writeFile(path.join(copy, "scripts", name), "export {};\n");
  }
});
