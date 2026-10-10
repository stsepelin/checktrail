import test from "node:test";
import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createPlan, validate } from "../src/engine.js";
import { dotnetFormatExtensionsEvidence } from "../src/dotnet-format-extensions-evidence.js";
import { projectReport } from "../src/output.js";
import { runProcess } from "../src/runner.js";
import { mavenHash } from "../src/maven.js";
import {
  dotnetFormattingNative as native,
  dotnetFormattingFixture,
  dotnetFormattingPacket,
  dotnetFormattingObservation,
  dotnetFormattingPolicy,
  repairDotnetFormatting,
  rewriteDotnetFormattingNative,
  rewriteDotnetFormattingPacket,
  sourceDotnetFormattingBytes,
} from "./dotnet-format-extensions-fixture.js";
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const run = (root: string) =>
  validate(root, {
    trusted: true,
    timeoutMs: 120000,
  });
function expect(report: Awaited<ReturnType<typeof run>>, status: string) {
  const check = report.checks[0]!;
  assert.equal(
    check.status,
    status,
    JSON.stringify({
      reason: check.reason,
      processes: check.processes.map((p) => ({
        status: p.exitCode,
        stderr: p.stderr.slice(-800),
        truncated: p.truncated,
        timedOut: p.timedOut,
      })),
    }),
  );
  assert.equal(check.findingsComplete, true);
  assert.equal(report.sourceChanged, false);
  assert.equal(report.sourceFingerprint, report.finalSourceFingerprint);
  return dotnetFormattingObservation(report);
}
test("dotnet-format-extensions broken acceptance", native, async (t) => {
  const root = await dotnetFormattingFixture(t),
    before = await sourceDotnetFormattingBytes(root),
    report = await run(root),
    observed = expect(report, "failed");
  assert.equal(report.outcome, "failed");
  assert.equal(observed.allDocuments, 12);
  assert.equal(
    observed.phases[0]!.documents.filter((d) => d.selected).length,
    6,
  );
  assert.ok(
    observed.phases.every((p) =>
      p.documents.filter((d) => !d.selected).every((d) => !d.changed),
    ),
  );
  assert.deepEqual(
    observed.phases.map((p) => p.mode),
    ["Whitespace", "CodeStyle", "Analyzers"],
  );
  const whitespace = observed.phases[0]!,
    styles = observed.phases[1]!,
    analyzers = observed.phases[2]!;
  assert.deepEqual(
    new Set(
      whitespace.documents
        .filter((d) => d.sourceGenerated && d.changed)
        .map((d) => d.language),
    ),
    new Set(["C#", "Visual Basic"]),
  );
  assert.ok(
    whitespace.documents.some(
      (d) => d.file.endsWith("Original.Generated.g.cs") && d.changed,
    ),
  );
  assert.deepEqual(
    new Set(styles.diagnostics.map((d) => d.id)),
    new Set(["IDE0005", "IDE0007"]),
  );
  assert.deepEqual(
    new Set(
      styles.diagnostics
        .filter((d) => d.id === "IDE0005")
        .map((d) => d.file!.split("/").slice(-2).join("/")),
    ),
    new Set(["CSharp/Counter.cs", "VisualBasic/Counter.vb"]),
  );
  assert.deepEqual(
    new Set(analyzers.diagnostics.map((d) => d.id)),
    new Set(["CA1822"]),
  );
  assert.equal(
    analyzers.diagnostics.filter((d) => d.id === "CA1822").length,
    5,
  );
  assert.deepEqual(
    new Set(
      analyzers.diagnostics
        .filter((d) => d.file!.includes("/generated/"))
        .map((d) => d.project.split("/").slice(-2).join("/")),
    ),
    new Set(["CSharp/CSharp.csproj", "VisualBasic/VisualBasic.vbproj"]),
  );
  for (const phase of [styles, analyzers]) {
    assert.equal(phase.generatedSemanticFixesSupported, false);
    assert.ok(
      phase.documents
        .filter((d) => d.sourceGenerated)
        .every((d) => !d.changed && d.route === "native-generated-diagnostics"),
    );
  }
  const vb = styles.documents.find((d) =>
    d.file.endsWith("/VisualBasic/Counter.vb"),
  )!;
  assert.equal(vb.changed, false);
  assert.ok(styles.sdkReport.some((r) => r.FilePath === vb.file));
  assert.ok(
    styles.documents.some(
      (d) => d.file.endsWith("/CSharp/Counter.cs") && d.changed,
    ),
  );
  assert.deepEqual(await sourceDotnetFormattingBytes(root), before);
});
test("dotnet-format-extensions fixed acceptance", native, async (t) => {
  const root = await dotnetFormattingFixture(t),
    broken = await run(root);
  expect(broken, "failed");
  await repairDotnetFormatting(root);
  const repaired = await run(root),
    observed = expect(repaired, "passed");
  assert.equal(repaired.outcome, "passed");
  assert.equal(observed.allDocuments, 12);
  assert.equal(
    observed.phases[0]!.documents.filter((d) => d.selected).length,
    6,
  );
  assert.ok(
    observed.phases.every((p) =>
      p.documents.filter((d) => !d.selected).every((d) => !d.changed),
    ),
  );
  assert.ok(
    observed.phases.every(
      (p) =>
        p.diagnostics.length === 0 &&
        p.sdkReport.length === 0 &&
        p.documents.every((d) => !d.changed && d.changes.length === 0),
    ),
  );
  assert.notEqual(repaired.sourceFingerprint, broken.sourceFingerprint);
  assert.deepEqual(
    new Set(
      observed.phases[0]!.documents.filter((d) => d.sourceGenerated).map(
        (d) => d.language,
      ),
    ),
    new Set(["C#", "Visual Basic"]),
  );
});
test("dotnet-format-extensions near-miss acceptance", native, async (t) => {
  const root = await dotnetFormattingFixture(t, "near-miss"),
    file = path.join(root, "CSharp/Counter.cs");
  const source = await readFile(file, "utf8");
  await writeFile(
    file,
    Buffer.concat([
      Buffer.from([239, 187, 191]),
      Buffer.from(
        source.replace(
          "        var number",
          "        // using System.Text; CA1822 diagnostic lookalike 🙂\r\n        var number",
        ),
      ),
    ]),
  );
  const report = await run(root),
    observed = expect(report, "passed");
  const doc = observed.phases[0]!.documents.find((d) =>
    d.file.endsWith("/CSharp/Counter.cs"),
  )!;
  assert.equal(doc.utf8Bom, true);
  assert.ok(doc.before.includes("🙂"));
  assert.ok(
    observed.phases.every(
      (p) => p.diagnostics.length === 0 && p.documents.every((d) => !d.changed),
    ),
  );
  assert.equal(observed.allDocuments, 12);
  assert.equal(
    observed.phases[0]!.documents.filter((d) => d.selected).length,
    6,
  );
  assert.ok(
    observed.phases.every((p) =>
      p.documents.filter((d) => !d.selected).every((d) => !d.changed),
    ),
  );
  assert.ok(doc.before.includes("_value + number"));

  const mappedRoot = await dotnetFormattingFixture(t);
  const editorFile = path.join(mappedRoot, ".editorconfig");
  await writeFile(
    editorFile,
    (await readFile(editorFile, "utf8")) +
      "[Counter.vb]\ngenerated_code = false\n",
  );
  const cs = path.join(mappedRoot, "CSharp/Counter.cs"),
    vb = path.join(mappedRoot, "VisualBasic/Counter.vb");
  await writeFile(
    cs,
    (await readFile(cs, "utf8")).replace(
      "    public  int Value()",
      '#line 400 "Original virtual CSharp.cs"\n    public  int Value()',
    ),
  );
  await writeFile(
    vb,
    (await readFile(vb, "utf8"))
      .replace(
        "Namespace Original",
        '#ExternalSource("Original virtual VisualBasic.vb", 700)\nNamespace Original',
      )
      .replace("End Namespace", "End Namespace\n#End ExternalSource"),
  );
  const mappedReport = await run(mappedRoot),
    mapped = expect(mappedReport, "failed"),
    diagnostics = mapped.phases[2]!.diagnostics.filter(
      (d) =>
        (d.id === "CA1822" && d.file?.endsWith("/Counter.cs")) ||
        (d.id === "CA1822" && d.file?.endsWith("/Counter.vb")),
    );
  assert.equal(diagnostics.length, 2);
  assert.deepEqual(
    new Set(diagnostics.map((d) => d.mapped.startLine)),
    new Set([400, 702]),
  );
  assert.ok(
    diagnostics.every(
      (d) =>
        d.mapped.file.startsWith("Original virtual ") &&
        d.physical.file === d.file &&
        d.physical.startLine < 20,
    ),
  );
  assert.deepEqual(
    new Set(
      mappedReport.checks[0]!.findings!.filter(
        (f) =>
          f.ruleId === "dotnet-format-extensions/CA1822" &&
          (f.file === "CSharp/Counter.cs" ||
            f.file === "VisualBasic/Counter.vb"),
      ).map((f) => f.file),
    ),
    new Set(["CSharp/Counter.cs", "VisualBasic/Counter.vb"]),
  );
  const mappedCheck = (await createPlan(mappedRoot)).plan.checks[0]!;
  const mappedProcess = mappedReport.checks[0]!.processes[0]!;
  for (const mutate of [
    (p: ReturnType<typeof dotnetFormattingPacket>) => {
      const document = p.build.modules
        .flatMap((m) => m.metadata?.documents ?? [])
        .find((d) => d.hash === "")!;
      assert.ok(document);
      document.file += ".Adjacent";
    },
    (p: ReturnType<typeof dotnetFormattingPacket>) => {
      const document = p.build.modules
        .flatMap((m) => m.metadata?.documents ?? [])
        .find((d) => d.hash === "")!;
      assert.ok(document);
      document.hash = "0".repeat(64);
    },
    (p: ReturnType<typeof dotnetFormattingPacket>) => {
      const document = p.build.modules
        .flatMap((m) => m.metadata?.documents ?? [])
        .find((d) => d.file.endsWith("/CSharp/Counter.cs"))!;
      assert.ok(document);
      document.hash = "";
      document.algorithm = "00000000-0000-0000-0000-000000000000";
    },
  ]) {
    assert.equal(
      dotnetFormatExtensionsEvidence(
        mappedCheck,
        [rewriteDotnetFormattingPacket(mappedProcess, mutate)],
        mappedRoot,
      ).findingsComplete,
      false,
    );
  }
  const invalidMapping = rewriteDotnetFormattingNative(
    mappedProcess,
    (native) => {
      for (const phase of native.phases) {
        const doc = phase.documents.find((d) =>
          d.file.endsWith("/CSharp/Counter.cs"),
        )!;
        doc.lineMappings.at(-1)!.span.endColumn += 512;
      }
    },
  );
  assert.equal(
    dotnetFormatExtensionsEvidence(mappedCheck, [invalidMapping], mappedRoot)
      .findingsComplete,
    false,
  );
  const changed = rewriteDotnetFormattingNative(
    mappedReport.checks[0]!.processes[0]!,
    (native) => {
      for (const phase of native.phases)
        for (const row of phase.sdkReport)
          for (const change of row.FileChanges) {
            const diagnostic = phase.diagnostics.find(
              (d) =>
                d.documentId === row.DocumentId.Id &&
                d.id === change.DiagnosticId &&
                d.mapped.startLine === change.LineNumber &&
                d.mapped.startColumn === change.CharNumber,
            );
            if (
              diagnostic &&
              diagnostic.mapped.file !== diagnostic.physical.file
            ) {
              change.LineNumber = diagnostic.physical.startLine;
              change.CharNumber = diagnostic.physical.startColumn;
            }
          }
    },
  );
  assert.equal(
    dotnetFormatExtensionsEvidence(mappedCheck, [changed], mappedRoot)
      .findingsComplete,
    false,
  );
});
test("dotnet-format-extensions prerequisite acceptance", native, async (t) => {
  const root = await dotnetFormattingFixture(t, "fixed"),
    policy = path.join(root, "checktrail.dotnet-format.json"),
    original = await readFile(policy);
  for (const config of [
    { ...dotnetFormattingPolicy, styleDiagnostics: ["IDE00050"] },
    { ...dotnetFormattingPolicy, analyzerDiagnostics: ["CA18220"] },
    { ...dotnetFormattingPolicy, styleDiagnostics: ["CA1822"] },
    { ...dotnetFormattingPolicy, includeGenerated: false },
    { ...dotnetFormattingPolicy, trusted: true },
  ]) {
    await writeFile(policy, JSON.stringify(config));
    const check = (await createPlan(root)).plan.checks[0]!;
    assert.equal(check.commands.length, 0);
    assert.match(check.unavailableReason!, /unsupported|prerequisites/);
  }
  await writeFile(policy, original);
  const fake = await mkdtemp(path.join(tmpdir(), "original-sdk-admission-")),
    marker = path.join(fake, "executed"),
    previous = process.env.PATH;
  try {
    await writeFile(
      path.join(fake, "dotnet"),
      `#!/bin/sh\n: > '${marker}'\nprintf '10.0.401\\n'\n`,
      { mode: 0o755 },
    );
    process.env.PATH = fake;
    const check = (await createPlan(root)).plan.checks[0]!;
    assert.equal(check.commands.length, 0);
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    await rm(fake, { recursive: true, force: true });
  }
  assert.equal((await createPlan(root)).plan.checks[0]!.commands.length, 1);
});
test("dotnet-format-extensions stale acceptance", native, async (t) => {
  const root = await dotnetFormattingFixture(t, "fixed"),
    report = await run(root);
  expect(report, "passed");
  const check = (await createPlan(root)).plan.checks[0]!,
    process = report.checks[0]!.processes[0]!;
  for (const file of [
    "CSharp/Counter.cs",
    "Generator/OriginalGenerator.cs",
    ".editorconfig",
    "checktrail.dotnet-format.json",
    ".checktrail/repository/original-marker.txt",
    ".checktrail/repository.json",
  ]) {
    const target = path.join(root, file),
      original = await readFile(target);
    try {
      await writeFile(target, Buffer.concat([original, Buffer.from("\n")]));
      assert.equal(
        dotnetFormatExtensionsEvidence(check, [process], root).findingsComplete,
        false,
        file,
      );
    } finally {
      await writeFile(target, original);
    }
    assert.equal(
      dotnetFormatExtensionsEvidence(check, [process], root).status,
      "passed",
      file,
    );
  }
  const extra = path.join(root, ".checktrail/repository/adjacent.txt");
  try {
    await writeFile(extra, "Original unexpected artifact");
    assert.equal(
      dotnetFormatExtensionsEvidence(check, [process], root).findingsComplete,
      false,
    );
  } finally {
    await rm(extra, { force: true });
  }
  const failedRoot = await dotnetFormattingFixture(t, "fixed"),
    failedFile = path.join(failedRoot, "CSharp/Counter.cs"),
    originalFailed = await readFile(failedFile, "utf8");
  await writeFile(
    failedFile,
    originalFailed.replace("return number;", 'return "original wrong type";'),
  );
  const failedCheck = (await createPlan(failedRoot)).plan.checks[0]!,
    failedReport = await run(failedRoot);
  assert.equal(failedReport.checks[0]!.status, "failed");
  assert.ok(
    failedReport.checks[0]!.findings!.some(
      (f) =>
        f.ruleId === "dotnet-build/CS0029" && f.file === "CSharp/Counter.cs",
    ),
  );
  await writeFile(failedFile, originalFailed);
  assert.equal(
    dotnetFormatExtensionsEvidence(
      failedCheck,
      failedReport.checks[0]!.processes,
      failedRoot,
    ).findingsComplete,
    false,
  );
  for (const field of [
    "sdkPinsSha256",
    "helperSourceSha256",
    "requestFileSha256",
    "runtimeConfigSha256",
    "mirroredSha256",
  ] as const)
    assert.equal(
      dotnetFormatExtensionsEvidence(
        check,
        [
          rewriteDotnetFormattingPacket(process, (p) => {
            p.extensions![field] = "0".repeat(64);
          }),
        ],
        root,
      ).findingsComplete,
      false,
      field,
    );
  assert.equal(
    dotnetFormatExtensionsEvidence(
      check,
      [
        rewriteDotnetFormattingPacket(process, (p) => {
          p.extensions!.firstDocument.sourceSha256 = "0".repeat(64);
        }),
      ],
      root,
    ).findingsComplete,
    false,
  );
  assert.equal(
    dotnetFormatExtensionsEvidence(
      check,
      [
        rewriteDotnetFormattingPacket(process, (p) => {
          p.extensions!.phases[0]!.capturedOutput.completeForObservedStreams = false;
        }),
      ],
      root,
    ).findingsComplete,
    false,
  );
  for (const mutate of [
    (n: ReturnType<typeof dotnetFormattingObservation>) => {
      n.helperSha256 = "0".repeat(64);
    },
    (n: ReturnType<typeof dotnetFormattingObservation>) => {
      n.formatterSha256 = "0".repeat(64);
    },
    (n: ReturnType<typeof dotnetFormattingObservation>) => {
      n.loaded[0]!.sha256 = "0".repeat(64);
    },
    (n: ReturnType<typeof dotnetFormattingObservation>) => {
      n.loaded[0]!.file += ".adjacent";
    },
    (n: ReturnType<typeof dotnetFormattingObservation>) => {
      n.constructorParameters[0] = "AdjacentWorkspaceFilePath";
    },
  ])
    assert.equal(
      dotnetFormatExtensionsEvidence(
        check,
        [rewriteDotnetFormattingNative(process, mutate)],
        root,
      ).findingsComplete,
      false,
    );
});
test("dotnet-format-extensions empty acceptance", native, async (t) => {
  const root = await dotnetFormattingFixture(t),
    report = await run(root);
  expect(report, "failed");
  const check = (await createPlan(root)).plan.checks[0]!,
    process = report.checks[0]!.processes[0]!;
  for (const text of ["", "{}", "[]", process.stdout.slice(0, -1)])
    assert.equal(
      dotnetFormatExtensionsEvidence(
        check,
        [{ ...process, stdout: text }],
        root,
      ).findingsComplete,
      false,
    );
  assert.equal(
    dotnetFormatExtensionsEvidence(check, [], root).findingsComplete,
    false,
  );
  for (const flag of ["truncated", "cancelled", "timedOut"] as const)
    assert.equal(
      dotnetFormatExtensionsEvidence(
        check,
        [{ ...process, [flag]: true }],
        root,
      ).findingsComplete,
      false,
    );
  const mutations: Array<
    (n: ReturnType<typeof dotnetFormattingObservation>) => void
  > = [
    (n) => {
      n.phases.pop();
    },
    (n) => {
      n.phases[0]!.documents.pop();
    },
    (n) => {
      n.phases[0]!.documents.push(structuredClone(n.phases[0]!.documents[0]!));
    },
    (n) => {
      n.phases[0]!.documents[0]!.sourceSha256 = "0".repeat(64);
    },
    (n) => {
      n.phases[0]!.documents[0]!.before += "adjacent";
    },
    (n) => {
      n.phases[0]!.documents.find((d) => d.selected)!.selected = false;
    },
    (n) => {
      n.phases[0]!.documents[0]!.documentId =
        "00000000-0000-0000-0000-000000000000";
    },
    (n) => {
      n.phases[0]!.documents.find((d) => d.changed)!.changes[0]!.newText +=
        "adjacent";
    },
    (n) => {
      n.phases[0]!.documents.find((d) => d.changed)!.changes[0]!.line++;
    },
    (n) => {
      n.phases[0]!.documents.find((d) => d.changed)!.changes = [];
    },
    (n) => {
      n.phases[0]!.documents.find((d) => d.sourceGenerated)!.route =
        "sdk-pipeline";
    },
    (n) => {
      n.phases[0]!.sdkReport = [];
    },
    (n) => {
      n.phases[0]!.sdkReport[0]!.FilePath += ".adjacent";
    },
    (n) => {
      n.phases[0]!.sdkReport[0]!.FileChanges[0]!.LineNumber++;
    },
    (n) => {
      n.phases[1]!.diagnostics[0]!.id += "0";
    },
    (n) => {
      n.phases[1]!.diagnostics[0]!.physical.startColumn++;
    },
    (n) => {
      n.phases[1]!.diagnostics[0]!.sourceTextSha256 = "0".repeat(64);
    },
    (n) => {
      n.phases[1]!.catalog.pop();
    },
    (n) => {
      n.phases[1]!.catalog[0]!.supported = [];
    },
    (n) => {
      n.phases[2]!.diagnostics.find((d) =>
        d.file!.includes("/generated/"),
      )!.id += "0";
    },
    (n) => {
      n.phases[1]!.analyzerExceptions.push("Original analyzer failure");
    },
    (n) => {
      n.phases[2]!.documents.find((d) => d.sourceGenerated)!.changed = true;
    },
    (n) => {
      n.phases[2]!.diagnostics[0]!.projectId =
        "00000000-0000-0000-0000-000000000000";
    },
    (n) => {
      n.workspaceFailures.push("Original workspace failure");
    },
  ];
  for (const [index, mutate] of mutations.entries())
    assert.equal(
      dotnetFormatExtensionsEvidence(
        check,
        [rewriteDotnetFormattingNative(process, mutate)],
        root,
      ).findingsComplete,
      false,
      "coherently rehashed native corruption " + index,
    );
  const packet = dotnetFormattingPacket(report);
  packet.extensions!.completed.observationSha256 = "0".repeat(64);
  assert.equal(
    dotnetFormatExtensionsEvidence(
      check,
      [{ ...process, stdout: JSON.stringify(packet) }],
      root,
    ).findingsComplete,
    false,
  );
});
test(
  "dotnet-format-extensions privacy acceptance",
  { ...native, timeout: 300000 },
  async (t) => {
    const root = await dotnetFormattingFixture(t),
      file = path.join(root, "CSharp/Counter.cs"),
      text = await readFile(file, "utf8");
    await writeFile(
      file,
      text.replace(
        "namespace Original;",
        "namespace Original; // source_canary_original_formatter\n",
      ),
    );
    const report = await run(root);
    expect(report, "failed");
    assert.equal(
      JSON.stringify(projectReport(report, false)).includes(
        "source_canary_original_formatter",
      ),
      false,
    );
    assert.equal(
      JSON.stringify(projectReport(report, false)).includes(root),
      false,
    );
    assert.ok(
      JSON.stringify(projectReport(report, true)).includes(
        "source_canary_original_formatter",
      ),
    );
    const denied = spawnSync(process.execPath, [cli, "run", "--root", root], {
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /trust/i);
    for (const detailed of [false, true]) {
      const response = spawnSync(
        process.execPath,
        [
          cli,
          "run",
          "--root",
          root,
          "--trust-project",
          ...(detailed ? ["--detailed"] : []),
        ],
        { encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1048576 },
      );
      assert.equal(response.status, 1, response.stderr.slice(-1500));
      assert.equal(JSON.parse(response.stdout).outcome, "failed");
      assert.equal(
        response.stdout.includes("source_canary_original_formatter"),
        detailed,
      );
      assert.equal(response.stdout.includes(root), detailed);
    }
    for (const { allow, detailed } of [
      { allow: false, detailed: false },
      { allow: true, detailed: false },
      { allow: true, detailed: true },
    ]) {
      const client = new Client(
        { name: "original-dotnet-format-client", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      try {
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [
              cli,
              "serve",
              "--root",
              root,
              ...(allow ? ["--allow-execution"] : []),
              ...(detailed ? ["--detailed"] : []),
            ],
            env: {
              PATH: process.env.PATH ?? "",
              TMPDIR: tmpdir(),
              TMP: tmpdir(),
              TEMP: tmpdir(),
            },
            stderr: "pipe",
          }),
        );
        assert.equal(
          (
            await client.callTool({
              name: "validation_run",
              arguments: { trusted: true },
            })
          ).isError,
          true,
        );
        const response = await client.callTool({
          name: "validation_run",
          arguments: {},
        });
        if (allow) {
          assert.notEqual(response.isError, true);
          const encoded = JSON.stringify(response);
          assert.ok(encoded.includes("failed"));
          assert.equal(
            encoded.includes("source_canary_original_formatter"),
            detailed,
          );
          assert.equal(encoded.includes(root), detailed);
        } else assert.equal(response.isError, true);
        assert.equal(
          (
            await client.callTool({
              name: "validation_run",
              arguments: { detailed: true },
            })
          ).isError,
          true,
        );
      } finally {
        await client.close();
      }
    }
  },
);
async function reached(owner: string) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    for (const command of await readdir(owner))
      if (command.startsWith("checktrail-command-")) {
        const base = path.join(owner, command);
        for (const folder of await readdir(base).catch(() => []))
          if (folder.startsWith("checktrail-dotnet-build-")) {
            const temporary = path.join(base, folder),
              file = path.join(
                temporary,
                "observer/format-extensions/first-document.json",
              );
            try {
              const marker = JSON.parse(await readFile(file, "utf8"));
              if (
                marker.phase === "sdk-formatting-first-document-completed" &&
                marker.mode === "Whitespace"
              ) {
                const args = (
                  await readFile(`/proc/${marker.processId}/cmdline`)
                )
                  .toString()
                  .split("\0");
                assert.ok(
                  args.includes(
                    path.join(
                      temporary,
                      "observer/format-extensions/ChecktrailFormattingExtensions.dll",
                    ),
                  ),
                );
                assert.ok(
                  args.includes(
                    path.join(
                      temporary,
                      "observer/format-extensions/request.json",
                    ),
                  ),
                );
                return {
                  pid: marker.processId as number,
                  temporary,
                  file: marker.file as string,
                  sourceSha256: marker.sourceSha256 as string,
                };
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
          }
      }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("Actual native first-document completion was not reached");
}
test(
  "dotnet-format-extensions lifecycle acceptance",
  { ...native, timeout: 300000 },
  async (t) => {
    for (const mode of ["cancel", "timeout", "output"] as const) {
      const root = await dotnetFormattingFixture(t),
        file = path.join(root, "CSharp/Counter.cs");
      const source = await readFile(file, "utf8"),
        heavy = Array.from(
          { length: 500 },
          (_, i) =>
            `    public static int V${i}(int value){return value+${i};}\n`,
        ).join("");
      await writeFile(file, source.replace(/\n}\n$/, "\n" + heavy + "}\n"));
      const check = (await createPlan(root)).plan.checks[0]!,
        owner = await mkdtemp(
          path.join(tmpdir(), "original-format-extensions-owned-"),
        ),
        previous = process.env.TMPDIR,
        abort = new AbortController();
      process.env.TMPDIR = owner;
      const pending = runProcess(root, check.commands[0]!, {
        timeoutMs: mode === "timeout" ? 45000 : 120000,
        maxOutputBytes: mode === "output" ? 1024 : 8 * 1048576,
        signal: abort.signal,
      });
      void pending.catch(() => {});
      try {
        const witness = await reached(owner);
        assert.ok(witness.file.endsWith("/CSharp/Counter.cs"));
        assert.equal(witness.sourceSha256, mavenHash(await readFile(file)));
        process.kill(witness.pid, 0);
        if (mode !== "output") process.kill(witness.pid, "SIGSTOP");
        if (mode === "cancel") abort.abort();
        const result = await pending;
        assert.equal(result.cancelled, mode === "cancel");
        assert.equal(result.timedOut, mode === "timeout");
        assert.equal(result.truncated, mode === "output");
        assert.equal(
          dotnetFormatExtensionsEvidence(check, [result], root)
            .findingsComplete,
          false,
        );
        await assert.rejects(access(witness.temporary), { code: "ENOENT" });
        await assert.rejects(readFile(`/proc/${witness.pid}/cmdline`), {
          code: "ENOENT",
        });
        assert.deepEqual(await readdir(owner), []);
      } finally {
        abort.abort();
        await pending;
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
        await rm(owner, { recursive: true, force: true });
      }
    }
  },
);
test(
  "dotnet-format-extensions installed acceptance",
  { ...native, timeout: 600000 },
  async () => {
    if (process.env.CHECKTRAIL_DOTNET_FORMAT_EXTENSIONS_INSTALLED === "1") {
      assert.match(
        await import("node:fs/promises").then((fs) =>
          fs.realpath(
            fileURLToPath(new URL("../src/engine.js", import.meta.url)),
          ),
        ),
        /node_modules\/@stsepelin\/checktrail\/dist\/src\/engine\.js$/,
      );
      return;
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "dotnet-format-extensions",
    };
    delete env.NODE_TEST_CONTEXT;
    const installed = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            "../../scripts/verify-import-context-package.mjs",
            import.meta.url,
          ),
        ),
      ],
      { env, encoding: "utf8", timeout: 570000, maxBuffer: 4 * 1048576 },
    );
    assert.equal(installed.status, 0, installed.stderr.slice(-2000));
    const receipt = JSON.parse(installed.stdout);
    assert.equal(receipt.profile.complete, true);
    assert.equal(receipt.profile.required, 9);
    assert.equal(receipt.profile.passed, 9);
    assert.equal(receipt.offlineProductionInstall, true);
    assert.equal(receipt.harnessOutsideInstalledPackage, true);
    if (process.env.CHECKTRAIL_DOTNET_FORMAT_EXTENSIONS_INSTALL_RECEIPT)
      await writeFile(
        process.env.CHECKTRAIL_DOTNET_FORMAT_EXTENSIONS_INSTALL_RECEIPT,
        JSON.stringify(receipt),
      );
  },
);
