import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, rename, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";
import {
  buildNativeInputs,
  nativeJobIds,
  validateInputContract,
} from "./ci-impact.mjs";

try {
  const args = process.argv.slice(2);
  const update = args.length === 1 && args[0] === "--update-inputs";
  assert.ok(args.length === 0 || update, "Invalid CI preflight arguments");
  assert.ok(
    !update || process.env.GITHUB_ACTIONS !== "true",
    "CI cannot rewrite its expected input contract",
  );
  const json = async (file) => JSON.parse(await readFile(file, "utf8"));
  const manifest = await json("package.json");
  const lock = await json("package-lock.json");
  assert.equal(
    lock.lockfileVersion,
    3,
    "Expected the committed v3 dependency lock",
  );
  assert.equal(lock.name, manifest.name, "Root package name drift");
  assert.equal(lock.version, manifest.version, "Root package version drift");
  const root = lock.packages?.[""];
  assert.ok(root, "Root dependency lock entry missing");
  const namePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
  const versionPattern =
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  const names = new Set();
  const counts = {};
  for (const role of ["dependencies", "devDependencies"]) {
    const declarations = manifest[role] ?? {};
    assert.ok(
      declarations &&
        typeof declarations === "object" &&
        !Array.isArray(declarations),
      "Invalid dependency declarations",
    );
    assert.ok(
      isDeepStrictEqual(declarations, root[role] ?? {}),
      "Root dependency declaration drift",
    );
    counts[role] = Object.keys(declarations).length;
    for (const [name, declared] of Object.entries(declarations)) {
      assert.ok(
        namePattern.test(name) && !names.has(name),
        "Invalid or duplicate dependency role",
      );
      names.add(name);
      assert.equal(
        typeof declared,
        "string",
        "Dependency pin must be a string",
      );
      const alias = /^npm:(.+)@([^@]+)$/.exec(declared);
      const target = alias?.[1] ?? name;
      const version = alias?.[2] ?? declared;
      assert.ok(
        namePattern.test(target) && versionPattern.test(version),
        "Dependency declaration must be exactly pinned: " + name,
      );
      const selected = lock.packages["node_modules/" + name];
      assert.ok(
        selected && !selected.link && selected.version === version,
        "Selected dependency lock drift: " + name,
      );
      assert.ok(
        typeof selected.integrity === "string" && selected.integrity.length > 0,
        "Selected dependency integrity missing: " + name,
      );
      if (alias || selected.name !== undefined)
        assert.equal(
          selected.name,
          target,
          "Selected dependency identity drift: " + name,
        );
      const installed = await json(
        path.join("node_modules", name, "package.json"),
      );
      assert.ok(
        installed.name === target && installed.version === version,
        "Installed dependency metadata drift: " + name,
      );
    }
  }
  assert.ok(names.size > 0, "Dependency declaration inventory is empty");
  const workflow = parse(await readFile(".github/workflows/ci.yml", "utf8"));
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8", maxBuffer: 4 * 1048576 },
  )
    .split("\0")
    .filter(Boolean);
  const actual = await buildNativeInputs({
    workflow,
    requirements: await json("scripts/required-native-tests.json"),
    files,
    readText: (file) => readFile(file, "utf8"),
  });
  validateInputContract(actual, nativeJobIds(workflow));
  if (update) {
    const temporary = await mkdtemp("scripts/ci-input-update-");
    try {
      const next = path.join(temporary, "inputs.json");
      await writeFile(next, JSON.stringify(actual, null, 2) + "\n", {
        flag: "wx",
      });
      await rename(next, "scripts/ci-native-inputs.json");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  } else {
    assert.ok(
      isDeepStrictEqual(actual, await json("scripts/ci-native-inputs.json")),
      "CI input contract is stale; regenerate and review it before running the matrix",
    );
  }
  process.stdout.write(
    JSON.stringify({
      declaredDependencyMetadataConsistent: true,
      inputContractCurrent: true,
      inputContractUpdated: update,
      counts,
    }) + "\n",
  );
} catch (error) {
  // Assertion messages contain only fixed reasons and validated package names.
  process.stderr.write(
    "CI preflight failed: " +
      (error?.code === "ERR_ASSERTION"
        ? error.message.split("\n")[0]
        : "metadata unavailable or invalid") +
      "\n",
  );
  process.exitCode = 1;
}
