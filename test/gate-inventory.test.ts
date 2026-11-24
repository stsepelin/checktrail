import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  "scripts/ci-full-suite-profiles.json",
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
// The full-suite shard inventory is the set of test sources; empty
// placeholders carry their names into each fixture.
const testSourceNames = async () =>
  (await readdir(path.join(repository, "test")))
    .filter((name) => name.endsWith(".test.ts"))
    .sort();
async function source(t: TestContext) {
  return fixture(t, {
    ...Object.fromEntries(
      await Promise.all(
        files.map(async (file) => [
          file,
          await readFile(path.join(repository, file), "utf8"),
        ]),
      ),
    ),
    ...Object.fromEntries(
      (await testSourceNames()).map((name) => ["test/" + name, ""]),
    ),
  });
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
// ci-full-suite-shards.mjs admits every profile in its list before any shard
// runs, so refusing one listed profile refuses each selected profile listed.
const fullSuiteRefusals = async (except: string[] = []) =>
  (
    JSON.parse(await readFile(path.join(repository, files[3]!), "utf8")) as {
      profiles: string[];
    }
  ).profiles
    .filter(
      (profile) =>
        !except.includes(profile) &&
        admissionProfileIds({
          extensionProfiles: JSON.parse(
            readFileSync(path.join(repository, files[0]!), "utf8"),
          ).extensionProfiles,
        }).includes(profile),
    )
    .map((profile) => ({
      profile,
      controller: "scripts/ci-full-suite-shards.mjs",
      reason: "companion-cohort-differs",
    }));
const byProfile = (rows: AdmissionRefusal[]) =>
  [...rows].sort((a, b) =>
    a.profile < b.profile ? -1 : a.profile > b.profile ? 1 : 0,
  );
const installedCount = (profile: string) => ({
  profile,
  controller: `test/gate-${profile}.test.ts`,
  reason: "installed-count-differs",
});

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
          installedCount("dotnet-generator-extensions"),
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
  absentNames?: string[];
  fileOrder?: string[];
  shards?: number;
  countedBy?: string;
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
    passedOnly?: boolean;
  }[];
  installedCountCallbacks: {
    controller: string;
    rows: number;
    profiles: string[];
    passedOnly?: boolean;
  }[];
  maxProfileRows: number;
  maxFileCharacters: number;
  maxNameBytes: number;
  installedHarness: { controller: string; profiles: string[]; files: string[] };
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
      // The installed lifecycle controller compares the batch receipt with the
      // sum of its profile lengths.
      for (const platform of platforms) {
        const batch = lifecycleFoundationSelection(platform).flatMap(
          (profile: string) => rows[profile]!,
        );
        assert.equal(new Set(batch.map(canonicalRow)).size, batch.length);
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
// A copy of the check a container applies to a runner batch over its cohort:
// the runner's own admission of each profile, then an exact count or a
// comparison with the sum of the profile lengths.
const cohortBatchAdmits = (entry: CompanionCohort, rows: RequiredNative) => {
  const lists = entry.cohort.map((owner) => rows[owner]);
  if (!lists.every((list) => runnable(list, entry.shards ? Infinity : 256)))
    return false;
  const all = lists.flat() as NativeCase[];
  const distinct = new Set(all.map(canonicalRow)).size;
  const shards = Array.from({ length: entry.shards ?? 0 }, (_, shard) =>
    all.filter((_row, index) => index % entry.shards! === shard),
  );
  const firsts = (entry.fileOrder ?? []).map((file) =>
    all.findIndex((row) => row.file === file),
  );
  const counted =
    entry.countedBy === undefined ||
    all.some((row) => row.name === entry.countedBy);
  return (
    (entry.rows === undefined || !counted || distinct === entry.rows) &&
    (!entry.disjoint || distinct === all.length) &&
    !all.some((row) => entry.absentNames?.includes(row.name)) &&
    (!entry.files || all.every((row) => entry.files!.includes(row.file))) &&
    shards.every((shard) => shard.length > 0 && shard.length <= 256) &&
    firsts.every(
      (at, index) => at >= 0 && (index === 0 || at > firsts[index - 1]!),
    )
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

// A literal count asserted on a native receipt, zero included. Fixture reports
// count their own `tests`, and the Java warning policy receipt counts the one
// callback its package check names itself; neither comes from a manifest
// profile.
const assertedCount =
  /(?<!\btests[!?]?|WarningPolicy\.acceptance)\.(?:required|passed)(?:,\s*|\s*===\s*)(\d+)\s*[,)]|\brequirements\.length,\s*([1-9]\d*)\s*[,)]/u;
const countAnchors: Record<string, Record<string, string>> = {
  "test/review-context-limits.test.ts": {
    "review-context-limits":
      "expanded context original controls execute against a fresh offline installed runtime",
  },
  "scripts/verify-tasks-runtime-arm64.mjs": {
    "confidence-provenance": "confidenceProvenance.installedEvidence.profile,",
    "lifecycle-platforms":
      "for (const evidence of [lifecycleSource, lifecycleInstalled.evidence])",
  },
};
// Every count asserted in the block that checks a profile's receipts. The block
// runs from where the controller runs the profile, or from the profile's
// anchor, to the next runner batch or anchor, so each later receipt check in
// the block must agree as well as the first.
function pinnedBlock(text: string, controller: string, profile: string) {
  const anchors = Object.values(countAnchors[controller] ?? {});
  const at =
    countAnchors[controller]?.[profile] !== undefined
      ? text.indexOf(countAnchors[controller][profile])
      : (runnerBatches(text).find((batch) => batch.profiles.includes(profile))
          ?.at ??
        [
          "verify-consumer-witness-profile.mjs " + profile,
          profile,
          JSON.stringify(profile.replace(/^mutation-/u, "")),
        ]
          .map((anchor) => text.indexOf(anchor))
          .find((index) => index >= 0) ??
        -1);
  assert.ok(at >= 0, controller + " never names " + profile);
  const end = Math.min(
    ...[
      ...runnerBatches(text).map((batch) => batch.at),
      ...anchors.map((anchor) => text.indexOf(anchor)),
    ].filter((index) => index > at),
    text.length,
  );
  return text.slice(at, end);
}
const pinnedCounts = (text: string, controller: string, profile: string) =>
  [
    ...pinnedBlock(text, controller, profile).matchAll(
      new RegExp(assertedCount.source, "gu"),
    ),
  ].map((match) => Number(match[1] ?? match[2]));
// Whether a block checks the receipt's required count, not only its passes.
const checksRequired = (block: string) =>
  /(?<!\btests[!?]?)\.required(?:,\s*|\s*===\s*)\d+\s*[,)]|\brequirements\.length,\s*[1-9]/u.test(
    block,
  );
// Runner batches a controller starts, read from its source: the profiles
// passed to verify-required-native-tests.mjs as array items, a spread of a
// declared array, or shell words.
function runnerBatches(text: string) {
  const batches: { at: number; profiles: string[]; unresolved?: string }[] = [];
  for (const match of text.matchAll(/verify-required-native-tests\.mjs/gu)) {
    const rest = text.slice(match.index + match[0].length);
    const profiles: string[] = [];
    let unresolved: string | undefined;
    if (rest.startsWith('"')) {
      const items = /^"((?:\s*,\s*(?:"[a-z0-9-]+"|\.\.\.\w+))*)/u.exec(
        rest,
      )![1]!;
      for (const item of items.matchAll(/"([a-z0-9-]+)"|\.\.\.(\w+)/gu)) {
        if (item[1]) profiles.push(item[1]);
        else {
          const declared = new RegExp(
            "\\b" + item[2] + "\\s*=\\s*\\[([^\\]]*)\\]",
            "u",
          ).exec(text);
          if (!declared) {
            unresolved = item[2];
            continue;
          }
          profiles.push(
            ...[...declared[1]!.matchAll(/"([a-z0-9-]+)"/gu)].map((x) => x[1]!),
          );
        }
      }
    } else {
      const words = /^((?: [a-z0-9][a-z0-9-]*)+)/u.exec(rest);
      if (words) profiles.push(...words[1]!.trim().split(" "));
    }
    if (profiles.length > 0 || unresolved)
      batches.push({
        at: match.index,
        profiles,
        ...(unresolved ? { unresolved } : {}),
      });
  }
  return batches;
}
const attributedProfiles = (report: Admission) => {
  const attributed: Record<string, string[]> = {};
  for (const row of [
    ...report.companionCohorts,
    ...report.rowCountControllers.flatMap((entry) =>
      entry.profiles.map((profile) => ({
        profile,
        controller: entry.controller,
      })),
    ),
    ...Object.entries(controllerSelectors).map(([profile, entry]) => ({
      profile,
      controller: entry.controller,
    })),
  ])
    if (!(row.controller in attributed)) attributed[row.controller] = [];
  for (const row of report.companionCohorts)
    attributed[row.controller]!.push(row.profile);
  for (const entry of report.rowCountControllers)
    if (attributed[entry.controller]!.length === 0)
      attributed[entry.controller]!.push(...entry.profiles);
  return Object.fromEntries(
    Object.entries(attributed).map(([controller, profiles]) => [
      controller,
      [...new Set(profiles)],
    ]),
  );
};
interface BatchCohort {
  profile: string;
  controller: string;
  cohort: string[];
  rows?: number;
  disjoint?: boolean;
}
const batchRule = (row: BatchCohort) =>
  JSON.stringify([
    row.profile,
    row.controller,
    [...row.cohort].sort(),
    row.rows ?? null,
    row.disjoint ?? false,
  ]);
// Every batch of other profiles a controller of a selected profile runs, with
// the check it applies to the batch receipt: an exact count, a comparison with
// the sum of the profile lengths, or only the runner's own admission.
// A controller whose batches name no selected profile, such as one that runs
// them from a command template, serves the profiles `attributed` gives it.
async function deriveBatchCohorts(
  root: string,
  admitted: string[],
  attributed: Record<string, string[]>,
) {
  const sources = [
    ...(await readdir(path.join(root, "scripts")))
      .filter((name) => name.endsWith(".mjs"))
      .map((name) => "scripts/" + name),
    ".github/workflows/ci.yml",
  ];
  const found: BatchCohort[] = [];
  for (const controller of sources) {
    const text = await readFile(path.join(root, controller), "utf8").catch(
      () => "",
    );
    const batches = runnerBatches(text);
    const named = /^scripts\/verify-([a-z0-9-]+)-container\.mjs$/u.exec(
      controller,
    )?.[1];
    const unread = batches.find((batch) => batch.unresolved);
    batches.forEach((batch, index) => {
      const derived = controller.endsWith(".yml")
        ? batch.profiles.filter((p) => admitted.includes(p))
        : [
            ...new Set([
              ...batches.flatMap((row) =>
                row.profiles.filter((p) => admitted.includes(p)),
              ),
              ...(named && admitted.includes(named) ? [named] : []),
            ]),
          ];
      // A workflow step names its selected profiles in each batch.
      const served =
        derived.length > 0 || controller.endsWith(".yml")
          ? derived
          : (attributed[controller] ?? []);
      if (served.length > 0)
        assert.equal(unread?.unresolved, undefined, controller);
      if (served.length === 0) return;
      const window = text.slice(
        batch.at,
        batches[index + 1]?.at ?? batch.at + 1500,
      );
      // Every count asserted on the batch receipt, which the first assertion
      // names, must agree; conflicting literals mark the rule unreadable.
      const asserted = [
        ...window.matchAll(
          /([\w.]+)\.(?:required|passed),\s*([\s\S]*?)\)\s*;/gu,
        ),
      ];
      const checks = asserted
        .filter((match) => match[1] === asserted[0]?.[1])
        .map((match) => match[2]!);
      const literals = new Set(
        checks
          .filter((check) => /^\s*\d+\s*$/u.test(check))
          .map((check) => Number(check)),
      );
      const rule: { rows?: number; disjoint?: boolean } = {};
      if (literals.size > 0)
        rule.rows = literals.size === 1 ? [...literals][0]! : -1;
      else if (
        checks.some(
          (check) => /\.length/u.test(check) && /\+|reduce\(/u.test(check),
        )
      )
        rule.disjoint = true;
      for (const profile of served) {
        // A batch validates every profile before running any, so the other
        // profiles in it are this profile's cohort.
        const cohort = batch.profiles.filter((p) => p !== profile);
        if (cohort.length > 0 && cohort.length === batch.profiles.length - 1)
          found.push({ profile, controller, cohort, ...rule });
        else if (!batch.profiles.includes(profile) && batch.profiles.length > 0)
          found.push({ profile, controller, cohort: batch.profiles, ...rule });
      }
    });
  }
  return found;
}
// The test files a package check copies into its fresh consumer.
function copiedTestFiles(text: string) {
  const start = text.indexOf('await mkdir(path.join(consumer, "dist/test")');
  assert.ok(start >= 0);
  const list = /for \(const file of \[([^\]]*)\]\)/u.exec(text.slice(start));
  assert.ok(list);
  return [...list[1]!.matchAll(/"([a-z0-9-]+\.test\.js)"/gu)].map(
    (match) => "dist/test/" + match[1],
  );
}
// The acceptance files verify-import-context-package.mjs copies into its fresh
// consumer, and the selected profiles some controller installs through it.
async function deriveInstalledHarness(root: string, admitted: string[]) {
  const controller = "scripts/verify-import-context-package.mjs";
  const text = await readFile(path.join(root, controller), "utf8");
  const files = copiedTestFiles(text);
  const profiles = new Set<string>();
  for (const directory of ["scripts", "test"])
    for (const name of (await readdir(path.join(root, directory))).filter(
      (file) => /\.(?:mjs|ts)$/u.test(file),
    )) {
      const source = await readFile(path.join(root, directory, name), "utf8");
      for (const match of source.matchAll(
        /CHECKTRAIL_IMPORT_CONTEXT_PROFILE[:=] ?"?([a-z0-9-]+)/gu,
      ))
        if (admitted.includes(match[1]!)) profiles.add(match[1]!);
    }
  return { controller, profiles: [...profiles].sort(), files };
}
// The exact counts the selected acceptance files assert: inside the installed
// acceptance callback, or anywhere else, which the audit does not model.
async function deriveInstalledCounts(root: string) {
  const found: {
    controller: string;
    rows: number;
    profiles: string[];
    passedOnly?: boolean;
  }[] = [];
  const elsewhere: string[] = [];
  const counts = new RegExp(assertedCount.source, "gu");
  for (const name of (await readdir(path.join(root, "test"))).sort()) {
    const id = /^gate-([a-z0-9-]+)\.test\.ts$/u.exec(name)?.[1];
    if (!id || id === "inventory") continue;
    const text = await readFile(path.join(root, "test", name), "utf8");
    const declared = /^test\(\s*(["'`])[^"'`]*installed acceptance\1/mu.exec(
      text,
    );
    const end = declared
      ? ([...text.matchAll(/^test\(/gmu)].find((m) => m.index > declared.index)
          ?.index ?? text.length)
      : -1;
    const inside: number[] = [];
    for (const match of text.matchAll(counts)) {
      if (declared && match.index > declared.index && match.index < end)
        inside.push(Number(match[1] ?? match[2]));
      else elsewhere.push("test/" + name);
    }
    if (inside.length === 0) continue;
    assert.equal(new Set(inside).size, 1, name);
    found.push({
      controller: "test/" + name,
      rows: inside[0]!,
      profiles:
        id === "mutation-runners"
          ? mutationFamilies.map((family) => "mutation-" + family)
          : [id],
      ...(checksRequired(text.slice(declared!.index, end))
        ? {}
        : { passedOnly: true }),
    });
  }
  return { found, elsewhere };
}

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
  const lifecyclePackage = await readScript(
    "scripts/verify-lifecycle-platforms-package.mjs",
  );
  for (const text of [
    "const foundationRequired = foundationProfiles.reduce(",
    "(total, profile) => total + definitions[profile].length,",
    "assert.equal(evidence.foundation.required, foundationRequired);",
  ])
    assert.equal(lifecyclePackage.split(text).length, 2, text);
  const lifecycle = await scriptModule("lifecycle-runtime-evidence.mjs");
  const foundations = report.companionCohorts.filter(
    (row) => row.controller === "scripts/verify-lifecycle-platforms.mjs",
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
  // One controller checks confidence-provenance and lifecycle-platforms
  // receipts in separate blocks. Moving the lifecycle counts into the other
  // block, or lowering them, leaves a 9 elsewhere in the file but not in the
  // lifecycle block.
  const arm64 = "scripts/verify-tasks-runtime-arm64.mjs";
  const original = await readScript(arm64);
  const lifecycleAt = original.indexOf(
    countAnchors[arm64]!["lifecycle-platforms"]!,
  );
  const counts =
    "      assert.equal(evidence.required, 9);\n      assert.equal(evidence.passed, 9);\n";
  assert.equal(original.slice(lifecycleAt).split(counts).length, 2);
  const lowered =
    original.slice(0, lifecycleAt) +
    original.slice(lifecycleAt).replace(counts, counts.replaceAll("9", "8"));
  const moved =
    original.slice(0, lifecycleAt).replace(counts, counts + counts) +
    original.slice(lifecycleAt).replace(counts, "");
  for (const [label, text] of [
    ["lowered", lowered],
    ["moved", moved],
  ] as const) {
    assert.notEqual(text, original, label);
    assert.match(text, /evidence\.required, 9\)/u, label);
    assert.ok(
      pinnedCounts(text, arm64, "confidence-provenance").every((n) => n === 9),
      label,
    );
    const lifecycle = pinnedCounts(text, arm64, "lifecycle-platforms");
    assert.ok(lifecycle.length === 0 || lifecycle.some((n) => n !== 9), label);
  }
  // A zero is a count that conflicts with nine, not an absent one.
  const kotlin = "scripts/verify-kotlin-extensions-container.mjs";
  const kotlinText = await readScript(kotlin);
  const zeroed = kotlinText.replace(
    "installed.profile.passed, 9);",
    "installed.profile.passed, 0);",
  );
  assert.notEqual(zeroed, kotlinText);
  assert.deepEqual(
    [...new Set(pinnedCounts(zeroed, kotlin, "kotlin-extensions"))],
    [9, 0],
  );
  // A later receipt in the same block counts as much as the first.
  const vue = "scripts/verify-vue-router-assembly-container.mjs";
  const vueText = await readScript(vue);
  assert.deepEqual(pinnedCounts(vueText, vue, "assembly-vue-router"), [9, 9]);
  const installedLowered = vueText.replace(
    "installed.profile.passed, 9);",
    "installed.profile.passed, 8);",
  );
  assert.notEqual(installedLowered, vueText);
  assert.deepEqual(
    pinnedCounts(installedLowered, vue, "assembly-vue-router"),
    [9, 8],
  );
  for (const entry of report.rowCountControllers) {
    const text = await readScript(entry.controller);
    for (const profile of entry.profiles) {
      assert.deepEqual(
        [...new Set(pinnedCounts(text, entry.controller, profile))],
        [entry.rows],
        entry.controller + " " + profile,
      );
      assert.equal(
        entry.passedOnly ?? false,
        !checksRequired(pinnedBlock(text, entry.controller, profile)),
        entry.controller + " " + profile,
      );
    }
  }
  const admitted = admissionProfileIds(await readScope());
  const derived = await deriveBatchCohorts(
    repository,
    admitted,
    attributedProfiles(report),
  );
  const batchControllers = new Set(derived.map((row) => row.controller));
  assert.deepEqual(
    report.companionCohorts
      .filter((row) => batchControllers.has(row.controller))
      .map(batchRule)
      .sort(),
    derived.map(batchRule).sort(),
  );
  for (const entry of report.companionCohorts)
    for (const name of entry.absentNames ?? [])
      assert.equal(
        (await readScript(entry.controller)).split(JSON.stringify(name)).length,
        2,
        entry.controller + " " + name,
      );
  const ruby = await readScript("scripts/verify-ruby-tools-baseline.mjs");
  for (const text of [
    ')["ruby-tools"];',
    '(_, i) => shard === "all" || i % 3 === Number(shard) - 1,',
    "assert.ok(selected.length > 0);",
  ])
    assert.equal(ruby.split(text).length, 2, text);
  assert.deepEqual(
    report.companionCohorts.find((row) => row.cohort.includes("ruby-tools")),
    {
      profile: "ruby-extensions",
      controller: "scripts/verify-ruby-tools-baseline.mjs",
      cohort: ["ruby-tools"],
      shards: 3,
    },
  );
  // The preserved Ruby tools rows keep each of the baseline's three shards
  // nonempty, so the audit checks only their uniqueness.
  assert.ok(
    (
      JSON.parse(
        await readFile(path.join(repository, files[1]!), "utf8"),
      ) as RequiredNative
    )["ruby-tools"]!.length >= 3,
  );
  for (const entry of report.companionCohorts.filter(
    (row) => row.files && row.controller.endsWith("-package.mjs"),
  )) {
    const text = await readScript(entry.controller);
    assert.equal(
      text.split(`const profile = ${JSON.stringify(entry.cohort[0])};`).length,
      2,
      entry.controller,
    );
    assert.deepEqual(
      [...entry.files!].sort(),
      copiedTestFiles(text).sort(),
      entry.controller,
    );
  }
  // The files that produce a controller's expected unrequired callbacks, in the
  // order the controller lists those callbacks.
  const sources = await readdir(path.join(repository, "test"));
  for (const entry of report.companionCohorts.filter((row) => row.fileOrder)) {
    const owners: string[] = [];
    for (const name of entry.absentNames!) {
      const owner: string[] = [];
      for (const file of sources.filter((file) => file.endsWith(".test.ts")))
        if ((await readScript("test/" + file)).includes(JSON.stringify(name)))
          owner.push("dist/test/" + file.replace(/\.ts$/u, ".js"));
      assert.equal(owner.length, 1, name);
      if (!owners.includes(owner[0]!)) owners.push(owner[0]!);
    }
    assert.deepEqual(entry.fileOrder, owners, entry.controller);
  }
  for (const entry of report.companionCohorts.filter(
    (row) => row.controller.startsWith("test/") && row.rows !== undefined,
  ))
    assert.deepEqual(
      [
        ...new Set(
          pinnedCounts(
            await readScript(entry.controller),
            entry.controller,
            entry.cohort[0]!,
          ),
        ),
      ],
      [entry.rows],
      entry.controller,
    );
  const laravelCache = (
    await scriptModule("laravel-cache-runtime-evidence.mjs")
  ).laravelCacheHarnessFiles as string[];
  assert.deepEqual(
    report.companionCohorts.find((row) => row.cohort.includes("laravel-cache"))!
      .files,
    laravelCache.filter((file) =>
      /^dist\/test\/[a-z0-9-]+\.test\.js$/u.test(file),
    ),
  );
  assert.equal(
    (await readScript("scripts/verify-laravel-cache.mjs")).split(
      "laravelCacheHarnessFiles.includes(row.file),",
    ).length,
    2,
  );
  const contextLimits = report.companionCohorts.filter(
    (row) => row.controller === "test/review-context-limits.test.ts",
  );
  assert.equal(contextLimits.length, 2);
  for (const row of contextLimits) {
    assert.deepEqual(row.files, report.installedHarness.files);
    assert.match(
      await readScript("test/review-context-limits.test.ts"),
      new RegExp('^test\\(\\s*"' + row.countedBy + '"', "mu"),
    );
  }
  const suiteSelector = await readScript("scripts/ci-full-suite-shards.mjs");
  for (const text of [
    "Array.isArray(rows) && rows.length > 0 && rows.length <= 256,",
    'assert.ok(!unique.has(key), "Duplicate required callback");',
  ])
    assert.equal(suiteSelector.split(text).length, 2, text);
  const suiteList = (
    JSON.parse(await readFile(path.join(repository, files[3]!), "utf8")) as {
      profiles: string[];
    }
  ).profiles;
  assert.deepEqual(
    report.companionCohorts
      .filter((row) => row.controller === "scripts/ci-full-suite-shards.mjs")
      .map((row) => [row.profile, row.cohort]),
    admitted
      .filter((profile) => suiteList.includes(profile))
      .map((profile) => [
        profile,
        suiteList.filter((other) => other !== profile),
      ]),
  );
  const harness = await deriveInstalledHarness(repository, admitted);
  assert.equal(report.installedHarness.controller, harness.controller);
  assert.deepEqual(
    [...report.installedHarness.profiles].sort(),
    harness.profiles,
  );
  assert.deepEqual(
    [...report.installedHarness.files].sort(),
    [...harness.files].sort(),
  );
  assert.deepEqual(
    report.installedCountCallbacks.map((row) => JSON.stringify(row)).sort(),
    (await deriveInstalledCounts(repository)).found
      .map((row) => JSON.stringify(row))
      .sort(),
  );
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
  // Terraform installs only its harness files, so an unlisted long file name
  // there is also an installed-harness refusal. The Go workflow batch has no
  // file list, only the runner's own admission.
  const longName =
    (profile: string, bytes: number) => (rows: RequiredNative) => {
      rows[profile]!.push({
        file: "dist/test/" + "t".repeat(bytes - 8) + ".test.js",
        name: profile + " long address 7019",
      });
      assert.equal(path.basename(rows[profile]!.at(-1)!.file).length, bytes);
    };
  const cases: [string, (rows: RequiredNative) => void, AdmissionRefusal[]][] =
    [
      ["256 rows", pad(256), []],
      ["257 rows", pad(257), limit("row-limit")],
      [
        "a 255-byte Go installed harness file name",
        longName("go-installed-harness", 255),
        [],
      ],
      [
        "a 256-byte Go installed harness file name",
        longName("go-installed-harness", 256),
        ["go-extensions", "host-session-readiness"].map((profile) => ({
          profile,
          controller: ".github/workflows/ci.yml",
          reason: "companion-cohort-differs",
        })),
      ],
      [
        "a 256-byte Terraform file name",
        longName("terraform-extensions", 256),
        [
          ...limit("address-limit"),
          {
            profile: "terraform-extensions",
            controller: "scripts/verify-import-context-package.mjs",
            reason: "installed-harness-differs",
          },
        ],
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
            installedCount(profile),
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
  const counted = (profile: string, ...controllers: string[]) => [
    ...controllers.map((controller) => ({
      profile,
      controller: "scripts/" + controller,
      reason: "row-count-differs",
    })),
    installedCount(profile),
  ];
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
  const suite = await fullSuiteRefusals();
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
        byProfile([
          companion("lifecycle-platforms", "verify-lifecycle-platforms.mjs"),
          ...suite,
        ]),
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
        "a posix-owner row also filed under posix-cleanup",
        (rows) => {
          rows["posix-cleanup"]!.push({ ...rows["posix-owner"]![2]! });
        },
        [companion("lifecycle-platforms", "verify-lifecycle-platforms.mjs")],
      ],
      [
        "a required C++ tools extra",
        (rows) => {
          rows["cpp-tools"]!.push({
            file: "dist/test/cpp-tools.test.js",
            name: "C/C++ planning is data only and rejects undeclared CMake commands and missing source scope",
          });
        },
        [companion("cpp-extensions", "verify-cpp-extensions-container.mjs")],
      ],
      [
        "a Ruby tools row repeated",
        (rows) => {
          rows["ruby-tools"]!.push({ ...rows["ruby-tools"]![5]! });
        },
        [companion("ruby-extensions", "verify-ruby-tools-baseline.mjs")],
      ],
      [
        "a lifecycle runtime bindings row repeated",
        (rows) => {
          rows["lifecycle-runtime-bindings"]!.push({
            ...rows["lifecycle-runtime-bindings"]![0]!,
          });
        },
        [
          companion(
            "independent-evaluation-protocol",
            "verify-tasks-runtime-arm64.mjs",
          ),
          companion("lifecycle-platforms", "verify-tasks-runtime-arm64.mjs"),
          companion(
            "native-license-provenance",
            "verify-tasks-runtime-arm64.mjs",
          ),
        ],
      ],
      [
        "a Terraform row in a file the installed harness omits",
        (rows) => {
          rows["terraform-extensions"]!.push({
            file: "dist/test/gate-inventory.test.js",
            name: "terraform-extensions uninstalled row 5147",
          });
        },
        [
          {
            profile: "terraform-extensions",
            controller: "scripts/verify-import-context-package.mjs",
            reason: "installed-harness-differs",
          },
        ],
      ],
      [
        "a php-review row also filed under php-tools, a Terraform row in its surfaces file",
        (rows) => {
          rows["php-tools"]!.push({ ...rows["php-review"]![3]! });
          rows["terraform-extensions"]!.push({
            file: "dist/test/terraform-extensions-surfaces.test.js",
            name: "terraform-extensions installed harness row 5147",
          });
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
  // The Go workflow step validates its whole batch first, so a repeated row in
  // one selected profile also stops the other.
  const batched = await frozen(t);
  await alter<RequiredNative>(batched, files[2]!, (rows) => {
    rows["host-session-readiness"]!.push({
      ...rows["host-session-readiness"]![0]!,
    });
  });
  const refused = await audit(batched, true);
  assert.equal(refused.code, 2);
  assert.deepEqual(unresolvedAddresses(refused.stdout), [
    "host-session-readiness/broken",
  ]);
  assert.deepEqual(
    admissionRefusals(refused.stdout),
    byProfile([
      {
        profile: "go-extensions",
        controller: ".github/workflows/ci.yml",
        reason: "companion-cohort-differs",
      },
      {
        profile: "host-session-readiness",
        controller: genericRunner,
        reason: "duplicate-address",
      },
      installedCount("host-session-readiness"),
      ...(await fullSuiteRefusals(["host-session-readiness"])),
    ]),
  );
});

// The installed acceptance callback in a selected test file runs its whole
// profile from a fresh package and expects nine passes.
test("finite inventory strict freeze refuses an unselected row a selected installed callback's count rejects", async (t) => {
  const extra = (profile: string) => (rows: RequiredNative) => {
    rows[profile]!.push({
      file: `dist/test/gate-${profile}.test.js`,
      name: `${profile} unselected acceptance 4483`,
    });
  };
  const cases: [string, (rows: RequiredNative) => void, AdmissionRefusal[]][] =
    [
      [
        "an extra go-extensions row",
        extra("go-extensions"),
        [installedCount("go-extensions")],
      ],
      [
        "an extra host-session-readiness row",
        extra("host-session-readiness"),
        [installedCount("host-session-readiness")],
      ],
      [
        "go-extensions and host-session-readiness reordered",
        (rows) => {
          rows["go-extensions"]!.reverse();
          rows["host-session-readiness"]!.reverse();
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

test("finite inventory strict freeze refuses a baseline batch its controller's runner or sum check rejects", async (t) => {
  const batch = (profile: string, controller: string) => ({
    profile,
    controller,
    reason: "companion-cohort-differs",
  });
  const repeat = (profile: string, index: number) => (rows: RequiredNative) => {
    rows[profile]!.push({ ...rows[profile]![index]! });
  };
  const copy =
    (from: string, to: string, index: number) => (rows: RequiredNative) => {
      rows[to]!.push({ ...rows[from]![index]! });
    };
  const cases: [string, (rows: RequiredNative) => void, AdmissionRefusal[]][] =
    [
      [
        "a helm row repeated",
        repeat("helm", 3),
        [
          batch(
            "helm-extensions",
            "scripts/verify-helm-extensions-container.mjs",
          ),
          batch("helm-extensions", "scripts/verify-helm-package.mjs"),
        ],
      ],
      [
        "a go-installed-harness row repeated",
        repeat("go-installed-harness", 0),
        [
          batch("go-extensions", ".github/workflows/ci.yml"),
          batch("host-session-readiness", ".github/workflows/ci.yml"),
        ],
      ],
      [
        "a swift-tools row also filed under swift",
        copy("swift-tools", "swift", 1),
        [
          batch(
            "swift-extensions",
            "scripts/verify-swift-extensions-container.mjs",
          ),
        ],
      ],
      [
        "a kotlin row also filed under java",
        copy("kotlin", "java", 2),
        [
          batch(
            "kotlin-extensions",
            "scripts/verify-kotlin-extensions-container.mjs",
          ),
        ],
      ],
      [
        "a review-probe row also filed under review",
        copy("review-probe", "review", 0),
        [
          batch(
            "confidence-provenance",
            "scripts/verify-confidence-provenance.mjs",
          ),
        ],
      ],
      [
        "a kustomize row also filed under kubeconform",
        copy("kustomize", "kubeconform", 0),
        [
          batch(
            "kubernetes-extensions",
            "scripts/verify-kubernetes-extensions-container.mjs",
          ),
          batch(
            "kustomize-extensions",
            "scripts/verify-kustomize-extensions-container.mjs",
          ),
        ],
      ],
      [
        "a Go installed harness row filed under helm",
        copy("go-installed-harness", "helm", 0),
        [batch("helm-extensions", "scripts/verify-helm-package.mjs")],
      ],
      [
        "the terraform baseline reversed",
        (rows) => {
          rows.terraform!.reverse();
        },
        [
          batch(
            "terraform-extensions",
            "scripts/verify-terraform-extensions-container.mjs",
          ),
        ],
      ],
      [
        "an extra review-context-limits row",
        (rows) => {
          rows["review-context-limits"]!.push({
            file: rows["review-context-limits"]![0]!.file,
            name: "review-context-limits unselected row 3907",
          });
        },
        ["go-extensions", "host-session-readiness"].map((profile) =>
          batch(profile, "test/review-context-limits.test.ts"),
        ),
      ],
      [
        "a Ruby tools shard past the row limit",
        (rows) => {
          const list = rows["ruby-tools"]!;
          while (list.length < 769)
            list.push({
              file: list[0]!.file,
              name: "ruby-tools padded row " + (6091 + list.length),
            });
        },
        [batch("ruby-extensions", "scripts/verify-ruby-tools-baseline.mjs")],
      ],
      [
        "257 Ruby tools rows in three shards, terraform lifecycle rows swapped",
        (rows) => {
          const list = rows["ruby-tools"]!;
          while (list.length < 257)
            list.push({
              file: list[0]!.file,
              name: "ruby-tools padded row " + (6091 + list.length),
            });
          const terraform = rows.terraform!;
          [terraform[0], terraform[2]] = [terraform[2]!, terraform[0]!];
        },
        [],
      ],
      [
        "new distinct helm and kubeconform rows, swift reordered",
        (rows) => {
          rows.helm!.push({
            file: rows.helm![0]!.file,
            name: "helm baseline addition 2657",
          });
          rows.kubeconform!.push({
            file: rows.kubeconform![0]!.file,
            name: "kubeconform baseline addition 2657",
          });
          rows.swift!.reverse();
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

test("finite inventory strict freeze refuses a full-suite profile list its shard selector rejects", async (t) => {
  const selected = [
    "assembly-vue-router",
    "attempt-archives",
    "confidence-provenance",
    "consumer-impact",
    "context-go",
    "context-php",
    "context-python",
    "context-rust",
    "go-extensions",
    "host-session-readiness",
    "independent-evaluation-protocol",
    "multi-candidate-workflow",
    "tasks-matrix",
  ];
  const broken: [string, (list: string[]) => string[], string[]][] = [
    ["a profile named twice", (list) => [...list, "gate-inventory"], []],
    [
      "a native mutation cohort added",
      (list) => [...list, "mutation-jest"],
      ["mutation-jest"],
    ],
    [
      "an unknown profile added",
      (list) => [...list, "unknown-profile-4410"],
      [],
    ],
  ];
  for (const [label, edit, alsoBlocked] of broken) {
    const root = await frozen(t);
    await alter<{ profiles: string[] }>(root, files[3]!, (value) => {
      value.profiles = edit(value.profiles);
    });
    const result = await audit(root, true);
    assert.equal(result.code, 2, label + ": " + result.stderr);
    const admission = JSON.parse(result.stdout).controllerAdmission;
    assert.equal(admission.fullSuiteListAdmitted, false, label);
    assert.deepEqual(
      [...admission.fullSuiteBlockedProfiles].sort(),
      [...selected, ...alsoBlocked].sort(),
      label,
    );
  }
  for (const [label, list] of [
    ["only a native mutation cohort", ["mutation-jest"]],
    ["an empty list", []],
  ] as const) {
    const root = await frozen(t);
    await alter<{ profiles: string[] }>(root, files[3]!, (value) => {
      value.profiles = [...list];
    });
    const result = await audit(root, true);
    assert.equal(result.code, 2, label + ": " + result.stderr);
    assert.equal(
      JSON.parse(result.stdout).controllerAdmission.fullSuiteListAdmitted,
      false,
      label,
    );
  }
  const outside = await frozen(t);
  await alter<RequiredNative>(outside, files[2]!, (rows) => {
    rows["gate-inventory"]!.push({
      file: "dist/test/absent-from-the-suite-4410.test.js",
      name: "a callback in a file the shard inventory lacks 4410",
    });
  });
  const outsideResult = await audit(outside, true);
  assert.equal(outsideResult.code, 2, outsideResult.stderr);
  assert.deepEqual(
    JSON.parse(outsideResult.stdout).controllerAdmission.fullSuiteListProblems,
    ["file-outside-test-inventory:gate-inventory"],
  );
  for (const [label, place] of [
    [
      "a test source replaced by a directory",
      async (root: string) => {
        await rm(path.join(root, "test/gate-inventory.test.ts"));
        await mkdir(path.join(root, "test/gate-inventory.test.ts"));
      },
    ],
    [
      "a test source replaced by a symlink",
      async (root: string) => {
        await rm(path.join(root, "test/gate-inventory.test.ts"));
        await writeFile(path.join(root, "linked-source-6620.ts"), "");
        await symlink(
          path.join(root, "linked-source-6620.ts"),
          path.join(root, "test/gate-inventory.test.ts"),
        );
      },
    ],
    [
      "a test source the shard's file-name rule rejects",
      async (root: string) => {
        await writeFile(path.join(root, "test/Extra.test.ts"), "");
      },
    ],
    [
      "more test sources than the shards can partition",
      async (root: string) => {
        const present = (await readdir(path.join(root, "test"))).length;
        await Promise.all(
          Array.from({ length: 4097 - present }, (_, index) =>
            writeFile(
              path.join(root, "test", "padding-6620-" + index + ".test.ts"),
              "",
            ),
          ),
        );
      },
    ],
    [
      "the test directory replaced by a symlink",
      async (root: string) => {
        await rename(
          path.join(root, "test"),
          path.join(root, "real-tests-6620"),
        );
        await symlink(
          path.join(root, "real-tests-6620"),
          path.join(root, "test"),
        );
      },
    ],
  ] as const) {
    const root = await frozen(t);
    await place(root);
    const result = await audit(root, true);
    assert.equal(result.code, 2, label + ": " + result.stderr);
    assert.equal(
      JSON.parse(result.stdout).controllerAdmission.fullSuiteListAdmitted,
      false,
      label,
    );
  }
  const named = await frozen(t);
  await writeFile(path.join(named, "test/extra-6620.test.ts"), "");
  const namedResult = await audit(named, true);
  assert.equal(namedResult.code, 0, namedResult.stderr);
  const shardSource = await readFile(
    path.join(repository, "scripts/ci-full-suite-shards.mjs"),
    "utf8",
  );
  const auditSource = await readFile(script, "utf8");
  const pattern = (text: string) =>
    /const (?:fullSuiteFilePattern|filePattern) = (\/[^\n]+\/u);/u.exec(
      text,
    )![1];
  assert.equal(pattern(auditSource), pattern(shardSource));
  const empty = await frozen(t);
  await alter<{ profiles: string[] }>(empty, files[3]!, (value) => {
    value.profiles = [];
  });
  const emptied = await audit(empty, true);
  assert.equal(emptied.code, 2, emptied.stderr);
  assert.equal(
    JSON.parse(emptied.stdout).controllerAdmission.fullSuiteListAdmitted,
    false,
  );
  const root = await frozen(t);
  await alter<{ profiles: string[] }>(root, files[3]!, (value) => {
    value.profiles = [...value.profiles].reverse();
  });
  const reordered = await audit(root, true);
  assert.equal(reordered.code, 0, reordered.stderr);
  assert.deepEqual(
    JSON.parse(reordered.stdout).controllerAdmission.refusals,
    [],
  );
  assert.equal(
    JSON.parse(reordered.stdout).controllerAdmission.fullSuiteListAdmitted,
    true,
  );
});

test("finite inventory full-suite list admission agrees with the real shard selector", async (t) => {
  const { selectFullSuiteRequirements } = (await import(
    path.join(repository, "scripts/ci-full-suite-shards.mjs")
  )) as {
    selectFullSuiteRequirements: (
      profiles: RequiredNative,
      selection: string[],
      inventory: { file: string }[],
      assignedFiles: string[],
    ) => unknown;
  };
  const names = (await testSourceNames()).map((name) =>
    name.replace(/\.ts$/u, ".js"),
  );
  const variants: [string, (list: string[]) => string[], boolean][] = [
    ["as written", (list) => list, true],
    ["reordered", (list) => [...list].reverse(), true],
    ["empty", () => [], false],
    ["a profile named twice", (list) => [...list, list[0]!], false],
    ["a native mutation cohort", (list) => [...list, "mutation-jest"], false],
    ["an unknown profile", (list) => [...list, "unknown-profile-4410"], false],
  ];
  for (const [label, edit, expected] of variants) {
    const root = await frozen(t);
    let selection: string[] = [];
    await alter<{ profiles: string[] }>(root, files[3]!, (value) => {
      value.profiles = selection = edit(value.profiles);
    });
    const manifest = JSON.parse(
      await readFile(path.join(root, files[2]!), "utf8"),
    ) as RequiredNative;
    let admitted = true;
    try {
      selectFullSuiteRequirements(
        manifest,
        selection,
        names.map((file) => ({ file })),
        names,
      );
    } catch {
      admitted = false;
    }
    assert.equal(admitted, expected, label + " (real selector)");
    const result = await audit(root, true);
    assert.equal(
      JSON.parse(result.stdout).controllerAdmission.fullSuiteListAdmitted,
      admitted,
      label,
    );
  }
});

test("finite inventory strict freeze refuses rows a cache, installed context or full-suite controller cannot run", async (t) => {
  const helmLifecycle = {
    file: "dist/test/helm-lifecycle.test.js",
    name: "helm lifecycle row in another harness 7781",
  };
  const counting =
    "expanded context original controls execute against a fresh offline installed runtime";
  const goBatch = ["go-extensions", "host-session-readiness"].map(
    (profile) => ({
      profile,
      controller: "test/review-context-limits.test.ts",
      reason: "companion-cohort-differs",
    }),
  );
  const cases: [
    string,
    (rows: RequiredNative) => void,
    AdmissionRefusal[],
    string[],
  ][] = [
    [
      "a laravel-cache row replaced by a Helm lifecycle row",
      (rows) => {
        rows["laravel-cache"]![0] = { ...helmLifecycle };
      },
      [
        {
          profile: "assembly-laravel",
          controller: "scripts/laravel-cache-runtime-evidence.mjs",
          reason: "companion-cohort-differs",
        },
      ],
      [],
    ],
    [
      "a review-context-limits row replaced by a Helm lifecycle row",
      (rows) => {
        rows["review-context-limits"]![0] = { ...helmLifecycle };
      },
      goBatch,
      [],
    ],
    [
      "a review-context-limits row removed while its counting callback stays",
      (rows) => {
        rows["review-context-limits"]!.splice(1, 1);
      },
      goBatch,
      [],
    ],
    [
      "the counting review-context-limits callback removed",
      (rows) => {
        rows["review-context-limits"] = rows["review-context-limits"]!.filter(
          (row) => row.name !== counting,
        );
        assert.equal(rows["review-context-limits"].length, 8);
      },
      [],
      [],
    ],
    [
      "a core row repeated",
      (rows) => {
        rows.core!.push({ ...rows.core![2]! });
      },
      byProfile(await fullSuiteRefusals()),
      [],
    ],
    // These containers check only passes, so a missing Nuxt row is the
    // unresolved binding alone.
    [
      "an assembly-nuxt row removed",
      (rows) => {
        rows["assembly-nuxt"]!.pop();
      },
      [],
      ["assembly-nuxt/installed"],
    ],
  ];
  for (const [label, edit, expected, unresolved] of cases) {
    const root = await frozen(t);
    await alter<RequiredNative>(root, files[2]!, edit);
    const result = await audit(root, true);
    assert.equal(
      result.code,
      expected.length || unresolved.length ? 2 : 0,
      label,
    );
    assert.deepEqual(unresolvedAddresses(result.stdout), unresolved, label);
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
  const batchControllers = new Set(
    (
      await deriveBatchCohorts(
        repository,
        admissionProfileIds(scope),
        attributedProfiles(shape),
      )
    ).map((row) => row.controller),
  );
  const counted = [
    ...new Set(
      [...shape.rowCountControllers, ...shape.installedCountCallbacks].flatMap(
        (row) => row.profiles,
      ),
    ),
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
          entry.controller in foundationSelectors ||
            batchControllers.has(entry.controller) ||
            entry.rows !== undefined ||
            entry.files !== undefined ||
            entry.cohort.includes("ruby-tools") ||
            entry.controller === "scripts/ci-full-suite-shards.mjs",
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
            : !cohortBatchAdmits(entry, rows),
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
          entry.passedOnly
            ? rows[profile]!.length > entry.rows
            : rows[profile]!.length !== entry.rows,
      })),
    ),
    ...shape.installedHarness.profiles.map((profile) => ({
      rule: shape.installedHarness.controller,
      profile,
      controller: shape.installedHarness.controller,
      reasons: ["installed-harness-differs"],
      refuses: async (_root: string, rows: RequiredNative) =>
        rows[profile]!.some(
          (row) => !shape.installedHarness.files.includes(row.file),
        ),
    })),
    ...shape.installedCountCallbacks.flatMap((entry) =>
      entry.profiles.map((profile) => ({
        rule: entry.controller,
        profile,
        controller: entry.controller,
        reasons: ["installed-count-differs"],
        refuses: async (_root: string, rows: RequiredNative) =>
          entry.passedOnly
            ? rows[profile]!.length > entry.rows
            : rows[profile]!.length !== entry.rows,
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
      "companion cohort rows repeated",
      (rows) => {
        for (const id of cohortProfiles) rows[id]!.push({ ...rows[id]![0]! });
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
    ...[257, 769].map(
      (size) =>
        [
          `Ruby tools baseline of ${size} rows`,
          (rows: RequiredNative) => {
            const list = rows["ruby-tools"]!;
            while (list.length < size)
              list.push({
                file: list[0]!.file,
                name: "ruby-tools padded row " + (6091 + list.length),
              });
          },
        ] as [string, (rows: RequiredNative) => void],
    ),
    [
      "the counting review-context-limits callback removed",
      (rows) => {
        rows["review-context-limits"] = rows["review-context-limits"]!.filter(
          (row) =>
            row.name !==
            "expanded context original controls execute against a fresh offline installed runtime",
        );
      },
    ],
    [
      "a core row repeated, a context-c row removed",
      (rows) => {
        rows.core!.push({ ...rows.core![2]! });
        rows["context-c"]!.pop();
      },
    ],
    [
      "a row outside the installed harness",
      (rows) => {
        rows["terraform-extensions"]!.push({
          file: "dist/test/gate-inventory.test.js",
          name: "terraform-extensions uninstalled row 5147",
        });
      },
    ],
    [
      "baseline extras required",
      (rows) => {
        rows["cpp-tools"]!.push({
          file: "dist/test/cpp-tools.test.js",
          name: "C/C++ planning is data only and rejects undeclared CMake commands and missing source scope",
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
  /\.(?:required|passed),\s*\d+\s*[,)]/u,
  /\b(?:required|passed)\s*===\s*\d+/u,
  // A zero after `.length` is an emptiness check or a reduce seed, not a count.
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
  const admitted = admissionProfileIds(await readScope());
  // A batch cohort with neither a count nor a sum comparison, or with only a
  // file list, holds no exact rule for the discovery to find; the batch and
  // harness derivations cover it instead. The discovery scans scripts only.
  const modelled = new Set([
    ...Object.values(controllerSelectors).map((row) => row.controller),
    ...shape.companionCohorts.map((row) => row.controller),
    ...shape.rowCountControllers.map((row) => row.controller),
  ]);
  const exactlyModelled = new Set([
    ...Object.values(controllerSelectors).map((row) => row.controller),
    ...shape.companionCohorts
      .filter(
        (row) =>
          row.rows !== undefined ||
          row.disjoint ||
          row.sha256 ||
          row.preserved ||
          row.outsideFile,
      )
      .map((row) => row.controller),
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
    [...exactlyModelled].filter(
      (name) => name.startsWith("scripts/") && !found.includes(name),
    ),
    [],
  );
  assert.deepEqual(
    Object.keys(unmodelledRowSelectors).filter((name) => !found.includes(name)),
    [],
  );
  const audited = {
    batches: new Set(shape.companionCohorts.map(batchRule)),
    installed: new Set(
      shape.installedCountCallbacks.map((row) => JSON.stringify(row)),
    ),
  };
  const unmodelledBatches = async (root: string) =>
    (await deriveBatchCohorts(root, admitted, attributedProfiles(shape)))
      .filter((row) => !audited.batches.has(batchRule(row)))
      .map((row) => row.controller + " " + row.cohort.join(","));
  const unmodelledInstalled = async (root: string) => {
    const { found: counted, elsewhere } = await deriveInstalledCounts(root);
    return [
      ...counted
        .filter((row) => !audited.installed.has(JSON.stringify(row)))
        .map((row) => row.controller),
      ...elsewhere,
    ];
  };
  assert.deepEqual(await unmodelledBatches(repository), []);
  assert.deepEqual(await unmodelledInstalled(repository), []);
  const tracked = [
    ...(await readdir(path.join(repository, "scripts")))
      .filter((name) => name.endsWith(".mjs"))
      .map((name) => "scripts/" + name),
    ...(await readdir(path.join(repository, "test")))
      .filter((name) => /^gate-.*\.test\.ts$/u.test(name))
      .map((name) => "test/" + name),
    ".github/workflows/ci.yml",
  ];
  const copy = await fixture(
    t,
    Object.fromEntries(
      await Promise.all(
        tracked.map(async (name) => [name, await readScript(name)]),
      ),
    ),
  );
  for (const [name, body] of [
    [
      "verify-zig-extensions-container.mjs",
      'const source = JSON.parse(run(["node", "scripts/verify-required-native-tests.mjs", "zig-extensions"]));\nassert.equal(source.required, 9);\n',
    ],
    [
      "verify-odin-extensions-container.mjs",
      'const source = JSON.parse(run(["node", "scripts/verify-required-native-tests.mjs", "odin-extensions"]));\nassert.equal(source.required, 0);\n',
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
  // A new baseline batch in an existing controller, and a new installed count
  // in a selected acceptance file, are each unmodelled until the audit adds
  // them.
  // A second assertion on a batch receipt counts as much as the first.
  const django = path.join(
    copy,
    "scripts/verify-django-assembly-container.mjs",
  );
  const djangoText = await readFile(django, "utf8");
  const lowered = djangoText.replace(
    "frameworks.passed, 8);",
    "frameworks.passed, 7);",
  );
  assert.notEqual(lowered, djangoText);
  await writeFile(django, lowered);
  assert.deepEqual(await unmodelledBatches(copy), [
    "scripts/verify-django-assembly-container.mjs frameworks",
  ]);
  await writeFile(django, djangoText);
  const helm = path.join(copy, "scripts/verify-helm-extensions-container.mjs");
  const before = await readFile(helm, "utf8");
  await writeFile(
    helm,
    before +
      'run(["node", "scripts/verify-required-native-tests.mjs", "helm-tools"]);\n',
  );
  assert.deepEqual(await unmodelledBatches(copy), [
    "scripts/verify-helm-extensions-container.mjs helm-tools",
  ]);
  await writeFile(helm, before);
  const terraform = path.join(copy, "test/gate-terraform-extensions.test.ts");
  const acceptance = await readFile(terraform, "utf8");
  const declared = acceptance.indexOf(
    '"terraform-extensions installed acceptance"',
  );
  assert.ok(declared > 0);
  const body = acceptance.indexOf("=> {", declared) + 4;
  await writeFile(
    terraform,
    acceptance.slice(0, body) +
      "\n  assert.equal(receipt.profile.required, 10);" +
      acceptance.slice(body),
  );
  assert.deepEqual(await unmodelledInstalled(copy), [
    "test/gate-terraform-extensions.test.ts",
  ]);
  await writeFile(terraform, acceptance);
  assert.deepEqual(await unmodelledInstalled(copy), []);
});
