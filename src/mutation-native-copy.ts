import { createHash } from "node:crypto";
import {
  lstat,
  readdir,
  open,
  readlink,
  mkdir,
  writeFile,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { withinRoot } from "./inventory.js";
export const mutationHash = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
type Entry =
  | { path: string; mode: number; bytes: Buffer }
  | { path: string; target: string };
export interface MutationDependencies {
  fingerprint: string;
  entries: Entry[];
}
export async function mutationBoundedBytes(
  root: string,
  file: string,
  maximum: number,
): Promise<Buffer> {
  const full = await withinRoot(root, file),
    handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum)
      throw Error("Mutation file exceeds its selected byte bound");
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    const final = await handle.stat();
    if (
      size !== stat.size ||
      final.size !== stat.size ||
      final.mtimeMs !== stat.mtimeMs ||
      final.ctimeMs !== stat.ctimeMs
    )
      throw Error("Mutation file changed during bounded read");
    return bytes.subarray(0, size);
  } finally {
    await handle.close();
  }
}
export async function mutationDependencies(
  root: string,
  directory: string,
  active: () => boolean,
): Promise<MutationDependencies> {
  const entries: Entry[] = [];
  let seen = 0,
    total = 0;
  const base = path.join(root, directory);
  if (
    (await lstat(base)).isSymbolicLink() ||
    !(await lstat(base)).isDirectory()
  )
    throw Error("Physical mutation dependency directory required");
  async function visit(relative: string, depth: number): Promise<void> {
    if (!active() || depth > 32)
      throw Error("Mutation dependency preparation interrupted or too deep");
    for (const item of (
      await readdir(path.join(root, relative), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (!active() || ++seen > 32000)
        throw Error("Mutation dependency entry budget exceeded");
      const file = path.posix.join(relative, item.name),
        full = path.join(root, file),
        stat = await lstat(full);
      if (stat.isSymbolicLink()) {
        const resolved = await withinRoot(root, file),
          target = path.relative(base, resolved);
        if (
          target === ".." ||
          target.startsWith(".." + path.sep) ||
          path.isAbsolute(target)
        )
          throw Error("Mutation dependency link leaves its selected closure");
        const link = await readlink(full);
        if (!link.length) throw Error("Empty mutation dependency link");
        entries.push({
          path: file,
          target: path.relative(path.dirname(full), resolved),
        });
      } else if (stat.isDirectory()) await visit(file, depth + 1);
      else if (stat.isFile()) {
        total += stat.size;
        if (stat.size > 64 * 1048576 || total > 384 * 1048576)
          throw Error("Mutation dependency byte budget exceeded");
        const bytes = await mutationBoundedBytes(
          root,
          file,
          Math.min(64 * 1048576, 384 * 1048576 - total + stat.size),
        );
        if (bytes.length !== stat.size)
          throw Error("Mutation dependency changed while reading");
        entries.push({ path: file, mode: stat.mode & 0o777, bytes });
      } else
        throw Error(
          "Special mutation dependency entries require another profile",
        );
    }
  }
  await visit(directory, 0);
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(
      JSON.stringify(
        "bytes" in entry
          ? [entry.path, entry.mode, entry.bytes.length]
          : [entry.path, entry.target],
      ),
    );
    if ("bytes" in entry) hash.update(entry.bytes);
  }
  if (!entries.length) throw Error("Empty mutation dependency closure");
  return { fingerprint: hash.digest("hex"), entries };
}
export async function writeMutationCopy(
  copy: string,
  sources: Map<string, Buffer>,
  dependencies: MutationDependencies | undefined,
  active: () => boolean,
  edit?: { file: string; text: string },
) {
  // Every source and dependency entry has been validated before the first write.
  for (const [file, bytes] of sources) {
    if (!active()) throw Error("Mutation copy interrupted");
    const target = path.join(copy, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, edit?.file === file ? edit.text : bytes, {
      mode: 0o600,
      flag: "wx",
    });
  }
  for (const entry of dependencies?.entries ?? []) {
    if (!active()) throw Error("Mutation copy interrupted");
    const target = path.join(copy, entry.path);
    await mkdir(path.dirname(target), { recursive: true });
    if ("bytes" in entry)
      await writeFile(target, entry.bytes, { mode: entry.mode, flag: "wx" });
    else await symlink(entry.target, target);
  }
}
