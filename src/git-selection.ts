import { createHash } from "node:crypto";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { withinRoot } from "./inventory.js";
import { runProcess } from "./runner.js";
import { affectedProjects } from "./workspace.js";
import type {
  ChangeSelection,
  GitIdentity,
  Inventory,
  Workspace,
} from "./types.js";

const gitEnvironment = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_ATTR_NOSYSTEM: "1",
};
async function hostGit(root: string): Promise<string> {
  const outside = (file: string) => {
    const relative = path.relative(root, file);
    return (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    );
  };
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, "git");
    if (!outside(candidate)) continue;
    try {
      const resolved = await realpath(candidate);
      if (outside(resolved) && (await lstat(resolved)).isFile()) {
        await access(resolved, constants.X_OK);
        return resolved;
      }
    } catch {
      continue;
    }
  }
  throw new Error("A host Git executable outside the project is required");
}

function gitReader(root: string) {
  const executable = hostGit(root);
  const deadline = Date.now() + 5000;
  let bytes = 4 * 1024 * 1024;
  return async (args: string[]): Promise<string> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || bytes <= 0)
      throw new Error("Git inspection budget exceeded");
    const result = await runProcess(
      root,
      {
        executable: await executable,
        args: [
          "--no-pager",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "submodule.recurse=false",
          ...args,
        ],
        cwd: ".",
        env: gitEnvironment,
      },
      { timeoutMs: remaining, maxOutputBytes: bytes },
    );
    bytes -=
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
    if (
      result.exitCode !== 0 ||
      result.signal ||
      result.errorCode ||
      result.timedOut ||
      result.cancelled ||
      result.truncated ||
      result.stderr.trim()
    )
      throw new Error("Git inspection was not conclusive");
    return result.stdout;
  };
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const oid = (value: string): string => {
  const hash = value.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash))
    throw new Error("Invalid Git object identity");
  return hash;
};
type Entry = { mode: string; hash: string };
function entries(output: string, index: boolean): Map<string, Entry> {
  if (output && !output.endsWith("\0"))
    throw new Error("Unterminated Git evidence");
  const result = new Map<string, Entry>();
  for (const entry of output.split("\0").filter(Boolean)) {
    const match = (
      index
        ? /^(100644|100755) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t([^]*)$/
        : /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([^]*)$/
    ).exec(entry);
    if (!match) throw new Error("Unsupported Git entry or unresolved merge");
    const file = match[3]!;
    if (
      !file ||
      path.posix.isAbsolute(file) ||
      file.split("/").some((part) => !part || part === "." || part === "..") ||
      result.has(file)
    )
      throw new Error("Ambiguous Git path");
    result.set(file, { mode: match[1]!, hash: match[2]! });
    if (result.size > 20_000) throw new Error("Git entry limit exceeded");
  }
  return result;
}
function differences(
  a: Map<string, Entry>,
  b: Map<string, Entry>,
  target: Set<string>,
): void {
  for (const key of new Set([...a.keys(), ...b.keys()]))
    if (
      a.get(key)?.hash !== b.get(key)?.hash ||
      a.get(key)?.mode !== b.get(key)?.mode
    )
      target.add(key);
}

export async function selectGitChanges(
  source: Inventory,
  projects: string[],
  base: string,
  workspace?: Workspace,
): Promise<ChangeSelection> {
  const full: ChangeSelection = {
    mode: "full",
    reason:
      "Git change scope could not be established; retaining the full configured plan.",
    changedFiles: [],
    selectedProjects: [...new Set(projects)].sort(),
  };
  try {
    if (!base || base.length > 1024 || base.includes("\0")) return full;
    const read = gitReader(source.root);
    const top = (await read(["rev-parse", "--show-toplevel"])).trimEnd();
    if ((await realpath(top)) !== source.root)
      return {
        ...full,
        reason: "The configured root is not the Git worktree root.",
      };
    const version = (await read(["--version"])).trim();
    if (!/^git version \d+\.\d+\.\d+[^\n]*$/.test(version)) return full;
    const headCommit = oid(
      await read([
        "rev-parse",
        "--verify",
        "--end-of-options",
        "HEAD^{commit}",
      ]),
    );
    const baseCommit = oid(
      await read([
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${base}^{commit}`,
      ]),
    );
    const baseTree = entries(
      await read(["ls-tree", "-rz", "--full-tree", baseCommit]),
      false,
    );
    const headTree = entries(
      await read(["ls-tree", "-rz", "--full-tree", headCommit]),
      false,
    );
    const indexOutput = await read(["ls-files", "--stage", "-z"]);
    const index = entries(indexOutput, true);
    const identity: GitIdentity = {
      baseCommit,
      headCommit,
      version,
      worktreeId: digest(source.root),
      indexFingerprint: digest(indexOutput),
    };
    full.git = identity;
    const files = new Set(source.files);
    if (
      [...index.keys()].some(
        (file) =>
          !files.has(file) &&
          source.excluded.some(
            (excluded) => file === excluded || file.startsWith(`${excluded}/`),
          ),
      )
    )
      return {
        ...full,
        reason:
          "Tracked excluded content prevents complete working-tree comparison.",
      };
    const changed = new Set<string>();
    differences(baseTree, headTree, changed);
    differences(headTree, index, changed);
    let size = 0;
    const working = new Map<string, Entry>();
    for (const file of source.files) {
      const resolved = await withinRoot(source.root, file);
      const stat = await lstat(resolved);
      size += stat.size;
      if (
        !stat.isFile() ||
        stat.size > 8 * 1024 * 1024 ||
        size > 64 * 1024 * 1024
      )
        return full;
      const bytes = await readFile(resolved);
      const hash = createHash(headCommit.length === 40 ? "sha1" : "sha256")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
      working.set(file, {
        mode: stat.mode & 0o111 ? "100755" : "100644",
        hash,
      });
    }
    differences(index, working, changed);
    if (
      oid(
        await read([
          "rev-parse",
          "--verify",
          "--end-of-options",
          "HEAD^{commit}",
        ]),
      ) !== headCommit ||
      digest(await read(["ls-files", "--stage", "-z"])) !==
        identity.indexFingerprint
    )
      return full;
    const changedFiles = [...changed].sort();
    const impact = affectedProjects(projects, changedFiles, workspace);
    return {
      mode: impact.affected ? "affected" : "full",
      reason: impact.reason,
      changedFiles,
      selectedProjects: impact.projects,
      git: identity,
    };
  } catch {
    return full;
  }
}

export async function verifyGitIdentity(
  root: string,
  identity: GitIdentity,
): Promise<"same" | "changed" | "error"> {
  try {
    const read = gitReader(root);
    const head = oid(
      await read([
        "rev-parse",
        "--verify",
        "--end-of-options",
        "HEAD^{commit}",
      ]),
    );
    const index = digest(await read(["ls-files", "--stage", "-z"]));
    return head === identity.headCommit && index === identity.indexFingerprint
      ? "same"
      : "changed";
  } catch {
    return "error";
  }
}
