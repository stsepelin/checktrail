import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  rubyToolsConfigV2Schema,
  rubyToolsManifestLock,
} from "../src/ruby-tools.js";
const dependencies = [
  ...[
    ["rubocop", "1.91.0"],
    ["rspec-core", "3.13.6"],
    ["minitest", "6.0.6"],
  ].map(([name, version]) => ({
    name,
    version,
    groups: ["validation"],
    platforms: ["ruby"],
    included: true,
    platformMatches: true,
  })),
  {
    name: "json",
    version: "2.18.0",
    groups: ["default"],
    platforms: [],
    included: true,
    platformMatches: true,
  },
  {
    name: "prism",
    version: "1.8.1",
    groups: ["default"],
    platforms: [],
    included: true,
    platformMatches: true,
  },
];
const policy = () =>
  rubyToolsConfigV2Schema.parse({
    schemaVersion: 2,
    rubyVersion: "4.0.7",
    bundlerVersion: "4.0.20",
    repository: ".checktrail/dependencies/artifacts",
    repositoryManifest: ".checktrail/dependencies/repository.json",
    repositorySha256: "a".repeat(64),
    sources: ["spec/original.rb", "gemfiles/tools.rb"],
    cops: ["Lint/UselessAssignment"],
    rspec: { files: ["spec/original.rb"], support: [] },
    minitest: { files: [], support: [] },
    extensions: {
      profile: "declared-manifests-shared-and-inherited-v1",
      manifests: ["Gemfile", "gemfiles/tools.rb"],
      rspecHooks: [],
      dependencies,
    },
  });
const lock = () =>
  readFile(
    new URL("../../examples/ruby-tools/Gemfile.lock", import.meta.url),
    "utf8",
  );
test("Ruby extension lock admission uses declarative dependencies without evaluating grouped manifest code", async () => {
  const config = policy();
  const value = rubyToolsManifestLock(
    config,
    'raise "planning must never execute Ruby"\n',
    await lock(),
  );
  assert.equal(value.files.length, 19);
  assert.equal(value.specs["minitest"], "6.0.6");
  assert.equal(value.specs["rspec-core"], "3.13.6");
});
test("Ruby extension declarations reject duplicate names groups platforms manifests and ambiguous hooks", async () => {
  const text = await lock();
  for (const mutate of [
    (c: ReturnType<typeof policy>) => {
      c.extensions.dependencies.push(c.extensions.dependencies[0]!);
    },
    (c: ReturnType<typeof policy>) => {
      c.extensions.dependencies[0]!.groups.push("validation");
    },
    (c: ReturnType<typeof policy>) => {
      c.extensions.dependencies[0]!.platforms.push("ruby");
    },
    (c: ReturnType<typeof policy>) => {
      c.extensions.manifests.push("Gemfile");
    },
    (c: ReturnType<typeof policy>) => {
      const h = {
        kind: "before" as const,
        scope: "example" as const,
        file: "spec/original.rb",
        line: 3,
        registrations: 1,
        invocations: 1,
      };
      c.extensions.rspecHooks.push(h, h);
    },
  ]) {
    const config = policy();
    mutate(config);
    assert.throws(() => rubyToolsManifestLock(config, "", text));
  }
});
test("Ruby extension source closure rejects missing locked requirements inactive checkers and excessive hook registrations", async () => {
  const text = await lock();
  for (const mutate of [
    (c: ReturnType<typeof policy>) => {
      c.extensions.dependencies.pop();
    },
    (c: ReturnType<typeof policy>) => {
      c.extensions.dependencies[0]!.included = false;
    },
    (c: ReturnType<typeof policy>) => {
      c.extensions.dependencies[0]!.platformMatches = false;
    },
    (c: ReturnType<typeof policy>) => {
      c.extensions.manifests = ["gemfiles/tools.rb"];
    },
    (c: ReturnType<typeof policy>) => {
      c.extensions.rspecHooks = [
        {
          kind: "before",
          scope: "example",
          file: "spec/original.rb",
          line: 3,
          registrations: 513,
          invocations: 513,
        },
      ];
    },
  ]) {
    const config = policy();
    mutate(config);
    assert.throws(() => rubyToolsManifestLock(config, "", text));
  }
});
test("Ruby extension strict policy rejects adjacent profiles escaping paths and repository-supplied trust", () => {
  const config = policy();
  for (const value of [
    { ...config, trusted: true },
    { ...config, schemaVersion: 1 },
    {
      ...config,
      extensions: {
        ...config.extensions,
        profile: config.extensions.profile + "-adjacent",
      },
    },
    {
      ...config,
      extensions: { ...config.extensions, manifests: ["../Gemfile"] },
    },
    {
      ...config,
      extensions: {
        ...config.extensions,
        dependencies: [
          {
            ...config.extensions.dependencies[0]!,
            platforms: ["ruby-adjacent"],
          },
        ],
      },
    },
  ])
    assert.equal(rubyToolsConfigV2Schema.safeParse(value).success, false);
});

test("Ruby extension platform and condition exclusions retain complete locked source closure", async () => {
  const config = policy(),
    text = await lock();
  const platform = config.extensions.dependencies.find(
    (d) => d.name === "json",
  )!;
  platform.platformMatches = false;
  platform.included = false;
  config.extensions.dependencies.find((d) => d.name === "prism")!.included =
    false;
  assert.equal(rubyToolsManifestLock(config, "", text).files.length, 19);
  platform.included = true;
  assert.throws(() => rubyToolsManifestLock(config, "", text));
});
