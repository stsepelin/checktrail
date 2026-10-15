import { cp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function copyInstalledPackages(
  root: string,
  packages: string[],
  selectedModules?: string,
  validate?: (entry: {
    source: string;
    relative: string;
    version: string | undefined;
  }) => void | Promise<void>,
): Promise<void> {
  const copied = new Set<string>();
  const planned: {
    source: string;
    relative: string;
    version: string | undefined;
  }[] = [];
  const sourceModules =
    selectedModules ??
    fileURLToPath(new URL("../../node_modules/", import.meta.url));
  async function copy(
    name: string,
    from: string,
    optional = false,
  ): Promise<void> {
    const require = createRequire(from);
    for (const directory of require.resolve.paths(`${name}/package.json`) ??
      []) {
      const source = path.join(directory, name);
      const candidate = path.relative(sourceModules, source);
      if (
        selectedModules &&
        (candidate === ".." ||
          candidate.startsWith(".." + path.sep) ||
          path.isAbsolute(candidate))
      )
        continue;
      let metadata: {
        version?: string;
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      try {
        metadata = JSON.parse(
          await readFile(path.join(source, "package.json"), "utf8"),
        ) as typeof metadata;
      } catch {
        continue;
      }
      if (copied.has(source)) return;
      copied.add(source);
      const relative = path.relative(sourceModules, source);
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new Error("Test dependency is outside the local install");
      planned.push({ source, relative, version: metadata.version });
      for (const dependency of Object.keys(metadata.dependencies ?? {}))
        await copy(
          dependency,
          path.join(source, "package.json"),
          Object.hasOwn(metadata.optionalDependencies ?? {}, dependency),
        );
      for (const dependency of Object.keys(metadata.optionalDependencies ?? {}))
        await copy(dependency, path.join(source, "package.json"), true);
      return;
    }
    if (!optional) throw new Error(`Missing installed test dependency ${name}`);
  }
  for (const name of packages)
    await copy(
      name,
      selectedModules
        ? path.join(path.dirname(sourceModules), "package.json")
        : import.meta.filename,
    );
  // Validate the entire resolved graph before copying any package.
  for (const item of planned) await validate?.(item);
  for (const item of planned)
    await cp(item.source, path.join(root, "node_modules", item.relative), {
      recursive: true,
      verbatimSymlinks: true,
    });
}
