import path from "node:path";
import { z } from "zod";
import { swiftToolsInvocationSchema, swiftToolsScope } from "./swift-tools.js";
import { swiftAstMethods, swiftAstTesting } from "./swift-ast.js";
import { swiftTestingEvidence } from "./swift-testing.js";
import {
  swiftSame,
  swiftRequire,
  swiftCommon,
  swiftAstArgs,
  swiftCompiled,
  swiftLintOptions,
  swiftNativeScope,
} from "./swift-native.js";
import { mavenHash } from "./maven.js";
import type {
  Check,
  CheckResult,
  Finding,
  ProcessResult,
  TestEvidence,
} from "./types.js";
const text = z.string().max(4 * 1024 * 1024),
  file = z.string().min(1).max(8192),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
export const swiftToolsPacketSchema = z.strictObject({
  version: z.literal(1),
  mode: z.enum(["build", "test", "swiftlint"]),
  temporary: file,
  workspace: file,
  inputSha256: digest,
  optionsSha256: digest,
  tools: z
    .array(
      z.strictObject({
        name: z.enum(["swift", "swiftc", "swift-frontend", "swiftlint"]),
        entry: file,
        resolved: file,
        sha256: digest,
        afterSha256: digest,
      }),
    )
    .length(4),
  receipts: z
    .array(
      z.strictObject({
        phase: file,
        executable: file,
        args: z.array(file).max(4096),
        exitCode: z.number().int().min(0).max(255),
        stdout: text,
        stderr: text,
        stdoutSha256: digest,
        stderrSha256: digest,
        durationMs: z.number().int().nonnegative(),
      }),
    )
    .min(6)
    .max(260),
  artifacts: z
    .array(z.strictObject({ path: file, text, sha256: digest }))
    .max(2),
});
const lintSchema = z
  .array(
    z.strictObject({
      character: z.number().int().positive(),
      file,
      line: z.number().int().positive(),
      reason: file,
      rule_id: file,
      severity: z.enum(["Warning", "Error"]),
      type: file,
    }),
  )
  .max(20000);
export function swiftToolsEvidence(
  check: Check,
  processes: ProcessResult[],
): Pick<CheckResult, "status" | "reason" | "findings" | "tests"> {
  try {
    swiftRequire(
      check.commands.length === 1 && processes.length === 1,
      "Swift process accounting differs",
    );
    const process = processes[0]!;
    swiftRequire(
      process.exitCode === 0 &&
        !process.stderr.trim() &&
        !process.cancelled &&
        !process.timedOut &&
        !process.truncated &&
        !process.errorCode &&
        !process.signal,
      "Swift native collection incomplete",
    );
    const invocation = swiftToolsInvocationSchema.parse(
        JSON.parse(check.commands[0]!.args[2]!),
      ),
      config = invocation.config,
      packet = swiftToolsPacketSchema.parse(JSON.parse(process.stdout));
    swiftToolsScope(
      config,
      invocation.inputs.map((p) => p.path),
    );
    swiftRequire(
      check.id === `swift.${packet.mode}` &&
        check.commands[0]!.args[3] === packet.mode &&
        packet.inputSha256 === mavenHash(JSON.stringify(invocation.inputs)) &&
        new Set(invocation.inputs.map((p) => p.path)).size ===
          invocation.inputs.length,
      "Swift input/check identity differs",
    );
    swiftRequire(
      path.isAbsolute(packet.temporary) &&
        path.normalize(packet.temporary) === packet.temporary &&
        packet.workspace === path.join(packet.temporary, "project"),
      "Swift owned workspace differs",
    );
    swiftRequire(
      packet.optionsSha256 === mavenHash(swiftLintOptions(config)) &&
        swiftSame(
          packet.tools.map((t) => t.name),
          ["swift", "swiftc", "swift-frontend", "swiftlint"],
        ) &&
        packet.tools.every(
          (t) =>
            path.isAbsolute(t.entry) &&
            path.isAbsolute(t.resolved) &&
            t.sha256 === t.afterSha256,
        ),
      "Swift tool/settings identity differs",
    );
    for (const row of packet.receipts)
      swiftRequire(
        row.stdoutSha256 === mavenHash(row.stdout) &&
          row.stderrSha256 === mavenHash(row.stderr),
        "Swift native output identity differs",
      );
    for (const row of packet.artifacts)
      swiftRequire(
        row.sha256 === mavenHash(row.text),
        "Swift artifact identity differs",
      );
    let position = 0;
    const receipt = (phase: string, name: string, args: string[]) => {
      const row = packet.receipts[position++];
      swiftRequire(
        row &&
          row.phase === phase &&
          row.executable === packet.tools.find((t) => t.name === name)!.entry &&
          JSON.stringify(row.args) === JSON.stringify(args),
        "Swift invocation scope differs",
      );
      return row!;
    };
    for (const [phase, name, args, expected] of [
      [
        "swift-version",
        "swiftc",
        ["--version"],
        "Swift version 6.2.3 (swift-6.2.3-RELEASE)\nTarget: aarch64-unknown-linux-gnu\n",
      ],
      [
        "swiftpm-version",
        "swift",
        ["package", "--version"],
        "Swift Package Manager - Swift 6.2.3\n",
      ],
      ["swiftlint-version", "swiftlint", ["version"], "0.65.1\n"],
    ] as const) {
      const row = receipt(phase, name, [...args]);
      swiftRequire(
        row.exitCode === 0 && row.stdout === expected && !row.stderr.trim(),
        "Swift native version differs",
      );
    }
    const common = swiftCommon(packet.workspace, packet.temporary),
      manifest = receipt("manifest", "swift", [
        "package",
        ...common,
        "dump-package",
      ]),
      describe = receipt("describe", "swift", [
        "package",
        ...common,
        "describe",
        "--type",
        "json",
      ]);
    swiftRequire(
      manifest.exitCode === 0 &&
        describe.exitCode === 0 &&
        !manifest.stderr.trim() &&
        !describe.stderr.trim(),
      "Swift manifest collection incomplete",
    );
    swiftNativeScope(
      config,
      packet.workspace,
      manifest.stdout,
      describe.stdout,
    );
    const sources = config.targets.flatMap((t) => t.sources),
      findings: Finding[] = [];
    const relative = (absolute: string) => {
      const result = path
        .relative(packet.workspace, absolute)
        .split(path.sep)
        .join("/");
      swiftRequire(
        path.isAbsolute(absolute) &&
          absolute === path.join(packet.workspace, result) &&
          sources.includes(result),
        "Swift native address outside declared source",
      );
      return result;
    };
    const finish = (
      failed: boolean,
      tests?: TestEvidence,
    ): Pick<CheckResult, "status" | "reason" | "findings" | "tests"> => {
      swiftRequire(
        position === packet.receipts.length,
        "Swift extra native invocation",
      );
      return {
        status: failed ? "failed" : "passed",
        reason: failed
          ? "Native Swift source diagnostics or test failures were observed."
          : "Pinned native Swift scope and execution evidence agree.",
        ...(findings.length ? { findings } : {}),
        ...(tests ? { tests } : {}),
      };
    };
    if (packet.mode === "swiftlint") {
      swiftRequire(
        swiftSame(check.scope, sources) && !packet.artifacts.length,
        "Swift lint scope differs",
      );
      const row = receipt("swiftlint", "swiftlint", [
          "lint",
          "--config",
          path.join(packet.temporary, "swiftlint.yml"),
          "--no-cache",
          "--strict",
          "--reporter",
          "json",
          ...sources.map((f) => path.join(packet.workspace, f)),
        ]),
        data = lintSchema.parse(JSON.parse(row.stdout)),
        progress: string[] = [],
        indices = new Set<number>();
      let summary = 0;
      for (const line of row.stderr.trimEnd().split("\n")) {
        if (
          line ===
          "Linting Swift files at paths " +
            sources.map((f) => path.join(packet.workspace, f)).join(", ")
        )
          continue;
        const inspected = /^Linting '(.*)' \(([0-9]+)\/([0-9]+)\)$/.exec(line);
        if (inspected) {
          const index = Number(inspected[2]);
          swiftRequire(
            index >= 1 &&
              index <= sources.length &&
              !indices.has(index) &&
              Number(inspected[3]) === sources.length,
            "Swift lint inspection counts differ",
          );
          indices.add(index);
          progress.push(inspected[1]!);
          continue;
        }
        const end =
          /^Done linting! Found ([0-9]+) violations?, ([0-9]+) serious in ([0-9]+) files\.$/.exec(
            line,
          );
        swiftRequire(
          end &&
            ++summary === 1 &&
            Number(end[1]) === data.length &&
            Number(end[2]) === data.length &&
            Number(end[3]) === sources.length,
          "Swift lint native summary differs",
        );
      }
      swiftRequire(
        summary === 1 &&
          swiftSame(
            progress,
            sources.map((f) => path.basename(f)),
          ) &&
          row.exitCode === (data.length ? 2 : 0),
        "Swift lint participation/status differs",
      );
      for (const issue of data) {
        swiftRequire(
          config.rules.includes(
            issue.rule_id as (typeof config.rules)[number],
          ) && issue.severity === "Error",
          "Swift lint rule/severity differs",
        );
        findings.push({
          ruleId: "swift.swiftlint." + issue.rule_id,
          level: "error",
          message: issue.reason,
          file: path.posix.join(check.project, relative(issue.file)),
          line: issue.line,
        });
      }
      return finish(data.length > 0);
    }
    swiftRequire(
      swiftSame(
        check.scope,
        packet.mode === "test"
          ? [...config.tests.files, ...config.tests.support]
          : sources,
      ),
      "Swift check scope differs",
    );
    const frameworkFlag =
        config.tests.framework === "xctest"
          ? "--disable-swift-testing"
          : "--disable-xctest",
      build = receipt("build", "swift", [
        "build",
        ...common,
        "--build-tests",
        frameworkFlag,
        "-j",
        "2",
        "--verbose",
      ]);
    for (const line of (build.stdout + "\n" + build.stderr).split("\n")) {
      const diagnostic = /^(.*):([0-9]+):([0-9]+): (error|warning): (.+)$/.exec(
        line,
      );
      if (diagnostic)
        findings.push({
          ruleId: "swift.build",
          level: diagnostic[4] === "error" ? "error" : "warning",
          message: diagnostic[5]!,
          file: path.posix.join(check.project, relative(diagnostic[1]!)),
          line: Number(diagnostic[2]),
        });
      else if (/\berror:/.test(line)) {
        const excerpt = /^\s*\|[ \t^~`-]+error: (.+)$/.exec(line);
        swiftRequire(
          line === "error: fatalError" ||
            (excerpt &&
              findings.some(
                (f) => f.level === "error" && f.message === excerpt[1],
              )),
          "Swift build infrastructure error",
        );
      }
    }
    const buildErrors = findings.filter((f) => f.level === "error");
    swiftRequire(
      build.exitCode === (buildErrors.length ? 1 : 0),
      "Swift build status/diagnostics differ",
    );
    if (build.exitCode !== 0) {
      swiftRequire(
        !packet.artifacts.length,
        "Swift failed build artifacts differ",
      );
      return finish(true);
    }
    swiftCompiled(
      config,
      packet.workspace,
      packet.tools.find((t) => t.name === "swift-frontend")!.entry,
      build.stdout,
    );
    if (packet.mode === "build") {
      swiftRequire(!packet.artifacts.length, "Swift build artifacts differ");
      return finish(false);
    }
    const list = receipt("list", "swift", [
      "test",
      ...common,
      "--skip-build",
      frameworkFlag,
      "list",
    ]);
    swiftRequire(
      list.exitCode === 0 &&
        (!list.stderr.trim() ||
          /^\[[0-9]+\/[0-9]+\] Planning build$/.test(list.stderr.trim())),
      "Swift discovery incomplete",
    );
    const listed = list.stdout.trimEnd().split("\n");
    swiftRequire(
      listed.length > 0 &&
        listed.every(Boolean) &&
        new Set(listed).size === listed.length,
      "Swift discovery empty or ambiguous",
    );
    const methods = [],
      testingDeclarations = [];
    for (const target of config.targets.filter((t) => t.type === "test"))
      for (const file of target.sources) {
        const row = receipt(
          "ast:" + file,
          "swiftc",
          swiftAstArgs(
            config,
            packet.workspace,
            packet.temporary,
            target,
            file,
            packet.tools.find((t) => t.name === "swift-frontend")!.entry,
          ),
        );
        swiftRequire(
          row.exitCode === 0 && !row.stderr.trim(),
          "Swift compiler method collection incomplete",
        );
        const bound =
          config.tests.framework === "xctest"
            ? swiftAstMethods(
                row.stdout,
                target.name,
                path.join(packet.workspace, file),
              ).filter((m) => m.methodName.startsWith("test"))
            : swiftAstTesting(
                row.stdout,
                target.name,
                path.join(packet.workspace, file),
              );
        swiftRequire(
          config.tests.files.includes(file)
            ? bound.length > 0
            : bound.length === 0,
          "Swift test/support compiler scope differs",
        );
        if (config.tests.framework === "xctest")
          methods.push(
            ...swiftAstMethods(
              row.stdout,
              target.name,
              path.join(packet.workspace, file),
            ).filter((m) => m.methodName.startsWith("test")),
          );
        else
          testingDeclarations.push(
            ...swiftAstTesting(
              row.stdout,
              target.name,
              path.join(packet.workspace, file),
            ),
          );
      }
    if (config.tests.framework === "swift-testing") {
      const row = receipt("test", "swift", [
        "test",
        ...common,
        "--skip-build",
        frameworkFlag,
        "--xunit-output",
        path.join(packet.temporary, "results.xml"),
        "--event-stream-version",
        "0",
        "--event-stream-output-path",
        path.join(packet.temporary, "events.jsonl"),
      ]);
      swiftRequire(
        !row.stderr.trim() &&
          position === packet.receipts.length &&
          swiftSame(
            packet.artifacts.map((a) => a.path),
            ["results.xml", "events.jsonl"],
          ),
        "Swift Testing native collection differs",
      );
      const result = swiftTestingEvidence(
        check.project,
        packet.workspace,
        testingDeclarations,
        listed,
        packet.artifacts.find((a) => a.path === "events.jsonl")!.text,
        packet.artifacts.find((a) => a.path === "results.xml")!.text,
        row.exitCode,
      );
      findings.push(...result.findings);
      if (result.tests.skipped)
        return {
          status: "inconclusive",
          reason: "Native Swift tests contain skipped callbacks.",
          tests: result.tests,
        };
      return finish(result.tests.failed > 0, result.tests);
    }
    swiftRequire(
      !packet.artifacts.length,
      "Swift XCTest artifact scope differs",
    );
    const ids = methods.map((m) => m.className + "/" + m.methodName);
    swiftRequire(
      swiftSame(ids, listed),
      "Swift native discovery/compiler methods differ",
    );
    const row = receipt("test", "swift", [
        "test",
        ...common,
        "--skip-build",
        frameworkFlag,
        "--no-parallel",
      ]),
      started: string[] = [],
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
        callbackStart = /^Test Case '([^']+)' started at [0-9 .:-]+$/.exec(
          line,
        ),
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
          file: path.posix.join(check.project, relative(diagnostic[1]!)),
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
    if (skipped.length)
      return {
        status: "inconclusive",
        reason: "Native Swift tests contain skipped callbacks.",
        tests,
      };
    return finish(failed.length > 0, tests);
  } catch {
    return {
      status: "inconclusive",
      reason:
        "Swift native evidence is missing, unsupported, stale or inconsistent.",
    };
  }
}
