import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createPlan, validate } from "../src/engine.js";
import {
  dotnetFormatEvidence,
  dotnetFormatPacketSchema,
  dotnetFormatDocumentsSchema,
} from "../src/dotnet-format-evidence.js";
import { mavenHash } from "../src/maven.js";
import { dotnetBuildFixture } from "./dotnet-build-fixture.js";
import {
  dotnetFormatFixture,
  replaceDotnetFormatSource,
} from "./dotnet-format-fixture.js";
import { fixture } from "./helpers.js";
import type { CheckResult } from "../src/types.js";
const available =
  !!process.env.CHECKTRAIL_DOTNET_BUILD_CACHE &&
  spawnSync("dotnet", ["--list-sdks"], { encoding: "utf8" }).stdout?.includes(
    "10.0.401 [",
  );
const native = {
  skip: available
    ? false
    : "Pinned native .NET SDK/dependency cache not selected",
  timeout: 240000,
};
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
const expect = (r: CheckResult, status: string) =>
  assert.equal(
    r.status,
    status,
    JSON.stringify({
      status: r.status,
      reason: r.reason,
      stderr: r.processes.map((p) => p.stderr.slice(0, 512)),
    }),
  );
test(".NET whitespace formatting is opt-in and missing declarations cannot execute during planning", async (t) => {
  const root = await fixture(t, {
    "Original.slnx": "<Solution/>\n",
    "Counter.cs": "public class Counter {}\n",
  });
  assert.equal(
    (await createPlan(root)).plan.checks.some(
      (c) => c.id === "dotnet.format-whitespace",
    ),
    false,
  );
  await writeFile(
    path.join(root, "checktrail.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["dotnet.format-whitespace"] }],
    }),
  );
  const check = (await createPlan(root)).plan.checks[0]!;
  assert.equal(check.parser, "dotnet-format-json");
  assert.equal(check.commands.length, 0);
  const result = (await run(root)).checks[0]!;
  expect(result, "unavailable");
  assert.equal(result.processes.length, 0);
});
test(
  "native .NET whitespace planning keeps F# unsupported instead of accepting the SDK empty report",
  native,
  async (t) => {
    const { root } = await dotnetBuildFixture(t);
    await writeFile(
      path.join(root, "checktrail.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: ".", checks: ["dotnet.format-whitespace"] }],
      }),
    );
    const check = (await createPlan(root)).plan.checks[0]!;
    assert.equal(check.commands.length, 0);
    assert.match(check.unavailableReason!, /F#/);
    const result = (await run(root)).checks[0]!;
    expect(result, "unavailable");
    assert.equal(result.processes.length, 0);
    assert.ok(result.scope.some((f) => f.endsWith(".fs")));
  },
);
test(
  "native .NET whitespace reconciles C#/VB documents broken edits UTF-8 BOM and repaired valid near misses",
  native,
  async (t) => {
    const { root } = await dotnetFormatFixture(t),
      initial = (await run(root)).checks[0]!;
    expect(initial, "passed");
    assert.equal(initial.findingsComplete, true);
    const packet = dotnetFormatPacketSchema.parse(
        JSON.parse(initial.processes[0]!.stdout),
      ),
      observed = dotnetFormatDocumentsSchema.parse(
        JSON.parse(packet.format!.documents),
      );
    assert.equal(observed.projects.length, 4);
    assert.equal(observed.projects.flatMap((p) => p.documents).length, 14);
    assert.equal(
      observed.projects.flatMap((p) => p.documents).filter((d) => d.selected)
        .length,
      4,
    );
    assert.equal(
      observed.projects.flatMap((p) => p.documents).filter((d) => !d.selected)
        .length,
      10,
    );
    const originals = new Map<string, string>();
    for (const [file, old, value] of [
      ["CSharp/Counter.cs", "int value", "int  value"],
      ["VisualBasic/Counter.vb", "value As Integer", "value  As Integer"],
    ])
      originals.set(
        file!,
        await replaceDotnetFormatSource(root, file!, old!, value!),
      );
    try {
      const broken = (await run(root)).checks[0]!;
      expect(broken, "failed");
      assert.equal(broken.findingsComplete, true);
      const check = (await createPlan(root)).plan.checks[0]!,
        process = broken.processes[0]!,
        partialPacket = dotnetFormatPacketSchema.parse(
          JSON.parse(process.stdout),
        );
      partialPacket.format!.report = "[";
      const partial = dotnetFormatEvidence(check, [
        { ...process, stdout: JSON.stringify(partialPacket) },
      ]);
      assert.equal(
        partial.status,
        "failed",
        "An incomplete SDK report cannot erase validated native source edits",
      );
      assert.equal(partial.findingsComplete, false);
      assert.deepEqual(partial.findings?.map((f) => f.file).sort(), [
        "CSharp/Counter.cs",
        "VisualBasic/Counter.vb",
      ]);
      assert.deepEqual(
        broken.findings
          ?.filter((f) => f.ruleId === "dotnet-format/WHITESPACE")
          .map((f) => [f.file, f.line])
          .sort(),
        [
          ["CSharp/Counter.cs", 5],
          ["VisualBasic/Counter.vb", 3],
        ],
      );
    } finally {
      for (const [file, source] of originals)
        await writeFile(path.join(root, file), source);
    }
    const file = path.join(root, "CSharp/Counter.cs"),
      source = await readFile(file, "utf8");
    assert.equal(
      source.split("public static int Next(int value) => value + 1;").length,
      2,
    );
    await writeFile(
      file,
      Buffer.concat([
        Buffer.from([239, 187, 191]),
        Buffer.from(
          source.replace(
            "public static int Next(int value) => value + 1;",
            '// Original whitespace remains comment data.\n    public const string Label = "😀 int  value";\n    public static int Next(int value) => value + 1;',
          ),
        ),
      ]),
    );
    const fixed = (await run(root)).checks[0]!;
    expect(fixed, "passed");
    assert.equal(fixed.findingsComplete, true);
    assert.equal(
      fixed.findings?.filter((f) => f.ruleId === "dotnet-format/WHITESPACE")
        .length,
      0,
    );
  },
);
test(
  "native .NET whitespace rejects omitted forged stale filtered malformed and unreconciled native evidence",
  native,
  async (t) => {
    const { root } = await dotnetFormatFixture(t),
      check = (await createPlan(root)).plan.checks[0]!,
      result = (await run(root)).checks[0]!;
    expect(result, "passed");
    const process = result.processes[0]!,
      baseline = dotnetFormatPacketSchema.parse(JSON.parse(process.stdout));
    type Packet = typeof baseline;
    const controls: Array<[string, (d: Packet) => void]> = [];
    const add = (name: string, change: (d: Packet) => void) =>
      controls.push([name, change]);
    const docs = (
      d: Packet,
      change: (v: ReturnType<typeof dotnetFormatDocumentsSchema.parse>) => void,
    ) => {
      const v = dotnetFormatDocumentsSchema.parse(
        JSON.parse(d.format!.documents),
      );
      change(v);
      d.format!.documents = JSON.stringify(v);
      const r = d.nativeReceipts.at(-2)!;
      r.stdoutBytes = Buffer.byteLength(d.format!.documents);
      r.stdoutSha256 = mavenHash(d.format!.documents);
    };
    add("missing formatter", (d) => {
      d.format = null;
    });
    add("stale source", (d) => {
      d.build.inputSha256 = "0".repeat(64);
    });
    add("stale dependencies", (d) => {
      d.build.repositoryManifest += "\n";
    });
    add("foreign helper source", (d) => {
      d.format!.observerSourceSha256 = "0".repeat(64);
    });
    add("foreign helper", (d) => {
      d.format!.observerSha256 = "0".repeat(64);
    });
    add("foreign PID", (d) => {
      d.format!.documentLauncherPid++;
    });
    add("foreign workspace runtime", (d) => {
      d.format!.documents = d.format!.documents.replace(
        '"runtime":"10.0.12"',
        '"runtime":"9.0.0"',
      );
    });
    add("foreign observer directory", (d) => {
      d.format!.observerDirectory = "/foreign/format";
      docs(d, (v) => {
        v.workspaceAssembly =
          "/foreign/format/Microsoft.CodeAnalysis.Workspaces.MSBuild.dll";
        v.formatterAssembly =
          "/foreign/format/Microsoft.CodeAnalysis.Workspaces.dll";
      });
    });
    add("native load failure", (d) =>
      docs(d, (v) => {
        v.failures.push("Failure: original rejected project");
      }),
    );
    add("missing project", (d) =>
      docs(d, (v) => {
        v.projects.pop();
      }),
    );
    add("duplicate project", (d) =>
      docs(d, (v) => {
        v.projects.push(structuredClone(v.projects[0]!));
      }),
    );
    add("wrong language", (d) =>
      docs(d, (v) => {
        v.projects[0]!.language = "Visual Basic";
      }),
    );
    add("omitted document", (d) =>
      docs(d, (v) => {
        v.projects[0]!.documents.pop();
      }),
    );
    add("duplicate document", (d) =>
      docs(d, (v) => {
        v.projects[0]!.documents.push(
          structuredClone(v.projects[0]!.documents[0]!),
        );
      }),
    );
    add("foreign source bytes", (d) =>
      docs(d, (v) => {
        v.projects[0]!.documents[0]!.sourceSha256 = "0".repeat(64);
      }),
    );
    add("foreign source text", (d) =>
      docs(d, (v) => {
        v.projects[0]!.documents[0]!.text = "public class Foreign {}";
      }),
    );
    add("empty selected scope", (d) =>
      docs(d, (v) => {
        for (const p of v.projects)
          for (const doc of p.documents) {
            doc.selected = false;
            doc.text = null;
          }
      }),
    );
    add("hidden native changes", (d) =>
      docs(d, (v) => {
        v.projects[0]!.documents[0]!.changed = true;
      }),
    );
    add("unbounded options", (d) =>
      docs(d, (v) => {
        v.projects[0]!.documents[0]!.formatting.tabSize = 0;
      }),
    );
    add("missing call", (d) => {
      d.nativeReceipts.pop();
    });
    add("reordered calls", (d) => {
      const a = d.nativeReceipts.at(-1)!,
        b = d.nativeReceipts.at(-2)!;
      d.nativeReceipts.splice(-2, 2, a, b);
    });
    add("unbound native output", (d) => {
      d.nativeReceipts.at(-2)!.stdoutSha256 = "0".repeat(64);
    });
    add("native failure", (d) => {
      d.format!.formatterExitCode = 1;
      d.nativeReceipts.at(-1)!.exitCode = 1;
    });
    add("missing observed SDK dependency", (d) => {
      d.build.observedArtifacts = d.build.observedArtifacts.filter(
        (p) => !p.file.endsWith("/dotnet-format.dll"),
      );
    });
    add("unaccounted formatter diagnostic", (d) => {
      d.format!.formatterStderr = "Unexpected native loading failure\n";
      const r = d.nativeReceipts.at(-1)!;
      r.stderrBytes = Buffer.byteLength(d.format!.formatterStderr);
      r.stderrSha256 = mavenHash(d.format!.formatterStderr);
    });
    add("malformed report", (d) => {
      d.format!.report = "[";
    });
    add("phantom report", (d) => {
      d.format!.report = JSON.stringify([{ FilePath: "/foreign.cs" }]);
    });
    for (const [name, change] of controls) {
      const packet = structuredClone(baseline);
      change(packet);
      const parsed = dotnetFormatEvidence(check, [
        { ...process, stdout: JSON.stringify(packet) },
      ]);
      assert.equal(parsed.status, "inconclusive", name);
      assert.equal(parsed.findingsComplete, false, name);
    }
    assert.equal(dotnetFormatEvidence(check, [process]).status, "passed");
    assert.equal(dotnetFormatEvidence(check, []).status, "inconclusive");
  },
);
test(
  "native .NET whitespace observes effective per-file policy and cannot pass a filtered compiled source",
  native,
  async (t) => {
    const { root } = await dotnetFormatFixture(t),
      editor = path.join(root, ".editorconfig"),
      original = await readFile(editor, "utf8"),
      file = path.join(root, "CSharp/Counter.cs"),
      source = await readFile(file, "utf8");
    await writeFile(
      editor,
      original + "\n[CSharp/Counter.cs]\nindent_size = 2\ntab_width = 2\n",
    );
    await writeFile(
      file,
      source
        .split("\n")
        .map((line) => line.replace(/^( +)/, (s) => " ".repeat(s.length / 2)))
        .join("\n"),
    );
    const passed = (await run(root)).checks[0]!;
    expect(passed, "passed");
    const data = dotnetFormatPacketSchema.parse(
        JSON.parse(passed.processes[0]!.stdout),
      ),
      docs = dotnetFormatDocumentsSchema.parse(
        JSON.parse(data.format!.documents),
      ),
      doc = docs.projects
        .flatMap((p) => p.documents)
        .find((d) => d.selected && d.file.endsWith("/CSharp/Counter.cs"))!;
    assert.deepEqual(doc.formatting, {
      tabSize: 2,
      indentationSize: 2,
      useTabs: false,
      newLine: "\n",
    });
    await writeFile(file, source);
    const failed = (await run(root)).checks[0]!;
    expect(failed, "failed");
    assert.ok(
      failed.findings?.some(
        (f) =>
          f.ruleId === "dotnet-format/WHITESPACE" &&
          f.file === "CSharp/Counter.cs",
      ),
    );
    await writeFile(editor, original);
    const project = path.join(root, "CSharp/CSharp.csproj"),
      bytes = await readFile(project, "utf8");
    assert.equal(bytes.split("</Project>").length, 2);
    await writeFile(
      project,
      bytes.replace(
        "</Project>",
        '<ItemGroup><Compile Remove="Counter.cs" /></ItemGroup></Project>',
      ),
    );
    const filtered = (await run(root)).checks[0]!;
    assert.notEqual(filtered.status, "passed");
    assert.equal(filtered.findingsComplete, false);
  },
);
test(
  "native .NET whitespace retains native compiler failures and preserves caller-owned outputs",
  native,
  async (t) => {
    const { root } = await dotnetFormatFixture(t);
    await mkdir(path.join(root, "CSharp/bin"), { recursive: true });
    await mkdir(path.join(root, "CSharp/obj"), { recursive: true });
    const sentinel = path.join(root, "CSharp/bin/original.keep"),
      bytes = Buffer.from("caller-owned original output");
    await writeFile(sentinel, bytes);
    await writeFile(path.join(root, "CSharp/obj/original.keep"), bytes);
    await replaceDotnetFormatSource(
      root,
      "CSharp/Counter.cs",
      "=> value + 1;",
      "=> OriginalMissingSymbol;",
    );
    const failed = (await run(root)).checks[0]!;
    expect(failed, "failed");
    assert.ok(
      failed.findings?.some(
        (f) =>
          f.ruleId === "dotnet-build/CS0103" && f.file === "CSharp/Counter.cs",
      ),
    );
    assert.equal(failed.findingsComplete, false);
    assert.deepEqual(await readFile(sentinel), bytes);
    assert.deepEqual(
      await readFile(path.join(root, "CSharp/obj/original.keep")),
      bytes,
    );
    await assert.rejects(access(path.join(root, "CSharp/bin/Debug")));
  },
);
