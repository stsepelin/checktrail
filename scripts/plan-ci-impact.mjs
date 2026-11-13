import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, appendFile } from "node:fs/promises";
import process from "node:process";
import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
const { fetch, AbortSignal } = globalThis;
import { parse } from "yaml";
import {
  buildNativeInputs,
  acceptFullBaseline,
  requestFullBaselineJobs,
  requestFullBaselineChecks,
  acceptFullBaselineChecks,
  workflowJobNames,
  nativeJobIds,
  planNativeJobs,
} from "./ci-impact.mjs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  openSync,
  readSync,
  closeSync,
  readFileSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
import ts from "typescript";

// This is an admission profile, not a package exemption: every admitted bump
// still runs the live APIs, complete consumer files and the entire host queue.
export const dependencyHostCondition =
  "${{ always() && !cancelled() && needs.ci-plan.result == 'success' && (fromJSON(needs.ci-plan.outputs.plan).mode == 'full' || (fromJSON(needs.ci-plan.outputs.plan).mode == 'affected' && fromJSON(needs.ci-plan.outputs.plan).hostValidation == 'required')) }}";
const supportedDevelopmentRoots = ["vite", "rolldown"];
const consumerFiles = {
  vite: ["test/vitest.test.ts", "test/vite-library.test.ts"],
  rolldown: ["test/vite-library.test.ts"],
  vitest: ["test/vitest.test.ts"],
  jest: ["test/jest.test.ts"],
  "vitest-native-mutation": ["test/mutation-native-fixture.ts"],
};
const dependencyControlFiles = [
  "test/development-bundlers.test.ts",
  "test/package-smoke-tools.test.ts",
  "test/javascript-tool-preparation.test.ts",
  "test/consumer-witness-project.test.ts",
  "test/mutation-native-evidence.test.ts",
  "test/mutation-native-guards.test.ts",
  "test/mutation-native-selection.test.ts",
  "test/ci-development-dependencies.test.ts",
  "test/ci-validation.test.ts",
  "test/jvm-wrapper-phases.test.ts",
  "test/dependency-audit.test.ts",
  "test/development-dependency-audit.test.ts",
];
const dependencyNativeFiles = [
  "test/vite-library.test.ts",
  "test/gate-javascript-extensions.test.ts",
  "test/mutation-native-fixture.ts",
];
export const qualificationInputs = [
  "scripts/javascript-tools/package.json",
  "scripts/javascript-tools/package-lock.json",
  "scripts/prepare-javascript-tools.mjs",
  "scripts/package-smoke-tools.mjs",
  "scripts/verify-root-javascript-reporters.mjs",
  "scripts/prepare-mutation-tools.mjs",
  "scripts/verify-import-context-package.mjs",
  "scripts/verify-javascript-extensions-container.mjs",
  "scripts/verify-consumer-project-profile.mjs",
  "scripts/verify-mutation-package.mjs",
  "scripts/verify-mutation-container.mjs",
  "scripts/verify-mutation-guards.mjs",
  "test/javascript-extensions-fixture.ts",
  "test/mutation-native-fixture.ts",
  "test/tool-fixture.ts",
  "test/vite-library.test.ts",
  "test/vitest.test.ts",
  "test/jest.test.ts",
  "test/development-bundlers.test.ts",
  "test/package-smoke-tools.test.ts",
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function git(repository, args, options = {}) {
  return execFileSync(
    "git",
    ["-c", "core.untrackedCache=false", "-c", "core.fsmonitor=false", ...args],
    {
      cwd: repository,
      maxBuffer: 64 * 1048576,
      ...options,
    },
  );
}
function jsonObject(text, file) {
  const ast = ts.parseJsonText(file, text);
  assert.equal(ast.parseDiagnostics.length, 0, "Malformed JSON: " + file);
  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const names = node.properties.map((item) => item.name?.text);
      assert.equal(
        new Set(names).size,
        names.length,
        "Duplicate JSON key: " + file,
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const data = JSON.parse(text);
  assert.ok(data && typeof data === "object" && !Array.isArray(data), file);
  return data;
}
const validName = (name) =>
  typeof name === "string" &&
  /^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name) &&
  name.split("/").every((part) => ![".", "..", "@.", "@.."].includes(part));
const pinnedVersion = (value) =>
  typeof value === "string" &&
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
function dependencyGraph(manifest, lock) {
  // Resolve through declared dependencies, so nested and unhoisted installs work.
  // Missing/changed tooling fails admission instead of guessing SemVer rules.
  const direct = createRequire(import.meta.url);
  const lint = createRequire(direct.resolve("typescript-eslint/package.json"));
  const parser = createRequire(
    lint.resolve("@typescript-eslint/typescript-estree/package.json"),
  );
  const semver = parser("semver");
  assert.equal(lock.lockfileVersion, 3, "Unsupported dependency lock");
  assert.ok(
    lock.packages &&
      typeof lock.packages === "object" &&
      !Array.isArray(lock.packages),
  );
  const packages = lock.packages;
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.version, manifest.version);
  assert.equal(packages[""].name, manifest.name);
  assert.equal(packages[""].version, manifest.version);
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ])
    assert.deepEqual(
      packages[""][field] ?? {},
      manifest[field] ?? {},
      "Root declaration and lock differ: " + field,
    );
  const resolve = (parent, name) => {
    let prefix = parent;
    while (true) {
      const candidate = (prefix ? prefix + "/" : "") + "node_modules/" + name;
      if (
        !prefix.endsWith("node_modules") &&
        Object.hasOwn(packages, candidate)
      )
        return candidate;
      if (!prefix) return undefined;
      const separator = prefix.lastIndexOf("/");
      prefix = separator === -1 ? "" : prefix.slice(0, separator);
    }
  };
  const edges = new Map();
  for (const [location, entry] of Object.entries(packages)) {
    if (location) {
      assert.ok(
        location.startsWith("node_modules/") &&
          location
            .split("/node_modules/")
            .every((part, index) => validName(index ? part : part.slice(13))),
        "Invalid lock location",
      );
      assert.ok(
        !entry.link &&
          pinnedVersion(entry.version) &&
          semver.valid(entry.version) === entry.version,
        "Unsupported locked dependency",
      );
      assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
      const sri = Buffer.from(entry.integrity.slice(7), "base64");
      assert.ok(
        sri.length === 64 &&
          sri.toString("base64") === entry.integrity.slice(7),
        "Invalid locked SHA-512 integrity",
      );
      assert.equal(
        new URL(entry.resolved).origin,
        "https://registry.npmjs.org",
      );
    }
    const declarations = new Map();
    for (const field of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      const values = entry[field] ?? {};
      assert.ok(values && typeof values === "object" && !Array.isArray(values));
      for (const [name, specifier] of Object.entries(values)) {
        assert.ok(
          validName(name) &&
            typeof specifier === "string" &&
            specifier.length > 0 &&
            specifier.length < 1024,
          "Malformed dependency edge",
        );
        // npm optionalDependencies overrides the same dependency declaration;
        // a separately required peer still cannot become optional implicitly.
        if (
          field === "dependencies" &&
          Object.hasOwn(entry.optionalDependencies ?? {}, name)
        )
          continue;
        const required =
          field === "dependencies" ||
          (field === "peerDependencies" &&
            entry.peerDependenciesMeta?.[name]?.optional !== true);
        if (!declarations.has(name)) declarations.set(name, []);
        declarations.get(name).push({ field, specifier, required });
      }
    }
    const targets = new Map();
    for (const [name, clauses] of declarations) {
      const target = resolve(location, name);
      for (const { specifier, required } of clauses) {
        let expectedName = name,
          range = specifier;
        if (range.startsWith("npm:")) {
          const separator = range.lastIndexOf("@");
          assert.ok(separator > 4, "Malformed dependency alias");
          expectedName = range.slice(4, separator);
          range = range.slice(separator + 1);
        }
        assert.ok(
          validName(expectedName) && semver.validRange(range) !== null,
          "Unresolved dependency range",
        );
        assert.ok(
          target || !required,
          "Unresolved required dependency: " + name,
        );
        if (target) {
          assert.equal(
            packages[target].name ?? name,
            expectedName,
            "Dependency alias target differs",
          );
          assert.ok(
            semver.satisfies(packages[target].version, range),
            "Locked dependency violates its declared range: " +
              location +
              " -> " +
              name,
          );
        }
      }
      if (target)
        targets.set(name, { target, specifier: JSON.stringify(clauses) });
    }
    edges.set(location, targets);
  }
  const roots = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
    ...(manifest.peerDependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
  };
  const closures = new Map();
  for (const [name, specifier] of Object.entries(roots)) {
    let actualName = name,
      version = specifier;
    if (specifier.startsWith("npm:")) {
      assert.equal(name, "vitest-native-mutation", "Unreviewed root alias");
      assert.equal(specifier, "npm:vitest@5.0.5", "Unreviewed root alias");
      actualName = "vitest";
      version = "5.0.5";
    }
    assert.ok(
      validName(name) && pinnedVersion(version),
      "Unpinned root dependency",
    );
    const location = resolve("", name);
    assert.ok(location, "Unresolved root dependency");
    assert.equal(packages[location].version, version);
    assert.equal(
      packages[location].name ?? name,
      actualName,
      "Alias identity differs",
    );
    const found = new Set(),
      pending = [location];
    while (pending.length) {
      const item = pending.pop();
      if (found.has(item)) continue;
      found.add(item);
      pending.push(...[...edges.get(item).values()].map((row) => row.target));
    }
    closures.set(name, found);
  }
  return { packages, edges, closures };
}
export const developmentInventoryPath = "scripts/ci-development-inventory.json";
const inventoryScope = "audited-first-party-development-ci-v1";
const comparePath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
function exactKeys(value, keys) {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    "Expected a data object",
  );
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort(),
    "Unknown or missing inventory fields",
  );
}
function onlyOptions(value, keys) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.ok(
    Object.keys(value).every((key) => keys.includes(key)),
    "Unknown inventory option or exclusion",
  );
}
function safeInventoryPath(file) {
  return (
    typeof file === "string" &&
    file.length > 0 &&
    [...file].every(
      (char) =>
        char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127 && char !== "\\",
    ) &&
    !path.posix.isAbsolute(file) &&
    !path.win32.isAbsolute(file) &&
    path.posix.normalize(file) === file &&
    !file.split("/").some((part) => [".", "..", ""].includes(part))
  );
}
function treeEntries(repository, revision) {
  assert.match(revision, /^[a-f0-9]{40}$/);
  const rows = git(
    repository,
    ["ls-tree", "-r", "-z", "--full-tree", revision],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .map((row) => {
      const separator = row.indexOf("\t");
      assert.ok(separator > 0, "Malformed Git tree entry");
      const [mode, type, object] = row.slice(0, separator).split(" ");
      const file = row.slice(separator + 1);
      assert.ok(safeInventoryPath(file), "Unsupported inventory path");
      assert.ok(
        type === "blob" && ["100644", "100755"].includes(mode),
        "Unsupported inventory mode or type",
      );
      assert.match(object, /^[a-f0-9]{40}$/);
      return { path: file, mode, type, object };
    })
    .sort(comparePath);
  assert.ok(
    rows.length > 0 && rows.length <= 10000,
    "Inventory must be nonempty and bounded",
  );
  assert.equal(
    new Set(rows.map((row) => row.path.toLowerCase())).size,
    rows.length,
    "Duplicate or case-ambiguous inventory path",
  );
  return rows;
}
function treeText(repository, revision, rows, file) {
  assert.ok(
    rows.some((row) => row.path === file),
    "Missing qualification or inventory input: " + file,
  );
  return git(repository, ["show", revision + ":" + file], { encoding: "utf8" });
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const dataHash = (value) => digest(JSON.stringify(canonical(value)));
function maskDevelopmentVersions(value) {
  return {
    ...value,
    devDependencies: Object.fromEntries(
      Object.entries(value.devDependencies ?? {}).map(([name, version]) => [
        name,
        supportedDevelopmentRoots.includes(name)
          ? "<graph-approved-development-version>"
          : version,
      ]),
    ),
  };
}
function protectedLockProjection(manifest, lock, graph) {
  const admitted = new Set(),
    protectedNodes = new Set();
  for (const [name, closure] of graph.closures) {
    const production = [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
    ].some((field) => Object.hasOwn(manifest[field] ?? {}, name));
    const target =
      Object.hasOwn(consumerFiles, name) && !production
        ? admitted
        : protectedNodes;
    for (const location of closure) target.add(location);
  }
  return {
    ...lock,
    packages: Object.fromEntries(
      Object.entries(lock.packages)
        .filter(
          ([location, entry]) =>
            !location ||
            !admitted.has(location) ||
            protectedNodes.has(location) ||
            entry.dev !== true,
        )
        .map(([location, entry]) => [
          location,
          location ? entry : maskDevelopmentVersions(entry),
        ]),
    ),
  };
}
function inventoryEntries(rows, manifest, lock, graph) {
  return rows
    .filter((row) => row.path !== developmentInventoryPath)
    .map(({ path: file, mode, type, object }) => {
      if (file === "package.json" || file === "package-lock.json") {
        assert.equal(
          mode,
          "100644",
          "Dependency metadata must be a regular data file",
        );
        return {
          path: file,
          mode,
          type,
          fingerprint:
            file === "package.json"
              ? "root-manifest-sha256"
              : "protected-lock-sha256",
          hash:
            file === "package.json"
              ? digest(JSON.stringify(maskDevelopmentVersions(manifest)))
              : dataHash(protectedLockProjection(manifest, lock, graph)),
        };
      }
      return {
        path: file,
        mode,
        type,
        fingerprint: "git-blob-sha1",
        hash: object,
      };
    });
}
function parseInventory(text) {
  const value = jsonObject(text, developmentInventoryPath);
  exactKeys(value, ["schemaVersion", "scope", "entries"]);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.scope, inventoryScope);
  assert.ok(
    Array.isArray(value.entries) &&
      value.entries.length > 0 &&
      value.entries.length <= 10000,
  );
  for (const row of value.entries) {
    exactKeys(row, ["path", "mode", "type", "fingerprint", "hash"]);
    assert.ok(
      safeInventoryPath(row.path) && row.path !== developmentInventoryPath,
      "Malformed inventory path",
    );
    assert.ok(
      ["100644", "100755"].includes(row.mode) && row.type === "blob",
      "Malformed inventory mode or type",
    );
    const metadata =
      row.path === "package.json" || row.path === "package-lock.json";
    assert.equal(
      row.fingerprint,
      metadata
        ? row.path === "package.json"
          ? "root-manifest-sha256"
          : "protected-lock-sha256"
        : "git-blob-sha1",
    );
    assert.match(row.hash, metadata ? /^[a-f0-9]{64}$/ : /^[a-f0-9]{40}$/);
    if (metadata) assert.equal(row.mode, "100644");
  }
  assert.equal(
    new Set(value.entries.map((row) => row.path.toLowerCase())).size,
    value.entries.length,
    "Duplicate inventory path",
  );
  return { ...value, entries: value.entries.toSorted(comparePath) };
}
function requireQualification(rows) {
  for (const file of qualificationInputs)
    assert.ok(
      rows.some((row) => row.path === file),
      "Missing qualification input: " + file,
    );
}
export function captureDevelopmentInventory(options) {
  onlyOptions(options, ["repository", "revision"]);
  const { repository = process.cwd(), revision } = options;
  const rows = treeEntries(repository, revision);
  requireQualification(rows);
  const manifest = jsonObject(
      treeText(repository, revision, rows, "package.json"),
      "package.json",
    ),
    lock = jsonObject(
      treeText(repository, revision, rows, "package-lock.json"),
      "package-lock.json",
    );
  const graph = dependencyGraph(manifest, lock);
  // Capturing bytes is not a consumer audit and does not write or approve a profile.
  return {
    schemaVersion: 1,
    scope: inventoryScope,
    entries: inventoryEntries(rows, manifest, lock, graph),
  };
}
function requireInventory(actual, expected, label) {
  const match = isDeepStrictEqual(actual, expected);
  const different =
    actual.find((row, index) => !isDeepStrictEqual(row, expected[index]))
      ?.path ??
    expected[actual.length]?.path ??
    "inventory";
  assert.ok(match, label + " differs from the audited inventory: " + different);
}
function workingBlob(file, stat) {
  const hash = createHash("sha1").update("blob " + stat.size + "\0");
  const descriptor = openSync(file, "r"),
    block = Buffer.alloc(65536);
  try {
    let read;
    while ((read = readSync(descriptor, block, 0, block.length, null)) > 0)
      hash.update(block.subarray(0, read));
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}
function requireWorkingCheckout(
  repository,
  eventProfile,
  manifest,
  lock,
  expected,
  workflow,
  inputs,
) {
  const current = git(repository, ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const rows = treeEntries(repository, current);
  const profile = rows.find((row) => row.path === developmentInventoryPath);
  assert.ok(
    profile &&
      profile.mode === "100644" &&
      profile.type === "blob" &&
      profile.object === eventProfile.object,
    "Checked-out inventory profile differs from the bound head",
  );
  assert.equal(
    git(
      repository,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { encoding: "utf8" },
    ),
    "",
    "Dirty or untracked checked-out inputs require full verification",
  );
  const actualManifest = jsonObject(
      treeText(repository, current, rows, "package.json"),
      "package.json",
    ),
    actualLock = jsonObject(
      treeText(repository, current, rows, "package-lock.json"),
      "package-lock.json",
    );
  assert.deepEqual(
    actualManifest,
    manifest,
    "Checked-out manifest differs from the bound head",
  );
  assert.deepEqual(
    actualLock,
    lock,
    "Checked-out lock differs from the bound head",
  );
  requireInventory(
    inventoryEntries(
      rows,
      actualManifest,
      actualLock,
      dependencyGraph(actualManifest, actualLock),
    ),
    expected,
    "Checked-out tree",
  );
  const realRoot = realpathSync(repository);
  let bytes = 0;
  for (const row of rows) {
    const file = path.join(realRoot, row.path),
      physical = realpathSync(file),
      relative = path.relative(realRoot, physical);
    assert.equal(
      physical,
      file,
      "Checked-out input has a noncanonical physical path",
    );
    assert.ok(
      relative &&
        relative !== ".." &&
        !relative.startsWith(".." + path.sep) &&
        !path.isAbsolute(relative),
      "Checked-out source escapes the repository",
    );
    const stat = lstatSync(file);
    assert.ok(
      stat.isFile() && !stat.isSymbolicLink(),
      "Checked-out input is not a regular file",
    );
    if (process.platform !== "win32")
      assert.equal(
        Boolean(stat.mode & 0o111),
        row.mode === "100755",
        "Checked-out executable mode differs",
      );
    bytes += stat.size;
    assert.ok(
      bytes <= 512 * 1048576,
      "Checked-out input verification bound exceeded",
    );
    assert.equal(
      workingBlob(file, stat),
      row.object,
      "Dirty checked-out input: " + row.path,
    );
  }
  // Deliberately do not apply repository, info, global or standard ignores.
  // ci-plan runs before build/fixture preparation; only npm's dependency root
  // exists legitimately outside this reviewed first-party source inventory.
  const untracked = git(
    repository,
    ["ls-files", "--others", "--directory", "--no-empty-directory", "-z"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  for (const file of untracked) {
    assert.equal(
      file,
      "node_modules/",
      "Unknown untracked input requires full verification: " + file,
    );
    const directory = path.join(realRoot, "node_modules"),
      stat = lstatSync(directory);
    assert.ok(
      stat.isDirectory() && !stat.isSymbolicLink(),
      "Untracked dependency root must be a real local directory",
    );
    assert.equal(
      realpathSync(directory),
      directory,
      "Untracked dependency root has a noncanonical physical path",
    );
  }
  assert.deepEqual(
    parse(
      readFileSync(path.join(realRoot, ".github/workflows/ci.yml"), "utf8"),
    ),
    workflow,
    "Checked-out workflow differs from the planned workflow",
  );
  assert.deepEqual(
    jsonObject(
      readFileSync(
        path.join(realRoot, "scripts/ci-native-inputs.json"),
        "utf8",
      ),
      "scripts/ci-native-inputs.json",
    ),
    inputs,
    "Checked-out owner contract differs from the planned contract",
  );
}
export function classifyDevelopmentBump(options) {
  onlyOptions(options, ["repository", "base", "head", "workflow", "inputs"]);
  const { repository = process.cwd(), base, head, workflow, inputs } = options;
  assert.match(base, /^[a-f0-9]{40}$/);
  assert.match(head, /^[a-f0-9]{40}$/);
  const changed = git(
    repository,
    ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", base, head],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  assert.ok(
    isDeepStrictEqual(changed, ["package-lock.json", "package.json"]),
    "Dependency selection requires only root manifest and lock changes",
  );
  assert.equal(
    workflow.jobs["host-validation"]?.if,
    dependencyHostCondition,
    "Required host dependency routing unavailable",
  );
  const beforeRows = treeEntries(repository, base),
    afterRows = treeEntries(repository, head);
  requireQualification(beforeRows);
  requireQualification(afterRows);
  const m0 = jsonObject(
      treeText(repository, base, beforeRows, "package.json"),
      "package.json",
    ),
    m1 = jsonObject(
      treeText(repository, head, afterRows, "package.json"),
      "package.json",
    );
  const l0 = jsonObject(
      treeText(repository, base, beforeRows, "package-lock.json"),
      "package-lock.json",
    ),
    l1 = jsonObject(
      treeText(repository, head, afterRows, "package-lock.json"),
      "package-lock.json",
    );
  const without = (value, field) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
  assert.equal(
    JSON.stringify(without(m0, "devDependencies")),
    JSON.stringify(without(m1, "devDependencies")),
    "Shared manifest input changed",
  );
  assert.deepEqual(
    without(l0, "packages"),
    without(l1, "packages"),
    "Shared lock metadata changed",
  );
  const names = new Set([
    ...Object.keys(m0.devDependencies ?? {}),
    ...Object.keys(m1.devDependencies ?? {}),
  ]);
  const bumps = [...names].filter(
    (name) => m0.devDependencies?.[name] !== m1.devDependencies?.[name],
  );
  assert.ok(
    bumps.length > 0 &&
      bumps.every((name) => supportedDevelopmentRoots.includes(name)),
    "Unreviewed development root bump",
  );
  for (const name of bumps)
    assert.ok(
      pinnedVersion(m0.devDependencies[name]) &&
        pinnedVersion(m1.devDependencies[name]),
      "Development bump must retain exact versions",
    );
  assert.deepEqual(
    without(l0.packages[""], "devDependencies"),
    without(l1.packages[""], "devDependencies"),
    "Shared root lock metadata changed",
  );
  const g0 = dependencyGraph(m0, l0),
    g1 = dependencyGraph(m1, l1);
  const changedNodes = new Set(
    [
      ...new Set([...Object.keys(g0.packages), ...Object.keys(g1.packages)]),
    ].filter(
      (location) =>
        location &&
        !isDeepStrictEqual(g0.packages[location], g1.packages[location]),
    ),
  );
  assert.ok(changedNodes.size > 0 && changedNodes.size <= 2048);
  for (const location of changedNodes)
    for (const graph of [g0, g1])
      if (graph.packages[location])
        assert.equal(
          graph.packages[location].dev,
          true,
          "Shared/production lock entry changed",
        );
  const affected = [...g0.closures.keys()]
    .filter((name) =>
      [...g0.closures.get(name), ...g1.closures.get(name)].some((location) =>
        changedNodes.has(location),
      ),
    )
    .sort();
  assert.ok(
    affected.length > 0 &&
      affected.every(
        (name) =>
          Object.hasOwn(consumerFiles, name) &&
          Object.hasOwn(m0.devDependencies, name) &&
          !["dependencies", "optionalDependencies", "peerDependencies"].some(
            (field) => Object.hasOwn(m0[field] ?? {}, name),
          ),
      ),
    "Unreviewed production/compiler/build/lint root effect: " +
      affected.join(", "),
  );
  const justified = new Set(bumps.map((name) => "node_modules/" + name));
  let previous = -1;
  while (previous !== justified.size) {
    previous = justified.size;
    for (const location of new Set([...g0.edges.keys(), ...g1.edges.keys()])) {
      const e0 = g0.edges.get(location) ?? new Map(),
        e1 = g1.edges.get(location) ?? new Map();
      for (const name of new Set([...e0.keys(), ...e1.keys()])) {
        const old = e0.get(name),
          next = e1.get(name);
        if (
          (justified.has(location) && !isDeepStrictEqual(old, next)) ||
          (old &&
            next &&
            old.target !== next.target &&
            justified.has(old.target))
        ) {
          if (old && changedNodes.has(old.target)) justified.add(old.target);
          if (next && changedNodes.has(next.target)) justified.add(next.target);
        }
      }
    }
  }
  assert.ok(
    [...changedNodes].every((location) => justified.has(location)),
    "Unrelated dependency re-resolution",
  );
  for (const location of changedNodes)
    assert.ok(
      affected.some(
        (name) =>
          g0.closures.get(name).has(location) ||
          g1.closures.get(name).has(location),
      ),
      "Unreachable dependency change",
    );

  const profile0 = beforeRows.find(
      (row) => row.path === developmentInventoryPath,
    ),
    profile1 = afterRows.find((row) => row.path === developmentInventoryPath);
  assert.ok(
    profile0 &&
      profile1 &&
      profile0.mode === "100644" &&
      profile1.mode === "100644" &&
      profile0.type === "blob" &&
      profile1.type === "blob" &&
      profile0.object === profile1.object,
    "Inventory profile must be the same regular data blob at both bound revisions",
  );
  const profile = parseInventory(
    treeText(repository, head, afterRows, developmentInventoryPath),
  );
  requireInventory(
    inventoryEntries(beforeRows, m0, l0, g0),
    profile.entries,
    "Base source",
  );
  requireInventory(
    inventoryEntries(afterRows, m1, l1, g1),
    profile.entries,
    "Head source",
  );
  requireWorkingCheckout(
    repository,
    profile1,
    m1,
    l1,
    profile.entries,
    workflow,
    inputs,
  );
  const routedFiles = [
    ...new Set([
      ...dependencyNativeFiles,
      ...affected.flatMap((name) => consumerFiles[name]),
    ]),
  ].sort();
  for (const file of routedFiles)
    assert.ok(
      Array.isArray(inputs[file]) && inputs[file].length > 0,
      "Missing declared dependency consumer owners: " + file,
    );
  const shared = [
    ...new Set([
      ...dependencyControlFiles,
      ...routedFiles.filter((file) => file.endsWith(".test.ts")),
    ]),
  ].sort();
  for (const file of shared)
    assert.ok(
      afterRows.some((row) => row.path === file),
      "Missing dependency regression: " + file,
    );
  return {
    routedFiles,
    sharedTestFiles: shared.map(
      (file) => "dist/" + file.replace(/\.ts$/, ".js"),
    ),
    evidence: {
      scope: "audited-development-dependency-consumers-v1",
      declaredBumps: bumps.sort().map((name) => ({
        name,
        before: m0.devDependencies[name],
        after: m1.devDependencies[name],
      })),
      affectedDevelopmentRoots: affected,
      changedLockEntries: [...changedNodes].sort(),
      auditedConsumerFiles: [
        ...new Set([
          ...routedFiles,
          ...dependencyControlFiles,
          "scripts/smoke-package.mjs",
          "scripts/package-smoke-tools.mjs",
          "scripts/verify-root-javascript-reporters.mjs",
          "scripts/run-ci-validation.mjs",
          "scripts/ci-validation.mjs",
          "scripts/ci-validation-phases.json",
        ]),
      ].sort(),
      sourceInventorySha256: dataHash(profile.entries),
      qualifiedLockSha256: digest(
        treeText(
          repository,
          head,
          afterRows,
          "scripts/javascript-tools/package-lock.json",
        ),
      ),
    },
  };
}

export async function main() {
  const workflow = parse(await readFile(".github/workflows/ci.yml", "utf8"));
  const jobs = nativeJobIds(workflow);
  const inputs = JSON.parse(
    await readFile("scripts/ci-native-inputs.json", "utf8"),
  );
  let changed = null,
    baseline = null,
    contractCurrent = false,
    producerInventory = null,
    developmentImpact = null,
    dependencyFallback = null;
  try {
    const files = execFileSync("git", ["ls-files", "-z"], {
      encoding: "utf8",
      maxBuffer: 4 * 1048576,
    })
      .split("\0")
      .filter(Boolean);
    producerInventory = files;
    const current = await buildNativeInputs({
      workflow,
      requirements: JSON.parse(
        await readFile("scripts/required-native-tests.json", "utf8"),
      ),
      files,
      readText: (file) => readFile(file, "utf8"),
    });
    contractCurrent = isDeepStrictEqual(current, inputs);
    if (process.env.GITHUB_EVENT_NAME === "pull_request" && contractCurrent) {
      const event = JSON.parse(
        await readFile(process.env.GITHUB_EVENT_PATH, "utf8"),
      );
      const base = event.pull_request.base.sha,
        head = event.pull_request.head.sha;
      assert.match(base, /^[a-f0-9]{40}$/);
      assert.match(head, /^[a-f0-9]{40}$/);
      changed = execFileSync(
        "git",
        ["diff", "--name-only", "-z", "--no-renames", base + "..." + head],
        { encoding: "utf8", maxBuffer: 4 * 1048576 },
      )
        .split("\0")
        .filter(Boolean);
      if (
        changed.includes("package.json") ||
        changed.includes("package-lock.json")
      ) {
        try {
          developmentImpact = classifyDevelopmentBump({
            base,
            head,
            workflow,
            inputs,
          });
          changed = developmentImpact.routedFiles;
        } catch (error) {
          dependencyFallback = error.message;
        }
      }
      // Optional historical context is never a prerequisite for testing the PR's
      // current declared inputs. It cannot qualify an omitted job at this revision.
      if (process.env.CHECKTRAIL_CI_OBSERVE_BASELINE === "1") {
        assert.match(
          process.env.GITHUB_REPOSITORY,
          /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/,
        );
        const request = async (url) => {
          let response;
          try {
            response = await fetch(url, {
              headers: {
                Authorization: "Bearer " + process.env.GITHUB_TOKEN,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
              },
              signal: AbortSignal.timeout(15000),
              redirect: "error",
            });
          } catch {
            throw Object.assign(
              new Error("Baseline API transport unavailable"),
              {
                code: "CI_BASELINE_API_UNAVAILABLE",
              },
            );
          }
          if ([429, 500, 502, 503, 504].includes(response.status)) {
            throw Object.assign(
              new Error("Baseline API temporarily unavailable"),
              {
                code: "CI_BASELINE_API_UNAVAILABLE",
              },
            );
          }
          assert.equal(response.status, 200, "Baseline API request failed");
          const body = await response.text();
          assert.ok(Buffer.byteLength(body) <= 4 * 1048576);
          return JSON.parse(body);
        };
        const api =
          "https://api.github.com/repos/" + process.env.GITHUB_REPOSITORY;
        const runs = await request(
          api +
            "/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=" +
            base +
            "&status=completed&per_page=10",
        );
        const run = runs.workflow_runs.find(
          (r) =>
            r.head_sha === base &&
            r.head_branch === "main" &&
            r.event === "push" &&
            r.conclusion === "success",
        );
        if (run) {
          assert.ok(Number.isSafeInteger(run.id) && run.id > 0);
          assert.ok(
            Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0,
          );
          const expectedNames = workflowJobNames(workflow);
          const seenJobNames = new Set(),
            seenJobIds = new Set();
          const requestJobs = async (url) => {
            const page = await request(url);
            assert.ok(
              Array.isArray(page.jobs),
              "Baseline job page is malformed",
            );
            for (const job of page.jobs) {
              assert.ok(
                job &&
                  Number.isSafeInteger(job.id) &&
                  job.id > 0 &&
                  job.run_id === run.id &&
                  job.status === "completed" &&
                  job.conclusion === "success" &&
                  expectedNames.includes(job.name) &&
                  !seenJobIds.has(job.id) &&
                  !seenJobNames.has(job.name),
                "Observed baseline job is not a distinct successful expected job",
              );
              seenJobIds.add(job.id);
              seenJobNames.add(job.name);
            }
            return page;
          };
          try {
            const result = await requestFullBaselineJobs(
              requestJobs,
              api +
                "/actions/runs/" +
                run.id +
                "/attempts/" +
                run.run_attempt +
                "/jobs",
              expectedNames.length,
            );
            // Valid but failed, skipped or incomplete jobs remain unqualified.
            baseline = acceptFullBaseline(run, result, { base, expectedNames });
          } catch (error) {
            if (error?.code !== "CI_BASELINE_API_UNAVAILABLE") throw error;
            assert.ok(
              Number.isSafeInteger(run.check_suite_id) &&
                run.check_suite_id > 0,
            );
            const result = await requestFullBaselineChecks(
              request,
              api + "/check-suites/" + run.check_suite_id + "/check-runs",
              expectedNames.length,
            );
            // Pagination is bounded; the run must still be the same successful
            // attempt after the final page. A concurrent retry invalidates reuse.
            const observedRun = await request(api + "/actions/runs/" + run.id);
            baseline = acceptFullBaselineChecks(run, result, {
              base,
              expectedNames,
              repository: process.env.GITHUB_REPOSITORY,
              observedRun,
            });
          }
        }
      }
    }
  } catch (error) {
    process.stderr.write(
      "CI planning or optional baseline observation failed: " +
        error.message +
        "\n",
    );
  }
  const plan = planNativeJobs({
    jobs,
    inputs,
    changed,
    baseline,
    contractCurrent,
    producerInventory,
    eventName: process.env.GITHUB_EVENT_NAME,
  });
  if (developmentImpact && plan.mode === "affected") {
    plan.hostValidation = "required";
    plan.sharedTestFiles = [
      ...new Set([
        ...plan.sharedTestFiles,
        ...developmentImpact.sharedTestFiles,
      ]),
    ].sort();
    plan.dependencyImpact = developmentImpact.evidence;
    plan.reason =
      "Verified development-only dependency graph with complete consumer files and the full installed/package/mutation host queue";
  } else if (dependencyFallback && plan.mode === "full") {
    plan.reason += "; dependency scope unavailable: " + dependencyFallback;
  }
  process.stdout.write(JSON.stringify(plan) + "\n");
  await appendFile(
    process.env.GITHUB_OUTPUT,
    "plan=" + JSON.stringify(plan) + "\n",
  );
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    "### Native CI selection\n\nMode: **" +
      plan.mode +
      "**. " +
      plan.reason +
      ".\n\nSelected: " +
      Object.entries(plan.selected)
        .filter(([, selected]) => selected)
        .map(([id]) => "`" + id + "`")
        .join(", ") +
      ".\n\nNot selected (not passing evidence): " +
      (plan.notSelected.map((id) => "`" + id + "`").join(", ") || "none") +
      ".\n\n" +
      (plan.mode === "full"
        ? "Full shared suites and package/mutation verification are required."
        : plan.hostValidation === "required"
          ? "Shared typecheck, lint, formatting, audits, complete consumer files and the entire installed/package/mutation host queue are required. Omitted native jobs are untested at this revision; no full-revision qualification is claimed."
          : "Shared typecheck, lint, formatting, audits and selected full test files are required. Omitted native jobs and package/mutation phases are untested at this revision; no Gate A qualification is claimed.") +
      "\n",
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
