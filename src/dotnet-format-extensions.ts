import path from "node:path";
import { fileURLToPath } from "node:url";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { z } from "zod";
import { dotnetBuildCheck } from "./dotnet-build.js";
import { readProjectFile } from "./inventory.js";
import { mavenHash, mavenLocal } from "./maven.js";
import { verifyFsharpSdk } from "./fsharp-format.js";
import {
  dotnetFormatterSdkPins,
  dotnetFormatterRuleCatalogue,
} from "./dotnet-formatter-pins.js";
import type { Check, Inventory, Project } from "./types.js";

const identifier = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
export const dotnetFormatExtensionsConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("sdk-code-style-and-analyzers-v1"),
  styleDiagnostics: z.array(identifier).min(1).max(64),
  analyzerDiagnostics: z.array(identifier).min(1).max(64),
  severity: z.enum(["info", "warn", "error"]),
  includeGenerated: z.literal(true),
});
export function dotnetFormatterRequire(
  value: unknown,
  message: string,
): asserts value {
  if (!value) throw Error(message);
}

export async function verifyDotnetFormatterSdk(root: string) {
  const executable = await verifyFsharpSdk(root);
  for (const pin of dotnetFormatterSdkPins) {
    const file = path.join(root, pin.file),
      info = await lstat(file);
    dotnetFormatterRequire(
      info.isFile() &&
        !info.isSymbolicLink() &&
        info.size === pin.bytes &&
        (await realpath(file)) === file,
      "Selected SDK formatter component identity",
    );
    const bytes = await readFile(file);
    dotnetFormatterRequire(
      bytes.length === pin.bytes && mavenHash(bytes) === pin.sha256,
      "Selected SDK formatter component bytes",
    );
  }
  for (const directory of [
    "sdk/10.0.401/DotnetTools/dotnet-format",
    "sdk/10.0.401/Sdks/Microsoft.NET.Sdk/analyzers",
    "packs/Microsoft.NETCore.App.Ref/10.0.12/analyzers",
  ]) {
    const actual: string[] = [];
    let entries = 0;
    async function walk(relative: string) {
      const folder = path.join(root, relative),
        info = await lstat(folder);
      dotnetFormatterRequire(
        info.isDirectory() &&
          !info.isSymbolicLink() &&
          (await realpath(folder)) === folder,
        "Selected SDK formatter directory",
      );
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        dotnetFormatterRequire(
          ++entries <= 4096,
          "Selected SDK formatter inventory bound",
        );
        const file = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) await walk(file);
        else actual.push(file);
      }
    }
    await walk(directory);
    const expected = dotnetFormatterSdkPins
      .filter((p) => p.file.startsWith(directory + "/"))
      .map((p) => p.file);
    dotnetFormatterRequire(
      JSON.stringify(actual.sort()) === JSON.stringify(expected.sort()),
      "Exact selected SDK formatter inventory",
    );
  }
  const sdk = "sdk/10.0.401",
    actual = (await readdir(path.join(root, sdk)))
      .filter((file) => /\.(?:dll|json|config)$/.test(file))
      .sort();
  const expected = dotnetFormatterSdkPins
    .filter((p) => path.posix.dirname(p.file) === sdk)
    .map((p) => path.posix.basename(p.file))
    .sort();
  dotnetFormatterRequire(
    JSON.stringify(actual) === JSON.stringify(expected),
    "Exact selected SDK root components",
  );
  return executable;
}

export async function selectedDotnetFormatterSdk() {
  for (const directory of (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)) {
    try {
      const tool = await realpath(path.join(directory, "dotnet"));
      dotnetFormatterRequire(
        path.basename(tool) === "dotnet",
        "Canonical selected SDK executable",
      );
      const root = path.dirname(tool);
      await verifyDotnetFormatterSdk(root);
      return { root, executable: tool };
    } catch {
      // Never execute a version guess to admit a different SDK component tree.
    }
  }
  throw Error("Selected SDK formatter components are unavailable");
}

export function validateDotnetFormattingRules(
  config: z.infer<typeof dotnetFormatExtensionsConfigSchema>,
  languages: string[],
) {
  const selected = languages.map((language) =>
    language === "csharp"
      ? "C#"
      : language === "visual-basic"
        ? "Visual Basic"
        : null,
  );
  dotnetFormatterRequire(
    selected.length > 0 && selected.every(Boolean),
    "SDK formatter project languages",
  );
  for (const [category, values] of [
    ["CodeStyle", config.styleDiagnostics],
    ["Analyzers", config.analyzerDiagnostics],
  ] as const) {
    dotnetFormatterRequire(
      new Set(values).size === values.length,
      "Unique selected SDK diagnostic identifiers",
    );
    for (const value of values) {
      dotnetFormatterRequire(
        selected.some((language) =>
          (
            dotnetFormatterRuleCatalogue[category][
              language as "C#" | "Visual Basic"
            ] as readonly string[]
          ).includes(value),
        ),
        "Selected diagnostic must exist in the observed native SDK catalogue",
      );
    }
  }
}

export async function dotnetFormatExtensionsCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const check = await dotnetBuildCheck(source, project);
  check.id = "dotnet.format-extensions";
  check.kind = "format";
  check.parser = "dotnet-format-extensions-json";
  check.reason =
    "Reconcile selected native SDK style/analyzer diagnostics, proposed source edits and complete declared generated-source participation without rewriting project files.";
  if (!check.commands.length) return check;
  try {
    const file = "checktrail.dotnet-format.json";
    dotnetFormatterRequire(
      project.files.includes(file),
      "Declare inventoried SDK formatting policy",
    );
    const text = await readProjectFile(
      source.root,
      path.posix.join(project.path, file),
    );
    dotnetFormatterRequire(
      Buffer.byteLength(text) <= 65536,
      "SDK formatting policy bound",
    );
    const config = dotnetFormatExtensionsConfigSchema.parse(JSON.parse(text));
    const invocation = JSON.parse(check.commands[0]!.args[2]!) as {
      config: { projects: Array<{ language: string }> };
    };
    validateDotnetFormattingRules(
      config,
      invocation.config.projects.map((p) => p.language),
    );
    for (const file of check.scope) {
      const bytes = await readFile(
        await mavenLocal(source.root, project.path, file),
      );
      dotnetFormatterRequire(
        bytes.length <= 65536,
        "SDK formatting document bound",
      );
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    await selectedDotnetFormatterSdk();
    check.commands[0]!.args[0] = fileURLToPath(
      new URL("./dotnet-build-runner.js", import.meta.url),
    );
    check.commands[0]!.args.push("--format-extensions", JSON.stringify(config));
  } catch {
    check.commands = [];
    check.unavailableReason =
      "SDK formatting prerequisites are missing, changed, incomplete or unsupported; declare current C#/VB projects, exact sources, generated outputs, dependencies and known native diagnostic identifiers.";
  }
  return check;
}
