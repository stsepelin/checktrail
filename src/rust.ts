import { fileURLToPath } from "node:url";
import type { Check, Inventory, Project } from "./types.js";

export const rustEnvironment = {
  CARGO_NET_OFFLINE: "true",
  CARGO_INCREMENTAL: "0",
  RUSTUP_AUTO_INSTALL: "0",
};

export function rustCheck(
  source: Inventory,
  project: Project,
  clippy = false,
): Check {
  const scope = project.files.filter((file) => file.endsWith(".rs"));
  const check: Check = {
    id: clippy ? "rust.cargo-clippy" : "rust.cargo-check",
    adapter: project.adapter,
    project: project.path,
    scope,
    kind: "analysis",
    parser: "rust-json",
    reason: clippy
      ? "Run pinned recommended Clippy lint groups at force-warn level for every native target offline with locked dependencies and fresh dep-info scope. Clippy diagnostics fail the check; unsupported or incomplete execution never passes."
      : "Check all native Cargo targets offline with locked dependencies, fresh temporary build output and Rust dep-info source accounting.",
    commands: [
      {
        executable: process.execPath,
        args: [
          fileURLToPath(new URL("./rust-runner.js", import.meta.url)),
          ...(clippy ? ["--clippy"] : []),
          source.root,
          ...scope,
        ],
        cwd: project.path,
        env: rustEnvironment,
      },
    ],
  };
  if (!scope.length)
    check.unavailableReason = "No Rust source was inventoried.";
  else if (!project.files.includes("Cargo.lock"))
    check.unavailableReason =
      "This profile requires an existing project-local Cargo.lock; validation never generates a lockfile.";
  else if (
    [source.root, project.path, ...scope].some((file) =>
      /[\r\n\\$#:]/.test(file),
    )
  )
    check.unavailableReason =
      "This Rust dep-info profile does not support newline, backslash, dollar, hash or colon in source paths.";
  return check;
}
