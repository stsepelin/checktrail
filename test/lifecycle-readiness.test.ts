import assert from "node:assert/strict";
import { test } from "node:test";
import {
  lifecycleExecute,
  lifecycleProject,
} from "./lifecycle-platforms-fixture.js";
import type { ProcessIdentity } from "../src/process-tree.js";
import { access, rm } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./helpers.js";
import { spawnSync } from "node:child_process";

test("lifecycle readiness preserves early terminal evidence without replacing a pending-run observation error", async () => {
  for (const early of [true, false]) {
    const original = Error("Original synthetic readiness refusal");
    const terminal = {
      outcome: "incomplete",
      errorCode: "OriginalFixtureProcessUnavailable",
    };
    const cleanups: ProcessIdentity[][] = [];
    const project = {
      root: "synthetic-root",
      control: "synthetic-control",
      marker: "synthetic-marker",
      release: "synthetic-release",
      file: "synthetic.test.js",
      observe: async () => {
        await Promise.resolve();
        throw original;
      },
      identities: async () => {
        throw Error("Unreached body has no identities");
      },
      continue: async () => {
        throw Error("Unreached body must not continue");
      },
      cleanup: async (rows: ProcessIdentity[]) => {
        cleanups.push(rows);
      },
    } satisfies Awaited<ReturnType<typeof lifecycleProject>>;
    await assert.rejects(
      lifecycleExecute(project, (signal) =>
        early
          ? Promise.resolve(terminal)
          : new Promise<typeof terminal>((resolve) => {
              signal.addEventListener("abort", () => resolve(terminal), {
                once: true,
              });
            }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        if (early) {
          assert.match(error.message, /execution ended before body readiness/);
          assert.match(error.message, /OriginalFixtureProcessUnavailable/);
          assert.equal(error.cause, original);
        } else assert.equal(error, original);
        return true;
      },
    );
    assert.deepEqual(
      cleanups,
      [[]],
      "Every refusal still closes only reached identities",
    );
  }
});

test("opt-in lifecycle diagnostics identify the failed operation and preserve original and cleanup causes without disclosing values", async () => {
  for (const early of [false, true]) {
    for (const cleanupFails of [false, true]) {
      const original = Error("synthetic-private-original-path"),
        cleanupFailure = Error("synthetic-private-cleanup-path"),
        terminal = {
          outcome: "incomplete",
          path: "synthetic-private-result-path",
        };
      const cleanups: ProcessIdentity[][] = [];
      const project = {
        root: "synthetic-root",
        control: "synthetic-control",
        marker: "synthetic-marker",
        release: "synthetic-release",
        file: "synthetic.test.js",
        observe: async () => {
          await Promise.resolve();
          throw original;
        },
        identities: async () => {
          throw Error("Unreached identities");
        },
        continue: async () => {
          throw Error("Unreached release");
        },
        cleanup: async (rows: ProcessIdentity[]) => {
          cleanups.push(rows);
          if (cleanupFails) throw cleanupFailure;
        },
      } satisfies Awaited<ReturnType<typeof lifecycleProject>>;
      await assert.rejects(
        lifecycleExecute(
          project,
          (signal) =>
            early
              ? Promise.resolve(terminal)
              : new Promise<typeof terminal>((resolve) => {
                  signal.addEventListener("abort", () => resolve(terminal), {
                    once: true,
                  });
                }),
          { operation: "privacy-cli-summary", enabled: true },
        ),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.cause, original);
          assert.deepEqual(
            error.errors,
            cleanupFails ? [original, cleanupFailure] : [original],
          );
          const context = JSON.parse(
            error.message.split("bounded diagnostic ")[1]!,
          );
          assert.equal(context.operation, "privacy-cli-summary");
          assert.equal(context.phase, "observe");
          assert.equal(context.settledBeforeAbort, early);
          assert.equal(context.settledAfterAbort, true);
          assert.equal(context.bodyObserved, false);
          assert.equal(context.cleanup, cleanupFails ? "failed" : "confirmed");
          assert.equal(context.reachedIdentities, 0);
          assert.equal(context.outcome, "incomplete");
          assert.equal(context.failureCount, cleanupFails ? 2 : 1);
          assert.ok(
            Number.isSafeInteger(context.elapsedMs) && context.elapsedMs >= 0,
          );
          assert.ok(Buffer.byteLength(error.message) < 1024);
          assert.equal(error.message.includes("synthetic-private"), false);
          return true;
        },
      );
      assert.deepEqual(cleanups, [[]]);
    }
  }
});

test("lifecycle readiness diagnostics retain bounded original terminal metadata and artifact presence before cleanup", async (t) => {
  const secret = "synthetic-private-readiness-value";
  const { lifecycleFailureDiagnostic } = await import(
    new URL("../../scripts/lifecycle-runtime-evidence.mjs", import.meta.url)
      .href
  );
  const observerSource = `import{readFileSync}from'node:fs';import{runRequiredTests}from${JSON.stringify(new URL("../../scripts/required-test-evidence.mjs", import.meta.url).href)};const requirements=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify(await runRequiredTests(requirements,{timeoutMs:10000,isolatedCaseWorkers:1})));`;
  const observer = await fixture(t, { "observer.mjs": observerSource });
  const observe = (requirements: { file: string; name: string }[]) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const result = spawnSync(
      process.execPath,
      [path.join(observer, "observer.mjs")],
      {
        input: JSON.stringify(requirements),
        encoding: "utf8",
        env,
        timeout: 15000,
        maxBuffer: 65536,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, "");
    return JSON.parse(result.stdout);
  };
  // A concrete large-value transport fixture, not a universal message-size claim.
  const maximumMessage =
    "Lifecycle operation failed; bounded diagnostic " +
    JSON.stringify({
      schemaVersion: 1,
      operation: "privacy-cli-detailed",
      phase: "completion-observation",
      failureContext: {
        observation: "post-abort/pre-cleanup",
        readiness: {
          bodyMarker: "unavailable",
          childMarkers: ["unavailable", "unavailable"],
        },
        execution: {
          state: "returned",
          checkCount: 10000,
          checks: [
            {
              status: "inconclusive",
              processCount: 10000,
              processes: [
                {
                  exitCode: 4294967295,
                  signal: "SIGSEGV",
                  timedOut: false,
                  cancelled: false,
                  truncated: false,
                  errorCode: "PROCESS_TREE_CLEANUP_UNAVAILABLE",
                  durationMs: 600000,
                  stdoutBytes: 4194304,
                  stderrBytes: 4194304,
                },
              ],
            },
          ],
        },
      },
      elapsedMs: Number.MAX_SAFE_INTEGER,
      bodyObserved: false,
      settledBeforeAbort: false,
      settledAfterAbort: true,
      outcome: "incomplete",
      cleanup: "confirmed",
      reachedIdentities: 4,
      failureCount: 2,
    });
  assert.equal(Buffer.byteLength(maximumMessage), 795);
  assert.ok(Buffer.byteLength(maximumMessage) <= 1000);
  for (const shape of [
    "partial",
    "complete",
    "malformed",
    "rejected",
    "stream-boundary",
    "stream-overflow",
    "windows-exit",
    "maximum-exit",
    "fractional-exit",
    "overflow-exit",
    "absent-id",
    "malformed-id",
  ] as const) {
    const control = await fixture(t, {
      "child-0": secret,
      ...(shape === "complete"
        ? { "child-1": secret, "reached.json": secret }
        : {}),
    });
    const original = Error(secret),
      terminalFailure = Object.assign(Error(secret), { code: "ENOENT" });
    const child = {
      command: { executable: secret, args: [secret], cwd: secret },
      exitCode: null,
      signal: "SIGKILL",
      timedOut: false,
      cancelled: true,
      truncated: false,
      errorCode: "POSIX_OWNER_UNAVAILABLE",
      durationMs: 42,
      stdout: shape === "stream-boundary" ? "a".repeat(4 * 1048576) : secret,
      stderr: shape === "stream-boundary" ? "" : secret,
    };
    const measured =
      shape === "malformed"
        ? {
            ...child,
            exitCode: -1,
            signal: "SIGKILL" + secret,
            timedOut: secret,
            cancelled: 1,
            truncated: null,
            errorCode: "POSIX_OWNER_UNAVAILABLE" + secret,
            durationMs: Number.MAX_SAFE_INTEGER,
            stdout: 7,
            stderr: null,
          }
        : shape === "stream-overflow"
          ? {
              ...child,
              stdout: "é".repeat(2 * 1048576 + 1),
              stderr: "a".repeat(4 * 1048576 + 1),
            }
          : shape === "windows-exit"
            ? { ...child, exitCode: 3221225477 }
            : shape === "maximum-exit"
              ? { ...child, exitCode: 4294967295 }
              : shape === "fractional-exit"
                ? { ...child, exitCode: 1.5 }
                : shape === "overflow-exit"
                  ? { ...child, exitCode: 4294967296 }
                  : child;
    const terminal = {
      outcome: "incomplete",
      path: secret,
      checks: [
        {
          id:
            shape === "malformed"
              ? "javascript.node-test" + secret
              : shape === "absent-id"
                ? undefined
                : shape === "malformed-id"
                  ? 7
                  : "javascript.node-test",
          status: shape === "malformed" ? secret : "error",
          reason: secret,
          processes: [measured, child, child],
        },
        { id: secret, status: secret, processes: secret },
        { id: secret, status: secret, processes: [] },
      ],
    };
    let cleanups = 0,
      capturedMessage = "";
    const project = {
      root: control,
      control,
      marker: path.join(control, "reached.json"),
      release: path.join(control, "release"),
      file: "synthetic.test.js",
      observe: async () => {
        throw original;
      },
      identities: async () => {
        throw Error("Unreached identities");
      },
      continue: async () => {
        throw Error("Unreached release");
      },
      cleanup: async (rows: ProcessIdentity[]) => {
        assert.deepEqual(rows, []);
        cleanups++;
        await rm(control, { recursive: true, force: true });
      },
    } satisfies Awaited<ReturnType<typeof lifecycleProject>>;
    await assert.rejects(
      lifecycleExecute(
        project,
        (signal) =>
          new Promise<typeof terminal>((resolve, reject) => {
            signal.addEventListener(
              "abort",
              () =>
                shape === "rejected"
                  ? reject(terminalFailure)
                  : resolve(terminal),
              { once: true },
            );
          }),
        { operation: "privacy-engine", enabled: true },
      ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, original);
        assert.deepEqual(error.errors, [original]);
        assert.equal(cleanups, 1);
        const context = JSON.parse(
          error.message.split("bounded diagnostic ")[1]!,
        );
        assert.equal(context.settledBeforeAbort, false);
        assert.equal(context.settledAfterAbort, true);
        assert.equal(context.bodyObserved, false);
        assert.deepEqual(context.failureContext.readiness, {
          bodyMarker: shape === "complete" ? "present" : "absent",
          childMarkers: [
            "present",
            shape === "complete" ? "present" : "absent",
          ],
        });
        assert.equal(
          context.failureContext.observation,
          "post-abort/pre-cleanup",
        );
        const execution = context.failureContext.execution;
        if (shape === "rejected") {
          assert.equal(execution.state, "rejected");
          assert.deepEqual(execution.error, { name: "Error", code: "ENOENT" });
          assert.equal(execution.outcome, undefined);
          assert.equal(execution.checkCount, null);
          assert.deepEqual(execution.checks, []);
        } else {
          assert.equal(execution.state, "returned");
          assert.equal(execution.error, undefined);
          assert.equal(execution.outcome, undefined);
          assert.equal(execution.checkCount, 3);
          assert.equal(execution.checks.length, 1);
          assert.equal(
            execution.checks[0].role,
            ["malformed", "absent-id", "malformed-id"].includes(shape)
              ? "other"
              : undefined,
          );
          assert.equal(
            execution.checks[0].status,
            shape === "malformed" ? "other" : "error",
          );
          assert.equal(execution.checks[0].processCount, 3);
          assert.equal(execution.checks[0].processes.length, 1);
          assert.deepEqual(execution.checks[0].processes[0], {
            exitCode:
              shape === "windows-exit"
                ? 3221225477
                : shape === "maximum-exit"
                  ? 4294967295
                  : null,
            signal: shape === "malformed" ? "other" : "SIGKILL",
            timedOut: shape === "malformed" ? null : false,
            cancelled: shape === "malformed" ? null : true,
            truncated: shape === "malformed" ? null : false,
            errorCode:
              shape === "malformed" ? "other" : "POSIX_OWNER_UNAVAILABLE",
            durationMs: shape === "malformed" ? null : 42,
            stdoutBytes: ["malformed", "stream-overflow"].includes(shape)
              ? null
              : Buffer.byteLength(child.stdout),
            stderrBytes: ["malformed", "stream-overflow"].includes(shape)
              ? null
              : Buffer.byteLength(child.stderr),
          });
          if (shape === "stream-boundary") {
            assert.equal(
              execution.checks[0].processes[0].stdoutBytes,
              4 * 1048576,
            );
            assert.equal(execution.checks[0].processes[0].stderrBytes, 0);
          }
        }
        assert.ok(Buffer.byteLength(error.message) <= 1000);
        assert.equal(error.message.includes(secret), false);
        assert.equal(error.message.includes(control), false);
        capturedMessage = error.message;
        return true;
      },
    );
    assert.equal(cleanups, 1);
    await assert.rejects(access(control), { code: "ENOENT" });
    const messages = [
      {
        name: "lifecycle-platforms broken acceptance",
        message: capturedMessage,
      },
      ...(shape === "partial"
        ? [
            {
              name: "original maximum lifecycle diagnostic",
              message: maximumMessage,
            },
          ]
        : []),
    ];
    const body =
      "import{test}from'node:test';" +
      messages
        .map(
          ({ name, message }) =>
            `test(${JSON.stringify(name)},()=>{throw Object.assign(Error(${JSON.stringify(message)}),${JSON.stringify(name === "original maximum lifecycle diagnostic" ? { code: "PROCESS_TREE_CLEANUP_UNAVAILABLE" } : {})})});`,
        )
        .join("\n");
    const delivery = await fixture(t, { "original.test.mjs": body });
    for (const { name, message } of messages) {
      const evidence = observe([
        { file: path.join(delivery, "original.test.mjs"), name },
      ]);
      assert.equal(evidence.complete, false);
      assert.equal(evidence.passed, 0);
      assert.equal(evidence.required, 1);
      const failures = evidence.problems.filter(
        (item: { reason: string }) => item.reason === "failed",
      );
      assert.equal(failures.length, 1);
      assert.equal(failures[0].message, message, JSON.stringify(evidence));
      assert.equal(
        failures[0].causeCode,
        name === "original maximum lifecycle diagnostic"
          ? "PROCESS_TREE_CLEANUP_UNAVAILABLE"
          : undefined,
      );
      const delivered = lifecycleFailureDiagnostic({
        stdout: JSON.stringify({
          ...evidence,
          profile: "lifecycle-platforms-runtime-v1",
        }),
        stderr: secret,
      });
      assert.equal(
        JSON.parse(delivered).problems.find(
          (item: { name: string; reason: string }) =>
            item.name === name && item.reason === "failed",
        ).message,
        message,
      );
      assert.equal(delivered.includes(secret), false);
      // Match the package assertion stderr and the installed callback's assertion.
      const packageSource = `import assert from'node:assert/strict';assert.equal(1,0,${JSON.stringify(delivered)});`;
      const wrapperSource = `import{test}from'node:test';import assert from'node:assert/strict';import{spawnSync}from'node:child_process';test('lifecycle-platforms installed acceptance',()=>{const r=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(packageSource)}],{encoding:'utf8',timeout:5000,maxBuffer:65536});assert.equal(r.error,undefined);assert.equal(r.signal,null);assert.equal(r.status,0,r.stdout+r.stderr);});`;
      const wrapper = await fixture(t, { "installed.test.mjs": wrapperSource });
      const outer = observe([
        {
          file: path.join(wrapper, "installed.test.mjs"),
          name: "lifecycle-platforms installed acceptance",
        },
      ]);
      assert.equal(outer.complete, false);
      assert.equal(outer.passed, 0);
      assert.equal(outer.required, 1);
      const outerFailures = outer.problems.filter(
        (item: { reason: string }) => item.reason === "failed",
      );
      assert.equal(outerFailures.length, 1);
      const context = JSON.parse(message.split("bounded diagnostic ")[1]!);
      const prefix =
        "Lifecycle operation failed; bounded diagnostic " +
        JSON.stringify({
          schemaVersion: context.schemaVersion,
          operation: context.operation,
          phase: context.phase,
          failureContext: context.failureContext,
        }).slice(0, -1);
      assert.ok(outerFailures[0].message.length <= 1000);
      assert.ok(
        outerFailures[0].message.includes(JSON.stringify(prefix).slice(1, -1)),
        "The whole original failure context must survive both bounded collectors and installed assertions",
      );
      if (name === "original maximum lifecycle diagnostic") {
        const retainedPrefix = JSON.stringify(prefix).slice(1, -1);
        const end =
          outerFailures[0].message.indexOf(retainedPrefix) +
          retainedPrefix.length;
        t.diagnostic(
          JSON.stringify({
            kind: "lifecycle-diagnostic-delivery",
            fixtureMessageBytes: Buffer.byteLength(message),
            retainedPrefixCharacters: retainedPrefix.length,
            retainedContextEnd: end,
            collectorCharacters: outerFailures[0].message.length,
            retainedHeadroom: outerFailures[0].message.length - end,
          }),
        );
      }
    }
  }
});

test("engine lifecycle fixtures enable failure diagnostics by default and preserve explicit opt-out", () => {
  const source = `
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
const target=${JSON.stringify(new URL("./lifecycle-platforms-fixture.js", import.meta.url).href)};
registerHooks({resolve(specifier,context,next){
 if(context.parentURL===target&&specifier==='../src/engine.js')return{shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent('export const validate=async()=>({outcome:"incomplete",checks:[{id:"javascript.node-test",status:"error",processes:[]}]});')};
 if(context.parentURL===target&&specifier==='node:timers/promises')return{shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent('export const setTimeout=async()=>{throw Error("Original authored readiness refusal")};')};
 return next(specifier,context);
}});
const {validateLifecycleProject}=await import(target), cleanups=[];
try{
 for(const disabled of [false,true]){
  await assert.rejects(validateLifecycleProject({after:callback=>cleanups.push(callback)},{broken:true},disabled?{operation:'engine',enabled:false}:undefined),error=>{
   if(disabled){assert.equal(error instanceof AggregateError,false);assert.match(error.message,/execution ended before body readiness/);}
   else{assert.ok(error instanceof AggregateError);const context=JSON.parse(error.message.split('bounded diagnostic ')[1]);assert.equal(context.operation,'engine');assert.equal(context.settledBeforeAbort,true);assert.equal(context.failureContext.execution.state,'returned');assert.equal(context.failureContext.execution.checks[0].status,'error');assert.deepEqual(context.failureContext.readiness,{bodyMarker:'absent',childMarkers:['absent','absent']});}
   return true;
  });
 }
 assert.equal(cleanups.length,4);console.log(JSON.stringify({defaultDiagnostic:true,explicitOptOut:true,originalEngineCodeExecuted:false}));
}finally{for(const cleanup of cleanups.reverse())await cleanup();}
`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source],
    {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 65536,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    defaultDiagnostic: true,
    explicitOptOut: true,
    originalEngineCodeExecuted: false,
  });
});
