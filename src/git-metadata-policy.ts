import path from "node:path";
import type { Command } from "./types.js";
export const gitMetadataEnvironment = Object.freeze({
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_ALLOW_PROTOCOL: "",
});
export const gitMetadataPrefix = Object.freeze([
  "--no-pager",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "submodule.recurse=false",
]);
const oid = (v: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v);
/** Exact read-only forms used by selection and review; no arbitrary Git subcommand. */
export function isGitMetadataCommand(command: Command): boolean {
  if (command.cwd !== "." || command.temporaryDirectory || !command.env)
    return false;
  if (
    JSON.stringify(Object.entries(command.env).sort()) !==
    JSON.stringify(Object.entries(gitMetadataEnvironment).sort())
  )
    return false;
  if (!gitMetadataPrefix.every((value, index) => command.args[index] === value))
    return false;
  let args = command.args.slice(gitMetadataPrefix.length);
  if (args.some((value) => typeof value !== "string" || value.includes("\0")))
    return false;
  const literal = args[0] === "--literal-pathspecs";
  if (literal) args = args.slice(1);
  if (args.length === 1 && args[0] === "--version") return !literal;
  if (args[0] === "rev-parse" && !literal) {
    if (args.length === 2 && args[1] === "--show-toplevel") return true;
    if (
      args.length === 3 &&
      args[1] === "--verify" &&
      args[2] === "HEAD^{commit}"
    )
      return true;
    return (
      args.length === 4 &&
      args[1] === "--verify" &&
      args[2] === "--end-of-options" &&
      args[3]!.length <= 1024 &&
      args[3]!.endsWith("^{commit}")
    );
  }
  if (args[0] === "ls-files" && !literal)
    return args.length === 3 && args[1] === "--stage" && args[2] === "-z";
  if (args[0] === "cat-file" && !literal)
    return (
      args.length === 3 && ["-s", "blob"].includes(args[1]!) && oid(args[2]!)
    );
  if (
    args[0] === "ls-tree" &&
    args[1] === "-rz" &&
    args[2] === "--full-tree" &&
    oid(args[3] ?? "")
  ) {
    if (args.length === 4) return true;
    return (
      literal &&
      args[4] === "--" &&
      args.slice(5).every((value) => value.length > 0 && value.length <= 1024)
    );
  }
  return false;
}

/** Selected Git for Windows x64 built-in, not the cmd/bin forwarding launcher. */
export function isWindowsBuiltinGit(executable: string): boolean {
  if (executable.startsWith("\\") || executable.startsWith("//")) return false;
  if (!path.win32.isAbsolute(executable)) return false;
  const directory = path.win32.dirname(executable);
  return (
    path.win32.basename(executable).toLowerCase() === "git.exe" &&
    path.win32.basename(directory).toLowerCase() === "bin" &&
    path.win32.basename(path.win32.dirname(directory)).toLowerCase() ===
      "mingw64"
  );
}
