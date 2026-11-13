import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  cp,
  symlink,
  mkdir,
  readFile,
  realpath,
  readdir,
  writeFile,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { fixture } from "./helpers.js";

const localFixture: typeof fixture = async (t, files) =>
  realpath(await fixture(t, files));

const repository = fileURLToPath(new URL("../../", import.meta.url));
const {
  copySmokeToolGraph,
  smokeProjectPath,
  preparePackageSmokeTools,
  qualifiedSmokePackages,
  frameworkSmokePackages,
} = await import(
  new URL("../../scripts/package-smoke-tools.mjs", import.meta.url).href
);
const metadata = (name: string, version: string, extra = {}) =>
  JSON.stringify({ name, version, ...extra });

test("smoke tools retain the selected nested graph and leave a conflicting production installation untouched", async (t) => {
  const root = await localFixture(t, {
    "source/package.json": "{}",
    "source/node_modules/tool/package.json": metadata("tool", "1.0.0", {
      dependencies: { nested: "1.0.0" },
      optionalDependencies: { absent: "1.0.0" },
    }),
    "source/node_modules/tool/index.js":
      "throw Error('Fixture package code must not execute');",
    "source/node_modules/tool/node_modules/nested/package.json": metadata(
      "nested",
      "1.0.0",
    ),
    "source/node_modules/nested/package.json": metadata("nested", "2.0.0"),
    "consumer/node_modules/tool/package.json": metadata("tool", "99.0.0"),
    "consumer/node_modules/tool/index.js":
      "Original production payload; must remain unchanged.",
  });
  const lock = {
    lockfileVersion: 3,
    packages: {
      "node_modules/tool": {
        version: "1.0.0",
        dependencies: { nested: "1.0.0" },
        optionalDependencies: { absent: "1.0.0" },
      },
      "node_modules/tool/node_modules/nested": { version: "1.0.0" },
      "node_modules/nested": { version: "2.0.0" },
      "node_modules/absent": { version: "1.0.0", optional: true },
    },
  };
  const destination = path.join(root, "consumer/qualified");
  const before = await readFile(
    path.join(root, "consumer/node_modules/tool/package.json"),
  );
  const result = await copySmokeToolGraph(destination, {
    modules: path.join(root, "source/node_modules"),
    packages: ["tool"],
    lock,
  });
  assert.deepEqual(
    result.packages.map((p: { location: string; version: string }) => [
      p.location,
      p.version,
    ]),
    [
      ["node_modules/tool", "1.0.0"],
      ["node_modules/tool/node_modules/nested", "1.0.0"],
    ],
  );
  assert.deepEqual(
    await readFile(path.join(root, "consumer/node_modules/tool/package.json")),
    before,
  );
  assert.equal(
    await readFile(
      path.join(root, "consumer/node_modules/tool/index.js"),
      "utf8",
    ),
    "Original production payload; must remain unchanged.",
  );
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(
          destination,
          "node_modules/tool/node_modules/nested/package.json",
        ),
        "utf8",
      ),
    ).version,
    "1.0.0",
  );
  await assert.rejects(access(path.join(destination, "node_modules/absent")));
  await assert.rejects(access(path.join(destination, "node_modules/nested")));
});

test("smoke graph admission refuses missing or drifting identities before publishing any namespace", async (t) => {
  for (const kind of ["version", "name", "unlocked", "missing"] as const) {
    const root = await localFixture(t, {
      "source/package.json": "{}",
      "source/node_modules/first/package.json": metadata("first", "1.0.0", {
        dependencies: { second: "1.0.0" },
      }),
      ...(kind === "missing"
        ? {}
        : {
            "source/node_modules/second/package.json": metadata(
              kind === "name" ? "changed-name" : "second",
              kind === "version" ? "2.0.0" : "1.0.0",
            ),
          }),
      "consumer/production-marker": "Original production marker",
    });
    const lock = {
      lockfileVersion: 3,
      packages: {
        "node_modules/first": {
          version: "1.0.0",
          dependencies: { second: "1.0.0" },
        },
        ...(kind === "unlocked"
          ? {}
          : { "node_modules/second": { version: "1.0.0" } }),
      },
    };
    const destination = path.join(root, "consumer/qualified");
    await assert.rejects(
      copySmokeToolGraph(destination, {
        modules: path.join(root, "source/node_modules"),
        packages: ["first"],
        lock,
      }),
      kind === "version"
        ? /version differs/
        : kind === "name"
          ? /name differs/
          : kind === "unlocked"
            ? /outside the selected lock/
            : /Missing installed test dependency second/,
    );
    await assert.rejects(access(destination));
    assert.equal(
      await readFile(path.join(root, "consumer/production-marker"), "utf8"),
      "Original production marker",
    );
  }
});

test("smoke rejects omitted renamed and rangedrift dependency declarations even when package versions match", async (t) => {
  for (const kind of ["omitted", "renamed", "range"] as const) {
    const sourceDependencies =
      kind === "omitted"
        ? {}
        : kind === "renamed"
          ? { renamed: "1.0.0" }
          : { child: "^1.0.0" };
    const root = await localFixture(t, {
      "source/package.json": "{}",
      "source/node_modules/parent/package.json": metadata("parent", "1.0.0", {
        dependencies: sourceDependencies,
      }),
      "source/node_modules/child/package.json": metadata("child", "1.0.0"),
      "source/node_modules/renamed/package.json": metadata("renamed", "1.0.0"),
    });
    const destination = path.join(root, "tools");
    await assert.rejects(
      copySmokeToolGraph(destination, {
        modules: path.join(root, "source/node_modules"),
        packages: ["parent"],
        lock: {
          lockfileVersion: 3,
          packages: {
            "node_modules/parent": {
              version: "1.0.0",
              dependencies: { child: "1.0.0" },
            },
            "node_modules/child": { version: "1.0.0" },
            "node_modules/renamed": { version: "1.0.0" },
          },
        },
      }),
      /declarations differ from lock/,
      kind,
    );
    await assert.rejects(access(destination));
  }
});

test("smoke resolves required peers and their dependencies and refuses a missing peer before publication", async (t) => {
  const root = await localFixture(t, {
    "source/package.json": "{}",
    "source/node_modules/parent/package.json": metadata("parent", "1.0.0", {
      peerDependencies: { peer: "1.0.0" },
    }),
    "source/node_modules/peer/package.json": metadata("peer", "1.0.0", {
      dependencies: { child: "1.0.0" },
    }),
    "source/node_modules/child/package.json": metadata("child", "1.0.0"),
  });
  const options = {
    modules: path.join(root, "source/node_modules"),
    packages: ["parent"],
    lock: {
      lockfileVersion: 3,
      packages: {
        "node_modules/parent": {
          version: "1.0.0",
          peerDependencies: { peer: "1.0.0" },
        },
        "node_modules/peer": {
          version: "1.0.0",
          dependencies: { child: "1.0.0" },
        },
        "node_modules/child": { version: "1.0.0" },
      },
    },
  };
  const copied = await copySmokeToolGraph(path.join(root, "valid"), options);
  assert.deepEqual(
    copied.packages.map((row: { location: string }) => row.location),
    ["node_modules/parent", "node_modules/peer", "node_modules/child"],
  );
  await rm(path.join(root, "source/node_modules/peer"), { recursive: true });
  const destination = path.join(root, "missing");
  await assert.rejects(
    copySmokeToolGraph(destination, options),
    /Missing installed test dependency peer/,
  );
  await assert.rejects(access(destination));
});

test("smoke cannot let optional-first discovery suppress a later required peer", async (t) => {
  const root = await localFixture(t, {
    "source/package.json": "{}",
    "source/node_modules/optional-owner/package.json": metadata(
      "optional-owner",
      "1.0.0",
      {
        peerDependencies: { peer: "1.0.0" },
        peerDependenciesMeta: { peer: { optional: true } },
      },
    ),
    "source/node_modules/required-owner/package.json": metadata(
      "required-owner",
      "1.0.0",
      { peerDependencies: { peer: "1.0.0" } },
    ),
  });
  const options = {
    modules: path.join(root, "source/node_modules"),
    packages: ["optional-owner", "required-owner"],
    lock: {
      lockfileVersion: 3,
      packages: {
        "node_modules/optional-owner": {
          version: "1.0.0",
          peerDependencies: { peer: "1.0.0" },
          peerDependenciesMeta: { peer: { optional: true } },
        },
        "node_modules/required-owner": {
          version: "1.0.0",
          peerDependencies: { peer: "1.0.0" },
        },
        "node_modules/peer": { version: "1.0.0" },
      },
    },
  };
  const destination = path.join(root, "missing");
  await assert.rejects(
    copySmokeToolGraph(destination, options),
    /Missing installed test dependency peer/,
  );
  await assert.rejects(access(destination));
  await mkdir(path.join(root, "source/node_modules/peer"));
  await writeFile(
    path.join(root, "source/node_modules/peer/package.json"),
    metadata("peer", "1.0.0"),
  );
  const present = await copySmokeToolGraph(path.join(root, "present"), options);
  assert.deepEqual(
    present.packages.map((row: { location: string }) => row.location),
    [
      "node_modules/optional-owner",
      "node_modules/peer",
      "node_modules/required-owner",
    ],
  );
});

test("smoke accepts effective optional overrides and absent optional dependencies and peers", async (t) => {
  const root = await localFixture(t, {
    "source/package.json": "{}",
    "source/node_modules/parent/package.json": metadata("parent", "1.0.0", {
      dependencies: { child: "source-shadowed-range" },
      optionalDependencies: { child: "1.0.0" },
      peerDependencies: { peer: "1.0.0" },
      peerDependenciesMeta: { peer: { optional: true } },
    }),
  });
  const result = await copySmokeToolGraph(path.join(root, "valid"), {
    modules: path.join(root, "source/node_modules"),
    packages: ["parent"],
    lock: {
      lockfileVersion: 3,
      packages: {
        "node_modules/parent": {
          version: "1.0.0",
          dependencies: { child: "lock-shadowed-range" },
          optionalDependencies: { child: "1.0.0" },
          peerDependencies: { peer: "1.0.0" },
          peerDependenciesMeta: { peer: { optional: true } },
        },
        "node_modules/child": { version: "1.0.0", optional: true },
        "node_modules/peer": { version: "1.0.0", optional: true },
      },
    },
  });
  assert.deepEqual(
    result.packages.map((row: { location: string }) => row.location),
    ["node_modules/parent"],
  );
  for (const name of ["child", "peer"])
    await assert.rejects(access(path.join(root, "valid/node_modules", name)));
});

test("smoke refuses a missing locked nested child instead of borrowing a different locked root version", async (t) => {
  const root = await localFixture(t, {
    "source/package.json": "{}",
    "source/node_modules/parent/package.json": metadata("parent", "1.0.0", {
      dependencies: { child: "1.0.0" },
    }),
    "source/node_modules/child/package.json": metadata("child", "2.0.0"),
  });
  const options = {
    modules: path.join(root, "source/node_modules"),
    packages: ["parent"],
    lock: {
      lockfileVersion: 3,
      packages: {
        "node_modules/parent": {
          version: "1.0.0",
          dependencies: { child: "1.0.0" },
        },
        "node_modules/parent/node_modules/child": { version: "1.0.0" },
        "node_modules/child": { version: "2.0.0" },
      },
    },
  };
  const destination = path.join(root, "missing");
  await assert.rejects(
    copySmokeToolGraph(destination, options),
    /Missing installed test dependency child/,
  );
  await assert.rejects(access(destination));
  await mkdir(
    path.join(root, "source/node_modules/parent/node_modules/child"),
    { recursive: true },
  );
  await writeFile(
    path.join(
      root,
      "source/node_modules/parent/node_modules/child/package.json",
    ),
    metadata("child", "1.0.0"),
  );
  const restored = await copySmokeToolGraph(
    path.join(root, "restored"),
    options,
  );
  assert.deepEqual(
    restored.packages.map((row: { location: string; version: string }) => [
      row.location,
      row.version,
    ]),
    [
      ["node_modules/parent", "1.0.0"],
      ["node_modules/parent/node_modules/child", "1.0.0"],
    ],
  );
  await assert.rejects(access(path.join(root, "restored/node_modules/child")));
});

test("smoke preserves a missing locked optional child without borrowing a root fallback", async (t) => {
  const root = await localFixture(t, {
    "source/package.json": "{}",
    "source/node_modules/parent/package.json": metadata("parent", "1.0.0", {
      optionalDependencies: { child: "1.0.0" },
    }),
    "source/node_modules/child/package.json": metadata("child", "2.0.0"),
  });
  const copied = await copySmokeToolGraph(path.join(root, "valid"), {
    modules: path.join(root, "source/node_modules"),
    packages: ["parent"],
    lock: {
      lockfileVersion: 3,
      packages: {
        "node_modules/parent": {
          version: "1.0.0",
          optionalDependencies: { child: "1.0.0" },
        },
        "node_modules/parent/node_modules/child": {
          version: "1.0.0",
          optional: true,
        },
        "node_modules/child": { version: "2.0.0" },
      },
    },
  });
  assert.deepEqual(
    copied.packages.map((row: { location: string }) => row.location),
    ["node_modules/parent"],
  );
  await assert.rejects(access(path.join(root, "valid/node_modules/child")));
});

test("smoke refuses an unlocked physical candidate without a manifest instead of borrowing a locked fallback", async (t) => {
  const root = await localFixture(t, {
    "source/package.json": "{}",
    "source/node_modules/parent/package.json": metadata("parent", "1.0.0", {
      dependencies: { child: "1.0.0" },
    }),
    "source/node_modules/parent/node_modules/child/index.js":
      "throw Error('Unlocked candidate must not execute');",
    "source/node_modules/child/package.json": metadata("child", "1.0.0"),
  });
  const destination = path.join(root, "refused");
  await assert.rejects(
    copySmokeToolGraph(destination, {
      modules: path.join(root, "source/node_modules"),
      packages: ["parent"],
      lock: {
        lockfileVersion: 3,
        packages: {
          "node_modules/parent": {
            version: "1.0.0",
            dependencies: { child: "1.0.0" },
          },
          "node_modules/child": { version: "1.0.0" },
        },
      },
    }),
    /outside the selected lock/,
  );
  await assert.rejects(access(destination));
});

test("smoke includes a present optional peer while allowing its declared absent near miss", async (t) => {
  const root = await localFixture(t, {
    "source/package.json": "{}",
    "source/node_modules/parent/package.json": metadata("parent", "1.0.0", {
      peerDependencies: { peer: "1.0.0" },
      peerDependenciesMeta: { peer: { optional: true } },
    }),
    "source/node_modules/peer/package.json": metadata("peer", "1.0.0"),
  });
  const options = {
    modules: path.join(root, "source/node_modules"),
    packages: ["parent"],
    lock: {
      lockfileVersion: 3,
      packages: {
        "node_modules/parent": {
          version: "1.0.0",
          peerDependencies: { peer: "1.0.0" },
          peerDependenciesMeta: { peer: { optional: true } },
        },
        "node_modules/peer": { version: "1.0.0", optional: true },
      },
    },
  };
  const present = await copySmokeToolGraph(path.join(root, "present"), options);
  assert.deepEqual(
    present.packages.map((row: { location: string }) => row.location),
    ["node_modules/parent", "node_modules/peer"],
  );
  await rm(path.join(root, "source/node_modules/peer"), { recursive: true });
  const absent = await copySmokeToolGraph(path.join(root, "absent"), options);
  assert.deepEqual(
    absent.packages.map((row: { location: string }) => row.location),
    ["node_modules/parent"],
  );
});

test("smoke refuses a malformed installed optional package instead of classifying it absent", async (t) => {
  for (const malformed of [true, false]) {
    const root = await localFixture(t, {
      "source/package.json": "{}",
      "source/node_modules/parent/package.json": metadata("parent", "1.0.0", {
        optionalDependencies: { child: "1.0.0" },
      }),
      "source/node_modules/child/index.js":
        "throw Error('Metadata-only fixture must not execute');",
      ...(malformed ? { "source/node_modules/child/package.json": "{" } : {}),
    });
    const destination = path.join(root, "refused");
    await assert.rejects(
      copySmokeToolGraph(destination, {
        modules: path.join(root, "source/node_modules"),
        packages: ["parent"],
        lock: {
          lockfileVersion: 3,
          packages: {
            "node_modules/parent": {
              version: "1.0.0",
              optionalDependencies: { child: "1.0.0" },
            },
            "node_modules/child": { version: "1.0.0", optional: true },
          },
        },
      }),
      malformed ? SyntaxError : /Invalid installed optional test dependency/,
    );
    await assert.rejects(access(destination));
  }
});

test("smoke namespaces refuse an existing empty destination and keep explicit project roles separate", async (t) => {
  const root = await localFixture(t, {
    "source/package.json": "{}",
    "source/node_modules/tool/package.json": metadata("tool", "1.0.0"),
  });
  const destination = path.join(root, "existing");
  await mkdir(destination);
  await assert.rejects(
    copySmokeToolGraph(destination, {
      modules: path.join(root, "source/node_modules"),
      packages: ["tool"],
      lock: {
        lockfileVersion: 3,
        packages: { "node_modules/tool": { version: "1.0.0" } },
      },
    }),
  );
  await assert.rejects(access(path.join(destination, "node_modules")));
  for (const name of [
    "node-test",
    "typescript",
    "typescript-build",
    "eslint",
    "vitest",
    "jest",
  ])
    assert.equal(smokeProjectPath(name), "smoke-tools/qualified-js/" + name);
  assert.equal(
    smokeProjectPath("vue-tsc"),
    "smoke-tools/root-frameworks/vue-tsc",
  );
  assert.equal(
    smokeProjectPath("playwright"),
    "smoke-tools/qualified-playwright/playwright",
  );
  assert.throws(() => smokeProjectPath("unknown"), /Unknown smoke project/);
});

test("smoke publishes all three role graphs together and removes staged tools when either later role drifts", async (t) => {
  const entry = (name: string) => ({
    name,
    version: "1.0.0",
    resolved: "https://registry.npmjs.org/" + name + "/-/original.tgz",
    integrity: "sha512-" + Buffer.alloc(64).toString("base64"),
  });
  const dependencies = Object.fromEntries(
    qualifiedSmokePackages.map((name: string) => [name, "1.0.0"]),
  );
  const profile = {
    name: "checktrail-javascript-acceptance-tools",
    version: "0.0.0",
    private: true,
    dependencies,
  };
  const rootLock = {
    lockfileVersion: 3,
    packages: Object.fromEntries(
      frameworkSmokePackages.map((name: string) => [
        "node_modules/" + name,
        entry(name),
      ]),
    ),
  };
  const qualifiedLock = {
    name: profile.name,
    version: profile.version,
    lockfileVersion: 3,
    packages: {
      "": profile,
      ...Object.fromEntries(
        qualifiedSmokePackages.map((name: string) => [
          "node_modules/" + name,
          entry(name),
        ]),
      ),
    },
  };
  const playwrightProfile = {
    name: "checktrail-playwright-acceptance-tools",
    version: "0.0.0",
    private: true,
    dependencies: { "@playwright/test": "1.0.0" },
  };
  const playwrightDependencies: Record<string, Record<string, string>> = {
    "@playwright/test": { playwright: "1.0.0" },
    playwright: { "playwright-core": "1.0.0" },
    "playwright-core": {},
  };
  const playwrightLock = {
    name: playwrightProfile.name,
    version: playwrightProfile.version,
    lockfileVersion: 3,
    packages: {
      "": playwrightProfile,
      ...Object.fromEntries(
        Object.entries(playwrightDependencies).map(([name, dependencies]) => [
          "node_modules/" + name,
          { ...entry(name), dependencies },
        ]),
      ),
    },
  };
  const files: Record<string, string> = {
    "source/scripts/playwright-tools/package.json":
      JSON.stringify(playwrightProfile),
    "source/scripts/playwright-tools/package-lock.json":
      JSON.stringify(playwrightLock),
    "source/.checktrail/playwright-tools/package.json":
      JSON.stringify(playwrightProfile),
    "source/node_modules/@playwright/test/package.json": metadata(
      "@playwright/test",
      "99.0.0",
    ),
    "source/scripts/javascript-tools/package.json": JSON.stringify(profile),
    "source/scripts/javascript-tools/package-lock.json":
      JSON.stringify(qualifiedLock),
    "source/package-lock.json": JSON.stringify(rootLock),
    "source/package.json": "{}",
    "source/.checktrail/javascript-tools/package.json": JSON.stringify(profile),
    "consumer/package.json": "{}",
    "consumer/package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: { "": {}, "node_modules/tool": { version: "99.0.0" } },
    }),
    "consumer/node_modules/tool/package.json": metadata("tool", "99.0.0"),
  };
  for (const name of qualifiedSmokePackages)
    files[
      "source/.checktrail/javascript-tools/node_modules/" +
        name +
        "/package.json"
    ] = metadata(name, "1.0.0");
  for (const name of frameworkSmokePackages)
    files["source/node_modules/" + name + "/package.json"] = metadata(
      name,
      name === "vue-tsc" ? "2.0.0" : "1.0.0",
    );
  for (const [name, dependencies] of Object.entries(playwrightDependencies))
    files[
      "source/.checktrail/playwright-tools/node_modules/" +
        name +
        "/package.json"
    ] = metadata(name, name === "playwright-core" ? "2.0.0" : "1.0.0", {
      dependencies,
    });
  const root = await localFixture(t, files),
    consumer = path.join(root, "consumer"),
    source = path.join(root, "source");
  await assert.rejects(
    preparePackageSmokeTools(consumer, source),
    /version differs from lock/,
  );
  assert.deepEqual((await readdir(consumer)).sort(), [
    "node_modules",
    "package-lock.json",
    "package.json",
  ]);
  await writeFile(
    path.join(source, "node_modules/vue-tsc/package.json"),
    metadata("vue-tsc", "1.0.0"),
  );
  // The first two graphs are valid now; failure in the third must also leave no prefix.
  await assert.rejects(
    preparePackageSmokeTools(consumer, source),
    /version differs from lock/,
  );
  assert.deepEqual((await readdir(consumer)).sort(), [
    "node_modules",
    "package-lock.json",
    "package.json",
  ]);
  await writeFile(
    path.join(
      source,
      ".checktrail/playwright-tools/node_modules/playwright-core/package.json",
    ),
    metadata("playwright-core", "1.0.0", { dependencies: {} }),
  );
  const direct = await preparePackageSmokeTools(consumer, source);
  for (const role of ["qualified-js", "root-frameworks"])
    await access(
      path.join(
        consumer,
        "smoke-tools",
        role,
        "node_modules/typescript/package.json",
      ),
    );
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(
          consumer,
          "smoke-tools/qualified-playwright/node_modules/@playwright/test/package.json",
        ),
        "utf8",
      ),
    ).version,
    "1.0.0",
  );
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(consumer, "node_modules/tool/package.json"),
        "utf8",
      ),
    ).version,
    "99.0.0",
  );
  for (const [name, targets, modules, packages, lock] of [
    [
      "framework root",
      ["node_modules"],
      "node_modules",
      frameworkSmokePackages,
      rootLock,
    ],
    [
      "qualified JavaScript root",
      [".checktrail/javascript-tools"],
      ".checktrail/javascript-tools/node_modules",
      qualifiedSmokePackages,
      qualifiedLock,
    ],
    [
      "qualified Playwright root",
      [".checktrail/playwright-tools"],
      ".checktrail/playwright-tools/node_modules",
      ["@playwright/test"],
      playwrightLock,
    ],
    [
      "controller layout",
      ["node_modules", ".checktrail"],
      ".checktrail/javascript-tools/node_modules",
      qualifiedSmokePackages,
      qualifiedLock,
    ],
  ] as const) {
    await t.test(
      name + " intentional links preserve the selected graph",
      async () => {
        const snapshot = path.join(root, "snapshot-" + name),
          installed = path.join(root, "consumer-" + name);
        await cp(source, snapshot, { recursive: true });
        for (const target of targets) {
          await rm(path.join(snapshot, target), { recursive: true });
          await symlink(
            path.join(source, target),
            path.join(snapshot, target),
            process.platform === "win32" ? "junction" : "dir",
          );
        }
        await cp(consumer, installed, {
          recursive: true,
          filter: (file) => file !== path.join(consumer, "smoke-tools"),
        });
        // Arbitrary copier callers retain the strict canonical-source boundary.
        await assert.rejects(
          copySmokeToolGraph(path.join(root, "refused-" + name), {
            modules: path.join(snapshot, modules),
            packages: [...packages],
            lock,
          }),
          /Smoke tool source must be canonical/,
        );
        assert.deepEqual(
          await preparePackageSmokeTools(installed, snapshot),
          direct,
        );
        assert.equal(
          JSON.parse(
            await readFile(
              path.join(installed, "node_modules/tool/package.json"),
              "utf8",
            ),
          ).version,
          "99.0.0",
        );
      },
    );
  }
});

test("host smoke preserves qualified preparation and routes current-root reporter proof separately from the phase controller", async () => {
  const workflow = parse(
    await readFile(path.join(repository, ".github/workflows/ci.yml"), "utf8"),
  );
  const commands = (
    workflow.jobs["host-validation"].steps as { run?: string }[]
  ).map((step) => step.run ?? "");
  const prepare = commands.findIndex((command) =>
    command.includes("node scripts/prepare-javascript-tools.mjs"),
  );
  const build = commands.indexOf("npm run build"),
    proof = commands.findIndex((command) =>
      command.includes("node scripts/verify-root-javascript-reporters.mjs"),
    ),
    controller = commands.indexOf(
      "node scripts/run-ci-validation.mjs --shard${{ matrix.shard }}",
    );
  assert.ok(
    prepare >= 0 && prepare < build && build < proof && proof < controller,
  );
  assert.equal(
    workflow.jobs["host-validation"].steps[proof].if,
    "matrix.shard == 0",
  );
  assert.deepEqual(commands[proof]!.trim().split("\n"), [
    "node --test dist/test/development-bundlers.test.js dist/test/vitest.test.js dist/test/jest.test.js",
    "node scripts/verify-root-javascript-reporters.mjs",
  ]);
  assert.equal(
    commands.filter((command) =>
      command.includes("node scripts/prepare-javascript-tools.mjs"),
    ).length,
    1,
  );
  assert.match(
    commands[prepare]!,
    /npm ci --prefix \.checktrail\/javascript-tools --ignore-scripts/,
  );
  const phases = JSON.parse(
    await readFile(
      path.join(repository, "scripts/ci-validation-phases.json"),
      "utf8",
    ),
  );
  assert.equal(
    phases.packages.filter(
      (row: { script: string }) => row.script === "scripts/smoke-package.mjs",
    ).length,
    1,
  );
  assert.equal(
    phases.packages.some(
      (row: { script: string }) =>
        row.script === "scripts/verify-root-javascript-reporters.mjs",
    ),
    false,
  );
});

test(
  "fresh-installed current-root reporters retain exact mixed outcomes and intended skips without production graph changes",
  { timeout: 180000 },
  async () => {
    const result = spawnSync(
      process.execPath,
      [path.join(repository, "scripts/verify-root-javascript-reporters.mjs")],
      {
        cwd: repository,
        encoding: "utf8",
        timeout: 170000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.currentRootReportersVerified, true);
    assert.equal(report.offlineProductionInstall, true);
    assert.equal(report.productionGraphUnchanged, true);
    const manifest = JSON.parse(
      await readFile(path.join(repository, "package.json"), "utf8"),
    );
    assert.deepEqual(report.versions, {
      vitest: manifest.devDependencies.vitest,
      jest: manifest.devDependencies.jest,
    });
    assert.deepEqual(
      report.cases.map((row: { phase: string }) => row.phase),
      ["broken", "fixed", "near-miss", "skipped"],
    );
    for (const row of report.cases) {
      assert.equal(
        row.qualification,
        row.phase === "skipped" ? "incomplete" : "expected-control-observed",
      );
      assert.equal(row.observations.length, 2);
      for (const check of row.observations) {
        assert.equal(
          check.status,
          row.phase === "broken"
            ? "failed"
            : row.phase === "skipped" && check.family === "jest"
              ? "inconclusive"
              : "passed",
        );
        assert.deepEqual(check.tests, {
          total: 4,
          passed: row.phase === "broken" || row.phase === "skipped" ? 3 : 4,
          failed: row.phase === "broken" ? 1 : 0,
          skipped: row.phase === "skipped" ? 1 : 0,
        });
      }
    }
  },
);
