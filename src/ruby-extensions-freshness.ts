import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { inventorySourcePath } from "./inventory.js";
import { mavenHash } from "./maven.js";
import {
  rubyToolsConfigSchema,
  rubyToolsInvocationSchema,
  rubyToolsManifestLock,
  rubyToolsRepositorySchema,
  rubyToolsSame,
} from "./ruby-tools.js";
import type { Check } from "./types.js";
function need(value: unknown): asserts value {
  if (!value) throw Error("Current Ruby extension identity differs");
}
function bytes(file: string, bound: number, hash?: string, size?: number) {
  need(path.isAbsolute(file) && realpathSync(file) === file);
  const stat = lstatSync(file);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= bound);
  const value = readFileSync(file);
  need(
    value.length <= bound &&
      (hash === undefined || mavenHash(value) === hash) &&
      (size === undefined || value.length === size),
  );
  return value;
}
export function rubyExtensionsFreshness(
  check: Check,
  root: string | undefined,
) {
  need(root && path.isAbsolute(root) && realpathSync(root) === root);
  const invocation = rubyToolsInvocationSchema.parse(
    JSON.parse(check.commands[0]!.args[2]!),
  );
  const config = invocation.config;
  need(config.schemaVersion === 2);
  const project = path.resolve(root, check.project);
  need(project === root || project.startsWith(root + path.sep));
  const files: string[] = [];
  let count = 0,
    total = 0;
  function walk(relative: string, depth: number) {
    need(depth <= 32);
    for (const name of readdirSync(path.join(project, relative))) {
      need(++count <= 20000);
      const file = path.posix.join(relative, name),
        full = path.join(project, file),
        stat = lstatSync(full);
      if (
        stat.isSymbolicLink() ||
        !inventorySourcePath(stat.isDirectory() ? file + "/_" : file)
      )
        continue;
      if (stat.isDirectory()) walk(file, depth + 1);
      else {
        need(stat.isFile());
        total += stat.size;
        need(stat.size <= 8 * 1024 * 1024 && total <= 64 * 1024 * 1024);
        files.push(file);
      }
    }
  }
  walk("", 0);
  need(
    rubyToolsSame(
      files,
      invocation.inputs.map((p) => p.path),
    ),
  );
  for (const pin of invocation.inputs)
    bytes(path.join(project, pin.path), 4 * 1024 * 1024, pin.sha256);
  need(
    isDeepStrictEqual(
      rubyToolsConfigSchema.parse(
        JSON.parse(
          bytes(
            path.join(project, "checktrail.ruby-tools.json"),
            4 * 1024 * 1024,
          ).toString("utf8"),
        ),
      ),
      config,
    ),
  );
  const lock = rubyToolsManifestLock(
    config,
    bytes(path.join(project, "Gemfile"), 65536).toString("utf8"),
    bytes(path.join(project, "Gemfile.lock"), 1024 * 1024).toString("utf8"),
  );
  const manifest = rubyToolsRepositorySchema.parse(
    JSON.parse(
      bytes(
        path.join(project, config.repositoryManifest),
        1024 * 1024,
        config.repositorySha256,
      ).toString("utf8"),
    ),
  );
  need(
    rubyToolsSame(
      lock.files.map((f) => f.path),
      manifest.files.map((f) => f.path),
    ) &&
      lock.files.every(
        (f) =>
          manifest.files.find((p) => p.path === f.path)?.sha256 === f.sha256,
      ),
  );
  const directory = path.join(project, config.repository);
  need(
    realpathSync(directory) === directory && lstatSync(directory).isDirectory(),
  );
  need(
    rubyToolsSame(
      readdirSync(directory),
      manifest.files.map((p) => p.path),
    ),
  );
  for (const pin of manifest.files)
    bytes(
      path.join(directory, pin.path),
      32 * 1024 * 1024,
      pin.sha256,
      pin.bytes,
    );
}
