import path from "node:path";
import { z } from "zod";
import type { Check, Command, ProcessResult } from "./types.js";

export const goEnvironment = {
  GOPROXY: "off",
  GOTOOLCHAIN: "local",
  GOFLAGS: "-mod=readonly",
  GOWORK: "off",
  GOENV: "off",
  GOCACHEPROG: "",
};

export function goScopeCommand(
  project: string,
  env: Record<string, string> = goEnvironment,
): Command {
  return {
    executable: "go",
    args: ["list", "-json", "./..."],
    cwd: project,
    env,
  };
}

function objects(text: string): unknown[] {
  const result: unknown[] = [];
  let depth = 0,
    start = 0,
    quoted = false,
    escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (!depth && char?.trim() && char !== "{")
      throw new Error("Unexpected package output");
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") {
      if (!depth) start = i;
      depth++;
    } else if (char === "}") {
      depth--;
      if (!depth) result.push(JSON.parse(text.slice(start, i + 1)));
      if (depth < 0) throw new Error("Invalid package JSON");
    } else if (!depth && char?.trim())
      throw new Error("Unexpected package output");
  }
  if (depth || quoted) throw new Error("Partial package output");
  return result;
}
const names = z.array(z.string()).default([]);
const packageSchema = z.object({
  Dir: z.string(),
  ImportPath: z.string().min(1),
  GoFiles: names,
  CgoFiles: names,
  TestGoFiles: names,
  XTestGoFiles: names,
  Error: z.unknown().optional(),
  DepsErrors: z.array(z.unknown()).optional(),
});

export function goScopeComplete(
  check: Check,
  process: ProcessResult | undefined,
  root: string | undefined,
  testOutput?: string,
): boolean {
  if (
    !root ||
    !process ||
    process.exitCode !== 0 ||
    process.stderr.trim() ||
    !check.scope.length
  )
    return false;
  try {
    const packages = objects(process.stdout).map((value) =>
      packageSchema.parse(value),
    );
    const expected = new Set(
      check.scope.map((file) => path.resolve(root, check.project, file)),
    );
    const seen = new Set<string>();
    const ids = new Set<string>();
    for (const item of packages) {
      if (
        !path.isAbsolute(item.Dir) ||
        ids.has(item.ImportPath) ||
        item.Error ||
        item.DepsErrors?.length
      )
        return false;
      ids.add(item.ImportPath);
      for (const file of [
        ...item.GoFiles,
        ...item.CgoFiles,
        ...item.TestGoFiles,
        ...item.XTestGoFiles,
      ]) {
        if (path.basename(file) !== file || !file.endsWith(".go")) return false;
        const resolved = path.resolve(item.Dir, file);
        if (!expected.has(resolved) || seen.has(resolved)) return false;
        seen.add(resolved);
      }
    }
    if (testOutput !== undefined) {
      const tested = new Set<string>();
      for (const line of testOutput.split("\n").filter(Boolean)) {
        const event = z
          .object({
            Action: z.string(),
            Package: z.string(),
            Test: z.string().optional(),
          })
          .parse(JSON.parse(line));
        if (!ids.has(event.Package)) return false;
        if (event.Action === "pass" && event.Test) tested.add(event.Package);
      }
      if (tested.size !== ids.size) return false;
    }
    return ids.size > 0 && seen.size === expected.size;
  } catch {
    return false;
  }
}
