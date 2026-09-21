import { nuxtEvidence } from "./nuxt-evidence.js";
import { externalEvidence } from "./external-evidence.js";
import { actionlintEvidence } from "./actionlint-evidence.js";
import { clangEvidence } from "./clang-evidence.js";
import { javaEvidence } from "./java-evidence.js";
import { dotnetEvidence } from "./dotnet-evidence.js";
import { rustEvidence } from "./rust-evidence.js";
import { laravelEvidence } from "./laravel-evidence.js";
import { pintEvidence } from "./pint-evidence.js";
import { fastapiEvidence } from "./fastapi-evidence.js";
import { vueRouterEvidence } from "./vue-router-evidence.js";
import { djangoEvidence } from "./django-evidence.js";
import path from "node:path";
import { phpunitEvidence } from "./phpunit-evidence.js";
import { phpstanEvidence } from "./phpstan-evidence.js";
import { mypyEvidence } from "./mypy-evidence.js";
import { ruffEvidence } from "./ruff-evidence.js";
import { pytestEvidence } from "./pytest-evidence.js";
import { eslintEvidence } from "./eslint-evidence.js";
import { golangciEvidence } from "./golangci-evidence.js";
import { typescriptBuildEvidence } from "./typescript-build-evidence.js";
import { goScopeComplete } from "./go-scope.js";
import { staticcheckEvidence } from "./staticcheck-evidence.js";
import { playwrightEvidence } from "./playwright-evidence.js";
import { jestEvidence } from "./jest-evidence.js";
import { vitestEvidence } from "./vitest-evidence.js";
import type {
  Check,
  CheckResult,
  ProcessResult,
  TestEvidence,
} from "./types.js";

function nodeTests(
  text: string,
  expectedFiles: number,
): TestEvidence | undefined {
  const result: TestEvidence = { total: 0, passed: 0, failed: 0, skipped: 0 };
  const files = new Set<string>();
  let globalSummaries = 0;
  let globalCounts: TestEvidence | undefined;
  try {
    for (const line of text.split("\n").filter(Boolean)) {
      const event = JSON.parse(line) as {
        type?: unknown;
        data?: { file?: unknown; counts?: Record<string, unknown> };
      };
      if (event.type !== "test:summary") continue;
      if (!event.data) return undefined;
      const counts = event.data.counts;
      if (!counts) return undefined;
      for (const key of [
        "tests",
        "passed",
        "failed",
        "skipped",
        "todo",
        "cancelled",
      ]) {
        if (
          typeof counts[key] !== "number" ||
          !Number.isSafeInteger(counts[key]) ||
          counts[key] < 0
        )
          return undefined;
      }
      const total = counts.tests as number;
      const passed = counts.passed as number;
      const failed = counts.failed as number;
      const skipped = (counts.skipped as number) + (counts.todo as number);
      if (counts.cancelled !== 0 || total !== passed + failed + skipped)
        return undefined;
      if (event.data.file === undefined) {
        globalSummaries++;
        globalCounts = { total, passed, failed, skipped };
        continue;
      }
      if (typeof event.data.file !== "string" || files.has(event.data.file))
        return undefined;
      files.add(event.data.file);
      result.total += total;
      result.passed += passed;
      result.failed += failed;
      result.skipped += skipped;
    }
  } catch {
    return undefined;
  }
  // Node counts an empty file as a passing test, but emits no file-level summary.
  return files.size === expectedFiles &&
    globalSummaries === 1 &&
    JSON.stringify(result) === JSON.stringify(globalCounts)
    ? result
    : undefined;
}

function pythonTests(text: string): TestEvidence | undefined {
  const runs = [...text.matchAll(/^Ran (\d+) tests? in [\d.]+s\r?$/gm)];
  if (runs.length !== 1) return undefined;
  const total = Number(runs[0]?.[1]);
  if (!Number.isSafeInteger(total)) return undefined;
  const finals = [...text.matchAll(/^(OK|FAILED)(?: \(([^\r\n]*)\))?\r?$/gm)];
  if (finals.length !== 1) return undefined;
  const detail = finals[0]?.[2] ?? "";
  const fields = detail ? detail.split(", ") : [];
  if (
    fields.some(
      (field) =>
        !/^(skipped|expected failures|unexpected successes|failures|errors)=\d+$/.test(
          field,
        ),
    )
  )
    return undefined;
  if (
    new Set(fields.map((field) => field.split("=")[0])).size !== fields.length
  )
    return undefined;
  const count = (key: string): number =>
    Number(new RegExp(`(?:^|, )${key}=(\\d+)(?:,|$)`).exec(detail)?.[1] ?? 0);
  const skipped = count("skipped") + count("expected failures");
  const failed =
    count("failures") + count("errors") + count("unexpected successes");
  if (skipped + failed > total || (finals[0]?.[1] === "FAILED" && failed === 0))
    return undefined;
  return { total, passed: total - skipped - failed, failed, skipped };
}

function goTests(
  text: string,
  allowPackageFailures = false,
): TestEvidence | undefined {
  const result: TestEvidence = { total: 0, passed: 0, failed: 0, skipped: 0 };
  const completed = new Set<string>();
  const packages = new Set<string>();
  const startedTests = new Set<string>();
  const startedPackages = new Set<string>();
  try {
    for (const line of text.split("\n").filter(Boolean)) {
      const event: unknown = JSON.parse(line);
      if (
        typeof event !== "object" ||
        event === null ||
        !("Action" in event) ||
        typeof event.Action !== "string"
      )
        return undefined;
      if (!["start", "run", "pass", "fail", "skip"].includes(event.Action))
        continue;
      if (!("Package" in event) || typeof event.Package !== "string")
        return undefined;
      if (event.Action === "start") {
        if (startedPackages.has(event.Package)) return undefined;
        startedPackages.add(event.Package);
        continue;
      }
      if (event.Action === "run") {
        if (!("Test" in event) || typeof event.Test !== "string")
          return undefined;
        const key = JSON.stringify([event.Package, event.Test]);
        if (startedTests.has(key)) return undefined;
        startedTests.add(key);
        continue;
      }
      if (!("Test" in event)) {
        if (packages.has(event.Package) || !startedPackages.has(event.Package))
          return undefined;
        packages.add(event.Package);
        if (event.Action === "fail" && !allowPackageFailures) return undefined;
        continue;
      }
      if (typeof event.Test !== "string") return undefined;
      const key = JSON.stringify([event.Package, event.Test]);
      if (completed.has(key) || !startedTests.has(key)) return undefined;
      completed.add(key);
      result.total++;
      if (event.Action === "pass") result.passed++;
      else if (event.Action === "fail") result.failed++;
      else result.skipped++;
    }
  } catch {
    return undefined;
  }
  return packages.size &&
    packages.size === startedPackages.size &&
    completed.size === startedTests.size
    ? result
    : undefined;
}

export function evaluate(
  check: Check,
  processes: ProcessResult[],
  root?: string,
): CheckResult {
  const result: CheckResult = {
    ...(check.external ? { external: check.external } : {}),
    id: check.id,
    adapter: check.adapter,
    project: check.project,
    scope: check.scope,
    status: "passed",
    reason: "The planned check completed successfully.",
    processes,
  };
  const set = (status: CheckResult["status"], reason: string): CheckResult => ({
    ...result,
    status,
    reason,
  });
  if (check.unavailableReason)
    return set("unavailable", check.unavailableReason);
  if (processes.length !== check.commands.length || processes.length === 0)
    return set("inconclusive", "Not all planned commands ran.");
  if (processes.some((p) => p.cancelled))
    return set("inconclusive", "Execution was cancelled.");
  if (processes.some((p) => p.timedOut))
    return set("inconclusive", "Execution exceeded its time limit.");
  if (processes.some((p) => p.truncated))
    return set(
      "inconclusive",
      "Output exceeded its limit; evidence is incomplete.",
    );
  if (
    processes.some(
      (p) => p.errorCode === "ENOENT" || p.errorCode === "UNSUPPORTED_PLATFORM",
    )
  )
    return set(
      "unavailable",
      "A required executable or supported execution platform is unavailable.",
    );
  if (processes.some((p) => p.errorCode || p.signal || p.exitCode === null))
    return set("error", "The process could not complete normally.");
  if (check.parser === "external-json")
    return { ...result, ...externalEvidence(check, processes) };
  if (check.parser === "typescript-build-json")
    return { ...result, ...typescriptBuildEvidence(check, processes, root) };
  if (check.parser === "golangci-json")
    return { ...result, ...golangciEvidence(check, processes, root) };
  if (check.parser === "staticcheck-json")
    return { ...result, ...staticcheckEvidence(check, processes, root) };
  if (
    check.parser === "go-scope-test" ||
    check.parser === "go-scope-analysis"
  ) {
    const native = evaluate(
      {
        ...check,
        parser: check.kind === "test" ? "go-json" : "exit",
        commands: check.commands.slice(1),
      },
      processes.slice(1),
      root,
    );
    if (native.status !== "passed")
      return {
        ...result,
        status: native.status,
        reason: native.reason,
        ...(native.tests ? { tests: native.tests } : {}),
      };
    if (
      !goScopeComplete(
        check,
        processes[0],
        root,
        check.kind === "test" ? processes[1]?.stdout : undefined,
      )
    )
      return set(
        "inconclusive",
        "Native Go selection omitted inventoried source, a package has no passing test, or scope could not be established.",
      );
    return { ...result, ...(native.tests ? { tests: native.tests } : {}) };
  }
  if (check.parser === "eslint-json")
    return { ...result, ...eslintEvidence(check, processes, root) };
  if (check.parser === "pint-json")
    return { ...result, ...pintEvidence(check, processes, root) };
  if (check.parser === "phpunit-junit")
    return { ...result, ...phpunitEvidence(check, processes, root) };
  if (check.parser === "phpstan-json")
    return { ...result, ...phpstanEvidence(check, processes, root) };
  if (check.parser === "mypy-json")
    return { ...result, ...mypyEvidence(check, processes, root) };
  if (check.parser === "ruff-json")
    return { ...result, ...ruffEvidence(check, processes, root) };
  if (check.parser === "pytest-json")
    return { ...result, ...pytestEvidence(check, processes, root) };
  if (check.parser === "nuxt-json")
    return { ...result, ...nuxtEvidence(check, processes) };
  if (check.parser === "vue-router-json")
    return { ...result, ...vueRouterEvidence(check, processes) };
  if (check.parser === "fastapi-json")
    return { ...result, ...fastapiEvidence(check, processes) };
  if (check.parser === "clang-json")
    return { ...result, ...clangEvidence(check, processes, root) };
  if (check.parser === "java-json")
    return { ...result, ...javaEvidence(check, processes, root) };
  if (check.parser === "actionlint-json")
    return { ...result, ...actionlintEvidence(check, processes) };
  if (check.parser === "dotnet-json")
    return { ...result, ...dotnetEvidence(check, processes, root) };
  if (check.parser === "rust-json")
    return { ...result, ...rustEvidence(check, processes, root) };
  if (check.parser === "laravel-json")
    return { ...result, ...laravelEvidence(check, processes) };
  if (check.parser === "django-json")
    return { ...result, ...djangoEvidence(check, processes) };
  if (check.parser === "playwright-json")
    return { ...result, ...playwrightEvidence(check, processes, root) };
  if (check.parser === "jest-json")
    return { ...result, ...jestEvidence(check, processes, root) };
  if (check.parser === "vitest-json")
    return { ...result, ...vitestEvidence(check, processes, root) };
  if (check.kind === "test") {
    const stdout = processes.map((p) => p.stdout).join("\n");
    const stderr = processes.map((p) => p.stderr).join("\n");
    const tests =
      check.parser === "node-events"
        ? nodeTests(stdout, check.scope.length)
        : check.parser === "unittest"
          ? pythonTests(stderr)
          : goTests(
              stdout,
              processes.some((process) => process.exitCode !== 0),
            );
    if (tests) result.tests = tests;
    if (processes.some((process) => process.exitCode !== 0))
      return set(
        "failed",
        tests?.failed
          ? "Test evidence contains failures."
          : "The tool returned a nonzero exit code; inspect detailed evidence for code or environment causes.",
      );
    if (!tests)
      return set(
        "inconclusive",
        "The test evidence could not be parsed unambiguously.",
      );
    if (tests.failed) return set("failed", "Test evidence contains failures.");
    if (tests.passed === 0)
      return set(
        "inconclusive",
        "No passing, non-skipped tests were observed.",
      );
  }
  if (processes.some((p) => p.exitCode !== 0))
    return set(
      "failed",
      "The tool returned a nonzero exit code; inspect detailed evidence for code or environment causes.",
    );
  if (
    check.parser === "ruby-syntax" &&
    processes.some(
      (process) =>
        process.stdout.trim() !== "Syntax OK" || process.stderr.trim(),
    )
  )
    return set(
      "inconclusive",
      "Ruby did not provide an unambiguous syntax-success result for every planned file.",
    );
  if (
    check.parser === "silent-syntax" &&
    processes.some((process) => process.stdout.trim() || process.stderr.trim())
  )
    return set(
      "inconclusive",
      "The compiler emitted output inconsistent with a clean syntax-only result.",
    );
  if (
    check.parser === "empty" &&
    processes.some((p) => p.stdout.trim() || p.stderr.trim())
  )
    return set("failed", "The formatter reported files or diagnostics.");
  if (check.parser === "tsc-files") {
    const files = processes.flatMap((p) =>
      p.stdout.split(/\r?\n/).filter(Boolean),
    );
    if (
      !root ||
      !check.scope.length ||
      processes.some((p) => p.stderr.trim()) ||
      files.some((file) => !path.isAbsolute(file))
    )
      return set(
        "inconclusive",
        "The compiler file list could not be interpreted unambiguously.",
      );
    const included = new Set(files.map((file) => path.normalize(file)));
    if (
      check.scope.some(
        (file) => !included.has(path.resolve(root, check.project, file)),
      )
    )
      return set(
        "inconclusive",
        "The compiler did not include every inventoried TypeScript file; inspect tsconfig scope.",
      );
  }
  return result;
}
