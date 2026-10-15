import { z } from "zod";
import path from "node:path";
import { readFile, readdir, lstat, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { externalPathSchema } from "./external-schema.js";
import { readProjectFile } from "./inventory.js";
import { mavenHash, mavenLocal } from "./maven.js";
import { fsharpFormatterPins, fsharpSdkPins } from "./fsharp-format-pins.js";
import type { Check, Inventory, Project } from "./types.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const fsharpFormatConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("fantomas-core-default-v1"),
  formatterDirectory: externalPathSchema,
  files: z.array(externalPathSchema).min(1).max(128),
});
export const fsharpFormatInvocationSchema = z.strictObject({
  config: fsharpFormatConfigSchema,
  inputs: z
    .array(
      z.strictObject({
        file: externalPathSchema,
        bytes: z.number().int().nonnegative().max(65536),
        sha256: digest,
      }),
    )
    .min(2)
    .max(129),
});
export function fsharpRequire(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
export async function fsharpRegular(file: string, bound: number) {
  const stat = await lstat(file);
  fsharpRequire(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size <= bound &&
      (await realpath(file)) === file,
    "Bounded canonical regular F# input required",
  );
  const bytes = await readFile(file);
  fsharpRequire(bytes.length <= bound, "F# file grew beyond its bound");
  return bytes;
}
export async function verifyFsharpFormatter(
  root: string,
  project: string,
  directory: string,
) {
  const resolved = await mavenLocal(root, project, directory),
    stat = await lstat(resolved);
  fsharpRequire(
    stat.isDirectory() && !stat.isSymbolicLink(),
    "Canonical formatter directory required",
  );
  fsharpRequire(
    JSON.stringify((await readdir(resolved)).sort()) ===
      JSON.stringify(fsharpFormatterPins.map((p) => p.file).sort()),
    "Exact selected formatter assembly inventory required",
  );
  for (const pin of fsharpFormatterPins) {
    const file = await mavenLocal(root, project, directory + "/" + pin.file),
      bytes = await fsharpRegular(file, 32 * 1024 * 1024);
    fsharpRequire(
      bytes.length === pin.bytes && mavenHash(bytes) === pin.sha256,
      "Pinned formatter assembly bytes differ",
    );
  }
  return resolved;
}
export async function verifyFsharpSdk(root: string) {
  fsharpRequire(
    path.isAbsolute(root) && (await realpath(root)) === root,
    "Canonical selected SDK root required",
  );
  for (const directory of ["host/fxr", "shared/Microsoft.NETCore.App"]) {
    fsharpRequire(
      JSON.stringify((await readdir(path.join(root, directory))).sort()) ===
        JSON.stringify(["10.0.12"]),
      "Exact runtime and native host version inventory required",
    );
  }
  const groups = new Map<string, string[]>();
  for (const pin of fsharpSdkPins) {
    const file = path.join(root, pin.file),
      bytes = await fsharpRegular(file, 64 * 1024 * 1024);
    fsharpRequire(
      bytes.length === pin.bytes && mavenHash(bytes) === pin.sha256,
      "Selected SDK/compiler/runtime bytes differ",
    );
    if (pin.file !== "dotnet") {
      const directory = path.posix.dirname(pin.file),
        files = groups.get(directory) ?? [];
      files.push(path.posix.basename(pin.file));
      groups.set(directory, files);
    }
  }
  for (const [directory, expected] of groups) {
    const actual = (
      await readdir(path.join(root, directory), { withFileTypes: true })
    )
      .filter((e) => /\.(dll|so|json)$/.test(e.name))
      .map((e) => e.name)
      .sort();
    fsharpRequire(
      JSON.stringify(actual) === JSON.stringify(expected.sort()),
      "Selected SDK component inventory differs",
    );
  }
  return path.join(root, "dotnet");
}
export async function fsharpFormatCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const scope = project.files.filter((f) => /\.(?:fs|fsi|fsx)$/.test(f)).sort(),
    check: Check = {
      id: "dotnet.format-fsharp",
      adapter: project.adapter,
      project: project.path,
      scope,
      kind: "format",
      parser: "fsharp-format-json",
      commands: [],
      reason:
        "Inspect every declared F# implementation, signature or script with the pinned non-rewriting native formatter and complete source/document accounting.",
    };
  try {
    fsharpRequire(scope.length > 0, "No inventoried F# documents selected");
    const name = "checktrail.fsharp-format.json";
    fsharpRequire(
      project.files.includes(name),
      "Declare the native default formatting profile in checktrail.fsharp-format.json",
    );
    const contents = await readProjectFile(
        source.root,
        path.posix.join(project.path, name),
      ),
      config = fsharpFormatConfigSchema.parse(JSON.parse(contents));
    fsharpRequire(
      new Set(config.files).size === config.files.length &&
        JSON.stringify([...config.files].sort()) === JSON.stringify(scope),
      "Declare every inventoried F# document exactly once",
    );
    await verifyFsharpFormatter(
      source.root,
      project.path,
      config.formatterDirectory,
    );
    const inputs = [];
    let total = 0;
    for (const file of [name, ...config.files]) {
      const bytes = await fsharpRegular(
        await mavenLocal(source.root, project.path, file),
        65536,
      );
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      total += bytes.length;
      fsharpRequire(total <= 8 * 1024 * 1024, "F# source input byte bound");
      inputs.push({ file, bytes: bytes.length, sha256: mavenHash(bytes) });
    }
    const invocation = JSON.stringify(
      fsharpFormatInvocationSchema.parse({ config, inputs }),
    );
    fsharpRequire(
      Buffer.byteLength(invocation) <= 100 * 1024,
      "F# invocation argument bound",
    );
    check.commands = [
      {
        executable: process.execPath,
        args: [
          fileURLToPath(new URL("./fsharp-format-runner.js", import.meta.url)),
          source.root,
          invocation,
        ],
        cwd: project.path,
        temporaryDirectory: true,
        env: { PATH: process.env.PATH ?? "" },
      },
    ];
  } catch {
    check.commands = [];
    check.unavailableReason =
      "F# formatter prerequisites are missing, changed, incomplete or unsupported; declare every source and the exact selected local formatter assemblies.";
  }
  return check;
}
