import assert from "node:assert/strict";
import test from "node:test";
import {
  dotnetBuildEvidence,
  dotnetBuildPacketSchema,
} from "../src/dotnet-build-evidence.js";
import { createPlan } from "../src/engine.js";
import { native, run } from "./dotnet-build-controls.js";
import { dotnetBuildFixture } from "./dotnet-build-fixture.js";

test(
  "native .NET packet rejects omitted, forged, stale and disabled participation",
  native,
  async (t) => {
    const { root } = await dotnetBuildFixture(t),
      report = await run(root),
      result = report.checks[0]!,
      check = (await createPlan(root)).plan.checks[0]!,
      original = result.processes[0]!;
    assert.equal(result.status, "passed", JSON.stringify(result));
    const baseline = dotnetBuildPacketSchema.parse(JSON.parse(original.stdout));
    const controls: Array<[string, (data: typeof baseline) => void]> = [];
    const add = (name: string, change: (data: typeof baseline) => void) =>
      controls.push([name, change]);
    add("stale source", (d) => {
      d.inputSha256 = "0".repeat(64);
    });
    add("same parsed manifest with unpinned raw bytes", (d) => {
      d.repositoryManifest += "\n";
    });
    add("foreign launcher", (d) => {
      d.launcherPid++;
    });
    add("missing native close", (d) => {
      d.events.pop();
    });
    add("no native finished", (d) => {
      d.events = d.events.filter((e) => e.type !== "finished");
    });
    add("duplicate native init", (d) => {
      d.events.splice(1, 0, structuredClone(d.events[0]!));
    });
    add("compiler missing", (d) => {
      d.events = d.events.filter((e) => e.type !== "compilerStarted");
    });
    add("compiler terminal missing", (d) => {
      d.events = d.events.filter((e) => e.type !== "compilerFinished");
    });
    add("compiler terminal duplicated", (d) => {
      d.events.push(
        structuredClone(d.events.find((e) => e.type === "compilerFinished")!),
      );
    });
    add("foreign task assembly", (d) => {
      d.events.find((e) => e.type === "compilerStarted")!.assembly =
        "/original/custom/task.dll";
    });
    add("omitted project", (d) => {
      d.modules.pop();
    });
    add("duplicate module", (d) => {
      d.modules.push(structuredClone(d.modules[0]!));
    });
    add("foreign native project", (d) => {
      d.events.find((e) => e.type === "projectStarted")!.file =
        "/original/hidden.csproj";
    });
    add("native evaluation missing", (d) => {
      d.events = d.events.filter((e) => e.type !== "evaluation");
    });
    add("framework mismatch", (d) => {
      (
        d.events.find(
          (e) =>
            e.type === "evaluation" && String(e.file).endsWith("CSharp.csproj"),
        )!.properties as Record<string, string>
      ).TargetFramework = "net9.0";
    });
    add("analysis disabled", (d) => {
      (
        d.events.find(
          (e) =>
            e.type === "evaluation" && String(e.file).endsWith("CSharp.csproj"),
        )!.properties as Record<string, string>
      ).EnableNETAnalyzers = "false";
    });
    add("Roslyn command replaced", (d) => {
      d.events.find((e) => e.type === "compilerCommand")!.line =
        "/original/compiler --version";
    });
    add("F# compiler host replaced", (d) => {
      d.events.find(
        (e) => e.type === "parameter" && e.name === "DotnetFscCompilerPath",
      )!.values = ['"/original/fsc.dll"'];
    });
    add("unobserved source", (d) => {
      d.compiledSources.pop();
    });
    add("changed source bytes", (d) => {
      const source = d.compiledSources.find((p) =>
        p.file.endsWith("CSharp/Counter.cs"),
      )!;
      source.sha256 = "0".repeat(64);
      for (const module of d.modules)
        for (const document of module.metadata?.documents ?? [])
          if (
            document.file === source.file &&
            document.algorithm === "8829d00f-11b8-4213-878b-770e8597ac16"
          )
            document.hash = source.sha256;
    });
    add("foreign symbol document", (d) => {
      d.modules[0]!.metadata!.documents[0]!.file = "/original/uncompiled.cs";
    });
    add("wrong symbol checksum", (d) => {
      d.modules[0]!.metadata!.documents[0]!.hash = "0".repeat(64);
    });
    add("unbound test class", (d) => {
      d.modules.find((m) =>
        m.file.endsWith("CSharpTests.csproj"),
      )!.metadata!.types = [];
    });
    add("compiler source omission", (d) => {
      (
        d.events.find((e) => e.type === "parameter" && e.name === "Sources")!
          .values as string[]
      ).shift();
    });
    add("compiler source duplicates", (d) => {
      const sources = d.events.find(
        (e) => e.type === "parameter" && e.name === "Sources",
      )!.values as string[];
      sources.push(sources[0]!);
    });
    add("compiler parameter duplicates", (d) => {
      d.events.push(
        structuredClone(
          d.events.find((e) => e.type === "parameter" && e.name === "Sources")!,
        ),
      );
    });
    add("compiler skipped", (d) => {
      const event = structuredClone(
        d.events.find((e) => e.type === "parameter" && e.name === "Sources")!,
      );
      event.name = "SkipCompilerExecution";
      event.values = ["True"];
      d.events.push(event);
    });
    add("native ledger omitted", (d) => {
      d.nativeReceipts = d.nativeReceipts.filter((r) => r.phase !== "build");
    });
    add("contradictory build ledger", (d) => {
      d.nativeReceipts.find((r) => r.phase === "build")!.exitCode = 1;
    });
    add("error despite exit zero", (d) => {
      d.events.splice(-1, 0, {
        type: "diagnostic",
        severity: "error",
        code: "CS1000",
        message: "original control",
      });
    });
    for (const [name, change] of controls) {
      const data = structuredClone(baseline);
      change(data);
      assert.equal(
        dotnetBuildEvidence(check, [
          { ...original, stdout: JSON.stringify(data) },
        ]).status,
        "inconclusive",
        name,
      );
    }
    assert.equal(
      dotnetBuildEvidence(check, [original]).status,
      "passed",
      "unaltered native packet remains valid",
    );
  },
);
