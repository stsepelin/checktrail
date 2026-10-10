import path from "node:path";
import { swiftRequire, swiftSame } from "./swift-native.js";
import type { SwiftAstMethod } from "./swift-ast.js";
import type { Finding } from "./types.js";
/** Bind native XCTest discovery, complete lifecycle, suite counters and physical diagnostics. */
export function swiftXCTestEvidence(
  project: string,
  workspace: string,
  sources: string[],
  methods: SwiftAstMethod[],
  listed: string[],
  row: { stdout: string; stderr: string; exitCode: number },
) {
  const findings: Finding[] = [];
  const relative = (absolute: string) => {
    const result = path.relative(workspace, absolute).split(path.sep).join("/");
    swiftRequire(
      path.isAbsolute(absolute) &&
        absolute === path.join(workspace, result) &&
        sources.includes(result),
      "Swift native address outside declared source",
    );
    return result;
  };
  const ids = methods.map((m) => m.className + "/" + m.methodName);
  swiftRequire(
    swiftSame(ids, listed),
    "Swift native discovery/compiler methods differ",
  );
  const started: string[] = [],
    ended: string[] = [],
    failed: string[] = [],
    skipped: string[] = [];
  const lookup = new Map(
    methods.map((m) => [
      m.className.slice(m.className.indexOf(".") + 1) + "." + m.methodName,
      m,
    ]),
  );
  swiftRequire(
    lookup.size === methods.length,
    "Swift native callback names are ambiguous",
  );
  type Suite = {
    name: string;
    total: number;
    skipped: number;
    failures: number;
  };
  const suites: Suite[] = [];
  let pending: Suite | undefined;
  let active = "",
    allEnded = false,
    assertionFailures = 0;
  for (const line of row.stdout.trimEnd().split("\n")) {
    const suiteStart = /^Test Suite '([^']+)' started at [0-9 .:-]+$/.exec(
        line,
      ),
      suiteEnd = /^Test Suite '([^']+)' (passed|failed) at [0-9 .:-]+$/.exec(
        line,
      ),
      callbackStart = /^Test Case '([^']+)' started at [0-9 .:-]+$/.exec(line),
      callbackEnd =
        /^Test Case '([^']+)' (passed|failed|skipped) \([0-9.]+ seconds\)$/.exec(
          line,
        ),
      summary =
        /^\t Executed ([0-9]+) tests?, with (?:([0-9]+) tests? skipped and )?([0-9]+) failures? \(([0-9]+) unexpected\) in [0-9.]+ \([0-9.]+\) seconds$/.exec(
          line,
        );
    if (summary) {
      swiftRequire(
        pending &&
          Number(summary[1]) === pending.total &&
          Number(summary[2] ?? 0) === pending.skipped &&
          Number(summary[3]) === pending.failures &&
          Number(summary[4]) === 0,
        "Swift nested suite counters differ",
      );
      if (pending!.name === "All tests") {
        swiftRequire(
          pending!.total === methods.length && !suites.length,
          "Swift root suite count differs",
        );
        allEnded = true;
      }
      pending = undefined;
      continue;
    }
    swiftRequire(!pending, "Swift native suite summary missing");
    if (suiteStart) {
      swiftRequire(
        !active &&
          !allEnded &&
          (suites.length > 0 || suiteStart[1] === "All tests"),
        "Swift suite start differs",
      );
      suites.push({
        name: suiteStart[1]!,
        total: 0,
        skipped: 0,
        failures: 0,
      });
      continue;
    }
    if (suiteEnd) {
      swiftRequire(
        !active && suites.at(-1)?.name === suiteEnd[1],
        "Swift suite terminal differs",
      );
      pending = suites.pop()!;
      swiftRequire(
        pending.failures > 0 === (suiteEnd[2] === "failed"),
        "Swift suite outcome differs",
      );
      continue;
    }
    if (callbackStart) {
      swiftRequire(
        !active && suites.length > 0 && lookup.has(callbackStart[1]!),
        "Swift callback start differs",
      );
      active = callbackStart[1]!;
      started.push(active);
      continue;
    }
    if (callbackEnd) {
      swiftRequire(
        active === callbackEnd[1],
        "Swift callback terminal differs",
      );
      ended.push(active);
      for (const suite of suites) {
        suite.total++;
        if (callbackEnd[2] === "skipped") suite.skipped++;
      }
      if (callbackEnd[2] === "failed") failed.push(active);
      if (callbackEnd[2] === "skipped") skipped.push(active);
      active = "";
      continue;
    }
    const diagnostic = /^(.*):([0-9]+): (?:error: )?([^ :]+) : (.+)$/.exec(
      line,
    );
    if (diagnostic) {
      swiftRequire(
        active === diagnostic[3] && Number(diagnostic[2]) > 0,
        "Swift failure outside callback",
      );
      if (
        /^Test skipped(?: - |: required (?:true value but got false|false value but got true) - )/.test(
          diagnostic[4]!,
        )
      ) {
        relative(diagnostic[1]!);
        continue;
      }
      assertionFailures++;
      for (const suite of suites) suite.failures++;
      findings.push({
        ruleId: "swift.test",
        level: "error",
        message: diagnostic[4]!,
        file: path.posix.join(project, relative(diagnostic[1]!)),
        line: Number(diagnostic[2]),
      });
      continue;
    }
    swiftRequire(
      !line.startsWith("Test Case ") &&
        !line.startsWith("Test Suite ") &&
        !line.includes("Executed ") &&
        !/\berror:/.test(line),
      "Swift unexpected native lifecycle/error",
    );
  }
  swiftRequire(
    !row.stderr.trim() &&
      !active &&
      !pending &&
      !suites.length &&
      allEnded &&
      swiftSame(started, [...lookup.keys()]) &&
      swiftSame(ended, [...lookup.keys()]) &&
      (failed.length === 0) === (assertionFailures === 0) &&
      row.exitCode === (failed.length ? 1 : 0),
    "Swift test lifecycle/summary differs",
  );
  const tests = {
    total: methods.length,
    passed: methods.length - failed.length - skipped.length,
    failed: failed.length,
    skipped: skipped.length,
  };
  return { tests, findings };
}
