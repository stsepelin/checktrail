import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { TestContext } from "node:test";
import { fixture } from "./helpers.js";
import { mavenHash } from "../src/maven.js";
import { dotnetBuildConfigSchema } from "../src/dotnet-build.js";
export async function dotnetBuildFixture(t: TestContext) {
  const cache = process.env.CHECKTRAIL_DOTNET_BUILD_CACHE;
  if (!cache) throw Error("Native .NET dependency cache not selected");
  const root = await fixture(t, {});
  await cp(
    fileURLToPath(new URL("../../examples/dotnet-build/", import.meta.url)),
    root,
    { recursive: true },
  );
  await mkdir(path.join(root, ".checktrail"));
  await cp(cache, path.join(root, ".checktrail/dependencies"), {
    recursive: true,
  });
  const data = JSON.parse(
    await readFile(
      fileURLToPath(
        new URL(
          "../../scripts/dotnet-build-fixture-projects.json",
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  );
  for (const project of data.projects) {
    const lock = path.posix.join(
      path.posix.dirname(project.file),
      "packages.lock.json",
    );
    await cp(path.join(cache, "fixture-locks", lock), path.join(root, lock));
  }
  const config = dotnetBuildConfigSchema.parse({
    schemaVersion: 1,
    solution: "Original.slnx",
    repository: ".checktrail/dependencies/artifacts",
    repositoryManifest: ".checktrail/dependencies/repository.json",
    repositorySha256: mavenHash(
      await readFile(path.join(cache, "repository.json")),
    ),
    projects: data.projects,
  });
  await writeFile(
    path.join(root, "checktrail.dotnet-build.json"),
    JSON.stringify(config),
  );
  return { root, config };
}
