import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { mavenHash } from "./maven.js";
import { swiftAstMethods, swiftAstTesting } from "./swift-ast.js";
import { swiftXCTestEvidence } from "./swift-xctest.js";
import { swiftTestingEvidence } from "./swift-testing.js";
import {
  swiftCommon,
  swiftAstArgs,
  swiftLintOptions,
  swiftRequire,
  swiftSame,
} from "./swift-native.js";
import {
  swiftExtensionsPacketSchema,
  swiftExtensionsUnavailableSchema,
  swiftExtensionsTargets,
  swiftExtensionsGenerated,
  swiftExtensionsCompiled,
  swiftExtensionsScanArgs,
} from "./swift-extensions-native.js";
import { swiftExtensionsNativeGraph } from "./swift-extensions-graph.js";
import { swiftExtensionsSdkReferences } from "./swift-extensions-sdk.js";
import { swiftExtensionsFreshness } from "./swift-extensions-freshness.js";
import type {
  Check,
  CheckResult,
  ProcessResult,
  Finding,
  TestEvidence,
} from "./types.js";
const lintSchema = z
  .array(
    z.strictObject({
      character: z.number().int().positive(),
      file: z.string().min(1).max(8192),
      line: z.number().int().positive(),
      reason: z.string().min(1).max(8192),
      rule_id: z.enum(["force_try", "force_unwrapping"]),
      severity: z.literal("Error"),
      type: z.string().min(1).max(8192),
    }),
  )
  .max(20000);
export function swiftExtensionsEvidence(
  check: Check,
  processes: ProcessResult[],
  root?: string,
): Pick<CheckResult, "status" | "reason" | "findings" | "tests"> {
  try {
    swiftRequire(
      check.commands.length === 1 && processes.length === 1,
      "Swift extension process accounting differs",
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
      "Swift extension native collection incomplete",
    );
    const { config, invocation } = swiftExtensionsFreshness(check, root),
      value: unknown = JSON.parse(process.stdout),
      unavailable = swiftExtensionsUnavailableSchema.safeParse(value);
    const inputSha256 = mavenHash(JSON.stringify(invocation.inputs));
    if (unavailable.success) {
      swiftRequire(
        check.id === `swift.${unavailable.data.mode}-extensions` &&
          check.commands[0]!.args[3] === unavailable.data.mode &&
          unavailable.data.inputSha256 === inputSha256,
        "Swift extension prerequisite identity differs",
      );
      return {
        status: "unavailable",
        reason:
          "Pinned native Swift extension prerequisites are unavailable before project evaluation.",
      };
    }
    const packet = swiftExtensionsPacketSchema.parse(value),
      findings: Finding[] = [];
    swiftRequire(
      check.id === `swift.${packet.mode}-extensions` &&
        check.commands[0]!.args[3] === packet.mode &&
        packet.inputSha256 === inputSha256 &&
        isDeepStrictEqual(packet.config, config),
      "Swift extension packet input identity differs",
    );
    swiftRequire(
      path.isAbsolute(packet.temporary) &&
        path.normalize(packet.temporary) === packet.temporary &&
        packet.workspace === path.join(packet.temporary, "project"),
      "Swift extension owned workspace differs",
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
        ) &&
        packet.sdkBeforeSha256 === mavenHash(JSON.stringify(config.sdk)) &&
        packet.sdkBeforeSha256 === packet.sdkAfterSha256,
      "Swift extension tool/SDK/settings identity differs",
    );
    for (const row of packet.receipts)
      swiftRequire(
        row.stdoutSha256 === mavenHash(row.stdout) &&
          row.stderrSha256 === mavenHash(row.stderr),
        "Swift extension output hash differs",
      );
    for (const row of packet.artifacts)
      swiftRequire(
        row.sha256 === mavenHash(row.text),
        "Swift extension artifact hash differs",
      );
    swiftRequire(
      new Set(packet.artifacts.map((a) => a.path)).size ===
        packet.artifacts.length,
      "Swift extension repeated artifact",
    );
    let position = 0;
    const usedArtifacts: string[] = [];
    const receipt = (phase: string, name: string, args: string[]) => {
      const row = packet.receipts[position++];
      swiftRequire(
        row &&
          row.phase === phase &&
          row.executable === packet.tools.find((t) => t.name === name)!.entry &&
          isDeepStrictEqual(row.args, args),
        "Swift extension invocation scope differs",
      );
      return row!;
    };
    const artifact = (file: string) => {
      const relative = path
        .relative(packet.temporary, file)
        .split(path.sep)
        .join("/");
      swiftRequire(
        file === path.join(packet.temporary, relative) &&
          !relative.startsWith("../"),
        "Swift extension artifact address differs",
      );
      const row = packet.artifacts.find((a) => a.path === relative);
      swiftRequire(
        row && !usedArtifacts.includes(relative),
        "Swift extension artifact missing/reused",
      );
      usedArtifacts.push(relative);
      return row!;
    };
    const targets = swiftExtensionsTargets(config),
      sources = targets.flatMap((t) => t.sources),
      generated = swiftExtensionsGenerated(config, packet.temporary),
      common = swiftCommon(packet.workspace, packet.temporary);
    const relative = (absolute: string) => {
      const result = path
        .relative(packet.workspace, absolute)
        .split(path.sep)
        .join("/");
      const owned =
        sources.includes(result) || generated.some((g) => g.path === absolute);
      swiftRequire(
        path.isAbsolute(absolute) &&
          path.normalize(absolute) === absolute &&
          owned,
        "Swift extension diagnostic escapes physical source",
      );
      return sources.includes(result) ? result : undefined;
    };
    const finish = (failed: boolean, tests?: TestEvidence) => {
      swiftRequire(
        position === packet.receipts.length &&
          swiftSame(
            usedArtifacts,
            packet.artifacts.map((a) => a.path),
          ),
        "Swift extension extra native invocation/artifact",
      );
      return {
        status: (tests?.skipped
          ? "inconclusive"
          : failed
            ? "failed"
            : "passed") as CheckResult["status"],
        reason: tests?.skipped
          ? "Native Swift extension tests contain skipped callbacks."
          : failed
            ? "Native Swift extension diagnostics or test failures were observed."
            : "Declared packages, physical generated sources, SDK bytes and native participation agree.",
        ...(tests ? { tests } : {}),
        ...(findings.length ? { findings } : {}),
      };
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
        row.exitCode === 0 && row.stdout === expected && !row.stderr,
        "Swift extension native version differs",
      );
    }
    const graph = [];
    for (const p of config.packages) {
      const options = swiftCommon(
          path.join(packet.workspace, p.path),
          packet.temporary,
        ),
        manifest = receipt("manifest:" + p.identity, "swift", [
          "package",
          ...options,
          "dump-package",
        ]),
        describe = receipt("describe:" + p.identity, "swift", [
          "package",
          ...options,
          "describe",
          "--type",
          "json",
        ]);
      swiftRequire(
        manifest.exitCode === 0 &&
          describe.exitCode === 0 &&
          !manifest.stderr.trim() &&
          !describe.stderr.trim(),
        "Swift extension native manifest collection incomplete",
      );
      graph.push({
        identity: p.identity,
        manifest: manifest.stdout,
        describe: describe.stdout,
      });
    }
    swiftExtensionsNativeGraph(config, packet.workspace, graph);
    const build = receipt("build", "swift", [
      "build",
      ...common,
      "--build-tests",
      "-j",
      "2",
      "--verbose",
    ]);
    for (const line of (build.stdout + "\n" + build.stderr).split("\n")) {
      const diagnostic = /^(.*):([0-9]+):([0-9]+): (error|warning): (.+)$/.exec(
        line,
      );
      if (diagnostic) {
        const file = relative(diagnostic[1]!);
        findings.push({
          ruleId: "swift.build-extensions",
          level: diagnostic[4] === "error" ? "error" : "warning",
          message: diagnostic[5]!,
          ...(file ? { file: path.posix.join(check.project, file) } : {}),
          line: Number(diagnostic[2]),
        });
      } else if (/\berror:/.test(line)) {
        const excerpt = /^\s*\|[ \t^~`-]+error: (.+)$/.exec(line);
        swiftRequire(
          line === "error: fatalError" ||
            (excerpt &&
              findings.some(
                (f) => f.level === "error" && f.message === excerpt[1],
              )),
          "Swift extension build infrastructure error",
        );
      }
    }
    const errors = findings.filter((f) => f.level === "error");
    swiftRequire(
      build.exitCode === (errors.length ? 1 : 0),
      "Swift extension build status differs",
    );
    if (build.exitCode) {
      swiftRequire(
        !packet.generatedBefore.length && !packet.generatedAfter.length,
        "Swift failed build generated tree differs",
      );
      return finish(true);
    }
    swiftRequire(
      swiftSame(
        packet.generatedBefore,
        generated.map((g) => g.path),
      ) && swiftSame(packet.generatedAfter, packet.generatedBefore),
      "Swift extension complete generated output tree differs",
    );
    swiftExtensionsCompiled(
      config,
      packet.workspace,
      packet.temporary,
      packet.tools.find((t) => t.name === "swift-frontend")!.entry,
      build.stdout + "\n" + build.stderr,
    );
    for (const g of generated) {
      const row = artifact(g.path);
      swiftRequire(
        row.text.trim().length > 0,
        "Swift extension generated source empty",
      );
    }
    for (const t of targets) {
      const row = receipt(
          "sdk:" + t.name,
          "swift-frontend",
          swiftExtensionsScanArgs(
            config,
            packet.workspace,
            packet.temporary,
            t,
          ),
        ),
        data = artifact(path.join(packet.temporary, "sdk", t.name + ".json"));
      swiftRequire(
        row.exitCode === 0 && !row.stdout.trim(),
        "Swift extension SDK scan incomplete",
      );
      const files = [
        ...t.sources,
        ...generated
          .filter((g) => g.package === t.package && g.target === t.name)
          .map((g) => path.relative(packet.workspace, g.path)),
      ];
      swiftExtensionsSdkReferences(
        config,
        t.name,
        packet.workspace,
        packet.temporary,
        files,
        data.text,
        row.stderr,
      );
    }
    if (packet.mode === "build") return finish(false);
    if (packet.mode === "swiftlint") {
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
        issues = lintSchema.parse(JSON.parse(row.stdout));
      const indices = new Set<number>(),
        inspected: string[] = [];
      let summaries = 0;
      for (const line of row.stderr.trimEnd().split("\n")) {
        if (
          line ===
          "Linting Swift files at paths " +
            sources.map((f) => path.join(packet.workspace, f)).join(", ")
        )
          continue;
        const progress = /^Linting '(.*)' \(([0-9]+)\/([0-9]+)\)$/.exec(line);
        if (progress) {
          const i = Number(progress[2]);
          swiftRequire(
            i >= 1 &&
              i <= sources.length &&
              !indices.has(i) &&
              Number(progress[3]) === sources.length,
            "Swift extension lint counters differ",
          );
          indices.add(i);
          inspected.push(progress[1]!);
          continue;
        }
        const end =
          /^Done linting! Found ([0-9]+) violations?, ([0-9]+) serious in ([0-9]+) files\.$/.exec(
            line,
          );
        swiftRequire(
          end &&
            ++summaries === 1 &&
            Number(end[1]) === issues.length &&
            Number(end[2]) === issues.length &&
            Number(end[3]) === sources.length,
          "Swift extension lint summary differs",
        );
      }
      swiftRequire(
        summaries === 1 &&
          isDeepStrictEqual(
            inspected.sort(),
            sources.map((f) => path.basename(f)).sort(),
          ) &&
          row.exitCode === (issues.length ? 2 : 0),
        "Swift extension lint participation differs",
      );
      for (const issue of issues) {
        const file = relative(issue.file);
        swiftRequire(
          file && config.rules.includes(issue.rule_id),
          "Swift extension lint rule/source differs",
        );
        findings.push({
          ruleId: "swift.swiftlint." + issue.rule_id,
          level: "error",
          message: issue.reason,
          file: path.posix.join(check.project, file!),
          line: issue.line,
        });
      }
      return finish(issues.length > 0);
    }
    const framework =
        packet.mode === "xctest"
          ? "--disable-swift-testing"
          : "--disable-xctest",
      list = receipt("list", "swift", [
        "test",
        ...common,
        "--skip-build",
        framework,
        "list",
      ]);
    swiftRequire(
      list.exitCode === 0 &&
        (!list.stderr.trim() ||
          /^\[[0-9]+\/[0-9]+\] Planning build$/.test(list.stderr.trim())),
      "Swift extension discovery incomplete",
    );
    const listed = list.stdout.trimEnd().split("\n");
    swiftRequire(
      listed.length > 0 &&
        listed.every(Boolean) &&
        new Set(listed).size === listed.length,
      "Swift extension discovery empty or repeated",
    );
    const methods = [],
      declarations = [];
    for (const t of targets.filter((t) => t.type === "test"))
      for (const file of t.sources) {
        const row = receipt(
          "ast:" + file,
          "swiftc",
          swiftAstArgs(
            {
              platform: config.platform,
              tests: { framework: "swift-testing" },
            },
            packet.workspace,
            packet.temporary,
            t,
            file,
            packet.tools.find((t) => t.name === "swift-frontend")!.entry,
          ),
        );
        swiftRequire(
          row.exitCode === 0 && !row.stderr.trim(),
          "Swift extension compiler declaration collection incomplete",
        );
        const xctest = swiftAstMethods(
            row.stdout,
            t.name,
            path.join(packet.workspace, file),
          ).filter((m) => m.methodName.startsWith("test")),
          testing = swiftAstTesting(
            row.stdout,
            t.name,
            path.join(packet.workspace, file),
          );
        swiftRequire(
          (config.tests.xctest.includes(file)
            ? xctest.length > 0
            : xctest.length === 0) &&
            (config.tests.testing.includes(file)
              ? testing.length > 0
              : testing.length === 0),
          "Swift extension complete test/support compiler cohort differs",
        );
        methods.push(...xctest);
        declarations.push(...testing);
      }
    const row = receipt("test", "swift", [
      "test",
      ...common,
      "--skip-build",
      framework,
      ...(packet.mode === "xctest"
        ? ["--no-parallel"]
        : [
            "--xunit-output",
            path.join(packet.temporary, "results.xml"),
            "--event-stream-version",
            "0",
            "--event-stream-output-path",
            path.join(packet.temporary, "events.jsonl"),
          ]),
    ]);
    const result =
      packet.mode === "xctest"
        ? swiftXCTestEvidence(
            check.project,
            packet.workspace,
            sources,
            methods,
            listed,
            row,
          )
        : swiftTestingEvidence(
            check.project,
            packet.workspace,
            declarations,
            listed,
            artifact(path.join(packet.temporary, "events.jsonl")).text,
            artifact(path.join(packet.temporary, "results.xml")).text,
            row.exitCode,
          );
    swiftRequire(!row.stderr.trim(), "Swift extension unexpected test stderr");
    findings.push(...result.findings);
    return finish(result.tests.failed > 0, result.tests);
  } catch {
    return {
      status: "inconclusive",
      reason:
        "Swift extension evidence is missing, unsupported, stale or inconsistent.",
    };
  }
}
