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
  "test/javascript-tool-preparation.test.ts",
  "test/consumer-witness-project.test.ts",
  "test/mutation-native-evidence.test.ts",
  "test/mutation-native-guards.test.ts",
  "test/mutation-native-selection.test.ts",
  "test/ci-development-dependencies.test.ts",
  "test/ci-validation.test.ts",
  "test/dependency-audit.test.ts",
  "test/development-dependency-audit.test.ts",
];
const dependencyCompleteControls = new Set([
  ...dependencyControlFiles,
  "test/artifact-evidence.test.ts",
  "test/ci-impact.test.ts",
  "test/ci-affected-tests.test.ts",
  "test/ci-source-boundaries.test.ts",
  "test/gate-inventory.test.ts",
]);
const dependencyNativeFiles = [
  "test/vite-library.test.ts",
  "test/gate-javascript-extensions.test.ts",
  "test/mutation-native-fixture.ts",
];
// Exact source/fixture wiring reviewed for the independent qualified graph.
// Unrelated source, audit and notice bytes are not part of this profile.
export const dependencyQualificationHashes = {
  "scripts/javascript-tools/package.json":
    "8178c794db4976dc569542f207a31817ee25bc0bca096e1508cde6e471457ede",
  "scripts/javascript-tools/package-lock.json":
    "ae19bc7b5fa2b518a105f26f8024aaeb913c72adebea889cfe584687843ad52e",
  "scripts/prepare-javascript-tools.mjs":
    "375bf189766d28ea627cde53a4bb8d34ceca4aebd1cbcccc00507091fd3a8d6f",
  "scripts/prepare-mutation-tools.mjs":
    "6b401e24eb53a49a956f2610283499665244b758386f6c618ed1020f18d3b5e6",
  "scripts/verify-import-context-package.mjs":
    "a8f0e3ef027f8b41d80b66430ac405d000b81a5301fe87d2cee18f5530dd8585",
  "scripts/verify-javascript-extensions-container.mjs":
    "cea36493b2f1df107cdfe137c5b6398d793471a5e93890686d6e28da5caa269e",
  "scripts/verify-consumer-project-profile.mjs":
    "9b52f40ba337b03d5f7f6fde34f1c3adea2b422ba251475aab088345affa2c4c",
  "scripts/verify-mutation-package.mjs":
    "b34ea0a17c7f663f1672f8eb28958a20ccbd4fc0e999385e59179aabdf29a522",
  "scripts/verify-mutation-container.mjs":
    "95444964f2f4dbd25336e57e7bbc480d9eee7fef4af036c60f4e2d31b5079f57",
  "scripts/verify-mutation-guards.mjs":
    "9545c961c31e2149cbce158c9b66c48ea43ac64a4c5cfef3d5e10b20569c7d43",
  "test/javascript-extensions-fixture.ts":
    "6428059f49cf07f6721c4d26a00995798eab29c864f2630e1de639cd3cb4478b",
  "test/mutation-native-fixture.ts":
    "dc088599885b222bc23a7e998db916fdb1f0486d04ecbed695e174cc05a4fe00",
  "test/tool-fixture.ts":
    "e0bf8f90a2bae5787b9f7aa790d3de44f6995e88467747b856f542b9106ca5be",
  "test/vite-library.test.ts":
    "be64a684bf53aa7a520e3106fa7ed39180c8605b8890ca014f99a519125fc145",
  "test/vitest.test.ts":
    "26c02594f74a7a9caa5dc67eb76c6fb084ff9faec50bcd26332a1003b5f4fd5f",
  "test/jest.test.ts":
    "82bc1d5e348eae205ead0f595ea5188e5c32e08d0c61c2b6158918dcb4dde03b",
  "test/development-bundlers.test.ts":
    "e49b3584d34c5f8c6dc5184bfc139e50bdbfa5f7031669fc81e82ec8989bc7e6",
};
export const dependencyConsumerHashes = {
  "scripts/smoke-package.mjs":
    "b8499f2ec473d8810e7c61816374ea385eb8ba9e551c08ea888fc02c5178b9c3",
  "src/jest-runner.ts":
    "ec20aca6cde95f08637d159fbfd81e119b91d28860fd2b9a82d2326a89518986",
  "src/mutation-jest-runner.ts":
    "ef860aecccffee5d0dd4007e42bf6e903699534717abdc2fe617245d9df8562f",
  "src/mutation-vitest-runner.ts":
    "89fa31be7729a6427f187f2d0ef8f03cc5e50f87c2d8eddc6d76cb005e22add4",
  "src/vite-library-prerequisites.ts":
    "441316a620d961aa61c887a1571d5edaa82dc4ff292d13a81609ee24d086a84f",
  "src/vite-library-runner.ts":
    "c78b6c7889f0100bdd24b3c28b2dc9d74670b5e5e26acaef9604e2da53e96daa",
  "src/vitest-runner.ts":
    "08d658c0083474b2b2c6ee9c542174149d426d2b461d46ad9fabef0170712a12",
  "test/development-bundlers.test.ts":
    "e49b3584d34c5f8c6dc5184bfc139e50bdbfa5f7031669fc81e82ec8989bc7e6",
  "test/javascript-extensions-fixture.ts":
    "6428059f49cf07f6721c4d26a00995798eab29c864f2630e1de639cd3cb4478b",
  "test/jest.test.ts":
    "82bc1d5e348eae205ead0f595ea5188e5c32e08d0c61c2b6158918dcb4dde03b",
  "test/mutation-native-fixture.ts":
    "dc088599885b222bc23a7e998db916fdb1f0486d04ecbed695e174cc05a4fe00",
  "test/vite-library.test.ts":
    "be64a684bf53aa7a520e3106fa7ed39180c8605b8890ca014f99a519125fc145",
  "test/vitest.test.ts":
    "26c02594f74a7a9caa5dc67eb76c6fb084ff9faec50bcd26332a1003b5f4fd5f",
};
// Freeze only unresolved module-resolution slices, not unrelated source bytes.
export const dependencyResolutionHash =
  "ea7d0afaa8f6636736220efad739d3ddcd068a84e1bd7c76835e4804977ac618";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function git(repository, args, options = {}) {
  return execFileSync("git", args, {
    cwd: repository,
    maxBuffer: 64 * 1048576,
    ...options,
  });
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
function snapshot(repository, revision, required) {
  const rows = git(repository, ["ls-tree", "-r", "-z", revision], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .map((row) => {
      const [metadata, file] = row.split("\t");
      const [mode, kind, object] = metadata.split(" ");
      return { mode, kind, object, file };
    });
  assert.ok(rows.length > 0 && rows.length <= 10000);
  const selected = rows.filter(
    ({ file }) => required.includes(file) || /\.[cm]?[jt]sx?$/.test(file),
  );
  for (const file of required)
    assert.ok(
      selected.some((row) => row.file === file),
      "Missing qualification input: " + file,
    );
  assert.ok(
    selected.every(
      (row) => row.kind === "blob" && ["100644", "100755"].includes(row.mode),
    ),
    "Unsupported source object",
  );
  const bytes = git(repository, ["cat-file", "--batch"], {
    input: selected.map((row) => row.object).join("\n") + "\n",
  });
  const texts = new Map();
  let offset = 0;
  for (const row of selected) {
    const end = bytes.indexOf(10, offset);
    assert.ok(end !== -1);
    const [object, kind, rawSize] = bytes
      .subarray(offset, end)
      .toString()
      .split(" ");
    const size = Number(rawSize);
    assert.equal(object, row.object);
    assert.equal(kind, "blob");
    assert.ok(Number.isSafeInteger(size) && size >= 0 && size <= 8 * 1048576);
    offset = end + 1;
    assert.ok(offset + size < bytes.length && bytes[offset + size] === 10);
    texts.set(row.file, bytes.subarray(offset, offset + size).toString("utf8"));
    offset += size + 1;
  }
  assert.equal(offset, bytes.length);
  return texts;
}
const packageName = (value) => {
  let decoded = decodeURIComponent(value).replaceAll("\\", "/").toLowerCase();
  if (/^(?:\.|\/|file:|[a-z]:\/)/.test(decoded)) {
    const installed = /(?:^|\/)node_modules\/(?:\.bin\/)?(.+)/.exec(decoded);
    if (installed) decoded = installed[1];
  }
  const name = decoded.startsWith("@")
    ? decoded.split("/").slice(0, 2).join("/")
    : decoded.split("/")[0];
  return name === "vitest-native-mutation" ? "vitest" : name;
};

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
function inspectedConsumers(texts, affected, hashes, resolutionHash) {
  const canonical = new Set(
    affected.map((name) =>
      name === "vitest-native-mutation" ? "vitest" : name,
    ),
  );
  const inspected = new Set(),
    resolutions = {};
  for (const [file, text] of texts) {
    if (!/\.[cm]?[jt]sx?$/.test(file) || file === "scripts/plan-ci-impact.mjs")
      continue;
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    assert.equal(
      ast.parseDiagnostics.length,
      0,
      "Unparseable consumer source: " + file,
    );
    const aliases = new Set(["copyInstalledPackages"]),
      factories = new Set(["createRequire"]),
      loaders = new Set(["require", "import.meta.resolve"]),
      evaluators = new Set([
        "eval",
        "Function",
        "globalThis.eval",
        "globalThis.Function",
      ]),
      declarations = new Map();
    function declarationsIn(node) {
      if (
        ts.isImportDeclaration(node) &&
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings)
      )
        for (const item of node.importClause.namedBindings.elements) {
          const imported = item.propertyName?.text ?? item.name.text;
          if (imported === "copyInstalledPackages") aliases.add(item.name.text);
          if (imported === "createRequire") factories.add(item.name.text);
        }
      if (ts.isVariableDeclaration(node)) {
        if (ts.isIdentifier(node.name)) {
          const name = node.name.text;
          declarations.set(
            name,
            declarations.has(name) ? null : node.initializer,
          );
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const item of node.name.elements)
            if (ts.isIdentifier(item.name)) {
              const imported = item.propertyName?.text ?? item.name.text;
              if (imported === "copyInstalledPackages")
                aliases.add(item.name.text);
              if (imported === "createRequire") factories.add(item.name.text);
              if (
                imported === "resolve" &&
                node.initializer?.getText(ast) === "import.meta"
              )
                loaders.add(item.name.text);
            }
        }
      }
      ts.forEachChild(node, declarationsIn);
    }
    declarationsIn(ast);
    const member = (node, name) =>
      !!node &&
      ((ts.isPropertyAccessExpression(node) && node.name.text === name) ||
        (ts.isElementAccessExpression(node) &&
          node.argumentExpression &&
          ts.isStringLiteralLike(node.argumentExpression) &&
          node.argumentExpression.text === name));
    let previous = -1;
    while (
      previous !==
      aliases.size + factories.size + loaders.size + evaluators.size
    ) {
      previous = aliases.size + factories.size + loaders.size + evaluators.size;
      for (const [name, initializer] of declarations) {
        if (!initializer) continue;
        const value = initializer.getText(ast);
        if (evaluators.has(value)) evaluators.add(name);
        if (aliases.has(value) || member(initializer, "copyInstalledPackages"))
          aliases.add(name);
        if (factories.has(value) || member(initializer, "createRequire"))
          factories.add(name);
        if (
          loaders.has(value) ||
          (ts.isCallExpression(initializer) &&
            (factories.has(initializer.expression.getText(ast)) ||
              member(initializer.expression, "createRequire"))) ||
          (member(initializer, "resolve") &&
            loaders.has(initializer.expression.getText(ast)))
        )
          loaders.add(name);
      }
    }
    const literals = (node, depth = 0) => {
      if (!node || depth > 8) return null;
      if (ts.isStringLiteralLike(node)) return [node.text];
      if (ts.isParenthesizedExpression(node))
        return literals(node.expression, depth + 1);
      if (ts.isIdentifier(node))
        return literals(declarations.get(node.text), depth + 1);
      if (ts.isArrayLiteralExpression(node)) {
        const values = node.elements.map((item) => literals(item, depth + 1));
        return values.every(Boolean) ? values.flat() : null;
      }
      if (ts.isConditionalExpression(node)) {
        const left = literals(node.whenTrue, depth + 1),
          right = literals(node.whenFalse, depth + 1);
        return left && right ? [...left, ...right] : null;
      }
      return null;
    };
    const local = (node) => {
      const value = literals(node);
      if (
        value?.every(
          (item) =>
            /^(?:\.\.?\/|node:|data:|file:)/.test(item) &&
            !item.includes("node_modules"),
        )
      )
        return true;
      if (
        node &&
        ts.isPropertyAccessExpression(node) &&
        node.name.text === "href"
      )
        return local(node.expression);
      return !!(
        node &&
        ts.isNewExpression(node) &&
        node.expression.getText(ast) === "URL" &&
        local(node.arguments?.[0])
      );
    };
    const sites = [];
    const resolutionSlice = (node) => {
      const values = new Set([node.getText(ast)]),
        seen = new Set();
      function visitName(item) {
        if (ts.isIdentifier(item) && !seen.has(item.text)) {
          seen.add(item.text);
          const declaration = declarations.get(item.text);
          if (declaration) {
            values.add(declaration.getText(ast));
            ts.forEachChild(declaration, visitName);
          }
        }
        ts.forEachChild(item, visitName);
      }
      visitName(node);
      return [...values].sort();
    };
    let consumer = false;
    function visit(node) {
      if (
        ts.isNewExpression(node) &&
        evaluators.has(node.expression.getText(ast))
      )
        sites.push(resolutionSlice(node));
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        canonical.has(packageName(node.moduleSpecifier.text))
      )
        consumer = true;
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal) &&
        canonical.has(packageName(node.argument.literal.text))
      )
        consumer = true;
      if (ts.isCallExpression(node)) {
        const expression = node.expression.getText(ast);
        if (
          evaluators.has(expression) ||
          /(?:^|\.)(?:runInContext|runInNewContext|runInThisContext|compileFunction)$/.test(
            expression,
          )
        )
          sites.push(resolutionSlice(node));
        const cli =
          /(?:^|\.)(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)$/.test(
            expression,
          );
        if (cli) {
          const command = literals(node.arguments[0]);
          const args = literals(node.arguments[1]);
          const rootPath = (value) => {
            const decoded = decodeURIComponent(value).replaceAll("\\", "/");
            const match = /(?:^|\/)node_modules\/(?:\.bin\/)?(.+)/.exec(
              decoded,
            );
            return match && canonical.has(packageName(match[1]));
          };
          if (
            command?.some(
              (value) =>
                canonical.has(packageName(value.split(/\s+/)[0])) ||
                rootPath(value),
            ) ||
            args?.some(rootPath) ||
            (command?.some((value) => ["npx", "npm"].includes(value)) &&
              args?.some((value) => canonical.has(packageName(value))))
          )
            consumer = true;
          if (
            !command ||
            ((command.includes("node") ||
              node.arguments[0]?.getText(ast) === "process.execPath") &&
              !args)
          )
            sites.push(resolutionSlice(node));
        }
        if (
          aliases.has(expression) ||
          member(node.expression, "copyInstalledPackages")
        ) {
          const values = literals(node.arguments[1]);
          if (!values) sites.push(resolutionSlice(node));
          else if (values.some((name) => canonical.has(packageName(name))))
            consumer = true;
        }
        if (
          node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          loaders.has(expression) ||
          (member(node.expression, "resolve") &&
            loaders.has(node.expression.expression.getText(ast))) ||
          (ts.isCallExpression(node.expression) &&
            (factories.has(node.expression.expression.getText(ast)) ||
              member(node.expression.expression, "createRequire")))
        ) {
          const values = literals(node.arguments[0]);
          if (values?.some((name) => canonical.has(packageName(name))))
            consumer = true;
          else if (!values && !local(node.arguments[0]))
            sites.push(resolutionSlice(node));
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    // These exact Node control files run in their entirety for every admitted
    // dependency plan. Their audit/Git subprocess wiring adds no omitted native
    // consumer, and unrelated audit implementation bytes are not hash-gated.
    if (sites.length && !dependencyCompleteControls.has(file)) {
      const fingerprint = digest(JSON.stringify(sites));
      resolutions[file] = fingerprint;
    }
    if (consumer) {
      assert.equal(
        digest(text),
        hashes[file],
        "Unreviewed dependency consumer: " + file,
      );
      inspected.add(file);
    }
  }
  assert.equal(
    digest(JSON.stringify(resolutions)),
    resolutionHash,
    "Unreviewed module-resolution/copy wiring",
  );
  return {
    observedConsumers: [...inspected].sort(),
    moduleResolutionInventorySha256: resolutionHash,
  };
}
export function classifyDevelopmentBump({
  repository = process.cwd(),
  base,
  head,
  workflow,
  inputs,
  qualificationHashes = dependencyQualificationHashes,
  consumerHashes = dependencyConsumerHashes,
  resolutionHash = dependencyResolutionHash,
}) {
  assert.match(base, /^[a-f0-9]{40}$/);
  assert.match(head, /^[a-f0-9]{40}$/);
  const changed = git(
    repository,
    ["diff", "--name-only", "-z", "--no-renames", base, head],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  assert.deepEqual(
    changed,
    ["package-lock.json", "package.json"],
    "Dependency selection requires only root manifest and lock changes",
  );
  assert.equal(
    workflow.jobs["host-validation"]?.if,
    dependencyHostCondition,
    "Required host dependency routing unavailable",
  );
  const required = [
    "package.json",
    "package-lock.json",
    ...Object.keys(qualificationHashes),
  ];
  const before = snapshot(repository, base, required),
    after = snapshot(repository, head, required);
  for (const [file, expected] of Object.entries(qualificationHashes)) {
    assert.equal(
      before.get(file),
      after.get(file),
      "Qualification input changed: " + file,
    );
    assert.equal(
      digest(after.get(file)),
      expected,
      "Unsupported qualification input: " + file,
    );
  }
  const m0 = jsonObject(before.get("package.json"), "package.json"),
    m1 = jsonObject(after.get("package.json"), "package.json");
  const l0 = jsonObject(before.get("package-lock.json"), "package-lock.json"),
    l1 = jsonObject(after.get("package-lock.json"), "package-lock.json");
  const without = (value, field) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
  assert.deepEqual(
    without(m0, "devDependencies"),
    without(m1, "devDependencies"),
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
  for (const command of Object.values(m0.scripts ?? {}))
    assert.ok(
      typeof command === "string" &&
        !/(?:^|[\s;&|])(?:vite|rolldown|vitest|jest)(?:[\s;&|]|$)/.test(
          command,
        ),
      "Root tool is used by a build/test script",
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
  const { observedConsumers, moduleResolutionInventorySha256 } =
    inspectedConsumers(after, affected, consumerHashes, resolutionHash);
  const routedFiles = [
    ...new Set([
      ...dependencyNativeFiles,
      ...affected.flatMap((name) => consumerFiles[name]),
      ...observedConsumers.filter(
        (file) =>
          file.startsWith("test/") &&
          Array.isArray(inputs[file]) &&
          inputs[file].length > 0,
      ),
    ]),
  ].sort();
  for (const file of routedFiles)
    assert.ok(
      Array.isArray(inputs[file]) && inputs[file].length > 0,
      "Missing declared dependency consumer owners: " + file,
    );
  const sharedTestFiles = [
    ...new Set([
      ...dependencyControlFiles,
      ...observedConsumers.filter(
        (file) => file.startsWith("test/") && file.endsWith(".test.ts"),
      ),
      ...routedFiles.filter((file) => file.endsWith(".test.ts")),
    ]),
  ];
  for (const file of sharedTestFiles)
    assert.ok(after.has(file), "Missing dependency regression: " + file);
  return {
    routedFiles,
    sharedTestFiles: sharedTestFiles
      .map((file) => "dist/" + file.replace(/\.ts$/, ".js"))
      .sort(),
    evidence: {
      scope: "development-dependency-consumers-v1",
      declaredBumps: bumps.sort().map((name) => ({
        name,
        before: m0.devDependencies[name],
        after: m1.devDependencies[name],
      })),
      affectedDevelopmentRoots: affected,
      changedLockEntries: [...changedNodes].sort(),
      observedConsumers,
      moduleResolutionInventorySha256,
      qualifiedLockSha256: digest(
        after.get("scripts/javascript-tools/package-lock.json"),
      ),
    },
  };
}

export async function main(dependencyProfile = {}) {
  const workflow = parse(await readFile(".github/workflows/ci.yml", "utf8"));
  const jobs = nativeJobIds(workflow);
  const inputs = JSON.parse(
    await readFile("scripts/ci-native-inputs.json", "utf8"),
  );
  let changed = null,
    baseline = null,
    contractCurrent = false,
    developmentImpact = null,
    dependencyFallback = null;
  try {
    const files = execFileSync("git", ["ls-files", "-z"], {
      encoding: "utf8",
      maxBuffer: 4 * 1048576,
    })
      .split("\0")
      .filter(Boolean);
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
            ...dependencyProfile,
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
