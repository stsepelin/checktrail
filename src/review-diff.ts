import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import { gitReader } from "./git-selection.js";
import { inventorySourcePath } from "./inventory.js";

export const commitId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
type Source = { path: string; sha256: string; content: string };
const hash = (content: string) =>
  createHash("sha256").update(content).digest("hex");

// A single exact replacement range avoids quadratic diff algorithms. It can
// include unchanged middle lines; it is not a minimal edit or rename detector.
export function reviewChanges(
  base: Source[],
  current: Source[],
  selected: string[],
) {
  const old = new Map(base.map((file) => [file.path, file]));
  const now = new Map(current.map((file) => [file.path, file]));
  return selected.map((file) => {
    const before = old.get(file);
    const after = now.get(file);
    if (!before && !after)
      throw new Error("Selected review path exists in neither revision");
    const previous = before?.content ?? "";
    const next = after?.content ?? "";
    const a = previous === "" ? [] : previous.split("\n");
    const b = next === "" ? [] : next.split("\n");
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start])
      start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
      endA--;
      endB--;
    }
    return {
      path: file,
      kind: !before
        ? ("added" as const)
        : !after
          ? ("deleted" as const)
          : previous === next
            ? ("unchanged" as const)
            : ("modified" as const),
      beforeSha256: before?.sha256 ?? null,
      afterSha256: after?.sha256 ?? null,
      hunks:
        previous === next
          ? []
          : [
              {
                beforeStartLine: start + 1,
                beforeLineCount: endA - start,
                afterStartLine: start + 1,
                afterLineCount: endB - start,
                removed: a.slice(start, endA),
                added: b.slice(start, endB),
              },
            ],
    };
  });
}

export async function reviewGit(
  root: string,
  baseCommit: string,
  selected: string[],
  currentSource: "working-tree" | "index" = "working-tree",
  sourceLimit: 131072 | 1048576 = 131072,
) {
  commitId.parse(baseCommit);
  const read = gitReader(root);
  if (
    (await realpath(
      (await read(["rev-parse", "--show-toplevel"])).trimEnd(),
    )) !== root
  )
    throw new Error("Review diff requires the configured Git worktree root");
  const resolved = (
    await read([
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${baseCommit}^{commit}`,
    ])
  ).trim();
  if (resolved !== baseCommit)
    throw new Error("Review base must be an exact immutable commit");
  const identity = async () => {
    const headCommit = commitId.parse(
      (await read(["rev-parse", "--verify", "HEAD^{commit}"])).trim(),
    );
    const index = await read(["ls-files", "--stage", "-z"]);
    return { headCommit, indexFingerprint: hash(index), index };
  };
  const before = await identity();
  const output = await read([
    "--literal-pathspecs",
    "ls-tree",
    "-rz",
    "--full-tree",
    baseCommit,
    "--",
    ...selected,
  ]);
  if (output && !output.endsWith("\0"))
    throw new Error("Incomplete review base tree");
  let total = 0;
  const readBlob = async (oid: string, file: string): Promise<Source> => {
    const size = Number((await read(["cat-file", "-s", oid])).trim());
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > 65536 ||
      (total += size) > sourceLimit
    )
      throw new Error("Review source exceeds limits");
    const content = await read(["cat-file", "blob", oid]);
    const bytes = Buffer.from(content);
    const actual = createHash(oid.length === 40 ? "sha1" : "sha256")
      .update(`blob ${size}\0`)
      .update(bytes)
      .digest("hex");
    if (bytes.length !== size || actual !== oid || content.includes("\0"))
      throw new Error("Review source must be exact UTF-8 text");
    return { path: file, sha256: hash(content), content };
  };
  const files: Source[] = [];
  const baseModes = new Map<string, "100644" | "100755">();
  for (const entry of output.split("\0").filter(Boolean)) {
    const match =
      /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([^]*)$/.exec(entry);
    if (
      !match ||
      !selected.includes(match[3]!) ||
      !inventorySourcePath(match[3]!) ||
      baseModes.has(match[3]!)
    )
      throw new Error("Review base path is excluded or is not a regular file");
    const mode = match[1] === "100755" ? "100755" : "100644";
    baseModes.set(match[3]!, mode);
    files.push(await readBlob(match[2]!, match[3]!));
  }
  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  const indexFiles: Source[] = [];
  const indexModes = new Map<string, "100644" | "100755">();
  if (currentSource === "index") {
    if (before.index && !before.index.endsWith("\0"))
      throw new Error("Incomplete review index");
    for (const entry of before.index.split("\0").filter(Boolean)) {
      const delimiter = entry.indexOf("\t");
      if (delimiter < 0) throw new Error("Malformed review index entry");
      const file = entry.slice(delimiter + 1);
      if (!selected.includes(file)) continue;
      const match =
        /^(100644|100755) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t([^]*)$/.exec(entry);
      if (!match || !inventorySourcePath(file) || indexModes.has(file))
        throw new Error(
          "Review index path is not regular or has an unresolved merge",
        );
      const mode = match[1] === "100755" ? "100755" : "100644";
      indexModes.set(file, mode);
      indexFiles.push(await readBlob(match[2]!, file));
    }
    indexFiles.sort((a, b) => a.path.localeCompare(b.path, "en"));
  }
  return {
    baseCommit,
    headCommit: before.headCommit,
    indexFingerprint: before.indexFingerprint,
    baseFiles: files,
    baseModes,
    indexFiles,
    indexModes,
    assertCurrent: async () => {
      if (JSON.stringify(await identity()) !== JSON.stringify(before))
        throw new Error("Git identity changed while preparing review context");
    },
  };
}
