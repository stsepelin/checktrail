import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, mkdir, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inventory } from "../src/inventory.js";
import { discover } from "../src/adapters.js";
import { mavenHash } from "../src/maven.js";
import {
  rubyToolsLock,
  rubyToolsCheck,
  rubyToolsConfigSchema,
  rubyToolsRepository,
} from "../src/ruby-tools.js";
import { fixture } from "./helpers.js";

test("Ruby data-only lock parsing binds every archive and rejects executable, ambiguous and unchecked declarations", async () => {
  const gemfile = await readFile(
    fileURLToPath(
      new URL("../../examples/ruby-tools/Gemfile", import.meta.url),
    ),
    "utf8",
  );
  const lock = await readFile(
    fileURLToPath(
      new URL("../../examples/ruby-tools/Gemfile.lock", import.meta.url),
    ),
    "utf8",
  );
  const parsed = rubyToolsLock(gemfile, lock);
  assert.equal(parsed.files.length, Object.keys(parsed.specs).length);
  assert.equal(parsed.specs.rubocop, "1.91.0");
  assert.equal(parsed.specs["rspec-core"], "3.13.6");
  assert.equal(parsed.specs.minitest, "6.0.6");
  assert.ok(
    parsed.files.every(
      (f) => f.sha256.length === 64 && f.path.endsWith(".gem"),
    ),
  );
  assert.deepEqual(parsed.platforms, ["aarch64-linux-musl", "ruby"]);
  const cases: [string, string, RegExp][] = [
    [gemfile + 'raise "executed"\n', lock, /executable/],
    [gemfile + 'gem "json", "2.18.0"\n', lock, /executable/],
    [
      gemfile.replace('"https://rubygems.org"', '"https://other.test"'),
      lock,
      /./,
    ],
    [
      gemfile,
      lock.replace(
        "remote: https://rubygems.org/",
        "remote: https://rubygems.org.other.test/",
      ),
      /public source/,
    ],
    [gemfile, lock + "\nGIT\n  remote: https://example.test\n", /sections/],
    [
      gemfile,
      lock.replace("    ast (2.4.3)", "    ast (2.4.3)\n    ast (2.4.3)"),
      /Duplicate/,
    ],
    [
      gemfile,
      lock.replace("      ast (~> 2.4.1)", "      absent (~> 2.4.1)"),
      /closure/,
    ],
    [gemfile, lock.replace("  ruby\n", "  ruby\n  ruby\n"), /duplicates/],
    [
      gemfile,
      lock.replace("  aarch64-linux-musl", "  aarch64-linux-musl-extra"),
      /platform/,
    ],
    [
      gemfile,
      lock.replace("  json (= 2.18.0)", "  json (>= 2.18.0)"),
      /not exact/,
    ],
    [
      gemfile,
      lock.replace(/^ {2}ast \(2\.4\.3\) sha256=.*\n/m, ""),
      /Every locked/,
    ],
    [gemfile, lock.replace("sha256=954615", "sha256=zz4615"), /checksum/],
    [gemfile, lock.replace("  ruby 4.0.7", "  ruby 4.0.8"), /runtime identity/],
    [gemfile, lock.replace("  4.0.20", "  4.0.22"), /runtime identity/],
    [
      gemfile.replace('gem "json", "2.18.0"', 'gem "json", "2.19.0"'),
      lock,
      /declarations differ/,
    ],
  ];
  for (const [manifest, value, reason] of cases)
    assert.throws(() => rubyToolsLock(manifest, value), reason);
  assert.equal(
    rubyToolsLock("# literal comment\n" + gemfile, lock).files.length,
    parsed.files.length,
  );
});

test("Ruby planning never evaluates project DSL and requires exact scope, native tool archives and manifest identity", async (t) => {
  const versions = {
    rubocop: "1.91.0",
    "rspec-core": "3.13.6",
    minitest: "6.0.6",
  };
  const blobs = Object.entries(versions).map(([name, version]) => ({
    path: `${name}-${version}.gem`,
    bytes: 4,
    sha256: mavenHash("data"),
  }));
  const manifest = JSON.stringify({ schemaVersion: 1, files: blobs });
  const gemfile =
    'source "https://rubygems.org"\nruby "4.0.7"\n' +
    Object.entries(versions)
      .map(([name, v]) => `gem "${name}", "${v}"\n`)
      .join("");
  const lock =
    "GEM\n  remote: https://rubygems.org/\n  specs:\n" +
    Object.entries(versions)
      .map(([n, v]) => `    ${n} (${v})\n`)
      .join("") +
    "\nPLATFORMS\n  ruby\n\nDEPENDENCIES\n" +
    Object.entries(versions)
      .map(([n, v]) => `  ${n} (= ${v})\n`)
      .join("") +
    "\nCHECKSUMS\n" +
    Object.entries(versions)
      .map(([n, v]) => `  ${n} (${v}) sha256=${mavenHash("data")}\n`)
      .join("") +
    "\nRUBY VERSION\n  ruby 4.0.7\n\nBUNDLED WITH\n  4.0.20\n";
  const config = rubyToolsConfigSchema.parse({
    schemaVersion: 1,
    rubyVersion: "4.0.7",
    bundlerVersion: "4.0.20",
    repository: ".checktrail/gems",
    repositoryManifest: ".checktrail/repository.json",
    repositorySha256: mavenHash(manifest),
    sources: ["lib/value.rb", "spec/value_spec.rb"],
    cops: ["Lint/UselessAssignment"],
    rspec: { files: ["spec/value_spec.rb"], support: [] },
    minitest: { files: [], support: [] },
  });
  const root = await fixture(t, {
    Gemfile: gemfile,
    "Gemfile.lock": lock,
    "lib/value.rb": 'raise "never run while planning"',
    "spec/value_spec.rb": 'BEGIN { File.write("execution-marker", "bad") }',
    "checktrail.ruby-tools.json": JSON.stringify(config),
    ".checktrail/repository.json": manifest,
  });
  await mkdir(path.join(root, config.repository), { recursive: true });
  for (const blob of blobs)
    await writeFile(path.join(root, config.repository, blob.path), "data");
  const plan = async (mode: "rubocop" | "rspec" | "minitest" = "rubocop") => {
    const source = await inventory(root);
    return rubyToolsCheck(
      source,
      discover(source).find((p) => p.path === ".")!,
      mode,
    );
  };
  const good = await plan();
  assert.equal(good.unavailableReason, undefined);
  assert.deepEqual(good.scope, [
    "Gemfile",
    "lib/value.rb",
    "spec/value_spec.rb",
  ]);
  assert.equal(good.commands.length, 1);
  assert.equal(good.commands[0]!.temporaryDirectory, true);
  assert.match((await plan("minitest")).unavailableReason!, /No Ruby tests/);
  await assert.rejects(readFile(path.join(root, "execution-marker")));
  for (const [edit, reason] of [
    [{ ...config, sources: ["lib/value.rb"] }, /every inventoried/],
    [
      { ...config, cops: ["Lint/UselessAssignment", "Lint/UselessAssignment"] },
      /Duplicate/,
    ],
    [
      {
        ...config,
        rspec: { files: ["lib/value.rb"], support: ["lib/value.rb"] },
      },
      /belong/,
    ],
    [
      { ...config, minitest: { files: ["spec/value_spec.rb"], support: [] } },
      /Duplicate Ruby test/,
    ],
    [{ ...config, repositorySha256: "0".repeat(64) }, /identity differs/],
    [{ ...config, rubyVersion: "4.0.8" }, /invalid or unsupported/],
  ] as const) {
    await writeFile(
      path.join(root, "checktrail.ruby-tools.json"),
      JSON.stringify(edit),
    );
    const result = await plan();
    assert.equal(result.commands.length, 0);
    assert.match(result.unavailableReason!, reason);
  }
  await writeFile(
    path.join(root, "checktrail.ruby-tools.json"),
    JSON.stringify(config),
  );
  await writeFile(path.join(root, "Gemfile"), gemfile + 'raise "run me"\n');
  assert.match((await plan()).unavailableReason!, /executable/);
  await writeFile(path.join(root, "Gemfile"), gemfile);
  await writeFile(path.join(root, config.repository, "extra.gem"), "data");
  assert.match((await plan()).unavailableReason!, /regular Ruby gem/);
  const external = await fixture(t, { archive: "data" });
  await symlink(
    path.join(external, "archive"),
    path.join(root, config.repository, "linked.gem"),
  );
  await assert.rejects(
    rubyToolsRepository(root, ".", config, rubyToolsLock(gemfile, lock)),
    /regular Ruby gem/,
  );
});
