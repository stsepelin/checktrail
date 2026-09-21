import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { rustDependencyPaths } from "./rust-dep-info.js";

const target = z.object({
  name: z.string(),
  src_path: z.string(),
  kind: z.array(z.string()),
  test: z.boolean(),
});
const metadataSchema = z.object({
  version: z.literal(1),
  workspace_root: z.string(),
  target_directory: z.string(),
  build_directory: z.string(),
  workspace_members: z.array(z.string()),
  packages: z.array(
    z.object({
      id: z.string(),
      manifest_path: z.string(),
      targets: z.array(target),
    }),
  ),
});

function invoke(executable: string, args: string[]) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.signal || result.status === null)
    throw new Error("Rust tool did not complete within evidence limits");
  return result;
}
async function main() {
  const [root, ...scope] = process.argv.slice(2);
  if (!root || !scope.length) throw new Error("Invalid Rust scope");
  for (const tool of ["rustc", "cargo"]) {
    const version = invoke(tool, ["--version"]);
    if (
      version.status !== 0 ||
      version.stderr.trim() ||
      !new RegExp(`^${tool} 1\\.98\\.1 \\([a-f0-9]+ [0-9-]+\\)$`).test(
        version.stdout.trim(),
      )
    ) {
      process.stdout.write(
        JSON.stringify({
          unavailable: "rust-toolchain",
          reason: "unsupported-version",
        }),
      );
      process.exitCode = 3;
      return;
    }
  }
  const temporary = await mkdtemp(path.join(tmpdir(), "checktrail-rust-"));
  try {
    const config = [
      "--config",
      `build.build-dir=${JSON.stringify(temporary)}`,
      "--config",
      `build.target-dir=${JSON.stringify(temporary)}`,
    ];
    const metadataProcess = invoke("cargo", [
      "metadata",
      "--format-version=1",
      "--offline",
      "--locked",
      "--no-deps",
      ...config,
    ]);
    if (metadataProcess.status !== 0)
      throw new Error(
        "Cargo metadata could not resolve the locked local package",
      );
    const metadata = metadataSchema.parse(JSON.parse(metadataProcess.stdout));
    if (
      metadata.target_directory !== temporary ||
      metadata.build_directory !== temporary
    )
      throw new Error("Cargo did not select fresh output directories");
    const cwd = await realpath(process.cwd());
    const selected = metadata.packages.find(
      (item) => item.manifest_path === path.join(cwd, "Cargo.toml"),
    );
    if (
      metadata.workspace_root !== cwd ||
      metadata.workspace_members.length !== 1 ||
      !selected ||
      metadata.workspace_members[0] !== selected.id
    ) {
      process.stdout.write(
        JSON.stringify({
          unavailable: "rust-toolchain",
          reason: "unsupported-workspace",
        }),
      );
      process.exitCode = 3;
      return;
    }
    const execution = invoke("cargo", [
      "check",
      "--all-targets",
      "--offline",
      "--locked",
      "--message-format=json",
      "--color=never",
      "--target-dir",
      temporary,
      ...config,
    ]);
    const events = execution.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const files = new Set<string>();
    let entries = 0;
    let bytes = 0;
    let depInfoCount = 0;
    let scopeError = false;
    try {
      const pending = [temporary];
      while (pending.length) {
        const directory = pending.pop()!;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (++entries > 20_000) throw new Error("Rust build inventory limit");
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) pending.push(file);
          else if (entry.isFile() && entry.name.endsWith(".d")) {
            if (
              (await stat(file)).size >
              Math.min(8 * 1024 * 1024, 16 * 1024 * 1024 - bytes)
            )
              throw new Error("Rust dep-info byte limit");
            const source = await readFile(file, "utf8");
            bytes += Buffer.byteLength(source);
            if (bytes > 16 * 1024 * 1024)
              throw new Error("Rust dep-info byte limit");
            for (const dependency of rustDependencyPaths(source, cwd))
              files.add(dependency);
            depInfoCount++;
          }
        }
      }
    } catch {
      scopeError = true;
    }
    const expected = new Set(scope.map((item) => path.resolve(cwd, item)));
    const observedSources = [...files]
      .filter((file) => expected.has(file))
      .map((file) => path.relative(cwd, file))
      .sort();
    process.stdout.write(
      JSON.stringify({
        version: 1,
        cargoVersion: "1.98.1",
        rustcVersion: "1.98.1",
        exitCode: execution.status,
        project: path.relative(root, cwd) || ".",
        packageId: selected.id,
        targets: selected.targets,
        events,
        observedSources,
        depInfoCount,
        scopeError,
      }),
    );
    process.stderr.write(execution.stderr);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch(() => {
  process.stderr.write(
    "Rust collector failed while resolving the package or bounded native evidence.\n",
  );
  process.exitCode = 2;
});
