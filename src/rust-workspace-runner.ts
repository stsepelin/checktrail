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
import { rustDependencyPaths } from "./rust-dep-info.js";
import { rustCargoSelection } from "./rust-build.js";
import { rustTestsNative } from "./rust-test-native.js";
import {
  rustWorkspaceInputSchema,
  rustWorkspaceMetadataSchema,
} from "./rust-workspace-schema.js";
function invoke(executable: string, args: string[]) {
  const r = spawnSync(executable, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (r.error || r.signal || r.status === null)
    throw Error("Native Rust process did not complete");
  return r;
}
function native(executable: string, args: string[]) {
  const r = invoke(executable, args);
  return { exitCode: r.status!, stdout: r.stdout, stderr: r.stderr };
}
function unavailable(reason: string) {
  process.stdout.write(
    JSON.stringify({ unavailable: "rust-workspace", reason }),
  );
  process.exitCode = 3;
}
async function main() {
  const input = rustWorkspaceInputSchema.parse(JSON.parse(process.argv[2]!));
  const cwd = await realpath(process.cwd());
  if (cwd !== (await realpath(path.resolve(input.root, input.project))))
    throw Error("Rust workspace working directory mismatch");
  for (const tool of [
    "cargo",
    "rustc",
    ...(input.mode === "test" ? ["rustdoc"] : []),
  ]) {
    const version = invoke(tool, ["--version"]);
    if (
      version.status !== 0 ||
      version.stderr.trim() ||
      !new RegExp(`^${tool} 1\\.98\\.1 \\([a-f0-9]+ [0-9-]+\\)$`).test(
        version.stdout.trim(),
      )
    )
      return unavailable("unsupported-version");
  }
  if (input.mode === "clippy") {
    const version = invoke("cargo-clippy", ["--version"]);
    if (
      version.status !== 0 ||
      version.stderr.trim() ||
      !/^clippy 0\.1\.98 \([a-f0-9]+ [0-9-]+\)$/.test(version.stdout.trim())
    )
      return unavailable("unsupported-version");
  }
  const verbose = invoke("rustc", ["-vV"]);
  const hosts = [...verbose.stdout.matchAll(/^host: ([a-z0-9-]+)$/gm)];
  if (verbose.status !== 0 || verbose.stderr.trim() || hosts.length !== 1)
    throw Error("Unknown Rust host target");
  const hostTarget = hosts[0]![1]!;
  const target = input.selection.target;
  if (input.mode === "test" && target !== null && target !== hostTarget)
    return unavailable("cross-target-tests");
  if (target !== null) {
    const lib = invoke("rustc", [
      "--print",
      "target-libdir",
      "--target",
      target,
    ]);
    if (lib.status !== 0 || lib.stderr.trim())
      return unavailable("target-prerequisite");
    try {
      if (
        !(await readdir(lib.stdout.trim())).some((f) =>
          /^libstd-[a-f0-9]+\.rlib$/.test(f),
        )
      )
        return unavailable("target-prerequisite");
    } catch {
      return unavailable("target-prerequisite");
    }
  }
  const temporary = await realpath(
    await mkdtemp(path.join(tmpdir(), "checktrail-rust-workspace-")),
  );
  try {
    const config = [
      "--config",
      `build.build-dir=${JSON.stringify(temporary)}`,
      "--config",
      `build.target-dir=${JSON.stringify(temporary)}`,
    ];
    const selection = rustCargoSelection({
      ...input.selection,
      target: target ?? hostTarget,
    });
    const meta = native("cargo", [
      "metadata",
      "--format-version=1",
      "--offline",
      "--locked",
      ...(!input.selection.defaultFeatures ? ["--no-default-features"] : []),
      ...(input.selection.features.length
        ? ["--features", input.selection.features.join(",")]
        : []),
      ...(target ? ["--filter-platform", target] : []),
      ...config,
    ]);
    if (meta.exitCode !== 0)
      throw Error(
        "Cargo metadata could not resolve the requested locked profile",
      );
    const metadata = rustWorkspaceMetadataSchema.parse(JSON.parse(meta.stdout));
    if (
      metadata.workspace_root !== cwd ||
      metadata.target_directory !== temporary ||
      metadata.build_directory !== temporary
    )
      throw Error("Unsupported Rust workspace root or output directory");
    const members = metadata.packages.filter((p) =>
      metadata.workspace_members.includes(p.id),
    );
    const paths = members
      .map((p) => path.relative(cwd, path.dirname(p.manifest_path)) || ".")
      .sort();
    if (
      members.length !== metadata.workspace_members.length ||
      JSON.stringify(paths) !==
        JSON.stringify([...input.selection.workspaceMembers].sort())
    )
      return unavailable("workspace-members");
    for (const member of members) {
      if (
        (await realpath(member.manifest_path)) !== member.manifest_path ||
        !input.selection.workspaceMembers.includes(
          path.relative(cwd, path.dirname(member.manifest_path)) || ".",
        )
      )
        throw Error("Noncanonical Rust member");
    }
    for (const feature of input.selection.features) {
      const [name, value] = feature.split("/");
      if (
        !members.some(
          (m) => m.name === name && Object.hasOwn(m.features, value!),
        )
      )
        return unavailable("feature-prerequisite");
    }
    const execution = native("cargo", [
      input.mode === "clippy" ? "clippy" : "check",
      "--all-targets",
      "--offline",
      "--locked",
      "--message-format=json",
      "--color=never",
      ...selection,
      ...config,
      ...(input.mode === "clippy" ? ["--", "--force-warn", "clippy::all"] : []),
    ]);
    const files = new Set<string>();
    let entries = 0,
      bytes = 0,
      depInfoCount = 0,
      scopeError = false;
    try {
      const pending = [temporary];
      while (pending.length) {
        const dir = pending.pop()!;
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (++entries > 20000) throw Error("Rust inventory limit");
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) pending.push(file);
          else if (entry.isFile() && entry.name.endsWith(".d")) {
            if (
              (await stat(file)).size >
              Math.min(8 * 1024 * 1024, 16 * 1024 * 1024 - bytes)
            )
              throw Error("Rust dep-info limit");
            const text = await readFile(file, "utf8");
            bytes += Buffer.byteLength(text);
            if (bytes > 16 * 1024 * 1024) throw Error("Rust dep-info limit");
            for (const f of rustDependencyPaths(text, cwd)) files.add(f);
            depInfoCount++;
          }
        }
      }
    } catch {
      scopeError = true;
    }
    const inventoried = new Set(input.scope.map((f) => path.resolve(cwd, f)));
    const observedSources = [...files]
      .filter((f) => inventoried.has(f))
      .map((f) => path.relative(cwd, f))
      .sort();
    let tests = null,
      documentation = null;
    if (input.mode === "test" && execution.exitCode === 0) {
      tests = await rustTestsNative(
        invoke,
        config,
        temporary,
        members[0]!.id,
        members.flatMap((m) =>
          m.targets.filter((t) =>
            (t["required-features"] ?? []).every((f) =>
              metadata.resolve.nodes
                .find((n) => n.id === m.id)
                ?.features.includes(f),
            ),
          ),
        ),
        {
          cargoArgs: selection,
          packageIds: members.map((m) => m.id),
          documentation: false,
        },
      );
      if (
        tests.error === null &&
        members.some((m) => m.targets.some((t) => t.doctest))
      ) {
        const args = [
          "test",
          "--doc",
          "--offline",
          "--locked",
          "--color=never",
          ...selection,
          ...config,
          "--",
        ];
        documentation = {
          listed: native("cargo", [...args, "--list", "--format=terse"]),
          ignoredListed: native("cargo", [
            ...args,
            "--list",
            "--ignored",
            "--format=terse",
          ]),
          execution: native("cargo", [
            ...args,
            "--test-threads=1",
            "--color=never",
            "--format=pretty",
          ]),
        };
      }
    }
    process.stdout.write(
      JSON.stringify({
        version: 4,
        mode: input.mode,
        selection: input.selection,
        cargoVersion: "1.98.1",
        rustcVersion: "1.98.1",
        rustdocVersion: input.mode === "test" ? "1.98.1" : null,
        clippyVersion: input.mode === "clippy" ? "0.1.98" : null,
        project: input.project,
        hostTarget,
        metadata,
        execution,
        observedSources,
        depInfoCount,
        scopeError,
        tests,
        documentation,
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch(() => {
  process.stderr.write(
    "Rust workspace collector could not resolve the requested profile or bounded native evidence.\n",
  );
  process.exitCode = 2;
});
