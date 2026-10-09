import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { readProjectFile } from "./inventory.js";
import type { Check, Inventory, Project } from "./types.js";

const relative = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !path.posix.isAbsolute(value) &&
      !value.includes("\\") &&
      !/[\r\n\0]/.test(value) &&
      value !== ".." &&
      !value.startsWith("../") &&
      path.posix.normalize(value) === value,
  );
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const goWorkspaceSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    file: relative,
    sha256: digest,
    modules: z
      .array(
        z.strictObject({
          directory: relative,
          module: z
            .string()
            .min(1)
            .max(1024)
            .refine((value) => !/[\s\0]/.test(value)),
          manifestDigest: digest,
          role: z.enum(["member", "replacement"]),
        }),
      )
      .min(1)
      .max(16),
  })
  .superRefine((value, context) => {
    const directories = value.modules.map((item) => item.directory);
    const members = value.modules.filter((item) => item.role === "member");
    if (
      new Set(directories).size !== directories.length ||
      !members.length ||
      new Set(members.map((item) => item.module)).size !== members.length
    )
      context.addIssue({
        code: "custom",
        message: "Ambiguous Go workspace modules",
      });
  });
export type GoWorkspace = z.infer<typeof goWorkspaceSchema>;
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

// A bounded data lexer. No Go command, project helper or configuration code runs.
function rows(text: string): string[][] {
  if (Buffer.byteLength(text) > 65536 || text.includes("\0"))
    throw new Error("Go workspace manifest exceeds capture limits");
  const lines: string[][] = [];
  let row: string[] = [];
  const finish = () => {
    if (row.length) lines.push(row);
    row = [];
  };
  for (let index = 0; index < text.length;) {
    const char = text[index]!;
    if (char === "\n" || char === "\r") {
      finish();
      index++;
      continue;
    }
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (text.startsWith("//", index)) {
      while (
        index < text.length &&
        text[index] !== "\n" &&
        text[index] !== "\r"
      )
        index++;
      continue;
    }
    if (char === "(" || char === ")") {
      row.push(char);
      index++;
      continue;
    }
    if (char === "`")
      throw new Error("Go manifest paths require double quotes");
    if (char === '"') {
      const start = index++;
      let escaped = false,
        closed = false;
      while (index < text.length) {
        const next = text[index++]!;
        if (next === "\n" || next === "\r")
          throw new Error("Multiline Go manifest string is unsupported");
        if (!escaped && next === char) {
          closed = true;
          break;
        }
        if (char === '"' && !escaped && next === "\\") escaped = true;
        else escaped = false;
      }
      if (!closed) throw new Error("Unterminated Go manifest string");
      const raw = text.slice(start, index);
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new Error("Unsupported Go manifest escape");
      }
      if (typeof value !== "string" || /[\r\n\0]/.test(value))
        throw new Error("Invalid Go manifest string");
      row.push(value);
      continue;
    }
    const start = index;
    while (
      index < text.length &&
      !/[\s()"`]/.test(text[index]!) &&
      !text.startsWith("//", index)
    )
      index++;
    if (start === index) throw new Error("Unsupported Go manifest token");
    row.push(text.slice(start, index));
    if (row.length > 1024 || lines.length > 1024)
      throw new Error("Go manifest entry limit exceeded");
  }
  finish();
  return lines;
}
function directives(text: string) {
  const result: { directive: string; values: string[] }[] = [];
  let block: string | undefined;
  for (const row of rows(text)) {
    if (row.includes("(") || row.includes(")")) {
      if (!block && row.length === 2 && row[1] === "(") {
        block = row[0]!;
        continue;
      }
      if (block && row.length === 1 && row[0] === ")") {
        block = undefined;
        continue;
      }
      throw new Error("Ambiguous Go manifest block");
    }
    if (block) result.push({ directive: block, values: row });
    else result.push({ directive: row[0]!, values: row.slice(1) });
  }
  if (block) throw new Error("Unclosed Go manifest block");
  return result;
}
/** Read one literal module identity from captured text without consulting a Go host. */
export function capturedGoModulePath(text: string): string | null {
  try {
    if (rows(text).some((row) => row[0] === "module" && row.includes("(")))
      return null;
    const values = directives(text).filter(
      (entry) => entry.directive === "module",
    );
    if (values.length !== 1 || values[0]!.values.length !== 1) return null;
    const value = values[0]!.values[0]!;
    // Unsupported path spellings remain unknown; this is not native module validation.
    return value.length <= 1024 &&
      /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(value) &&
      !value.split("/").some((part) => part === "." || part === "..")
      ? value
      : null;
  } catch {
    return null;
  }
}
function replacements(entries: ReturnType<typeof directives>): string[] {
  const targets: string[] = [];
  const identities = new Set<string>();
  for (const { directive, values } of entries) {
    if (directive !== "replace") continue;
    const arrow = values.indexOf("=>");
    if (
      ![1, 2].includes(arrow) ||
      values.lastIndexOf("=>") !== arrow ||
      ![1, 2].includes(values.length - arrow - 1)
    )
      throw new Error("Ambiguous Go replacement declaration");
    const identity = JSON.stringify(values.slice(0, arrow));
    if (identities.has(identity))
      throw new Error("Duplicate Go replacement declaration");
    identities.add(identity);
    const target = values[arrow + 1]!;
    if (values.length === arrow + 2) {
      if (
        !target.startsWith("./") &&
        !target.startsWith("../") &&
        target !== "."
      )
        throw new Error(
          "Go local replacement must be relative to its manifest",
        );
      targets.push(target);
    } else if (
      target.startsWith(".") ||
      path.isAbsolute(target) ||
      target.includes("\\")
    )
      throw new Error("Go replacement version cannot conceal a local path");
  }
  return targets;
}
function localDirectory(base: string, value: string): string {
  if (
    path.posix.isAbsolute(value) ||
    value.includes("\\") ||
    /[\r\n\0]/.test(value)
  )
    throw new Error("Go workspace paths must stay inside the inventoried root");
  const resolved = path.posix.normalize(path.posix.join(base, value));
  if (resolved === ".." || resolved.startsWith("../"))
    throw new Error("Go workspace path escapes the inventoried root");
  return resolved;
}

async function select(
  source: Inventory,
  project: Project,
): Promise<GoWorkspace | undefined> {
  let directory = project.path;
  let file: string | undefined;
  for (;;) {
    const candidate = path.posix.join(directory, "go.work");
    if (source.excluded.includes(candidate))
      throw new Error("Go workspace must be an inventoried regular file");
    if (source.files.includes(candidate)) {
      file = candidate;
      break;
    }
    if (directory === ".") break;
    directory = path.posix.dirname(directory);
  }
  if (!file) return undefined;
  const text = await readProjectFile(source.root, file);
  const entries = directives(text);
  if (
    entries.some(
      ({ directive }) =>
        !["go", "toolchain", "godebug", "use", "replace"].includes(directive),
    )
  )
    throw new Error("Unsupported Go workspace directive");
  const versions = entries.filter(({ directive }) => directive === "go");
  if (
    versions.length !== 1 ||
    versions[0]!.values.length !== 1 ||
    !/^1\.\d+(?:\.\d+)?$/.test(versions[0]!.values[0]!)
  )
    throw new Error("Go workspace requires one exact Go version directive");
  for (const item of entries.filter(({ directive }) =>
    ["toolchain", "godebug"].includes(directive),
  ))
    if (item.values.length !== 1)
      throw new Error("Unsupported Go workspace setting");
  const uses = entries.filter(({ directive }) => directive === "use");
  if (
    !uses.length ||
    uses.length > 16 ||
    uses.some((item) => item.values.length !== 1)
  )
    throw new Error("Go workspace requires one to sixteen declared modules");
  const members = uses.map((item) =>
    localDirectory(directory, item.values[0]!),
  );
  if (new Set(members).size !== members.length)
    throw new Error("Duplicate Go workspace module");
  if (!members.includes(project.path))
    throw new Error("Go module is not a declared workspace member");
  const pending = [
    ...members,
    ...replacements(entries).map((target) => localDirectory(directory, target)),
  ];
  const modules: GoWorkspace["modules"] = [];
  const visited = new Set<string>();
  while (pending.length) {
    const next = pending.shift()!;
    if (visited.has(next)) continue;
    if (visited.size >= 16)
      throw new Error(
        "Go workspace local module closure exceeds sixteen modules",
      );
    visited.add(next);
    const manifest = path.posix.join(next, "go.mod");
    if (!source.files.includes(manifest))
      throw new Error("Go workspace module manifest is missing or excluded");
    const content = await readProjectFile(source.root, manifest);
    const moduleEntries = directives(content);
    const declared = moduleEntries.filter(
      ({ directive }) => directive === "module",
    );
    if (declared.length !== 1 || declared[0]!.values.length !== 1)
      throw new Error("Go workspace module identity is missing or ambiguous");
    modules.push({
      directory: next,
      module: declared[0]!.values[0]!,
      manifestDigest: sha256(content),
      role: members.includes(next) ? "member" : "replacement",
    });
    pending.push(
      ...replacements(moduleEntries).map((target) =>
        localDirectory(next, target),
      ),
    );
  }
  modules.sort((a, b) => a.directory.localeCompare(b.directory, "en"));
  return goWorkspaceSchema.parse({
    schemaVersion: 1,
    file,
    sha256: sha256(text),
    modules,
  });
}

/** Atomic binding of a captured workspace to every native command in a module. */
export async function applyGoWorkspace(
  source: Inventory,
  project: Project,
  checks: Check[],
): Promise<void> {
  const scoped = checks.filter((check) => check.id !== "go.format");
  try {
    const workspace = await select(source, project);
    if (!workspace) return;
    const file = path.resolve(source.root, workspace.file);
    for (const check of scoped) {
      check.goWorkspace = structuredClone(workspace);
      for (const command of check.commands)
        command.env = { ...command.env, GOWORK: file };
    }
  } catch (error) {
    for (const check of scoped)
      check.unavailableReason =
        error instanceof Error ? error.message : "Invalid Go workspace";
  }
}
