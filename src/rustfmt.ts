import { fileURLToPath } from "node:url";
import path from "node:path";
import { rustEnvironment } from "./rust.js";
import type { Check, Inventory, Project } from "./types.js";
export function rustfmtCheck(source: Inventory, project: Project): Check {
  const prefix = project.path === "." ? "" : project.path + "/";
  const files = source.files
    .filter((file) => file.startsWith(prefix) && file.endsWith(".rs"))
    .map((file) => file.slice(prefix.length));
  const configs = source.files
    .filter(
      (file) =>
        file.startsWith(prefix) &&
        ["rustfmt.toml", ".rustfmt.toml"].includes(path.posix.basename(file)),
    )
    .map((file) => file.slice(prefix.length));
  const config =
    ["rustfmt.toml", ".rustfmt.toml"].find((file) => configs.includes(file)) ??
    null;
  const check: Check = {
    id: "rust.cargo-fmt",
    adapter: "rust",
    project: project.path,
    scope: files,
    kind: "format",
    parser: "rustfmt-json",
    commands: [
      {
        executable: process.execPath,
        args: [
          fileURLToPath(new URL("./rustfmt-runner.js", import.meta.url)),
          JSON.stringify({
            version: 1,
            root: source.root,
            project: project.path,
            files,
            config,
          }),
        ],
        cwd: project.path,
        env: rustEnvironment,
      },
    ],
    reason:
      "Run pinned offline Cargo formatting in check mode and native per-file Rustfmt stdout comparisons with explicit root configuration; inline skips, disabled formatting and empty or unaccounted files remain incomplete.",
  };
  if (!files.length || files.length > 1000)
    check.unavailableReason =
      "Rust formatting requires between one and 1000 declared source files.";
  else if (!project.files.includes("Cargo.lock"))
    check.unavailableReason =
      "Rust formatting requires an existing project-local Cargo.lock; no lock or dependency is installed.";
  else if (configs.some((file) => file.includes("/")))
    check.unavailableReason =
      "Nested Rustfmt configuration is outside the single root-configuration formatting profile.";
  return check;
}
