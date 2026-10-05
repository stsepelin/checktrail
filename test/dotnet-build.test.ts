import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createPlan, validate } from "../src/engine.js";
import {
  dotnetBuildEvidence,
  dotnetBuildPacketSchema,
} from "../src/dotnet-build-evidence.js";
import { dotnetBuildProtectedEnvironment } from "../src/dotnet-build.js";
import { dotnetBuildFixture } from "./dotnet-build-fixture.js";
import { fixture } from "./helpers.js";
const available =
  !!process.env.CHECKTRAIL_DOTNET_BUILD_CACHE &&
  spawnSync("dotnet", ["--list-sdks"], { encoding: "utf8" }).stdout?.includes(
    "10.0.401 [",
  );
const native = {
  skip: available
    ? false
    : "Pinned native .NET SDK/dependency cache not selected",
};
const run = (root: string) =>
  validate(root, {
    trusted: true,
    timeoutMs: 120000,
  });
test(".NET build is opt-in and incomplete prerequisites cannot execute", async (t) => {
  const root = await fixture(t, {
    "Original.slnx": "<Solution/>\n",
    "Counter.cs": "public class Counter {}\n",
  });
  const initial = await createPlan(root);
  assert.equal(
    initial.plan.checks.some((c) => c.id === "dotnet.build"),
    false,
  );
  await writeFile(
    path.join(root, "checktrail.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["dotnet.build"] }],
    }),
  );
  const planned = await createPlan(root),
    check = planned.plan.checks[0]!;
  assert.equal(check.id, "dotnet.build");
  assert.equal(check.commands.length, 0);
  assert.match(check.unavailableReason!, /inventoried checktrail.dotnet-build/);
  const result = await run(root);
  assert.equal(result.checks[0]!.status, "unavailable");
  assert.equal(result.checks[0]!.processes.length, 0);
});
test(
  "native .NET builds C#/F#/VB in fresh outputs and rejects source errors in each language",
  native,
  async (t) => {
    const { root } = await dotnetBuildFixture(t);
    const passed = await run(root);
    assert.equal(
      passed.checks[0]!.status,
      "passed",
      JSON.stringify(passed.checks[0]),
    );
    assert.equal(passed.checks[0]!.findingsComplete, true);
    for (const [file, broken] of [
      [
        "CSharp/Counter.cs",
        "namespace Example; public static class Counter { public static int Next(int value) => missing; }",
      ],
      [
        "FSharp/Counter.fs",
        "namespace Example\nmodule Counter =\n    let next value = missing\n",
      ],
      [
        "VisualBasic/Counter.vb",
        "Namespace Example\n Public Module Counter\n Public Function NextValue(value As Integer) As Integer\n Return missing\n End Function\n End Module\nEnd Namespace\n",
      ],
    ]) {
      const target = path.join(root, file!),
        original = await readFile(target);
      try {
        await writeFile(target, broken!);
        const failed = await run(root);
        assert.equal(
          failed.checks[0]!.status,
          "failed",
          file + JSON.stringify(failed.checks[0]),
        );
        assert.equal(failed.checks[0]!.findingsComplete, false);
        assert.match(failed.checks[0]!.reason, /source (?:errors|compilation)/);
        assert.ok(
          failed.checks[0]!.findings?.some(
            (finding) =>
              finding.level === "error" &&
              finding.file === file &&
              finding.line! > 0,
          ),
          "Native source finding points to the compiled file",
        );
      } finally {
        await writeFile(target, original);
      }
    }
    assert.equal((await run(root)).checks[0]!.status, "passed");
    for (const directory of [
      "CSharp",
      "CSharpTests",
      "FSharp",
      "FSharpTests",
      "VisualBasic",
      "VisualBasicTests",
    ])
      assert.deepEqual(
        (await readdir(path.join(root, directory))).filter((name) =>
          ["obj", "bin"].includes(name),
        ),
        [],
      );
  },
);
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
test(
  ".NET planning rejects incomplete source, project, role and dependency identities",
  native,
  async (t) => {
    const { root, config } = await dotnetBuildFixture(t),
      target = path.join(root, "checktrail.dotnet-build.json");
    const controls: Array<[string, (data: typeof config) => void]> = [
      [
        "source omitted",
        (d) => {
          d.projects[0]!.sources = [];
        },
      ],
      [
        "project omitted",
        (d) => {
          d.projects.pop();
        },
      ],
      [
        "duplicate project",
        (d) => {
          d.projects.push(structuredClone(d.projects[0]!));
        },
      ],
      [
        "unbound test class",
        (d) => {
          d.projects[1]!.testClasses[0]!.file = "CSharp/Counter.cs";
        },
      ],
      [
        "source assigned twice",
        (d) => {
          d.projects[0]!.sources.push(d.projects[1]!.sources[0]!);
        },
      ],
      [
        "generated outside fresh obj",
        (d) => {
          d.projects[0]!.generatedSources = ["original/Generated.cs"];
        },
      ],
      [
        "wrong manifest",
        (d) => {
          d.repositorySha256 = "0".repeat(64);
        },
      ],
    ];
    for (const [name, change] of controls) {
      const data = structuredClone(config);
      change(data);
      await writeFile(target, JSON.stringify(data));
      const check = (await createPlan(root)).plan.checks[0]!;
      assert.equal(check.commands.length, 0, name);
      assert.ok(check.unavailableReason, name);
    }
    await writeFile(target, JSON.stringify(config));
    assert.equal((await createPlan(root)).plan.checks[0]!.commands.length, 1);
    await writeFile(path.join(root, "Hidden.csproj"), "<Project/>");
    assert.equal((await createPlan(root)).plan.checks[0]!.commands.length, 0);
  },
);
test(
  ".NET protected environment cannot be overridden by project requirements",
  native,
  async (t) => {
    const { root } = await dotnetBuildFixture(t);
    for (const name of dotnetBuildProtectedEnvironment) {
      await writeFile(
        path.join(root, "checktrail.json"),
        JSON.stringify({
          schemaVersion: 1,
          projects: [
            { path: ".", checks: ["dotnet.build"], environment: [name] },
          ],
        }),
      );
      await assert.rejects(
        createPlan(root, { environment: { [name]: "original-value" } }),
        /^[A-Z_][A-Z0-9_]*$/.test(name)
          ? /conflicts with protected adapter settings/
          : /invalid/i,
        name,
      );
    }
  },
);
test(
  "native .NET disabled compiler, omitted source and prebuild failures cannot pass",
  native,
  async (t) => {
    const { root } = await dotnetBuildFixture(t),
      file = path.join(root, "CSharp/CSharp.csproj"),
      source = await readFile(file, "utf8");
    for (const [name, xml] of [
      [
        "disabled compilation",
        "<PropertyGroup><SkipCompilerExecution>true</SkipCompilerExecution></PropertyGroup>",
      ],
      [
        "omitted source",
        '<ItemGroup><Compile Remove="Counter.cs" /></ItemGroup>',
      ],
      [
        "bootstrap failure",
        '<Target Name="OriginalFailure" BeforeTargets="CoreCompile"><Error Text="original build setup control" /></Target>',
      ],
    ]) {
      try {
        await writeFile(file, source.replace("</Project>", xml + "</Project>"));
        const check = (await run(root)).checks[0]!;
        assert.notEqual(check.status, "passed", name);
        if (name !== "omitted source")
          assert.notEqual(
            check.status,
            "failed",
            name + " is not a source allegation",
          );
        assert.equal(check.findingsComplete, false);
      } finally {
        await writeFile(file, source);
      }
    }
  },
);
test(
  "native .NET preserves inventoried near misses and caller-owned output trees",
  native,
  async (t) => {
    const { root } = await dotnetBuildFixture(t);
    await writeFile(
      path.join(root, ".editorconfig"),
      "root = true\n[*.{cs,vb}]\nindent_style = space\nindent_size = 4\n",
    );
    await mkdir(path.join(root, "CSharp/bin"));
    await writeFile(
      path.join(root, "CSharp/bin/original.txt"),
      "caller-owned output\n",
    );
    const check = (await run(root)).checks[0]!;
    assert.equal(check.status, "passed", JSON.stringify(check));
    assert.equal(
      await readFile(path.join(root, "CSharp/bin/original.txt"), "utf8"),
      "caller-owned output\n",
    );
  },
);

test(
  "native .NET records declared generated inputs and rejects their undeclared presence",
  native,
  async (t) => {
    const { root, config } = await dotnetBuildFixture(t),
      project = path.join(root, "CSharp/CSharp.csproj"),
      xml = await readFile(project, "utf8");
    const generated = "CSharp/obj/Debug/net10.0/Original.Generated.cs";
    await writeFile(
      project,
      xml.replace(
        "</Project>",
        '<Target Name="OriginalGenerate" BeforeTargets="CoreCompile"><WriteLinesToFile File="$(IntermediateOutputPath)Original.Generated.cs" Lines="namespace Example { public class GeneratedMarker { } }" Overwrite="true" /><ItemGroup><Compile Include="$(IntermediateOutputPath)Original.Generated.cs" /></ItemGroup></Target></Project>',
      ),
    );
    config.projects[0]!.generatedSources = [generated];
    await writeFile(
      path.join(root, "checktrail.dotnet-build.json"),
      JSON.stringify(config),
    );
    const valid = (await run(root)).checks[0]!;
    assert.equal(
      valid.status,
      "passed",
      JSON.stringify({ status: valid.status, reason: valid.reason }),
    );
    config.projects[0]!.generatedSources = [];
    await writeFile(
      path.join(root, "checktrail.dotnet-build.json"),
      JSON.stringify(config),
    );
    const unknown = (await run(root)).checks[0]!;
    assert.equal(unknown.status, "inconclusive");
    assert.equal(unknown.findingsComplete, false);
    await assert.rejects(access(path.join(root, generated)));
  },
);
test(
  "native .NET classifies an enabled SDK analyzer's source error and preserves its repair",
  native,
  async (t) => {
    const { root } = await dotnetBuildFixture(t),
      source = path.join(root, "CSharp/OriginalCandidate.cs"),
      configuration = path.join(root, "checktrail.dotnet-build.json"),
      config = JSON.parse(await readFile(configuration, "utf8"));
    config.projects[0].sources.push("CSharp/OriginalCandidate.cs");
    await writeFile(configuration, JSON.stringify(config));
    await writeFile(
      path.join(root, ".editorconfig"),
      "root = true\n[*.cs]\ndotnet_diagnostic.CA1822.severity = error\n",
    );
    await writeFile(
      source,
      "namespace Example; public class OriginalCandidate { public int OriginalValue() => 1; }\n",
    );
    const failed = (await run(root)).checks[0]!;
    assert.equal(
      failed.status,
      "failed",
      JSON.stringify({ status: failed.status, reason: failed.reason }),
    );
    assert.equal(failed.findingsComplete, false);
    const packet = dotnetBuildPacketSchema.parse(
      JSON.parse(failed.processes[0]!.stdout),
    );
    assert.ok(
      packet.events.some(
        (e) =>
          e.type === "diagnostic" &&
          e.code === "CA1822" &&
          e.severity === "error" &&
          String(e.file).endsWith("OriginalCandidate.cs"),
      ),
      "Selected native analyzer emitted the intended source error",
    );
    await writeFile(
      source,
      "namespace Example; public class OriginalCandidate { public static int OriginalValue() => 1; }\n",
    );
    assert.equal((await run(root)).checks[0]!.status, "passed");
    await writeFile(
      path.join(root, ".editorconfig"),
      "root = true\n[*.cs]\ndotnet_diagnostic.CA1822.severity = warning\n",
    );
    await writeFile(
      source,
      "namespace Example; public class OriginalCandidate { public int OriginalValue() => 1; }\n",
    );
    const warning = (await run(root)).checks[0]!;
    assert.equal(warning.status, "passed");
    assert.equal(warning.findingsComplete, true);
    assert.ok(
      warning.findings?.some(
        (finding) =>
          finding.ruleId === "dotnet-build/CA1822" &&
          finding.file === "CSharp/OriginalCandidate.cs" &&
          finding.level === "warning",
      ),
      "Native enabled warning retains its exact source address",
    );
  },
);
test(
  "native .NET rejects unavailable locked restore and corrupt dependency bytes before a source allegation",
  native,
  async (t) => {
    const { root } = await dotnetBuildFixture(t),
      lockFile = path.join(root, "CSharpTests/packages.lock.json"),
      lock = await readFile(lockFile, "utf8");
    await writeFile(lockFile, lock.replace(/4\.6\.1/g, "0.0.0"));
    const unavailable = (await run(root)).checks[0]!;
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.findingsComplete, false);
    assert.match(unavailable.reason, /locked offline/);
    await writeFile(lockFile, lock);
    const cache = path.join(
      root,
      ".checktrail/dependencies/artifacts/nunit/4.6.1/lib/net8.0/nunit.framework.dll",
    );
    await writeFile(cache, "original corrupt artifact");
    const planned = (await createPlan(root)).plan.checks[0]!;
    assert.equal(planned.commands.length, 0);
    assert.match(planned.unavailableReason!, /bounded regular .NET dependency/);
  },
);
