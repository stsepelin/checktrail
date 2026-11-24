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
const scriptModule = (name: string) =>
  import(new URL("../../scripts/" + name, import.meta.url).href);
// Two controllers check their rows inline at the top of a script that runs
// native tests on import, so their rule is pinned by its source text instead.
const inlineSelection = `assert.deepEqual(
  requirements,
  selection.acceptanceCases.map((item) => ({
    file: selection.acceptanceFile,
    name: item.name,
  })),
);`;
const inlineSelector =
  (id: string) => (_root: string, rows: RequiredNative, scope: Scope) => {
    const selected = scope.extensionProfiles.find((row) => row.id === id)!;
    assert.deepEqual(
      rows[id],
      selected.acceptanceCases.map((item) => ({
        file: selected.acceptanceFile,
        name: item.name,
      })),
    );
  };
const controllerSelectors: Record<
  string,
  (root: string, rows: RequiredNative, scope: Scope) => Promise<unknown> | void
> = {
  "cpp-extensions": async (root) =>
    (
      await scriptModule("selected-clang-consumer-witness.mjs")
    ).selectSelectedClangRequirements(root),
  "dotnet-generator-extensions": async (_root, rows) =>
    (
      await scriptModule("dotnet-generator-shards.mjs")
    ).validateGeneratorShardManifest(
      JSON.parse(
        await readFile(
          path.join(repository, "scripts/dotnet-generator-shards.v1.json"),
          "utf8",
        ),
      ),
      rows,
    ),
  "scala-extensions": async (_root, rows) =>
    (
      await scriptModule("scala-native-ci-phases.mjs")
    ).selectScalaExtensionSourceRequirements(rows["scala-extensions"]),
  "ruby-extensions": async (_root, rows) =>
    (
      await scriptModule("ruby-extensions-acceptance-selection.mjs")
    ).selectRubyExtensionAcceptance(rows["ruby-extensions"], "source", "all"),
  "consumer-impact": async (_root, rows, scope) =>
    (
      await scriptModule("consumer-runtime-evidence.mjs")
    ).selectConsumerRuntimeRequirements(rows, scope),
  "multi-candidate-workflow": async (_root, rows, scope) =>
    (
      await scriptModule("review-runtime-evidence.mjs")
    ).selectReviewRuntimeRequirements(rows, scope, "multi-candidate-workflow"),
  "confidence-provenance": async (_root, rows, scope) =>
    (
      await scriptModule("review-runtime-evidence.mjs")
    ).selectReviewRuntimeRequirements(rows, scope, "confidence-provenance"),
  "attempt-archives": async (_root, rows, scope) =>
    (
      await scriptModule("attempt-whole-evidence.mjs")
    ).selectAttemptWholeRequirements(rows, scope),
  "lifecycle-platforms": inlineSelector("lifecycle-platforms"),
  "tasks-matrix": async (_root, rows, scope) =>
    (
      await scriptModule("tasks-runtime-evidence.mjs")
    ).selectTasksRuntimeRequirements(
      rows,
      scope.extensionProfiles.find((row) => row.id === "tasks-matrix"),
      "linux",
    ),
  "native-license-provenance": async (_root, rows, scope) =>
    (
      await scriptModule("native-provenance-runtime-evidence.mjs")
    ).selectProvenanceRuntimeRequirements(rows, scope),
  "resource-release-readiness": inlineSelector("resource-release-readiness"),
  "independent-evaluation-protocol": async (_root, rows, scope) =>
    (
      await scriptModule("evaluation-runtime-evidence.mjs")
    ).selectEvaluationRuntimeRequirements(rows, scope),
};

// Each variant edits every dedicated profile at once; the audit must refuse
// exactly the profiles whose real selector throws on the same manifest.
test("finite inventory selector admission agrees with every dedicated controller selector", async (t) => {
  for (const [script, key] of [
    ["verify-lifecycle-platforms.mjs", 'profiles["lifecycle-platforms"];'],
    [
      "verify-resource-release-readiness.mjs",
      ')["resource-release-readiness"];',
    ],
  ] as const) {
    const text = await readFile(
      path.join(repository, "scripts", script),
      "utf8",
    );
    assert.equal(text.split(key).length, 2, script);
    assert.equal(text.split(inlineSelection).length, 2, script);
  }
  const scope = JSON.parse(
    await readFile(path.join(repository, files[0]!), "utf8"),
  ) as Scope;
  // The .NET generator selector compares against its shard partitions; the
  // audit models it with the selected cases, so the two must stay equal.
  const shards = JSON.parse(
    await readFile(
      path.join(repository, "scripts/dotnet-generator-shards.v1.json"),
      "utf8",
    ),
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
  const ids = Object.keys(controllerSelectors).sort();
  const variants: [string, (rows: RequiredNative) => void][] = [
    ["as written", () => {}],
    [
      "reversed",
      (rows) => {
        for (const id of ids) rows[id]!.reverse();
      },
    ],
    [
      "adjacent row",
      (rows) => {
        for (const id of ids)
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
      "companion cohort grown",
      (rows) => {
        rows["mcp-tasks"]!.push({
          file: "dist/test/mcp-validation-tasks.test.js",
          name: "MCP Tasks companion row 6203",
        });
      },
    ],
  ];
  const outcomes = new Map(ids.map((id) => [id, new Set<boolean>()]));
  for (const [label, edit] of variants) {
    const root = await source(t);
    await alter<RequiredNative>(root, files[2]!, edit);
    const rows = JSON.parse(
      await readFile(path.join(root, files[2]!), "utf8"),
    ) as RequiredNative;
    const result = await audit(root);
    assert.equal(result.code, 0, label + ": " + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(
      report.controllerAdmission.dedicatedSelectorProfiles,
      ids,
      label,
    );
    for (const id of ids) {
      let controllerRefused = false;
      try {
        await controllerSelectors[id]!(root, structuredClone(rows), scope);
      } catch {
        controllerRefused = true;
      }
      const auditRefused = (
        report.controllerAdmission.refusals as AdmissionRefusal[]
      ).some((row) => row.profile === id && row.controller !== genericRunner);
      assert.equal(auditRefused, controllerRefused, label + ": " + id);
      outcomes.get(id)!.add(controllerRefused);
    }
  }
  for (const [id, seen] of outcomes)
    assert.deepEqual([...seen].sort(), [false, true], id);
});
