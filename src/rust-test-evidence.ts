import path from "node:path";
import { z } from "zod";
import type {
  Check,
  CheckResult,
  ProcessResult,
  TestEvidence,
} from "./types.js";
import { rustEvidence } from "./rust-evidence.js";
import { rustTestList, rustTestRun } from "./rust-test-events.js";
import {
  rustTestNativeSchema,
  rustTestTargetSchema,
  rustTestArtifactSchema,
} from "./rust-test-native.js";
const schema = z.strictObject({
  version: z.literal(3),
  mode: z.literal("test"),
  rustdocVersion: z.literal("1.98.1"),
  cargoVersion: z.literal("1.98.1"),
  rustcVersion: z.literal("1.98.1"),
  project: z.string(),
  packageId: z.string(),
  exitCode: z.number().int(),
  targets: z.array(rustTestTargetSchema).min(1).max(100),
  events: z.array(z.unknown()).max(20000),
  observedSources: z.array(z.string()).max(20000),
  depInfoCount: z.number().int().nonnegative().max(20000),
  scopeError: z.boolean(),
  tests: rustTestNativeSchema.nullable(),
});
export function rustTestEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<
  CheckResult,
  "status" | "reason" | "tests" | "findings" | "findingsComplete"
> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Rust tests lack complete native build, listing, terminal cases or source/target evidence.",
    findingsComplete: false,
  };
  if (processes.length !== 1 || !root) return incomplete;
  const process = processes[0]!;
  if (process.exitCode !== 0)
    return rustEvidence({ ...check, id: "rust.cargo-check" }, processes, root);
  try {
    const data = schema.parse(JSON.parse(process.stdout));
    const { mode, rustdocVersion, tests, ...compilation } = data;
    void mode;
    void rustdocVersion;
    const compiler = rustEvidence(
      { ...check, id: "rust.cargo-check" },
      [{ ...process, stdout: JSON.stringify({ ...compilation, version: 1 }) }],
      root,
    );
    if (!tests) return compiler.status === "passed" ? incomplete : compiler;
    if (tests.build.exitCode !== 0)
      return {
        status: "error",
        reason:
          "Cargo could not compile/link the native test artifacts; test execution is incomplete.",
        findingsComplete: false,
      };
    if (tests.error !== null)
      return {
        ...incomplete,
        reason:
          "Native test artifact/listing/execution collection could not complete.",
      };
    const events = z
      .array(z.object({ reason: z.string() }).passthrough())
      .max(20000)
      .parse(
        tests.build.stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      );
    if (
      events.at(-1)?.reason !== "build-finished" ||
      events.at(-1)?.success !== true ||
      events.filter((e) => e.reason === "build-finished").length !== 1
    )
      return incomplete;
    const artifacts = events
      .filter((e) => e.reason === "compiler-artifact")
      .map((e) => rustTestArtifactSchema.parse(e))
      .filter(
        (e) =>
          e.package_id === data.packageId &&
          e.profile.test &&
          e.executable !== null &&
          !e.target.kind.includes("custom-build"),
      );
    const groups = tests.groups;
    const identities = groups.map((g) =>
      JSON.stringify([g.kind, g.target.name, g.target.src_path, g.target.kind]),
    );
    if (new Set(identities).size !== identities.length) return incomplete;
    const lib = groups.filter((g) => g.kind === "libtest");
    const docs = groups.filter((g) => g.kind === "doctest");
    const declarations = data.targets.filter(
      (t) => t.test && !t.kind.includes("custom-build"),
    );
    const same = (
      a: z.infer<typeof rustTestTargetSchema>,
      b: z.infer<typeof rustTestTargetSchema>,
    ) =>
      a.name === b.name &&
      a.src_path === b.src_path &&
      JSON.stringify(a.kind) === JSON.stringify(b.kind) &&
      a.test === b.test &&
      a.doctest === b.doctest;
    if (
      lib.length !== artifacts.length ||
      declarations.some((t) => !lib.some((g) => same(g.target, t))) ||
      lib.some(
        (g) =>
          !data.targets.some((t) => same(g.target, t)) ||
          !artifacts.some(
            (a) =>
              same(a.target, g.target) &&
              a.executable === g.executable &&
              !a.fresh,
          ),
      ) ||
      docs.length !== data.targets.filter((t) => t.doctest).length ||
      docs.length > 1 ||
      docs.some(
        (g) =>
          g.executable !== null ||
          !data.targets.some((t) => t.doctest && same(g.target, t)),
      )
    )
      return incomplete;
    const totals: TestEvidence = { total: 0, passed: 0, failed: 0, skipped: 0 };
    for (const group of groups) {
      if (!group.listed || !group.ignoredListed || !group.execution)
        return incomplete;
      if (group.kind === "libtest") {
        if (!group.executable) return incomplete;
        const relative = path.relative(tests.outputDirectory, group.executable);
        if (
          !relative ||
          relative.startsWith(".." + path.sep) ||
          path.isAbsolute(relative)
        )
          return incomplete;
      }
      const names = rustTestList(group.listed, group.kind === "doctest");
      const ignored = rustTestList(
        group.ignoredListed,
        group.kind === "doctest",
      );
      if (
        group.kind === "doctest" &&
        names.some(
          (name) =>
            !check.scope.some(
              (file) =>
                name.startsWith(file + " - ") &&
                / \(line [1-9][0-9]*\)$/.test(name),
            ),
        )
      )
        return incomplete;
      const result = rustTestRun(
        group.execution,
        names,
        ignored,
        group.kind === "doctest",
      );
      for (const key of ["total", "passed", "failed", "skipped"] as const)
        totals[key] += result.tests[key];
      if (totals.total > 1000) return incomplete;
    }
    if (totals.failed)
      return {
        status: "failed",
        reason:
          "Native Rust test cases failed; compiler scope and ignored accounting remain separately retained.",
        tests: totals,
        ...(compiler.findings ? { findings: compiler.findings } : {}),
        findingsComplete: compiler.status === "passed" && totals.skipped === 0,
      };
    if (compiler.status !== "passed")
      return { ...compiler, tests: totals, findingsComplete: false };
    if (!totals.passed || totals.skipped)
      return {
        ...incomplete,
        reason:
          "Native Rust tests were empty, entirely skipped or included ignored cases.",
        tests: totals,
      };
    return {
      status: "passed",
      reason:
        "Fresh native Rust test builds, exact listings and terminal cases reconcile; doctest compile-only and expected-failure cases retain native mode labels in detailed evidence.",
      tests: totals,
      ...(compiler.findings ? { findings: compiler.findings } : {}),
      findingsComplete: true,
    };
  } catch {
    return incomplete;
  }
}
