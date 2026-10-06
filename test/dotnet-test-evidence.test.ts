import assert from "node:assert/strict";
import test from "node:test";
import {
  dotnetTestEvidence,
  dotnetTestPacketSchema,
} from "../src/dotnet-test-evidence.js";
import { createPlan } from "../src/engine.js";
import { expect, native, run } from "./dotnet-test-controls.js";
import { dotnetTestFixture } from "./dotnet-test-fixture.js";

test(
  "native .NET test packets reject omitted forged stale and mismatched lifecycle artifact and TRX evidence",
  native,
  async (t) => {
    const { root } = await dotnetTestFixture(t),
      check = (await createPlan(root)).plan.checks[0]!,
      result = (await run(root)).checks[0]!;
    expect(result, "passed");
    const process = result.processes[0]!,
      baseline = dotnetTestPacketSchema.parse(JSON.parse(process.stdout));
    assert.equal(dotnetTestEvidence(check, [process]).status, "passed");
    const controls: Array<[string, (data: typeof baseline) => void]> = [];
    const add = (name: string, change: (data: typeof baseline) => void) =>
      controls.push([name, change]);
    add("missing project", (d) => {
      d.runs.pop();
    });
    add("duplicate project", (d) => {
      d.runs.push(structuredClone(d.runs[0]!));
    });
    add("stale source", (d) => {
      d.build.inputSha256 = "0".repeat(64);
    });
    add("stale dependency bytes", (d) => {
      d.build.repositoryManifest += "\n";
    });
    add("foreign helper source", (d) => {
      d.testObserverSourceSha256 = "0".repeat(64);
    });
    add("foreign helper runtime", (d) => {
      d.testObserverSha256 = "0".repeat(64);
    });
    add("foreign client PID", (d) => {
      d.runs[0]!.discoveryLauncherPid++;
    });
    add("foreign runtime", (d) => {
      d.runs[0]!.discoveryEvents[0]!.runtime = "9.0.0";
    });
    add("foreign ObjectModel", (d) => {
      d.runs[0]!.executionEvents[0]!.objectModel = "/original/foreign.dll";
    });
    add("fresh artifact digest disagrees", (d) => {
      d.runs[0]!.artifacts[0]!.sha256 = "0".repeat(64);
    });
    add("native test SDK input omitted", (d) => {
      d.build.observedArtifacts = d.build.observedArtifacts.filter(
        (p) => !p.file.endsWith("/vstest.console.dll"),
      );
    });
    add("native case omitted", (d) => {
      d.runs[0]!.discoveryEvents = d.runs[0]!.discoveryEvents.filter(
        (e) => e.type !== "discovered",
      );
    });
    add("duplicate native case", (d) => {
      d.runs[0]!.discoveryEvents.splice(
        2,
        0,
        structuredClone(
          d.runs[0]!.discoveryEvents.find((e) => e.type === "discovered")!,
        ),
      );
    });
    add("native result omitted", (d) => {
      d.runs[0]!.executionEvents = d.runs[0]!.executionEvents.filter(
        (e) => e.type !== "result",
      );
    });
    add("native result outside lifecycle", (d) => {
      const r = d.runs[0]!;
      const index = r.executionEvents.findIndex((e) => e.type === "result");
      const [item] = r.executionEvents.splice(index, 1);
      r.executionEvents.splice(1, 0, item!);
    });
    add("discovery incomplete", (d) => {
      d.runs[0]!.discoveryEvents.find(
        (e) => e.type === "discoveryFinished",
      )!.partial = [d.runs[0]!.assembly];
    });
    add("native discovery zero", (d) => {
      d.runs[0]!.discoveryEvents.find(
        (e) => e.type === "discoveryFinished",
      )!.total = 0;
    });
    add("native run canceled", (d) => {
      d.runs[0]!.executionEvents.find(
        (e) => e.type === "runFinished",
      )!.canceled = true;
    });
    add("native terminal count wrong", (d) => {
      d.runs[0]!.executionEvents.find(
        (e) => e.type === "runFinished",
      )!.executed = 0;
    });
    add("native statistics wrong", (d) => {
      d.runs[0]!.executionEvents.find((e) => e.type === "runFinished")!.stats =
        { Passed: 1 };
    });
    add("native start against foreign assembly", (d) => {
      d.runs[0]!.executionEvents.find((e) => e.type === "runStarted")!.sources =
        ["/original/foreign.dll"];
    });
    add("native class prefix near miss", (d) => {
      const e = d.runs[0]!.discoveryEvents.find(
        (e) => e.type === "discovered",
      )!;
      (e.test as { name: string }).name = "Example.CounterTestsExtra.Scale(-1)";
    });
    add("native method has no compiled symbol", (d) => {
      const run = d.runs[0]!;
      for (const event of [...run.discoveryEvents, ...run.executionEvents])
        if (
          event.test &&
          (event.test as { name: string }).name.endsWith(".Scale(-1)")
        )
          (event.test as { name: string }).name = (
            event.test as { name: string }
          ).name.replace(".Scale(-1)", ".Other(-1)");
      run.trx = run.trx.replace(
        /(<TestMethod\b[^>]* name=")Scale\(-1\)(")/,
        "$1Other(-1)$2",
      );
    });
    add("native PDB method source omitted", (d) => {
      const m = d.build.modules.find((m) => m.file === d.runs[0]!.file)!;
      m.metadata!.types.flatMap((t) => t.methods).forEach((m) => {
        m.files = [];
      });
    });
    add("native test infrastructure error", (d) => {
      d.runs[0]!.executionEvents.splice(2, 0, {
        type: "message",
        level: "Error",
        message: "Original native failure",
      });
    });
    add("native close missing", (d) => {
      d.runs[0]!.executionEvents.pop();
    });
    add("wrong native execution exit", (d) => {
      d.runs[0]!.executionExitCode = 1;
    });
    add("unreported native call", (d) => {
      d.nativeReceipts.pop();
    });
    add("extra native call", (d) => {
      d.nativeReceipts.push({
        ...structuredClone(d.nativeReceipts.at(-1)!),
        phase: "original-unreported-call",
      });
    });
    add("observer compile not clean", (d) => {
      d.nativeReceipts.find(
        (r) => r.phase === "test-observer-compile",
      )!.stdoutBytes = 1;
    });
    add("TRX result missing", (d) => {
      d.runs[0]!.trx = d.runs[0]!.trx.replace(
        /<UnitTestResult\b[^>]*\/>|<UnitTestResult\b[\s\S]*?<\/UnitTestResult>/,
        " ",
      );
    });
    add("TRX executed counter forged", (d) => {
      d.runs[0]!.trx = d.runs[0]!.trx.replace('executed="2"', 'executed="1"');
    });
    add("TRX outcome forged", (d) => {
      d.runs[0]!.trx = d.runs[0]!.trx.replace(
        'outcome="Completed"',
        'outcome="Failed"',
      );
    });
    add("TRX result duration forged", (d) => {
      d.runs[0]!.trx = d.runs[0]!.trx.replace(
        /duration="[^"]+"/,
        'duration="00:00:01.0000000"',
      );
    });
    add("TRX result source forged", (d) => {
      d.runs[0]!.trx = d.runs[0]!.trx.replace(
        /codeBase="[^"]+"/,
        'codeBase="/original/foreign.dll"',
      );
    });
    add("TRX entity declaration", (d) => {
      d.runs[0]!.trx =
        '<!DOCTYPE TestRun [<!ENTITY original "foreign">]>' + d.runs[0]!.trx;
    });
    add("TRX truncated", (d) => {
      d.runs[0]!.trx = d.runs[0]!.trx.slice(0, -30);
    });
    for (const [name, change] of controls) {
      const packet = structuredClone(baseline);
      change(packet);
      assert.ok(
        JSON.stringify(packet) !== JSON.stringify(baseline),
        "Control changes actual native evidence: " + name,
      );
      const parsed = dotnetTestEvidence(check, [
        { ...process, stdout: JSON.stringify(packet) },
      ]);
      assert.equal(parsed.status, "inconclusive", name);
      assert.equal(parsed.findingsComplete, false, name);
    }
  },
);
