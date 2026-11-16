import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";
import { runRequiredProfiles } from "./required-test-evidence.mjs";

export const baselineSha256 =
  "04b2ba50cb1e4516d5472ff2412478b75ec5f5803de34d62fa4b78237a1d5568";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return (
    relative !== "" &&
    !relative.startsWith(".." + path.sep) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
};

export async function selectBaselineCohort(repository, name) {
  const [registryBytes, baselineBytes, currentBytes] = await Promise.all([
    readFile(
      path.join(repository, "scripts/preserved-baseline-cohorts.v1.json"),
    ),
    readFile(path.join(repository, "docs/gate-a-native-baseline.v1.json")),
    readFile(path.join(repository, "scripts/required-native-tests.json")),
  ]);
  const registry = JSON.parse(registryBytes);
  assert.equal(registry.schemaVersion, 1);
  assert.equal(registry.baseline.sha256, baselineSha256);
  assert.equal(
    hash(baselineBytes),
    baselineSha256,
    "Frozen baseline bytes changed",
  );
  assert.ok(
    Object.hasOwn(registry.cohorts, name),
    "Unknown preserved baseline cohort",
  );
  const cohort = registry.cohorts[name],
    baseline = JSON.parse(baselineBytes);
  assert.ok(
    ["host", "container"].includes(cohort.backend),
    "Existing native controller adapter is not implemented; no completion credit",
  );
  assert.ok(cohort.profiles.length > 0, "Empty baseline cohort");
  assert.equal(
    new Set(cohort.profiles).size,
    cohort.profiles.length,
    "Duplicate baseline profile",
  );
  const current = JSON.parse(currentBytes),
    profiles = {};
  for (const profile of cohort.profiles) {
    assert.ok(
      Object.hasOwn(baseline, profile),
      "Unknown frozen baseline profile",
    );
    assert.ok(baseline[profile].length > 0, "Empty frozen baseline profile");
    assert.ok(
      Object.hasOwn(current, profile),
      "Missing current baseline profile",
    );
    for (const item of baseline[profile]) {
      assert.ok(
        current[profile].some(
          (candidate) =>
            candidate.file === item.file && candidate.name === item.name,
        ),
        "Frozen original callback missing from current manifest",
      );
    }
    profiles[profile] = baseline[profile];
  }
  return {
    cohort,
    profiles,
    selection: cohort.profiles,
    identities: {
      registrySha256: hash(registryBytes),
      baselineSha256,
      requiredNativeTestsSha256: hash(currentBytes),
    },
  };
}

async function executableIdentity(command, args) {
  let executable;
  if (path.isAbsolute(command)) executable = command;
  else {
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      const candidate = path.join(directory, command);
      if (
        await lstat(candidate)
          .then((stat) => stat.isFile() || stat.isSymbolicLink())
          .catch(() => false)
      ) {
        executable = candidate;
        break;
      }
    }
  }
  assert.ok(executable, "Required baseline tool is unavailable: " + command);
  const physical = await realpath(executable),
    bytes = await readFile(physical);
  const version = execFileSync(physical, args, {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    env: process.env,
  }).trim();
  assert.ok(
    version.length > 0 && version.length < 65536,
    "Required baseline tool emitted no bounded identity",
  );
  return {
    command: path.basename(command),
    sha256: hash(bytes),
    bytes: bytes.length,
    version,
  };
}

export async function captureBaselineRuntime(binding) {
  assert.equal(
    process.platform,
    binding.platform,
    "Baseline platform is inapplicable",
  );
  assert.equal(
    Number(process.versions.node.split(".")[0]),
    binding.nodeMajor,
    "Baseline Node selector is inapplicable",
  );
  if (binding.nodeVersion)
    assert.equal(
      process.versions.node,
      binding.nodeVersion,
      "Baseline Node version differs from existing controller",
    );
  const tools = {};
  for (const [command, args] of Object.entries(binding.tools ?? {})) {
    tools[command] = await executableIdentity(command, args);
  }
  requireBaselineToolVersions(binding, tools);
  const runtime = {
    platform: process.platform,
    arch: process.arch,
    node: await executableIdentity(process.execPath, ["--version"]),
    os: { type: os.type(), release: os.release(), version: os.version() },
    tools,
  };
  return runtime;
}

// CLI version tokens are compared at their actual boundaries. In particular,
// selected patch versions must not accept a neighboring patch by prefix.
export function requireBaselineToolVersions(binding, tools) {
  for (const [tool, expected] of Object.entries(
    binding.toolVersionAssertions ?? {},
  )) {
    assert.ok(
      typeof tools[tool]?.version === "string",
      "Required asserted baseline tool is unavailable",
    );
    assert.ok(
      Object.keys(expected).length > 0 &&
        Object.keys(expected).every((key) =>
          ["equals", "tokens"].includes(key),
        ),
      "Unknown baseline version assertion",
    );
    if (expected.equals !== undefined)
      assert.equal(
        tools[tool].version,
        expected.equals,
        "Baseline tool version differs from existing controller: " + tool,
      );
    if (expected.tokens !== undefined) {
      assert.ok(
        Array.isArray(expected.tokens) &&
          expected.tokens.length > 0 &&
          expected.tokens.every(
            (token) =>
              typeof token === "string" &&
              token.length > 0 &&
              !/\s/.test(token),
          ),
        "Invalid baseline version token",
      );
      const observed = tools[tool].version.split(/\s+/);
      assert.ok(
        expected.tokens.every((token) => observed.includes(token)),
        "Baseline tool version differs from existing controller: " + tool,
      );
    }
  }
  const selectors = binding.selectors ?? {};
  if (selectors.go)
    assert.deepEqual(
      tools.go?.version.split(/\s+/).slice(0, 3),
      ["go", "version", "go" + selectors.go],
      "Required baseline tool differs from existing selector: go",
    );
  if (selectors.rust)
    assert.deepEqual(
      tools.rustc?.version.split(/\s+/).slice(0, 2),
      ["rustc", selectors.rust],
      "Required baseline tool differs from existing selector: rustc",
    );
  for (const [tool, prefix] of [
    ["python3", selectors.python && "Python " + selectors.python + "."],
    ["php", selectors.php && "PHP " + selectors.php + "."],
  ]) {
    if (prefix)
      assert.ok(
        tools[tool]?.version.startsWith(prefix),
        "Required baseline tool differs from existing selector: " + tool,
      );
  }
  if (binding.gitVersion)
    assert.equal(
      tools.git?.version,
      "git version " + binding.gitVersion,
      "Baseline Git version differs",
    );
}

export async function callbackIdentities(root, profiles, selection) {
  assert.ok(
    Array.isArray(selection) && selection.length > 0,
    "Empty baseline profile selection",
  );
  assert.equal(
    new Set(selection).size,
    selection.length,
    "Duplicate baseline profile",
  );
  root = await realpath(root);
  const files = new Set(),
    addresses = new Set();
  for (const profile of selection) {
    assert.ok(Object.hasOwn(profiles, profile), "Unknown baseline profile");
    assert.ok(
      Array.isArray(profiles[profile]) && profiles[profile].length > 0,
      "Empty baseline callback selection",
    );
    for (const item of profiles[profile]) {
      assert.ok(typeof item.name === "string" && item.name.length > 0);
      assert.ok(
        typeof item.file === "string" &&
          item.file.startsWith("dist/test/") &&
          !item.file.split("/").includes(".."),
        "Unsafe callback file",
      );
      files.add(item.file);
      addresses.add(JSON.stringify([item.file, item.name]));
    }
  }
  assert.ok(addresses.size <= 4096, "Baseline callback union is unbounded");
  const identities = [];
  for (const file of [...files].sort()) {
    const absolute = path.join(root, file),
      physical = await realpath(absolute);
    assert.equal(physical, absolute, "Callback file falls back through a link");
    const stat = await lstat(physical);
    assert.ok(
      stat.isFile() && stat.size <= 4 * 1024 * 1024,
      "Callback file is not bounded and regular",
    );
    const bytes = await readFile(physical);
    identities.push({ file, bytes: bytes.length, sha256: hash(bytes) });
  }
  return {
    files: identities,
    uniqueCallbacks: addresses.size,
    memberships: selection.reduce(
      (sum, name) => sum + profiles[name].length,
      0,
    ),
  };
}

export async function assertInstalledEngineBinding({
  harness,
  installedPackage,
  sourceEngine,
}) {
  const packageRoot = await realpath(installedPackage);
  assert.ok(
    (await lstat(installedPackage)).isDirectory() &&
      !(await lstat(installedPackage)).isSymbolicLink(),
    "Installed package itself falls back through a link",
  );
  const installed = await realpath(path.join(packageRoot, "dist/src"));
  assert.ok(
    inside(packageRoot, installed),
    "Installed engine escapes production package",
  );
  assert.equal(
    installed,
    path.join(packageRoot, "dist/src"),
    "Installed engine falls back through a link",
  );
  assert.notEqual(
    installed,
    await realpath(sourceEngine),
    "Fresh engine is the source engine",
  );
  assert.equal(
    await realpath(path.join(harness, "dist/src")),
    installed,
    "Fresh harness does not resolve to physically installed engine",
  );
  const manifest = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, "@stsepelin/checktrail");
  return {
    physicallyInstalled: true,
    sourceFallbackRejected: true,
    engineRootIdentitySha256: hash(installed),
    scope: "Configured engine root alias, not a trace of every module loaded.",
  };
}

// This accepts synthetic unit fixtures too; only selectBaselineCohort admits
// production collection, from the immutable finite registry above.
export async function runBaselinePhase({
  root,
  profiles,
  selection,
  expectedCallbacks,
  expectedEngine,
  binding,
  installedPackage,
  sourceEngine,
  timeoutMs = 600000,
}) {
  const beforeRuntime = await captureBaselineRuntime(binding);
  const beforeCallbacks = await callbackIdentities(root, profiles, selection);
  assert.deepEqual(
    beforeCallbacks,
    expectedCallbacks,
    "Baseline callback bytes changed",
  );
  const physical = installedPackage
    ? await assertInstalledEngineBinding({
        harness: root,
        installedPackage,
        sourceEngine,
      })
    : { source: true };
  const beforeEngine = await captureCompiledEngine(path.join(root, "dist/src"));
  assert.equal(
    beforeEngine.treeSha256,
    expectedEngine.treeSha256,
    "Baseline engine bytes differ from packed source",
  );
  assert.equal(
    beforeEngine.manifestSha256,
    expectedEngine.manifestSha256,
    "Baseline engine manifest differs from packed source",
  );
  const absoluteProfiles = Object.fromEntries(
    selection.map((profile) => [
      profile,
      profiles[profile].map((item) => ({
        ...item,
        file: path.join(root, item.file),
      })),
    ]),
  );
  const report = await runRequiredProfiles(absoluteProfiles, selection, {
    timeoutMs,
  });
  assert.ok(report.complete, "Preserved baseline cohort incomplete");
  assert.equal(report.required, beforeCallbacks.uniqueCallbacks);
  assert.deepEqual(
    await callbackIdentities(root, profiles, selection),
    beforeCallbacks,
    "Baseline callback bytes changed during collection",
  );
  const compiledEngine = requireUnchangedCompiledEngine(
    beforeEngine,
    await captureCompiledEngine(path.join(root, "dist/src")),
  );
  if (installedPackage)
    await assertInstalledEngineBinding({
      harness: root,
      installedPackage,
      sourceEngine,
    });
  assert.deepEqual(
    await captureBaselineRuntime(binding),
    beforeRuntime,
    "Baseline runtime or tool bytes changed during collection",
  );
  return {
    ...report,
    compiledEngine,
    physicalBinding: physical,
    callbacks: beforeCallbacks,
    runtime: beforeRuntime,
    beforeAfterRuntimeIdentitiesMatch: true,
  };
}

async function copyRegularTree(from, to) {
  const stat = await lstat(from);
  assert.ok(!stat.isSymbolicLink(), "Public harness input must not be a link");
  if (stat.isDirectory()) {
    await mkdir(to, { recursive: true });
    for (const name of await readdir(from)) {
      assert.notEqual(
        name,
        "node_modules",
        "Nested dependency tree is not a public harness input",
      );
      await copyRegularTree(path.join(from, name), path.join(to, name));
    }
  } else {
    assert.ok(stat.isFile(), "Public harness input is not regular");
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
  }
}

export async function prepareBaselineHarness({
  repository,
  harness,
  installedPackage,
  preparedDirectories = [],
}) {
  await mkdir(harness);
  // Only Git-tracked public inputs, compiled test modules, and explicitly
  // selected prepared tools. No ignored/private .checktrail data is copied.
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
  for (const file of tracked) {
    if (file.startsWith("dist/") || file.split("/").includes("node_modules"))
      continue;
    assert.ok(!path.isAbsolute(file) && !file.split("/").includes(".."));
    const source = path.join(repository, file),
      stat = await lstat(source);
    assert.ok(
      stat.isFile() && !stat.isSymbolicLink(),
      "Tracked harness input is not a regular public file",
    );
    await mkdir(path.dirname(path.join(harness, file)), { recursive: true });
    await copyFile(source, path.join(harness, file));
  }
  await copyRegularTree(
    path.join(repository, "dist/test"),
    path.join(harness, "dist/test"),
  );
  await symlink(
    path.join(installedPackage, "dist/src"),
    path.join(harness, "dist/src"),
    process.platform === "win32" ? "junction" : "dir",
  );
  // Fixture dev dependencies remain external; production engine dependencies
  // resolve through the real installed package's own node_modules.
  await symlink(
    path.join(repository, "node_modules"),
    path.join(harness, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const name of preparedDirectories) {
    assert.match(name, /^[a-z0-9-]+$/);
    const source = path.join(repository, ".checktrail", name);
    assert.ok(
      (await lstat(source).catch(() => undefined))?.isDirectory(),
      "Required prepared baseline tools are unavailable: " + name,
    );
    await mkdir(path.join(harness, ".checktrail"), { recursive: true });
    await cp(source, path.join(harness, ".checktrail", name), {
      recursive: true,
      dereference: false,
    });
  }
}

export function requireBaselineSourceSubset({
  report,
  profiles,
  selection,
  fileBindings,
  baselineProfiles,
  baselineSelection,
  sourceContract,
}) {
  assert.ok(
    report &&
      sourceContract &&
      ["required-profiles", "full-suite-fragment"].includes(
        sourceContract.kind,
      ),
    "Unknown original source completeness contract",
  );
  if (sourceContract.kind === "required-profiles") {
    assert.equal(
      report.complete,
      true,
      "Original source command is incomplete",
    );
    assert.ok(
      !Object.hasOwn(report, "fragmentComplete"),
      "A fragment cannot be admitted as a complete original command",
    );
  } else {
    const expected = sourceContract.fragment;
    assert.equal(
      report.complete,
      false,
      "Source fragment was relabeled complete",
    );
    assert.equal(
      report.fragmentComplete,
      true,
      "Original source fragment is incomplete",
    );
    assert.equal(
      report.wholeSuiteComplete,
      false,
      "Source fragment claimed the whole suite",
    );
    assert.equal(report.shard, expected.shard, "Foreign source shard");
    assert.equal(
      report.profileManifestSha256,
      expected.profileManifestSha256,
      "Stale source profile manifest",
    );
    assert.deepEqual(
      report.unassignedFiles,
      expected.unassignedFiles,
      "Original unassigned source file partition changed",
    );
    assert.equal(
      report.partitionSha256,
      expected.partitionSha256,
      "Stale source partition",
    );
    assert.equal(
      report.inventorySha256,
      expected.inventorySha256,
      "Stale source inventory",
    );
    assert.deepEqual(
      report.requestedProfiles,
      expected.requestedProfiles,
      "Original source profile union changed",
    );
    assert.equal(report.totalRequired, expected.totalRequired);
    assert.equal(report.assignedRequired, expected.assignedRequired);
    assert.deepEqual(
      report.assignedFiles,
      expected.assignedFiles,
      "Source file partition changed",
    );
    assert.equal(
      report.compiledTests.treeSha256,
      expected.compiledTestsTreeSha256,
    );
    assert.equal(report.compiledTests.beforeAfterByteIdentitiesMatch, true);
  }
  assert.deepEqual(report.problems, [], "Original source command has problems");
  assert.ok(Array.isArray(selection) && selection.length > 0);
  assert.equal(new Set(selection).size, selection.length);
  if (selection.length === 1 && Object.hasOwn(report, "profile")) {
    assert.equal(
      report.profile,
      selection[0],
      "Foreign original source profile",
    );
  } else {
    assert.deepEqual(
      report.profiles,
      selection.map((profile) => ({
        profile,
        required: profiles[profile].length,
      })),
      "Original source selection changed",
    );
  }
  const fileIds = new Map();
  for (const row of fileBindings) {
    assert.ok(
      typeof row.file === "string" && row.file.startsWith("dist/test/"),
    );
    assert.match(row.sha256, /^[a-f0-9]{64}$/);
    assert.ok(!fileIds.has(row.file), "Duplicate source file binding");
    fileIds.set(row.file, row.id);
  }
  assert.equal(
    new Set(fileBindings.map((row) => row.id)).size,
    fileBindings.length,
  );
  const required = new Map();
  for (const profile of selection) {
    assert.ok(Object.hasOwn(profiles, profile) && profiles[profile].length > 0);
    for (const row of profiles[profile]) {
      assert.ok(
        fileIds.has(row.file),
        "Original required source file is unbound",
      );
      const fileId = fileIds.get(row.file);
      required.set(JSON.stringify([fileId, row.name]), {
        fileId,
        name: row.name,
      });
    }
  }
  assert.ok(
    Number.isSafeInteger(sourceContract.maxTerminalEvents) &&
      sourceContract.maxTerminalEvents > 0,
    "Missing bounded original source contract",
  );
  assert.ok(
    required.size > 0 && required.size <= sourceContract.maxTerminalEvents,
  );
  assert.equal(
    report.required,
    required.size,
    "Original required source count changed",
  );
  const ledger = report.ledger;
  assert.equal(ledger.schemaVersion, 1);
  assert.equal(ledger.truncated, false, "Original source ledger was truncated");
  assert.equal(
    ledger.maxTerminalEvents,
    sourceContract.maxTerminalEvents,
    "Original source terminal bound differs from the selected controller contract",
  );
  assert.ok(
    Array.isArray(ledger.events) &&
      ledger.events.length <= sourceContract.maxTerminalEvents,
  );
  assert.equal(ledger.terminalEventCount, ledger.events.length);
  assert.ok(ledger.events.length > 0, "Original source ledger is empty");
  assert.equal(
    ledger.files.length,
    fileBindings.length,
    "Original source file set changed",
  );
  for (let index = 0; index < fileBindings.length; index++) {
    const expected = fileBindings[index],
      actual = ledger.files[index];
    assert.equal(actual.id, expected.id, "Original source file order changed");
    assert.equal(actual.stable, true, "Original source file is stale");
    assert.deepEqual(actual.before, {
      state: "present",
      sha256: expected.sha256,
    });
    assert.deepEqual(
      actual.after,
      actual.before,
      "Original source file bytes changed",
    );
  }
  const knownFileIds = new Set(fileBindings.map((row) => row.id));
  const observed = new Map([...required.keys()].map((key) => [key, []]));
  let passed = 0;
  for (let index = 0; index < ledger.events.length; index++) {
    const event = ledger.events[index];
    assert.equal(
      event.sequence,
      index + 1,
      "Original source terminal sequence changed",
    );
    assert.ok(
      event.fileId === null || knownFileIds.has(event.fileId),
      "Original source event references a foreign file",
    );
    assert.ok(event.kind === "test" || event.kind === "suite");
    assert.ok(["passed", "failed", "skipped", "todo"].includes(event.outcome));
    assert.equal(
      event.nameTruncated,
      false,
      "Original source terminal name was truncated",
    );
    const key = JSON.stringify([event.fileId, event.name]);
    const isRequired = event.kind === "test" && required.has(key);
    assert.equal(
      event.required,
      isRequired,
      "Foreign actual required source event",
    );
    if (isRequired) {
      assert.equal(
        event.outcome,
        "passed",
        "Original required source event did not pass",
      );
      observed.get(key).push(event.sequence);
    }
    if (event.kind === "test" && event.outcome === "passed") passed++;
  }
  assert.equal(
    report.passed,
    passed,
    "Original source passed count is inconsistent",
  );
  assert.equal(
    ledger.cases.length,
    required.size,
    "Original required case set changed",
  );
  const actualCases = new Map();
  for (const item of ledger.cases) {
    const key = JSON.stringify([item.fileId, item.name]);
    assert.ok(
      required.has(key) && !actualCases.has(key),
      "Foreign or duplicate required source case",
    );
    assert.equal(
      item.outcome,
      "passed",
      "Original required source case did not pass",
    );
    const sequences = observed.get(key);
    assert.equal(
      sequences.length,
      1,
      "Original source case lacks one terminal event",
    );
    assert.deepEqual(
      item.terminalSequences,
      sequences,
      "Original source case terminal reference changed",
    );
    actualCases.set(key, item);
  }
  assert.equal(actualCases.size, required.size);
  assert.ok(Array.isArray(baselineSelection) && baselineSelection.length > 0);
  assert.equal(new Set(baselineSelection).size, baselineSelection.length);
  const subset = new Map(),
    memberships = [];
  for (const profile of baselineSelection) {
    assert.ok(
      Object.hasOwn(baselineProfiles, profile) &&
        baselineProfiles[profile].length > 0,
    );
    memberships.push({ profile, required: baselineProfiles[profile].length });
    for (const row of baselineProfiles[profile]) {
      const key = JSON.stringify([fileIds.get(row.file), row.name]);
      assert.ok(
        actualCases.has(key),
        "Frozen baseline callback missing from original source command",
      );
      subset.set(key, actualCases.get(key));
    }
  }
  return {
    scope:
      "Exact frozen baseline subset of the unchanged complete original source command; all original source records retained separately.",
    profiles: memberships,
    required: subset.size,
    cases: [...subset.values()],
    originalRequired: report.required,
    originalPassed: report.passed,
    originalSourceCommandComplete: sourceContract.kind === "required-profiles",
    originalSourceFragmentComplete:
      sourceContract.kind === "full-suite-fragment",
    wholeSuiteQualification: false,
  };
}

// Called by existing operator controllers around their unchanged source
// execution. The callback runs once; it is not a new source-test invocation.
export async function captureBaselineSourceFiles(
  root,
  profiles,
  selection,
  additionalFiles = [],
) {
  root = await realpath(root);
  await callbackIdentities(root, profiles, selection);
  const names = [
    ...new Set([
      ...selection.flatMap((profile) =>
        profiles[profile].map((row) => row.file),
      ),
      ...additionalFiles,
    ]),
  ];
  assert.ok(names.length > 0 && names.length <= 4096);
  const rows = [];
  for (const [index, file] of names.entries()) {
    assert.ok(
      typeof file === "string" &&
        file.startsWith("dist/test/") &&
        !file.split("/").includes(".."),
      "Unsafe original source file binding",
    );
    const full = path.join(root, file);
    assert.equal(
      await realpath(full),
      full,
      "Original source callback file is linked",
    );
    const stat = await lstat(full);
    assert.ok(stat.isFile() && stat.size <= 4 * 1024 * 1024);
    rows.push({
      id: "file-" + (index + 1),
      file,
      sha256: hash(await readFile(full)),
    });
  }
  return rows;
}

export async function captureBaselineSourceExecution({
  root,
  profiles,
  selection,
  additionalFiles = [],
  baselineProfiles,
  baselineSelection,
  binding,
  sourceContract,
  execute,
}) {
  assert.equal(
    typeof execute,
    "function",
    "Original source execution is required",
  );
  const scope = globalThis.structuredClone({
    profiles,
    selection,
    additionalFiles,
    baselineProfiles,
    baselineSelection,
    binding,
    sourceContract,
  });
  const files = await captureBaselineSourceFiles(
    root,
    scope.profiles,
    scope.selection,
    scope.additionalFiles,
  );
  const callbacks = await callbackIdentities(
    root,
    scope.baselineProfiles,
    scope.baselineSelection,
  );
  const runtime = await captureBaselineRuntime(scope.binding);
  const engineBefore = await captureCompiledEngine(path.join(root, "dist/src"));
  const originalReport = await execute();
  const subset = requireBaselineSourceSubset({
    report: originalReport,
    profiles: scope.profiles,
    selection: scope.selection,
    fileBindings: files,
    baselineProfiles: scope.baselineProfiles,
    baselineSelection: scope.baselineSelection,
    sourceContract: scope.sourceContract,
  });
  assert.deepEqual(
    await captureBaselineSourceFiles(
      root,
      scope.profiles,
      scope.selection,
      scope.additionalFiles,
    ),
    files,
    "Original source callback bytes changed during execution",
  );
  assert.deepEqual(
    await callbackIdentities(
      root,
      scope.baselineProfiles,
      scope.baselineSelection,
    ),
    callbacks,
    "Frozen baseline callback bytes changed during original source execution",
  );
  const compiledEngine = requireUnchangedCompiledEngine(
    engineBefore,
    await captureCompiledEngine(path.join(root, "dist/src")),
  );
  assert.deepEqual(
    await captureBaselineRuntime(scope.binding),
    runtime,
    "Original source runtime or tool bytes changed during execution",
  );
  return {
    schemaVersion: 1,
    profile: "preserved-baseline-original-source-v1",
    originalReport,
    subset,
    sourceScope: scope,
    fileBindings: files,
    callbacks,
    compiledEngine,
    runtime,
    beforeAfterRuntimeIdentitiesMatch: true,
    originalExecutionInvocations: 1,
    scope:
      "Unchanged original source command and its complete retained report, or one explicitly complete source fragment; no source callback replay by the wrapper.",
    wholeSuiteQualification: false,
    nativeLicenseClosureClaimed: false,
    gateAComplete: false,
    modelCalls: 0,
  };
}

export async function runFreshBaselineFromSourceCapture({
  sourceCapture,
  expectedSourceScope,
  sourceRoot,
  ...phase
}) {
  assert.ok(
    phase.installedPackage,
    "Source reuse requires a physically installed phase",
  );
  assert.equal(
    sourceCapture?.schemaVersion,
    1,
    "Missing original source capture",
  );
  assert.equal(sourceCapture.profile, "preserved-baseline-original-source-v1");
  assert.equal(sourceCapture.originalExecutionInvocations, 1);
  assert.equal(sourceCapture.beforeAfterRuntimeIdentitiesMatch, true);
  assert.equal(
    sourceCapture.compiledEngine.beforeAfterByteIdentitiesMatch,
    true,
  );
  assert.equal(sourceCapture.wholeSuiteQualification, false);
  assert.deepEqual(
    sourceCapture.sourceScope,
    expectedSourceScope,
    "Original source scope differs from the current controller contract",
  );
  assert.deepEqual(
    phase.profiles,
    expectedSourceScope.baselineProfiles,
    "Fresh phase omitted or changed frozen profile memberships",
  );
  assert.deepEqual(phase.selection, expectedSourceScope.baselineSelection);
  assert.deepEqual(phase.binding, expectedSourceScope.binding);
  const fileBindings = await captureBaselineSourceFiles(
    sourceRoot,
    expectedSourceScope.profiles,
    expectedSourceScope.selection,
    expectedSourceScope.additionalFiles,
  );
  assert.deepEqual(
    sourceCapture.fileBindings,
    fileBindings,
    "Original source capture has stale callback files",
  );
  const subset = requireBaselineSourceSubset({
    report: sourceCapture.originalReport,
    profiles: expectedSourceScope.profiles,
    selection: expectedSourceScope.selection,
    baselineProfiles: expectedSourceScope.baselineProfiles,
    baselineSelection: expectedSourceScope.baselineSelection,
    sourceContract: expectedSourceScope.sourceContract,
    fileBindings,
  });
  assert.deepEqual(
    sourceCapture.subset,
    subset,
    "Original source subset changed",
  );
  const callbacks = await callbackIdentities(
    sourceRoot,
    expectedSourceScope.baselineProfiles,
    expectedSourceScope.baselineSelection,
  );
  assert.deepEqual(
    sourceCapture.callbacks,
    callbacks,
    "Frozen source callbacks are stale",
  );
  assert.deepEqual(phase.expectedCallbacks, callbacks);
  const engine = await captureCompiledEngine(path.join(sourceRoot, "dist/src"));
  requireUnchangedCompiledEngine(sourceCapture.compiledEngine, engine);
  assert.equal(phase.expectedEngine.treeSha256, engine.treeSha256);
  assert.equal(phase.expectedEngine.manifestSha256, engine.manifestSha256);
  assert.deepEqual(
    sourceCapture.runtime,
    await captureBaselineRuntime(phase.binding),
    "Fresh runtime differs from the observed original source runtime",
  );
  const fresh = await runBaselinePhase(phase);
  assert.deepEqual(fresh.runtime, sourceCapture.runtime);
  return {
    schemaVersion: 1,
    profile: "preserved-baseline-source-reused-fresh-v1",
    originalSource: sourceCapture,
    fresh,
    sourceCallbacksReexecuted: false,
    sourceAndFreshSubsetComplete: true,
    wholeSuiteQualification: false,
    nativeLicenseClosureClaimed: false,
    gateAComplete: false,
    modelCalls: 0,
  };
}
