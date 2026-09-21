import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { Inventory } from "./types.js";

const excludedDirectories = new Set([
  ".git",
  "node_modules",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  ".build",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".output",
  ".repo-verifier",
  ".terraform",
  "obj",
]);

function sensitive(name: string): boolean {
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name === ".repo-verifier.local.json" ||
    /\.(pem|key|p12|pfx)$/i.test(name)
  );
}

export async function withinRoot(
  root: string,
  relative: string,
): Promise<string> {
  if (path.isAbsolute(relative) || relative.includes("\0"))
    throw new Error("Expected a relative path");
  const canonicalRoot = await realpath(root);
  const resolved = await realpath(path.resolve(canonicalRoot, relative));
  const relation = path.relative(canonicalRoot, resolved);
  if (
    relation === ".." ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  ) {
    throw new Error("Path escapes configured root");
  }
  return resolved;
}

export async function readProjectFile(
  root: string,
  relative: string,
): Promise<string> {
  const resolved = await withinRoot(root, relative);
  const stat = await lstat(resolved);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024)
    throw new Error("File exceeds inventory limits");
  return readFile(resolved, "utf8");
}

export async function inventory(inputRoot: string): Promise<Inventory> {
  const root = await realpath(inputRoot);
  const files: string[] = [];
  const excluded: string[] = [];
  const hash = createHash("sha256");
  let size = 0;
  let entriesSeen = 0;
  async function visit(relative: string, depth: number): Promise<void> {
    if (depth > 32) throw new Error("Inventory depth limit exceeded");
    const directory = await withinRoot(root, relative);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      if (++entriesSeen > 20_000)
        throw new Error("Inventory entry limit exceeded");
      const file = relative === "." ? entry.name : `${relative}/${entry.name}`;
      if (
        entry.name === ".git" ||
        entry.isSymbolicLink() ||
        sensitive(entry.name) ||
        (entry.isDirectory() && excludedDirectories.has(entry.name))
      ) {
        excluded.push(file);
      } else if (entry.isDirectory()) {
        await visit(file, depth + 1);
      } else if (entry.isFile()) {
        const resolved = await withinRoot(root, file);
        const stat = await lstat(resolved);
        size += stat.size;
        if (stat.size > 8 * 1024 * 1024 || size > 64 * 1024 * 1024) {
          throw new Error("Inventory byte limit exceeded");
        }
        const bytes = await readFile(resolved);
        hash.update(JSON.stringify([file, bytes.length]));
        hash.update(bytes);
        files.push(file);
      }
    }
  }
  await visit(".", 0);
  hash.update(JSON.stringify(excluded));
  return { root, files, excluded, fingerprint: hash.digest("hex") };
}
