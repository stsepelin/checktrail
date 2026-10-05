import path from "node:path";
import { z } from "zod";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import {
  dotnetBuildEvidence,
  dotnetBuildPacketSchema,
} from "./dotnet-build-evidence.js";
import { dotnetBuildInvocationSchema } from "./dotnet-build.js";
import { dotnetTestNativeSource } from "./dotnet-test-native.js";
import { mavenHash } from "./maven.js";
import type {
  Finding,
  Check,
  CheckResult,
  ProcessResult,
  TestEvidence,
} from "./types.js";
const file = z.string().min(1).max(8192),
  text = z.string().max(65536),
  digest = z.string().regex(/^[a-f0-9]{64}$/),
  guid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const testCase = z.strictObject({
  id: guid,
  name: text.min(1),
  displayName: text,
  executor: z.literal("executor://nunit3testexecutor/"),
  source: file,
  codeFile: text,
  line: z.number().int().nonnegative(),
});
const event = z
  .object({
    type: z.enum([
      "init",
      "discoveryStarted",
      "discovered",
      "discoveryFinished",
      "runStarted",
      "result",
      "runFinished",
      "close",
      "message",
    ]),
  })
  .catchall(z.unknown());
export const dotnetTestPacketSchema = z.strictObject({
  version: z.literal(1),
  build: dotnetBuildPacketSchema,
  testObserverSha256: digest,
  testObserverSourceSha256: digest,
  runs: z
    .array(
      z.strictObject({
        file,
        assembly: file,
        artifacts: z
          .array(
            z.strictObject({
              file,
              bytes: z
                .number()
                .int()
                .nonnegative()
                .max(64 * 1024 * 1024),
              sha256: digest,
            }),
          )
          .length(4),
        discoveryExitCode: z.number().int().min(0).max(255),
        executionExitCode: z.number().int().min(0).max(255),
        discoveryLauncherPid: z.number().int().positive(),
        executionLauncherPid: z.number().int().positive(),
        discoveryEvents: z.array(event).min(1).max(20000),
        executionEvents: z.array(event).min(1).max(20000),
        trx: z.string().max(1024 * 1024),
      }),
    )
    .max(64),
  nativeReceipts: dotnetBuildPacketSchema.shape.nativeReceipts,
});
function requireEvidence(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
const same = (a: string[], b: string[]) =>
  new Set(a).size === a.length &&
  new Set(b).size === b.length &&
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const array = (value: unknown): Record<string, unknown>[] =>
  value === undefined
    ? []
    : (Array.isArray(value) ? value : [value]).map((value) =>
        z.record(z.string(), z.unknown()).parse(value),
      );
const instant = (value: unknown) =>
  z.iso
    .datetime({ offset: true })
    .parse(value)
    .replace(
      /(:\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:\d{2})$/,
      (_, seconds, fraction: string | undefined, zone) =>
        seconds + "." + (fraction ?? "").padEnd(7, "0") + zone,
    );
const integer = (value: unknown) =>
  z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(0).max(20000))
    .parse(value);
export function dotnetTestEvidence(
  check: Check,
  processes: ProcessResult[],
): Pick<
  CheckResult,
  "status" | "reason" | "tests" | "findings" | "findingsComplete"
> {
  const incomplete = {
    status: "inconclusive" as const,
    findingsComplete: false,
    reason:
      ".NET tests do not reconcile fresh compilation, source-bound discovery, every native result and TRX",
  };
  if (processes.length !== 1) return incomplete;
  const process = processes[0]!;
  if (process.exitCode !== 0) return dotnetBuildEvidence(check, processes);
  const findings: Finding[] = [];
  let observedFailure = false;
  try {
    const raw = JSON.parse(process.stdout);
    if (raw.prerequisiteFailure) return dotnetBuildEvidence(check, processes);
    const data = dotnetTestPacketSchema.parse(raw),
      built = dotnetBuildEvidence(check, [
        { ...process, stdout: JSON.stringify(data.build) },
      ]);
    if (built.status !== "passed") return built;
    const invocation = dotnetBuildInvocationSchema.parse(
        JSON.parse(check.commands[0]!.args[2]!),
      ),
      projects = invocation.config.projects.filter(
        (item) => item.kind === "test",
      ),
      tests: TestEvidence = { total: 0, passed: 0, failed: 0, skipped: 0 };
    findings.push(...(built.findings ?? []));
    requireEvidence(
      data.testObserverSourceSha256 === mavenHash(dotnetTestNativeSource),
      "Pinned original test observer source",
    );
    const expectedPhases = [
      "sdk",
      "compiler-version",
      "observer-compile",
      "restore",
      "build",
      ...invocation.config.projects.map((p) => "metadata:" + p.file),
      "test-observer-compile",
      ...projects.flatMap((p) => [
        "test-discovery:" + p.file,
        "test-execution:" + p.file,
      ]),
    ];
    requireEvidence(
      JSON.stringify(data.nativeReceipts.map((r) => r.phase)) ===
        JSON.stringify(expectedPhases) &&
        data.nativeReceipts
          .filter((r) => !r.phase.startsWith("test-execution:"))
          .every((r) => r.exitCode === 0),
      "Exact ordered successful native call closure",
    );
    const compile = data.nativeReceipts.find(
      (r) => r.phase === "test-observer-compile",
    )!;
    requireEvidence(
      compile.stdoutBytes === 0 &&
        compile.stderrBytes === 0 &&
        compile.stdoutSha256 === mavenHash("") &&
        compile.stderrSha256 === mavenHash(""),
      "Original test observer compiler completed without unexpected diagnostics",
    );
    for (const name of [
      "Microsoft.VisualStudio.TestPlatform.ObjectModel.dll",
      "vstest.console.dll",
      "vstest.console.runtimeconfig.json",
      "vstest.console.deps.json",
    ])
      requireEvidence(
        data.build.observedArtifacts.some(
          (p) => p.file === path.join(data.build.sdk, name) && p.bytes > 0,
        ),
        "Selected native test SDK input was observed",
      );
    requireEvidence(
      projects.length > 0 &&
        same(
          data.runs.map((run) => run.file),
          projects.map((project) => project.file),
        ),
      "Every declared test project",
    );
    requireEvidence(
      JSON.stringify(
        data.nativeReceipts.slice(0, data.build.nativeReceipts.length),
      ) === JSON.stringify(data.build.nativeReceipts) &&
        data.nativeReceipts.reduce(
          (sum, item) => sum + item.stdoutBytes + item.stderrBytes,
          0,
        ) <=
          8 * 1024 * 1024,
      "Complete bounded native test ledger",
    );
    for (const run of data.runs) {
      const project = projects.find((item) => item.file === run.file)!,
        module = data.build.modules.find((item) => item.file === run.file)!;
      requireEvidence(
        run.assembly === module.assembly && module.metadata,
        "Fresh selected native test assembly",
      );
      const base = path.dirname(module.assembly),
        expected = [
          module.assembly,
          module.pdb,
          path.join(base, project.assemblyName + ".deps.json"),
          path.join(base, project.assemblyName + ".runtimeconfig.json"),
        ];
      requireEvidence(
        same(
          run.artifacts.map((item) => item.file),
          expected,
        ),
        "Fresh native test artifact scope",
      );
      requireEvidence(
        run.artifacts.every(
          (p) =>
            p.bytes > 0 &&
            data.build.observedArtifacts.some(
              (q) =>
                q.file === p.file &&
                q.bytes === p.bytes &&
                q.sha256 === p.sha256,
            ),
        ),
        "Each native test artifact matches the rechecked build observation",
      );
      const lifecycle = (
        events: typeof run.discoveryEvents,
        pid: number,
        start: string,
        finish: string,
      ) => {
        requireEvidence(
          events[0]!.type === "init" &&
            events.at(-1)!.type === "close" &&
            ["init", "close", start, finish].every(
              (type) =>
                events.filter((item) => item.type === type).length === 1,
            ),
          "Complete native test lifecycle",
        );
        requireEvidence(
          events[0]!.processId === pid &&
            events[0]!.objectModel ===
              path.join(
                data.build.sdk,
                "Microsoft.VisualStudio.TestPlatform.ObjectModel.dll",
              ) &&
            events[0]!.runtime === "10.0.12" &&
            events[0]!.observerSha256 === data.testObserverSha256,
          "Owned selected VSTest client",
        );
        const allowed =
          start === "discoveryStarted"
            ? [
                "init",
                "close",
                "discoveryStarted",
                "discoveryFinished",
                "discovered",
                "message",
              ]
            : [
                "init",
                "close",
                "runStarted",
                "runFinished",
                "result",
                "message",
              ];
        const first = events.findIndex((e) => e.type === start),
          last = events.findIndex((e) => e.type === finish);
        requireEvidence(
          events.every(
            (e, i) =>
              allowed.includes(e.type) &&
              (!["discovered", "result"].includes(e.type) ||
                (i > first && i < last)),
          ) && last === events.length - 2,
          "Native result and terminal order",
        );
        requireEvidence(
          events.findIndex((item) => item.type === start) <
            events.findIndex((item) => item.type === finish) &&
            !events.some(
              (item) => item.type === "message" && item.level === "Error",
            ),
          "Native test order and infrastructure messages",
        );
      };
      lifecycle(
        run.discoveryEvents,
        run.discoveryLauncherPid,
        "discoveryStarted",
        "discoveryFinished",
      );
      lifecycle(
        run.executionEvents,
        run.executionLauncherPid,
        "runStarted",
        "runFinished",
      );
      const discovered = run.discoveryEvents
          .filter((item) => item.type === "discovered")
          .map((item) => testCase.parse(item.test)),
        results = run.executionEvents
          .filter((item) => item.type === "result")
          .map((item) =>
            z
              .object({
                test: testCase,
                outcome: z.enum(["Passed", "Failed", "Skipped"]),
                displayName: text,
                error: text,
                durationMs: z.number().finite().min(0).max(120000),
                start: z.iso.datetime({ offset: true }),
                end: z.iso.datetime({ offset: true }),
              })
              .parse(item),
          );
      const discovery = z
        .object({
          total: z.number().int().nonnegative().max(20000),
          aborted: z.literal(false),
          full: z.array(file),
          partial: z.array(file),
          skipped: z.array(file),
          missing: z.array(file),
        })
        .parse(
          run.discoveryEvents.find((item) => item.type === "discoveryFinished"),
        );
      requireEvidence(
        run.discoveryExitCode === 0 &&
          discovery.total === discovered.length &&
          discovered.length > 0 &&
          discovery.partial.length === 0 &&
          discovery.skipped.length === 0 &&
          discovery.missing.length === 0 &&
          discovery.full.every((file) => file === run.assembly),
        "Complete native discovery",
      );
      requireEvidence(
        same(
          discovered.map((item) => item.id),
          results.map((item) => item.test.id),
        ),
        "Every discovered native test executed exactly once",
      );
      const start = z
        .object({ sources: z.array(file).length(1) })
        .parse(run.executionEvents.find((e) => e.type === "runStarted"));
      requireEvidence(
        start.sources[0] === run.assembly,
        "Native test run starts against exactly the selected assembly",
      );
      const roles = new Set<string>(),
        caseFiles = new Map<string, string>();
      for (const candidate of discovered) {
        requireEvidence(
          candidate.source === run.assembly,
          "Selected native test source assembly",
        );
        const matching = project.testClasses.filter((role) => {
          if (!candidate.name.startsWith(role.className + ".")) return false;
          const method = candidate.name
            .slice(role.className.length + 1)
            .split("(")[0]!;
          return module.metadata!.types.some(
            (type) =>
              type.className === role.className &&
              type.methods.some(
                (item) =>
                  item.name === method &&
                  item.files.includes(
                    path.join(data.build.workspace, role.file),
                  ),
              ),
          );
        });
        requireEvidence(
          matching.length === 1,
          "Unique symbol-bound native test class and method",
        );
        const role = matching[0]!;
        roles.add(role.className);
        caseFiles.set(candidate.id, role.file);
        requireEvidence(
          !candidate.codeFile ||
            candidate.codeFile === path.join(data.build.workspace, role.file),
          "Native test location agrees with symbols",
        );
      }
      requireEvidence(
        same(
          [...roles],
          project.testClasses.map((item) => item.className),
        ),
        "Every declared test class participates",
      );
      const counts = { Passed: 0, Failed: 0, Skipped: 0 };
      for (const result of results) {
        const original = discovered.find((item) => item.id === result.test.id)!;
        requireEvidence(
          JSON.stringify(original) === JSON.stringify(result.test) &&
            Date.parse(result.start) <= Date.parse(result.end),
          "Native result identity and timing",
        );
        requireEvidence(
          result.outcome !== "Passed" || result.error === "",
          "Passing native case has no error",
        );
        if (result.outcome === "Failed")
          findings.push({
            ruleId: "dotnet-test/case-failure",
            level: "error",
            message:
              result.error || "Native test failed: " + result.displayName,
            file: path.posix.join(
              check.project,
              caseFiles.get(result.test.id)!,
            ),
          });
        counts[result.outcome]++;
      }
      const terminal = z
        .object({
          canceled: z.literal(false),
          aborted: z.literal(false),
          error: z.literal(""),
          executed: z.number().int().nonnegative(),
          stats: z.record(
            z.string().regex(/^(?:Passed|Failed|Skipped)$/),
            z.number().int().nonnegative(),
          ),
          elapsedMs: z.number().finite().nonnegative().max(120000),
        })
        .parse(run.executionEvents.find((item) => item.type === "runFinished"));
      requireEvidence(
        terminal.executed === results.length &&
          Object.entries(counts).every(
            ([key, value]) =>
              (terminal.stats[key as keyof typeof counts] ?? 0) === value,
          ) &&
          run.executionExitCode === (counts.Failed ? 1 : 0),
        "Native statistics and exit agree",
      );
      for (const [phase, exit] of [
        ["test-discovery:", run.discoveryExitCode],
        ["test-execution:", run.executionExitCode],
      ] as const) {
        const receipts = data.nativeReceipts.filter(
          (item) => item.phase === phase + run.file,
        );
        requireEvidence(
          receipts.length === 1 && receipts[0]!.exitCode === exit,
          "Every native test call receipt",
        );
      }
      if (counts.Failed > 0) observedFailure = true;
      requireEvidence(
        !/<!DOCTYPE|<!ENTITY/i.test(run.trx) &&
          XMLValidator.validate(run.trx) === true,
        "Bounded native TRX XML",
      );
      const trx = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        parseAttributeValue: false,
        processEntities: false,
      }).parse(run.trx).TestRun;
      requireEvidence(
        trx &&
          trx["@_xmlns"] ===
            "http://microsoft.com/schemas/VisualStudio/TeamTest/2010",
        "Native TRX namespace",
      );
      requireEvidence(
        trx.ResultSummary?.["@_outcome"] ===
          (counts.Failed ? "Failed" : "Completed"),
        "Native TRX terminal outcome",
      );
      const times = z.record(z.string(), z.string()).parse(trx.Times);
      for (const name of ["creation", "queuing", "start", "finish"])
        z.iso.datetime({ offset: true }).parse(times["@_" + name]);
      requireEvidence(
        Date.parse(times["@_start"]!) <= Date.parse(times["@_finish"]!),
        "Native TRX run timing",
      );
      const definitions = array(trx.TestDefinitions?.UnitTest),
        entries = array(trx.TestEntries?.TestEntry),
        outcomes = array(trx.Results?.UnitTestResult);
      requireEvidence(
        same(
          definitions.map((item) => String(item["@_id"])),
          discovered.map((item) => item.id),
        ) &&
          same(
            outcomes.map((item) => String(item["@_testId"])),
            discovered.map((item) => item.id),
          ) &&
          same(
            entries.map((item) => String(item["@_testId"])),
            discovered.map((item) => item.id),
          ),
        "Exact TRX definitions, entries and results",
      );
      requireEvidence(
        new Set(outcomes.map((o) => o["@_executionId"])).size ===
          outcomes.length,
        "Unique native TRX executions",
      );
      for (const result of results) {
        const definition = definitions.find(
            (item) => item["@_id"] === result.test.id,
          )!,
          outcome = outcomes.find(
            (item) => item["@_testId"] === result.test.id,
          )!,
          entry = entries.find((item) => item["@_testId"] === result.test.id)!,
          method = z
            .record(z.string(), z.unknown())
            .parse(definition.TestMethod),
          execution = z
            .record(z.string(), z.unknown())
            .parse(definition.Execution);
        requireEvidence(
          method["@_codeBase"] === run.assembly &&
            method["@_adapterTypeName"] === result.test.executor &&
            method["@_className"] + "." + method["@_name"] ===
              result.test.name &&
            definition["@_name"] === result.test.displayName &&
            outcome["@_testName"] === result.displayName &&
            outcome["@_executionId"] === execution["@_id"] &&
            entry["@_executionId"] === execution["@_id"] &&
            outcome["@_outcome"] ===
              (result.outcome === "Skipped" ? "NotExecuted" : result.outcome),
          "Native case and TRX identity",
        );
      }
      for (const result of results) {
        const outcome = outcomes.find((o) => o["@_testId"] === result.test.id)!;
        guid.parse(outcome["@_executionId"]);
        requireEvidence(
          instant(outcome["@_startTime"]) === instant(result.start) &&
            instant(outcome["@_endTime"]) === instant(result.end) &&
            Date.parse(result.start) >= Date.parse(times["@_start"]!) &&
            Date.parse(result.end) <= Date.parse(times["@_finish"]!),
          "Native result and TRX timing agree",
        );
        const duration = z
          .string()
          .regex(/^\d{2}:\d{2}:\d{2}\.\d{7}$/)
          .parse(outcome["@_duration"])
          .split(":")
          .map(Number);
        requireEvidence(
          Math.abs(
            ((duration[0]! * 60 + duration[1]!) * 60 + duration[2]!) * 1000 -
              result.durationMs,
          ) < 0.0001,
          "Native result and TRX duration agree",
        );
      }
      const counters = z
        .record(z.string(), z.unknown())
        .parse(trx.ResultSummary?.Counters);
      requireEvidence(
        same(
          Object.keys(counters),
          "total executed passed failed error timeout aborted inconclusive passedButRunAborted notRunnable notExecuted disconnected warning completed inProgress pending"
            .split(" ")
            .map((k) => "@_" + k),
        ) &&
          integer(counters["@_total"]) === results.length &&
          integer(counters["@_passed"]) === counts.Passed &&
          integer(counters["@_failed"]) === counts.Failed &&
          // This pinned TRX logger leaves notExecuted at zero for NUnit skips.
          // Per-case NotExecuted plus the native Skipped count retain them.
          integer(counters["@_notExecuted"]) === 0 &&
          integer(counters["@_executed"]) === counts.Passed + counts.Failed &&
          Object.entries(counters)
            .filter(
              ([key]) =>
                ![
                  "@_total",
                  "@_executed",
                  "@_passed",
                  "@_failed",
                  "@_notExecuted",
                ].includes(key),
            )
            .every(([, value]) => integer(value) === 0),
        "Native TRX counters",
      );
      tests.total += results.length;
      tests.passed += counts.Passed;
      tests.failed += counts.Failed;
      tests.skipped += counts.Skipped;
    }
    return {
      status: tests.failed
        ? "failed"
        : tests.skipped
          ? "inconclusive"
          : "passed",
      findings,
      findingsComplete: tests.skipped === 0,
      tests,
      reason: tests.failed
        ? "Native source-bound .NET tests reported failures"
        : tests.skipped
          ? "Skipped .NET tests leave coverage incomplete"
          : "Every declared native .NET test case reconciles discovery, source symbols, execution and TRX",
    };
  } catch {
    return observedFailure
      ? {
          status: "failed",
          findings,
          findingsComplete: false,
          reason:
            "A native source-bound .NET case failure was observed; remaining evidence is incomplete",
        }
      : incomplete;
  }
}
