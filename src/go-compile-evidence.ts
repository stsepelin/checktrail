import path from "node:path";
import type { Check, Finding } from "./types.js";

// The supported native Go compiler profile can wrap positioned diagnostics in
// an unlocated package error. Accept only a complete compiler block, never a
// substring that merely mentions a filename inside a loading/cache error.
export function goCompileFindings(
  check: Check,
  root: string,
  text: string,
  ruleId: string,
): Finding[] | undefined {
  const lines = text
    .replace(/^(?:-?: )(?=# )/, "")
    .trimEnd()
    .split(/\r?\n/);
  if (lines.length < 2 || !/^# [^\r\n]+$/.test(lines[0]!)) return undefined;
  const expected = new Set(
    check.scope.map((file) => path.resolve(root, check.project, file)),
  );
  const findings: Finding[] = [];
  for (const line of lines.slice(1)) {
    const match = /^(.+\.go):([1-9]\d*):([1-9]\d*): (.+)$/.exec(line);
    if (!match) return undefined;
    const file = path.resolve(root, check.project, match[1]!);
    const lineNumber = Number(match[2]);
    const column = Number(match[3]);
    if (
      !expected.has(file) ||
      !Number.isSafeInteger(lineNumber) ||
      !Number.isSafeInteger(column)
    )
      return undefined;
    findings.push({
      ruleId,
      level: "error",
      message: match[4]!,
      file: path.relative(root, file).split(path.sep).join("/"),
      line: lineNumber,
    });
  }
  return findings;
}
