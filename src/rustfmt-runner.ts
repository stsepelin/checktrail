import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import { withinRoot } from "./inventory.js";
import { rustfmtHasSkip } from "./rustfmt-skips.js";
const invocation = z.strictObject({
  version: z.literal(1),
  root: z.string(),
  project: z.string(),
  files: z.array(z.string().min(1)).min(1).max(1000),
  config: z.string().nullable(),
});
const metadataSchema = z.object({
  version: z.literal(1),
  workspace_root: z.string(),
  workspace_members: z.array(z.string()).min(1),
  packages: z.array(
    z.object({
      id: z.string(),
      manifest_path: z.string(),
      edition: z.enum(["2015", "2018", "2021", "2024"]),
      targets: z.array(z.object({ src_path: z.string() })),
      dependencies: z.array(z.object({ path: z.string().optional() })),
    }),
  ),
});
const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
let remaining = 1024 * 1024;
function invoke(executable: string, args: string[]) {
  const value = spawnSync(executable, args, {
    encoding: "utf8",
    maxBuffer: Math.max(1, remaining),
  });
  if (value.error || value.signal || value.status === null)
    throw new Error("native-process-incomplete");
  remaining -=
    Buffer.byteLength(value.stdout) + Buffer.byteLength(value.stderr);
  if (remaining < 0) throw new Error("native-output-limit");
  return { exitCode: value.status, stdout: value.stdout, stderr: value.stderr };
}
async function main() {
  const request = invocation.parse(JSON.parse(process.argv[2] ?? ""));
  const cwd = await realpath(process.cwd());
  const root = await realpath(request.root);
  if (
    cwd !== path.resolve(root, request.project) ||
    new Set(request.files).size !== request.files.length
  )
    throw new Error("invalid-source-scope");
  for (const [tool, pattern] of [
    ["cargo", /^cargo 1\.98\.1 \([a-f0-9]+ [0-9-]+\)$/],
    ["rustfmt", /^rustfmt 1\.9\.0-stable \([a-f0-9]+ [0-9-]+\)$/],
  ] as const) {
    const value = invoke(tool, ["--version"]);
    if (
      value.exitCode !== 0 ||
      value.stderr.trim() ||
      !pattern.test(value.stdout.trim())
    )
      throw new Error("unsupported-version");
  }
  const meta = invoke("cargo", [
    "metadata",
    "--offline",
    "--locked",
    "--no-deps",
    "--format-version=1",
  ]);
  if (meta.exitCode !== 0 || meta.stderr.trim())
    throw new Error("metadata-prerequisite-failed");
  const metadata = metadataSchema.parse(JSON.parse(meta.stdout));
  if (metadata.workspace_root !== cwd)
    throw new Error("workspace-root-not-selected");
  const members = metadata.packages.filter((pkg) =>
    metadata.workspace_members.includes(pkg.id),
  );
  if (members.length !== metadata.workspace_members.length)
    throw new Error("workspace-members-incomplete");
  const memberDirectories = new Set(
    members.map((pkg) => path.dirname(pkg.manifest_path)),
  );
  if (
    members.some((pkg) =>
      pkg.dependencies.some(
        (dependency) =>
          dependency.path && !memberDirectories.has(dependency.path),
      ),
    )
  )
    throw new Error("nonmember-path-dependency");
  for (const pkg of members) {
    if (
      (await withinRoot(root, path.relative(root, pkg.manifest_path))) !==
      pkg.manifest_path
    )
      throw new Error("foreign-manifest");
    for (const target of pkg.targets)
      await withinRoot(root, path.relative(root, target.src_path));
  }
  const temporary = await mkdtemp(path.join(tmpdir(), "checktrail-rustfmt-"));
  try {
    const config = path.join(temporary, "rustfmt.toml");
    await writeFile(
      config,
      request.config === null
        ? ""
        : await readFile(
            await withinRoot(root, path.join(request.project, request.config)),
          ),
    );
    const files = [];
    for (const file of request.files) {
      const absolute = await withinRoot(root, path.join(request.project, file));
      const bytes = await readFile(absolute);
      const source = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
      const owner = members
        .filter((pkg) =>
          absolute.startsWith(path.dirname(pkg.manifest_path) + path.sep),
        )
        .sort((a, b) => b.manifest_path.length - a.manifest_path.length)[0];
      if (!owner) throw new Error("source-outside-selected-workspace");
      const configResult = invoke("rustfmt", [
        "--edition",
        owner.edition,
        "--config-path",
        config,
        "--print-config",
        "current",
        absolute,
      ]);
      if (configResult.exitCode !== 0 || configResult.stderr.trim())
        throw new Error("configuration-prerequisite-failed");
      const settings = parse(configResult.stdout);
      const disabled =
        settings.disable_all_formatting !== false ||
        settings.skip_children !== false ||
        settings.format_generated_files !== true ||
        !Array.isArray(settings.ignore) ||
        settings.ignore.length > 0 ||
        !Array.isArray(settings.skip_macro_invocations) ||
        settings.skip_macro_invocations.length > 0;
      const skipped = rustfmtHasSkip(source);
      const formatted =
        disabled || skipped || !source.trim()
          ? null
          : invoke("rustfmt", [
              "--edition",
              owner.edition,
              "--config-path",
              config,
              "--config",
              "skip_children=true",
              "--check",
              "--color",
              "never",
              absolute,
            ]);
      files.push({
        file,
        inputSha256: hash(bytes),
        nativeOutputSha256: formatted ? hash(formatted.stdout) : null,
        disabled,
        skipped,
        empty: !source.trim(),
        process: formatted,
      });
    }
    const cargo = invoke("cargo", [
      "fmt",
      "--all",
      "--check",
      "--",
      "--verbose",
      "--config-path",
      config,
      "--color",
      "never",
    ]);
    process.stdout.write(
      JSON.stringify({
        version: 1,
        cargoVersion: "1.98.1",
        rustfmtVersion: "1.9.0-stable",
        project: request.project,
        files,
        cargo,
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch(() => {
  process.stdout.write(
    JSON.stringify({ unavailable: "rust-formatting-profile" }),
  );
  process.exitCode = 2;
});
