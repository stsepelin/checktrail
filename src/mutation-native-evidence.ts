import path from "node:path";
import { parseAllDocuments } from "yaml";
import type {
  NativeMutationCase,
  NativeMutationObservation,
  NativeMutationProfile,
} from "./mutation-native-schema.js";
import type { ProcessResult } from "./types.js";
type ObjectValue = Record<string, unknown>;
const obj = (v: unknown): ObjectValue => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw Error("Native mutation object missing");
  return v as ObjectValue;
};
const arr = (v: unknown): unknown[] => {
  if (!Array.isArray(v) || v.length > 4096)
    throw Error("Native mutation array differs");
  return v;
};
const str = (v: unknown): string => {
  if (typeof v !== "string" || !v.length || v.length > 2048)
    throw Error("Native mutation string differs");
  return v;
};
const integer = (v: unknown, min = 0): number => {
  if (!Number.isSafeInteger(v) || Number(v) < min)
    throw Error("Native mutation integer differs");
  return Number(v);
};
const need = (v: unknown) => {
  if (!v) throw Error("Native mutation accounting differs");
};
export function mutationNativeJson(text: string): unknown {
  need(Buffer.byteLength(text) <= 1048576);
  const docs = parseAllDocuments(text, {
    strict: true,
    uniqueKeys: true,
    prettyErrors: false,
  });
  need(
    docs.length === 1 && !docs[0]!.errors.length && !docs[0]!.warnings.length,
  );
  const value: unknown = JSON.parse(text);
  let entries = 0;
  function walk(v: unknown, depth: number): void {
    need(depth <= 32 && ++entries <= 20000);
    if (v && typeof v === "object")
      for (const item of Object.values(v)) walk(item, depth + 1);
  }
  walk(value, 0);
  return value;
}
export function mutationNativeEvidence(
  profile: NativeMutationProfile,
  process: ProcessResult,
  root: string,
  selected: string[],
): {
  outcome: NativeMutationObservation["outcome"];
  cases: NativeMutationCase[];
} {
  const empty = (outcome: NativeMutationObservation["outcome"]) => ({
    outcome,
    cases: [],
  });
  if (
    process.cancelled ||
    process.timedOut ||
    process.truncated ||
    process.signal ||
    process.errorCode ||
    process.exitCode === null
  )
    return empty("inconclusive");
  try {
    const packet = obj(mutationNativeJson(process.stdout));
    if (packet.unavailable) return empty("unavailable");
    need(packet.schemaVersion === 1);
    const expected = selected.map((f) => path.resolve(root, f)).sort();
    need(
      JSON.stringify(arr(packet.selectedFiles).map(str).sort()) ===
        JSON.stringify(expected),
    );
    const cases: NativeMutationCase[] = [];
    let globalSetup = false,
      globalExecution = false;
    const seenFiles = new Set<string>();
    const fileOf = (v: unknown) => {
      const file = str(v);
      need(
        expected.includes(file) &&
          path.isAbsolute(file) &&
          path.normalize(file) === file,
      );
      seenFiles.add(file);
      return path.relative(root, file).split(path.sep).join("/");
    };
    const add = (
      file: string,
      name: string,
      line: number,
      column: number,
      status: NativeMutationCase["status"],
    ) => {
      need(cases.length < 256);
      cases.push({
        file,
        name,
        line,
        id: JSON.stringify([file, name, line, column]),
        status,
      });
    };
    if (profile === "vitest-flat-tests") {
      need(
        packet.format === "checktrail-mutation-vitest-1" &&
          packet.version === "5.0.1" &&
          ["passed", "failed"].includes(str(packet.endReason)),
      );
      globalExecution = arr(packet.unhandled).length > 0;
      for (const raw of arr(packet.modules)) {
        const module = obj(raw),
          file = fileOf(module.file);
        need(
          module.flat === true &&
            ["passed", "failed", "skipped"].includes(str(module.state)),
        );
        if (arr(module.errors).length) globalSetup = true;
        for (const rawCase of arr(module.cases)) {
          const c = obj(rawCase),
            location = obj(c.location),
            errors = arr(c.errors).map((e) => str(obj(e).name));
          need(
            c.parent === "module" &&
              c.retry === 0 &&
              c.fails === false &&
              ["run", "skip"].includes(str(c.mode)) &&
              c.fullName === c.name,
          );
          let status: NativeMutationCase["status"];
          if (c.state === "passed") {
            need(!errors.length && c.mode === "run");
            status = "passed";
          } else if (c.state === "failed") {
            need(errors.length && c.mode === "run");
            status = errors.every((n) => n === "AssertionError")
              ? "assertion-failure"
              : "execution-error";
          } else if (c.state === "skipped") {
            need(!errors.length);
            status = "skipped";
          } else throw Error("Pending native mutation case");
          add(
            file,
            str(c.name),
            integer(location.line, 1),
            integer(location.column, 1),
            status,
          );
        }
      }
      for (const raw of arr(packet.hooks)) {
        const hook = obj(raw),
          file = fileOf(hook.file),
          before = integer(hook.beforeErrors),
          after =
            hook.afterErrors === null ? before : integer(hook.afterErrors);
        need(
          after >= before &&
            ["beforeAll", "afterAll", "beforeEach", "afterEach"].includes(
              str(hook.name),
            ),
        );
        need(
          typeof hook.completed === "boolean" &&
            (hook.completed
              ? hook.afterErrors !== null
              : hook.afterErrors === null),
        );
        if (!hook.completed || after > before) {
          const status =
            hook.name === "beforeAll" || hook.name === "beforeEach"
              ? "setup-error"
              : "execution-error";
          const reached = cases.filter(
            (c) =>
              c.file === file &&
              (hook.caseName === null || c.name === hook.caseName),
          );
          for (const c of reached) {
            if (c.status === "skipped") continue;
            need(c.status !== "passed");
            c.status = status;
          }
          if (!reached.length) {
            if (status === "setup-error") globalSetup = true;
            else globalExecution = true;
          }
        }
      }
    } else if (profile === "jest-flat-tests") {
      need(
        packet.format === "checktrail-mutation-jest-1" &&
          packet.version === "30.5.2",
      );
      const native = obj(packet.native);
      need(
        native.wasInterrupted === false &&
          integer(native.numTodoTests) === 0 &&
          integer(native.numRuntimeErrorTestSuites) <= selected.length,
      );
      for (const raw of arr(native.testResults)) {
        const module = obj(raw),
          file = fileOf(module.testFilePath);
        if (module.testExecError !== undefined && module.testExecError !== null)
          globalSetup = true;
        for (const rawCase of arr(module.testResults)) {
          const c = obj(rawCase),
            location = obj(c.location),
            details = arr(c.failureDetails);
          need(
            !arr(c.ancestorTitles).length &&
              c.failing === false &&
              integer(c.invocations, 1) === 1 &&
              !arr(c.retryReasons ?? []).length &&
              !arr(c.retryMessages).length,
          );
          let status: NativeMutationCase["status"];
          if (c.status === "passed") {
            need(!details.length);
            status = "passed";
          } else if (c.status === "pending") {
            need(!details.length);
            status = "skipped";
          } else if (c.status === "failed") {
            need(details.length);
            status = details.every((d) => {
              const matcher = obj(d).matcherResult;
              if (!matcher) return false;
              const m = obj(matcher);
              return (
                m.pass === false &&
                typeof m.name === "string" &&
                m.name.length > 0
              );
            })
              ? "assertion-failure"
              : "execution-error";
          } else throw Error("Unknown native mutation Jest state");
          add(
            file,
            str(c.title),
            integer(location.line, 1),
            integer(location.column, 1),
            status,
          );
        }
      }
      need(
        integer(native.numTotalTests) === cases.length &&
          integer(native.numPassedTests) ===
            cases.filter((c) => c.status === "passed").length &&
          integer(native.numFailedTests) ===
            cases.filter(
              (c) =>
                c.status === "assertion-failure" ||
                c.status === "execution-error",
            ).length &&
          integer(native.numPendingTests) ===
            cases.filter((c) => c.status === "skipped").length,
      );
      for (const raw of arr(packet.hooks)) {
        const hook = obj(raw),
          file = fileOf(hook.file);
        need(
          ["beforeAll", "afterAll", "beforeEach", "afterEach"].includes(
            str(hook.name),
          ),
        );
        const status =
          hook.name === "beforeAll" || hook.name === "beforeEach"
            ? "setup-error"
            : "execution-error";
        const reached = cases.filter(
          (c) =>
            c.file === file && (hook.test === null || c.name === hook.test),
        );
        for (const c of reached) c.status = status;
        if (!reached.length) {
          if (status === "setup-error") globalSetup = true;
          else globalExecution = true;
        }
      }
    } else if (profile === "pytest-flat-tests") {
      need(
        packet.format === "checktrail-mutation-pytest-1" &&
          packet.python === "3.12.13" &&
          packet.version === "9.1.1" &&
          packet.finished === true &&
          packet.exitCode === process.exitCode &&
          !arr(packet.deselected).length,
      );
      globalSetup = arr(packet.collectionErrors).length > 0;
      const reports = arr(packet.reports).map(obj),
        ids = new Set<string>();
      for (const raw of arr(packet.items)) {
        const item = obj(raw),
          file = fileOf(item.file),
          id = str(item.id);
        need(
          id === file + "::" + id.split("::")[1] &&
            id.split("::").length === 2 &&
            !id.includes("[") &&
            !ids.has(id),
        );
        ids.add(id);
        const phases = reports.filter((r) => r.id === id);
        need(
          phases.length >= 2 &&
            phases.length <= 3 &&
            phases[0]!.phase === "setup" &&
            phases.at(-1)!.phase === "teardown" &&
            new Set(phases.map((r) => r.phase)).size === phases.length,
        );
        let status: NativeMutationCase["status"] = "passed";
        for (const phase of phases) {
          need(
            phase.xfail === false &&
              ["setup", "call", "teardown"].includes(str(phase.phase)),
          );
          if (phase.outcome === "passed") need(phase.exception === null);
          else if (phase.outcome === "skipped") status = "skipped";
          else if (phase.outcome === "failed") {
            const e = obj(phase.exception);
            need(typeof e.assertion === "boolean");
            str(e.name);
            if (phase.phase === "setup") status = "setup-error";
            else if (phase.phase === "teardown" || !e.assertion)
              status = "execution-error";
            else if (status === "passed") status = "assertion-failure";
          } else throw Error("Unknown native pytest phase");
        }
        if (phases.length === 2)
          need(status === "skipped" || status === "setup-error");
        else need(phases[1]!.phase === "call");
        add(file, id.split("::")[1]!, integer(item.line, 1), 0, status);
      }
      need(
        reports.every((r) => ids.has(str(r.id))) &&
          reports.length ===
            cases.reduce(
              (n, c) =>
                n +
                reports.filter((r) => r.id === c.file + "::" + c.name).length,
              0,
            ),
      );
    } else {
      need(
        packet.format === "checktrail-mutation-phpunit-1" &&
          packet.php === "8.5.6" &&
          packet.version === "13.3.4" &&
          typeof packet.aborted === "boolean",
      );
      if (packet.aborted) {
        need(packet.exitCode === null && process.exitCode !== 0);
        globalSetup = true;
      } else need(packet.exitCode === process.exitCode);
      const events = arr(packet.events).map(obj),
        starts = events.filter((e) => e.kind === "start");
      for (const start of starts) {
        const file = fileOf(start.file),
          id = str(start.id),
          method = str(start.method),
          className = str(start.class);
        need(id === className + "::" + method && /^test\w+$/.test(method));
        const line = integer(start.line, 1),
          rows = events.filter((e) => e.id === id);
        need(
          rows[0] === start &&
            rows.every(
              (e) =>
                e.file === start.file &&
                e.line === line &&
                e.method === method &&
                e.class === className,
            ),
        );
        let prepared = false,
          hookFailure: "setup-error" | "execution-error" | undefined,
          passed = false,
          finished = false,
          status: NativeMutationCase["status"] = "passed";
        need(new Set(rows.map((e) => e.kind)).size === rows.length);
        for (const e of rows.slice(1)) {
          need(!finished);
          if (e.kind === "prepared") {
            need(!prepared);
            prepared = true;
          } else if (e.kind === "passed") {
            need(prepared && !passed);
            passed = true;
          } else if (
            e.kind === "before-hook-failed" ||
            e.kind === "after-hook-failed"
          ) {
            str(e.exception);
            need(hookFailure === undefined);
            hookFailure =
              e.kind === "before-hook-failed"
                ? "setup-error"
                : "execution-error";
            status = hookFailure;
          } else if (e.kind === "failed" || e.kind === "error") {
            const name = str(e.exception);
            status =
              hookFailure ??
              (!prepared
                ? "setup-error"
                : passed
                  ? "execution-error"
                  : e.kind === "failed" &&
                      [
                        "PHPUnit\\Framework\\ExpectationFailedException",
                        "PHPUnit\\Framework\\AssertionFailedError",
                      ].includes(name)
                    ? "assertion-failure"
                    : "execution-error");
          } else if (e.kind === "skipped") status = "skipped";
          else if (e.kind === "incomplete" || e.kind === "risky")
            status = "execution-error";
          else if (e.kind === "finished") {
            finished = true;
            integer(e.assertions);
            if (status === "passed")
              need(prepared && passed && integer(e.assertions, 1) > 0);
          } else throw Error("Unknown native PHPUnit lifecycle");
        }
        need(finished || status === "setup-error" || status === "skipped");
        add(file, id, line, 0, status);
      }
      need(events.every((e) => starts.some((s) => s.id === e.id)));
    }
    need(new Set(cases.map((c) => c.id)).size === cases.length);
    const failures =
      globalSetup ||
      globalExecution ||
      cases.some(
        (c) =>
          c.status === "setup-error" ||
          c.status === "execution-error" ||
          c.status === "assertion-failure",
      );
    if (!cases.length && !globalSetup && !globalExecution)
      return empty("inconclusive");
    if (failures) need(process.exitCode !== 0);
    else need(process.exitCode === 0);
    if (globalSetup || cases.some((c) => c.status === "setup-error"))
      return { outcome: "setup-error", cases };
    if (globalExecution || cases.some((c) => c.status === "execution-error"))
      return { outcome: "execution-error", cases };
    need(seenFiles.size === expected.length && cases.length > 0);
    const outcome = cases.some((c) => c.status === "skipped")
      ? "skipped"
      : cases.some((c) => c.status === "assertion-failure")
        ? "assertion-failure"
        : "passed";
    return { outcome, cases };
  } catch {
    return empty("inconclusive");
  }
}
