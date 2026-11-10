import assert from "node:assert/strict";
import { readFile, readdir, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { fixture } from "./helpers.js";

const inputs = [
  "scripts/prepare-mutation-tools.mjs",
  "scripts/prepare-javascript-tools.mjs",
  "scripts/javascript-tools/package.json",
  "scripts/javascript-tools/package-lock.json",
];
async function profileFiles() {
  return Object.fromEntries(
    await Promise.all(
      inputs.map(async (file) => [
        file,
        await readFile(new URL("../../" + file, import.meta.url), "utf8"),
      ]),
    ),
  );
}
async function selectors() {
  return import(
    new URL("../../scripts/prepare-javascript-tools.mjs", import.meta.url).href
  );
}

test("qualified JavaScript and mutation preparation ignore development upgrades and publish the same exact graph", async (t) => {
  const files = await profileFiles();
  const qualified = JSON.parse(files["scripts/javascript-tools/package.json"]!);
  const expectedLock = JSON.parse(
    files["scripts/javascript-tools/package-lock.json"]!,
  );
  const outputs = [];
  for (const [script, destination] of [
    ["prepare-javascript-tools.mjs", "javascript-tools"],
    ["prepare-mutation-tools.mjs", "mutation-javascript-tools"],
  ] as const) {
    // These versions are intentionally unrelated to the qualified graph, including
    // the two development upgrades that previously broke native witness tests.
    const root = await fixture(t, {
      ...files,
      "package.json": JSON.stringify({
        devDependencies: {
          vite: "8.3.6",
          rolldown: "1.3.0",
          eslint: "99.0.0",
          vitest: "99.0.0",
          jest: "99.0.0",
        },
      }),
      "package-lock.json": "{}",
    });
    const run = () =>
      spawnSync(process.execPath, ["scripts/" + script], {
        cwd: root,
        encoding: "utf8",
        timeout: 10000,
      });
    const result = run();
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.rangeResolutionPerformed, false);
    assert.equal(
      receipt.profileLockSha256,
      createHash("sha256")
        .update(files["scripts/javascript-tools/package-lock.json"]!)
        .digest("hex"),
    );
    assert.deepEqual(receipt.versions, qualified.dependencies);
    const directory = path.join(root, ".checktrail", destination);
    assert.deepEqual((await readdir(directory)).sort(), [
      "package-lock.json",
      "package.json",
    ]);
    const artifacts = await Promise.all(
      ["package.json", "package-lock.json"].map(async (file) =>
        JSON.parse(await readFile(path.join(directory, file), "utf8")),
      ),
    );
    assert.deepEqual(artifacts, [qualified, expectedLock]);
    outputs.push(artifacts);
    assert.notEqual(
      run().status,
      0,
      "Preparation must refuse to replace an existing install",
    );
    assert.deepEqual(
      await Promise.all(
        ["package.json", "package-lock.json"].map(async (file) =>
          JSON.parse(await readFile(path.join(directory, file), "utf8")),
        ),
      ),
      artifacts,
    );
    for (const file of inputs)
      assert.equal(await readFile(path.join(root, file), "utf8"), files[file]);
  }
  assert.deepEqual(outputs[0], outputs[1]);
});

test("qualified tool selection rejects declaration, graph and integrity inconsistencies", async () => {
  const { selectQualifiedJavaScriptToolsLock } = await selectors();
  const files = await profileFiles();
  const manifest = JSON.parse(files["scripts/javascript-tools/package.json"]!);
  const lock = JSON.parse(files["scripts/javascript-tools/package-lock.json"]!);
  const before = JSON.stringify({ manifest, lock });
  for (const [mutate, message] of [
    [
      (m: typeof manifest) => {
        m.dependencies.vite = "^8.3.0";
      },
      /lock root must match/,
    ],
    [
      (_m: typeof manifest, l: typeof lock) => {
        l.packages[""].dependencies.rolldown = "1.3.0";
      },
      /lock root must match/,
    ],
    [
      (_m: typeof manifest, l: typeof lock) => {
        l.packages["node_modules/vite"].version = "8.3.6";
      },
      /lock must match its declaration/,
    ],
    [
      (_m: typeof manifest, l: typeof lock) => {
        delete l.packages["node_modules/vite"];
      },
      /lock must match its declaration/,
    ],
    [
      (_m: typeof manifest, l: typeof lock) => {
        delete l.packages["node_modules/vitest/node_modules/@vitest/mocker"];
      },
      /Missing locked required tool dependency/,
    ],
    [
      (_m: typeof manifest, l: typeof lock) => {
        l.packages["node_modules/vite"].integrity = "sha1-unqualified";
      },
      /sha512/,
    ],
    [
      (_m: typeof manifest, l: typeof lock) => {
        l.packages["node_modules/vite"].resolved = "file:outside";
      },
      /registry/,
    ],
  ] as const) {
    const m = structuredClone(manifest),
      l = structuredClone(lock);
    mutate(m, l);
    assert.throws(() => selectQualifiedJavaScriptToolsLock(m, l), message);
  }
  const unpinned = structuredClone(manifest),
    unpinnedLock = structuredClone(lock);
  unpinned.dependencies.vite = unpinnedLock.packages[""].dependencies.vite =
    "^8.3.0";
  assert.throws(
    () => selectQualifiedJavaScriptToolsLock(unpinned, unpinnedLock),
    /must be exactly pinned/,
  );
  assert.deepEqual(selectQualifiedJavaScriptToolsLock(manifest, lock), {
    manifest,
    lock,
  });
  assert.equal(JSON.stringify({ manifest, lock }), before);
});

test("invalid qualified graph publishes no partial tool artifacts and cannot fall back to development packages", async (t) => {
  const files = await profileFiles();
  const lock = JSON.parse(files["scripts/javascript-tools/package-lock.json"]!);
  lock.packages["node_modules/rolldown"].version = "1.3.0";
  for (const script of [
    "prepare-javascript-tools.mjs",
    "prepare-mutation-tools.mjs",
  ]) {
    const root = await fixture(t, {
      ...files,
      "scripts/javascript-tools/package-lock.json": JSON.stringify(lock),
      "package.json": '{"devDependencies":{"rolldown":"1.2.9"}}',
    });
    const result = spawnSync(process.execPath, ["scripts/" + script], {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Qualified tool lock must match its declaration: rolldown/,
    );
    await assert.rejects(access(path.join(root, ".checktrail")), {
      code: "ENOENT",
    });
  }
});

test("qualified graph optionality follows selected paths and required paths promote shared descendants", async () => {
  const { selectQualifiedJavaScriptToolsLock } = await selectors();
  const manifest = {
    name: "checktrail-javascript-acceptance-tools",
    version: "0.0.0",
    private: true,
    dependencies: { native: "1.0.0" } as Record<string, string>,
  };
  const entry = (name: string) => ({
    version: "1.0.0",
    resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
    integrity: "sha512-AAAA",
  });
  const source = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    packages: {
      "": {
        name: manifest.name,
        version: manifest.version,
        dependencies: manifest.dependencies,
      },
      "node_modules/native": {
        ...entry("native"),
        peerDependencies: { shared: "^1.0.0" },
        peerDependenciesMeta: { shared: { optional: true } },
      },
      // These were required in the source graph, but only an optional peer
      // reaches them from this selected profile (the Vite/YAML failure case).
      "node_modules/shared": {
        ...entry("shared"),
        dependencies: { leaf: "1.0.0" },
        peerDependencies: { "peer-leaf": "^1.0.0" },
      },
      "node_modules/leaf": entry("leaf"),
      "node_modules/peer-leaf": entry("peer-leaf"),
    } as Record<
      string,
      {
        [key: string]: unknown;
        dependencies?: Record<string, string>;
        optional?: boolean;
      }
    >,
  };
  const selected = selectQualifiedJavaScriptToolsLock(manifest, source).lock
    .packages;
  assert.equal(selected["node_modules/native"].optional, undefined);
  assert.equal(selected["node_modules/shared"].optional, true);
  assert.equal(selected["node_modules/leaf"].optional, true);
  assert.equal(selected["node_modules/peer-leaf"].optional, true);
  assert.equal(source.packages["node_modules/shared"]!.optional, undefined);
  assert.equal(source.packages["node_modules/peer-leaf"]!.optional, undefined);
  for (const dependencies of [
    { native: "1.0.0", consumer: "1.0.0" },
    { consumer: "1.0.0", native: "1.0.0" },
  ]) {
    const requiredManifest = { ...manifest, dependencies };
    const requiredSource = structuredClone(source);
    requiredSource.packages[""]!.dependencies = dependencies;
    requiredSource.packages["node_modules/consumer"] = {
      ...entry("consumer"),
      dependencies: { shared: "1.0.0" },
    };
    const required = selectQualifiedJavaScriptToolsLock(
      requiredManifest,
      requiredSource,
    ).lock.packages;
    assert.equal(required["node_modules/shared"].optional, undefined);
    assert.equal(required["node_modules/leaf"].optional, undefined);
    assert.equal(required["node_modules/peer-leaf"].optional, undefined);
    const missingRequiredPeer = structuredClone(requiredSource);
    delete missingRequiredPeer.packages["node_modules/peer-leaf"];
    assert.throws(
      () =>
        selectQualifiedJavaScriptToolsLock(
          requiredManifest,
          missingRequiredPeer,
        ),
      /Missing locked required tool dependency peer-leaf/,
    );
    delete requiredSource.packages["node_modules/leaf"];
    assert.throws(
      () =>
        selectQualifiedJavaScriptToolsLock(requiredManifest, requiredSource),
      /Missing locked required tool dependency leaf/,
    );
  }
  const absentOptional = structuredClone(source);
  delete absentOptional.packages["node_modules/shared"];
  assert.doesNotThrow(() =>
    selectQualifiedJavaScriptToolsLock(manifest, absentOptional),
  );
});
