import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { fixture } from "./helpers.js";
import { mavenHash } from "../src/maven.js";
import { rubyToolsConfigSchema } from "../src/ruby-tools.js";
export async function rubyToolsFixture(
  t: TestContext,
  checks = ["ruby.rubocop", "ruby.rspec", "ruby.minitest"],
) {
  const cache = process.env.CHECKTRAIL_RUBY_TOOLS_CACHE;
  if (!cache) throw Error("Native Ruby dependency cache not selected");
  const root = await fixture(t, {});
  await cp(
    fileURLToPath(new URL("../../examples/ruby-tools/", import.meta.url)),
    root,
    { recursive: true },
  );
  await mkdir(path.join(root, ".checktrail"));
  await cp(cache, path.join(root, ".checktrail/dependencies"), {
    recursive: true,
  });
  const config = rubyToolsConfigSchema.parse({
    schemaVersion: 1,
    rubyVersion: "4.0.7",
    bundlerVersion: "4.0.20",
    repository: ".checktrail/dependencies/artifacts",
    repositoryManifest: ".checktrail/dependencies/repository.json",
    repositorySha256: mavenHash(
      await readFile(path.join(cache, "repository.json")),
    ),
    sources: [
      "lib/quantity.rb",
      "spec/quantity_spec.rb",
      "test/quantity_test.rb",
    ],
    cops: ["Lint/UselessAssignment"],
    rspec: { files: ["spec/quantity_spec.rb"], support: [] },
    minitest: { files: ["test/quantity_test.rb"], support: [] },
  });
  await writeFile(
    path.join(root, "checktrail.ruby-tools.json"),
    JSON.stringify(config),
  );
  await writeFile(
    path.join(root, "checktrail.json"),
    JSON.stringify({ schemaVersion: 1, projects: [{ path: ".", checks }] }),
  );
  return { root, config };
}
