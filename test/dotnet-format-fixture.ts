import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { dotnetBuildFixture } from "./dotnet-build-fixture.js";
export async function dotnetFormatFixture(t: TestContext) {
  const { root, config } = await dotnetBuildFixture(t);
  config.projects = config.projects.filter((p) => p.language !== "fsharp");
  for (const directory of ["FSharp", "FSharpTests"])
    await rm(path.join(root, directory), { recursive: true });
  await writeFile(
    path.join(root, "Original.slnx"),
    "<Solution>\n" +
      config.projects.map((p) => `  <Project Path="${p.file}" />`).join("\n") +
      "\n</Solution>\n",
  );
  await writeFile(
    path.join(root, "checktrail.dotnet-build.json"),
    JSON.stringify(config),
  );
  await writeFile(
    path.join(root, "checktrail.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["dotnet.format-whitespace"] }],
    }),
  );
  return { root, config };
}
export async function replaceDotnetFormatSource(
  root: string,
  file: string,
  old: string,
  value: string,
) {
  const target = path.join(root, file),
    original = await readFile(target, "utf8");
  if (original.split(old).length !== 2)
    throw Error("One exact original fixture anchor: " + file);
  await writeFile(target, original.replace(old, value));
  return original;
}
