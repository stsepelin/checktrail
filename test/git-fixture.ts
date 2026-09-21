import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { deflateSync } from "node:zlib";

export function fixtureGit(
  root: string,
  args: string[],
  input?: string,
): string {
  return execFileSync(
    "git",
    ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args],
    {
      cwd: root,
      ...(input !== undefined ? { input } : {}),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
      },
    },
  );
}

export async function gitObject(
  root: string,
  kind: string,
  contents: Buffer,
): Promise<string> {
  const bytes = Buffer.concat([
    Buffer.from(`${kind} ${contents.length}\0`),
    contents,
  ]);
  const id = createHash("sha1").update(bytes).digest("hex");
  const directory = path.join(root, ".git/objects", id.slice(0, 2));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, id.slice(2)), deflateSync(bytes));
  return id;
}

export async function syntheticCommit(
  root: string,
  files: Record<string, string>,
  parent?: string,
): Promise<string> {
  async function tree(entries: [string, string][]): Promise<string> {
    const groups = new Map<string, [string, string][]>();
    const direct: { name: string; mode: string; id: string }[] = [];
    for (const [name, contents] of entries) {
      const slash = name.indexOf("/");
      if (slash < 0)
        direct.push({
          name,
          mode: "100644",
          id: await gitObject(root, "blob", Buffer.from(contents)),
        });
      else {
        const directory = name.slice(0, slash);
        const children = groups.get(directory) ?? [];
        children.push([name.slice(slash + 1), contents]);
        groups.set(directory, children);
      }
    }
    for (const [name, children] of groups)
      direct.push({ name, mode: "40000", id: await tree(children) });
    direct.sort((a, b) =>
      Buffer.compare(
        Buffer.from(a.name + (a.mode === "40000" ? "/" : "")),
        Buffer.from(b.name + (b.mode === "40000" ? "/" : "")),
      ),
    );
    return gitObject(
      root,
      "tree",
      Buffer.concat(
        direct.flatMap((entry) => [
          Buffer.from(`${entry.mode} ${entry.name}\0`),
          Buffer.from(entry.id, "hex"),
        ]),
      ),
    );
  }
  const id = await gitObject(
    root,
    "commit",
    Buffer.from(
      `tree ${await tree(Object.entries(files))}\n${parent ? `parent ${parent}\n` : ""}author Synthetic Fixture <fixture@example.invalid> 0 +0000\ncommitter Synthetic Fixture <fixture@example.invalid> 0 +0000\n\nSynthetic fixture\n`,
    ),
  );
  await mkdir(path.join(root, ".git/refs/heads"), { recursive: true });
  await writeFile(path.join(root, ".git/refs/heads/main"), `${id}\n`);
  await writeFile(path.join(root, ".git/HEAD"), "ref: refs/heads/main\n");
  fixtureGit(root, ["read-tree", id]);
  return id;
}
