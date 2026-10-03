import { spawnSync } from "node:child_process";
import path from "node:path";
import { lstat } from "node:fs/promises";
import { goBuildTagsSchema } from "./go-build.js";
import { goPackages } from "./go-scope.js";

async function main(): Promise<void> {
  const [encodedTags] = process.argv.slice(2);
  const temporary = process.env.CHECKTRAIL_TEMP;
  if (!encodedTags || !temporary || process.argv.length !== 3)
    throw new Error("Invalid Go build arguments");
  const tags = goBuildTagsSchema.parse(JSON.parse(encodedTags));
  if (!(await lstat(temporary)).isDirectory())
    throw new Error("Missing owned Go build output directory");
  const flags = tags.length ? [`-tags=${tags.join(",")}`] : [];
  const settings = { encoding: "utf8", maxBuffer: 1024 * 1024 } as const;
  const listed = spawnSync(
    "go",
    ["list", "-json", ...flags, "./..."],
    settings,
  );
  if (listed.error) throw listed.error;
  if (listed.status !== 0 || listed.stderr.trim()) {
    process.stdout.write(listed.stdout);
    process.stderr.write(listed.stderr);
    throw new Error("Native Go production package listing did not complete");
  }
  const packages = goPackages(listed.stdout);
  if (
    !packages.length ||
    packages.length > 4096 ||
    new Set(packages.map((item) => item.ImportPath)).size !== packages.length ||
    packages.some(
      (item) =>
        item.Error ||
        item.DepsErrors?.length ||
        item.ImportPath.startsWith("-") ||
        /[\r\n\0]/.test(item.ImportPath),
    )
  )
    throw new Error(
      "Native Go production packages are incomplete or ambiguous",
    );
  const production = packages.filter(
    (item) => item.GoFiles.length + item.CgoFiles.length > 0,
  );
  if (!production.length) throw new Error("No production Go packages selected");
  // A directory output rejects library-only modules. A fixed owned output per
  // package handles archives and linked mains without writing into the project.
  let code = 0;
  for (const [index, item] of production.entries()) {
    const result = spawnSync(
      "go",
      [
        "build",
        "-buildvcs=false",
        "-trimpath",
        "-o",
        path.join(temporary, String(index)),
        ...flags,
        item.ImportPath,
      ],
      settings,
    );
    if (result.error) throw result.error;
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.status === null)
      throw new Error("Native Go build did not exit normally");
    if (result.status !== 0) code = result.status;
  }
  process.exitCode = code;
}
main().catch((error: unknown) => {
  process.stderr.write(
    (error instanceof Error ? error.message : "Go build failed") + "\n",
  );
  process.exitCode = 2;
});
