import assert from "node:assert/strict";
import { mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fixture } from "./helpers.js";
import { archive, files, plugin } from "./spotbugs-plugin-fixture.js";
import {
  spotbugsExtensionPlugins,
  spotbugsExtensionLibraries,
  spotbugsHash,
} from "../src/spotbugs-extensions-inputs.js";
import {
  spotbugsExtensionsSchema,
  validateSpotbugsExtensionScope,
} from "../src/spotbugs-extensions.js";
const config = spotbugsExtensionsSchema.parse({
  profile: "linux-arm64-class-scopes-plugins-v1",
  stages: [
    {
      id: "original",
      path: ".",
      analyze: true,
      sources: ["Original.java"],
      dependsOn: [],
    },
  ],
  generators: [],
  jpms: [],
  plugins: [],
});
test("Analyzer plugin and library prerequisites inspect pinned local data without loading invalid fixture classes", async (t) => {
  const root = await realpath(await fixture(t, {})),
    bytes = archive(files),
    declared = { ...plugin, sha256: spotbugsHash(bytes) };
  await writeFile(path.join(root, "rules.jar"), bytes);
  const selected = { ...config, plugins: [declared] },
    pins = await spotbugsExtensionPlugins(root, ".", selected);
  assert.equal(pins.length, 1);
  assert.ok(pins[0]!.bytes.equals(bytes));
  assert.deepEqual(pins[0]!.metadata.classes, ["original/Detector.class"]);
  await writeFile(
    path.join(root, "rules.jar"),
    archive({
      ...files,
      "original/Detector.class": "Different still-invalid class data",
    }),
  );
  await assert.rejects(
    spotbugsExtensionPlugins(root, ".", selected),
    /identity/,
  );
  await writeFile(path.join(root, "rules.jar"), bytes);
  await mkdir(path.join(root, "alias"));
  for (const source of ["rules.jar", "alias/../rules.jar", "/rules.jar"]) {
    const deps = [{ path: source, sha256: declared.sha256 }];
    if (source === "rules.jar")
      assert.equal(
        (await spotbugsExtensionLibraries(root, ".", deps)).length,
        1,
      );
    else
      await assert.rejects(
        spotbugsExtensionLibraries(root, ".", deps),
        /unique plain/,
      );
  }
  await assert.rejects(
    spotbugsExtensionLibraries(root, ".", [
      { path: "rules.jar", sha256: declared.sha256 },
      { path: "rules.jar", sha256: declared.sha256 },
    ]),
    /unique/,
  );
  await rm(path.join(root, "rules.jar"));
  await writeFile(path.join(root, "foreign.jar"), bytes);
  await symlink("foreign.jar", path.join(root, "rules.jar"));
  await assert.rejects(
    spotbugsExtensionPlugins(root, ".", selected),
    /symbolic/,
  );
  await assert.rejects(
    spotbugsExtensionLibraries(root, ".", [
      { path: "rules.jar", sha256: declared.sha256 },
    ]),
    /symbolic/,
  );
});
test("Analyzer cohort ownership generated roles module dependencies and plugin providers match exact finite inventories", () => {
  validateSpotbugsExtensionScope(config, ["Original.java"]);
  const generated = spotbugsExtensionsSchema.parse({
    ...config,
    stages: [{ ...config.stages[0], sources: [] }],
    generators: [
      {
        module: ".",
        source: "generators/Original.java",
        className: "generator.Original",
        outputs: [
          {
            file: "src/main/java/demo/Generated.java",
            className: "demo.Generated",
          },
        ],
      },
    ],
  });
  validateSpotbugsExtensionScope(generated, ["generators/Original.java"]);
  const named = spotbugsExtensionsSchema.parse({
    ...config,
    stages: [
      {
        id: "library",
        path: "library",
        analyze: false,
        sources: [
          "library/src/main/java/module-info.java",
          "library/src/main/java/provider/Library.java",
        ],
        dependsOn: [],
      },
      {
        id: "application",
        path: "application",
        analyze: true,
        sources: [
          "application/src/main/java/module-info.java",
          "application/src/main/java/demo/Original.java",
        ],
        dependsOn: ["library"],
      },
    ],
    jpms: [
      {
        module: "library",
        name: "original.library",
        requires: [],
        exports: ["provider"],
      },
      {
        module: "application",
        name: "original.application",
        requires: ["original.library"],
        exports: ["demo"],
      },
    ],
  });
  const sources = named.stages.flatMap((stage) => stage.sources);
  validateSpotbugsExtensionScope(named, sources);
  for (const mutate of [
    (c: typeof named) => {
      c.jpms[1]!.requires = ["original.library.extra"];
    },
    (c: typeof named) => {
      c.jpms[1]!.requires.push("java.logging");
    },
    (c: typeof named) => {
      c.stages[1]!.dependsOn = ["application"];
    },
    (c: typeof named) => {
      c.stages[1]!.sources.push(c.stages[0]!.sources[1]!);
    },
    (c: typeof named) => {
      c.jpms.pop();
    },
    (c: typeof named) => {
      c.plugins = [
        plugin,
        { ...plugin, path: "second.jar", id: "original.rules.extra" },
      ];
    },
  ]) {
    const changed = structuredClone(named);
    mutate(changed);
    assert.throws(() => validateSpotbugsExtensionScope(changed, sources));
  }
  assert.throws(
    () =>
      validateSpotbugsExtensionScope(
        { ...config, stages: [{ ...config.stages[0]!, sources: [] }] },
        ["Original.java"],
      ),
    /explicit|requires/,
  );
});
