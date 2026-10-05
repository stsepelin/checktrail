import { z } from "zod";
import type { TestEvidence } from "./types.js";

export const rustTestProcessSchema = z.strictObject({
  exitCode: z.number().int(),
  stdout: z.string().max(1024 * 1024),
  stderr: z.string().max(1024 * 1024),
});
export type RustTestProcess = z.infer<typeof rustTestProcessSchema>;
export interface RustTestCase {
  name: string;
  status: "passed" | "failed" | "skipped";
  mode: "runtime" | "compile" | "compile-fail" | "should-panic";
}
const trailer =
  /^all doctests ran in \d+(?:\.\d+)?s; merged doctests compilation took \d+(?:\.\d+)?s$/;
export function rustTestList(
  process: RustTestProcess,
  doctest: boolean,
): string[] {
  if (process.exitCode !== 0) throw new Error("Native test listing failed");
  const names: string[] = [];
  for (const line of process.stdout.split(/\r?\n/)) {
    if (!line || (doctest && trailer.test(line))) continue;
    const match = /^(.*): test$/.exec(line);
    if (
      !match ||
      !match[1] ||
      match[1].length > 2048 ||
      Array.from(match[1]).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new Error("Unsupported native test listing");
    names.push(match[1]);
  }
  if (names.length > 1000 || new Set(names).size !== names.length)
    throw new Error("Native test listing is duplicate or oversized");
  return names;
}
export function rustTestRun(
  process: RustTestProcess,
  names: string[],
  ignored: string[],
  doctest: boolean,
): { tests: TestEvidence; cases: RustTestCase[] } {
  const expected = new Set(names);
  const skipped = new Set(ignored);
  if (
    expected.size !== names.length ||
    skipped.size !== ignored.length ||
    ignored.some((name) => !expected.has(name))
  )
    throw new Error("Test inventory does not reconcile");
  const cases: RustTestCase[] = [];
  let suite:
    { expected: number; cases: RustTestCase[]; details: boolean } | undefined;
  let summaries = 0;
  let trailing = false;
  for (const line of process.stdout.split(/\r?\n/)) {
    if (!line) continue;
    if (doctest && trailer.test(line) && !suite) {
      if (trailing) throw new Error("Duplicate native trailer");
      trailing = true;
      continue;
    }
    if (trailing) throw new Error("Unexpected native output after trailer");
    const start = /^running (\d+) tests?$/.exec(line);
    if (start) {
      if (suite) throw new Error("Interrupted native suite");
      const count = Number(start[1]);
      if (count > 1000) throw new Error("Native test count bound");
      suite = { expected: count, cases: [], details: false };
      continue;
    }
    if (!suite) throw new Error("Unstructured native test output");
    const finish =
      /^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out; finished in \d+(?:\.\d+)?s$/.exec(
        line,
      );
    if (finish) {
      const [passed, failed, ignoredCount, measured, filtered] = finish
        .slice(2)
        .map(Number);
      if (
        measured !== 0 ||
        filtered !== 0 ||
        passed! + failed! + ignoredCount! !== suite.expected ||
        suite.cases.length !== suite.expected ||
        suite.cases.filter((c) => c.status === "passed").length !== passed ||
        suite.cases.filter((c) => c.status === "failed").length !== failed ||
        suite.cases.filter((c) => c.status === "skipped").length !==
          ignoredCount ||
        (finish[1] === "ok") !== (failed === 0)
      ) {
        if (suite.details) continue;
        throw new Error("Native test counters do not reconcile");
      }
      cases.push(...suite.cases);
      suite = undefined;
      summaries++;
      continue;
    }
    if (suite.details) continue;
    if (
      line === "failures:" &&
      suite.cases.length === suite.expected &&
      suite.cases.some((c) => c.status === "failed")
    ) {
      suite.details = true;
      continue;
    }
    const result = /^test (.+) \.\.\. (ok|FAILED|ignored(?:, .+)?)$/.exec(line);
    if (!result) throw new Error("Unsupported native test event");
    let name = result[1]!;
    let mode: RustTestCase["mode"] = "runtime";
    if (!expected.has(name)) {
      for (const [suffix, kind] of [
        [" - compile fail", "compile-fail"],
        [" - should panic", "should-panic"],
        [" - compile", "compile"],
      ] as const)
        if (
          (doctest || kind === "should-panic") &&
          name.endsWith(suffix) &&
          expected.has(name.slice(0, -suffix.length))
        ) {
          name = name.slice(0, -suffix.length);
          mode = kind;
          break;
        }
    }
    if (
      !expected.has(name) ||
      cases.some((c) => c.name === name) ||
      suite.cases.some((c) => c.name === name)
    )
      throw new Error("Missing or repeated native test identity");
    const status =
      result[2] === "ok"
        ? "passed"
        : result[2] === "FAILED"
          ? "failed"
          : "skipped";
    if ((status === "skipped") !== skipped.has(name))
      throw new Error("Native ignored inventory does not reconcile");
    suite.cases.push({ name, status, mode });
  }
  if (
    suite ||
    !summaries ||
    (!doctest && summaries !== 1) ||
    cases.length !== names.length
  )
    throw new Error("Native suites are incomplete");
  const tests = {
    total: cases.length,
    passed: cases.filter((c) => c.status === "passed").length,
    failed: cases.filter((c) => c.status === "failed").length,
    skipped: cases.filter((c) => c.status === "skipped").length,
  };
  if ((process.exitCode === 0) !== (tests.failed === 0))
    throw new Error("Native exit and tests disagree");
  return { tests, cases };
}
