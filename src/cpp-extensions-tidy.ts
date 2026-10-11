import path from "node:path";
import { z } from "zod";
import { parse as yaml } from "yaml";
import { cppRequire } from "./cpp-tools.js";
import { cppTidyEnabled } from "./cpp-native.js";
import type { CppExtensionsConfig } from "./cpp-extensions-contract.js";
const text = z
  .string()
  .min(1)
  .refine((v) => !/[\r\n]/.test(v));
const range = z.strictObject({
  FilePath: text,
  FileOffset: z.number().int().nonnegative(),
  Length: z.number().int().nonnegative(),
});
const message = z.strictObject({
  Message: text,
  FilePath: text,
  FileOffset: z.number().int().nonnegative(),
  Replacements: z.array(z.unknown()).length(0),
  Ranges: z.array(range).max(1024).optional(),
});
export function cppExtensionsTidyDiagnostics(
  c: CppExtensionsConfig,
  workspace: string,
  buildDirectory: string,
  mainSource: string,
  output: string,
  stdout: string,
  stderr: string,
  source: (file: string) => Buffer,
) {
  const data = z
    .strictObject({
      MainSourceFile: z.literal(path.join(workspace, mainSource)),
      Diagnostics: z
        .array(
          z.strictObject({
            DiagnosticName: text,
            DiagnosticMessage: message,
            Notes: z.array(message).max(128).optional(),
            Level: z.literal("Error"),
            BuildDirectory: z.literal(buildDirectory),
          }),
        )
        .min(1)
        .max(256),
    })
    .parse(yaml(output));
  const expected: string[] = [];
  const location = (file: string, offset: number, allowEnd = false) => {
    const relative = path.relative(workspace, file).split(path.sep).join("/");
    cppRequire(
      relative !== "" &&
        !relative.startsWith("../") &&
        !path.isAbsolute(relative),
      "Analyzer address outside owned source",
    );
    const bytes = source(relative);
    cppRequire(
      offset < bytes.length || (allowEnd && offset === bytes.length),
      "Analyzer address outside physical source",
    );
    const prefix = bytes.subarray(0, offset);
    new TextDecoder("utf-8", { fatal: true }).decode(prefix);
    return {
      file: relative,
      line: prefix.toString("utf8").split("\n").length,
      column: offset - prefix.lastIndexOf(10),
      offset,
    };
  };
  const inspect = (m: z.infer<typeof message>, kind: string, suffix = "") => {
    const at = location(m.FilePath, m.FileOffset);
    for (const r of m.Ranges ?? []) {
      location(r.FilePath, r.FileOffset);
      location(r.FilePath, r.FileOffset + r.Length, true);
    }
    expected.push(
      `${m.FilePath}:${at.line}:${at.column}: ${kind}: ${m.Message}${suffix}`,
    );
    return { ...at, message: m.Message };
  };
  const findings = data.Diagnostics.map((d) => {
    cppRequire(
      cppTidyEnabled(c).includes(d.DiagnosticName),
      "Analyzer rule outside selected cohort",
    );
    const at = inspect(
      d.DiagnosticMessage,
      "error",
      ` [${d.DiagnosticName},-warnings-as-errors]`,
    );
    for (const note of d.Notes ?? []) inspect(note, "note");
    return { ...at, rule: d.DiagnosticName };
  });
  const observed = stdout
    .split("\n")
    .filter((l) => /^.+:\d+:\d+: (?:error|warning|note): /.test(l));
  const count = data.Diagnostics.length,
    noun = count === 1 ? "warning" : "warnings";
  cppRequire(
    JSON.stringify(observed) === JSON.stringify(expected),
    "Complete analyzer console/YAML diagnostic cohort differs",
  );
  cppRequire(
    stderr ===
      `${count} ${noun} generated.\n${count} ${noun} treated as error${count === 1 ? "" : "s"}\n`,
    "Native analyzer diagnostic counters differ",
  );
  return findings;
}
