import test from "node:test";
import assert from "node:assert/strict";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createPlan, validate } from "../src/engine.js";
import { fsharpFormatEvidence } from "../src/fsharp-format-evidence.js";
import { verifyFsharpSdk } from "../src/fsharp-format.js";
import { fsharpSdkPins } from "../src/fsharp-format-pins.js";
import { fsharpNativeSchema } from "../src/fsharp-format-contract.js";
import { mavenHash } from "../src/maven.js";
import { runProcess } from "../src/runner.js";
import { projectReport } from "../src/output.js";
import {
  fsharpFormatFixture,
  fsharpFormatNative as native,
  fsharpReportNative,
  fsharpReportPacket,
  fsharpOriginalFiles,
  repairFsharpFormatting,
  fsharpRewriteNative,
  fsharpRewritePacket,
  fsharpSourceBytes,
} from "./fsharp-format-fixture.js";
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const run = (root: string) =>
  validate(root, {
    trusted: true,
    timeoutMs: 120000,
  });
const evaluate = (
  root: string,
  check: Awaited<ReturnType<typeof createPlan>>["plan"]["checks"][number],
  process: Parameters<typeof fsharpFormatEvidence>[1][number],
) => fsharpFormatEvidence(check, [process], root);
test("dotnet-fsharp-format broken acceptance", native, async (t) => {
  const files = {
      ...fsharpOriginalFiles,
      "syntax.fs": "module Syntax\nlet missing =\n",
      "conditional.fs":
        "#if ORIGINAL\nlet first =\n#else\nlet second =\n#endif\n",
      "invalid-signature.fsi": "module Signature\nval missing :\n",
    },
    root = await fsharpFormatFixture(t, files),
    before = await fsharpSourceBytes(root, Object.keys(files)),
    report = await run(root),
    result = report.checks[0]!;
  assert.equal(report.outcome, "failed", result.reason);
  assert.equal(result.findingsComplete, true);
  assert.deepEqual(
    new Set(
      result
        .findings!.filter((f) => f.ruleId === "fsharp/format")
        .map((f) => f.file),
    ),
    new Set(["implementation.fs", "signature.fsi"]),
  );
  const documents = fsharpReportNative(report).documents;
  assert.equal(documents.length, 5);
  const syntax = documents.find((d) => d.file.endsWith("/syntax.fs"))!;
  assert.equal(syntax.error!.kind, "parse");
  assert.deepEqual(
    syntax.diagnostics.map((d) => d.code),
    [58, 10],
  );
  assert.deepEqual(
    syntax.error!.diagnostics.map((d) => d.code),
    [58, 10],
  );
  assert.equal(syntax.error!.diagnostics[0]!.range!.startLine, 2);
  const conditional = documents.find((d) =>
    d.file.endsWith("/conditional.fs"),
  )!;
  assert.equal(conditional.error!.kind, "define-parse");
  assert.deepEqual(conditional.error!.combinations, ["no defines", "ORIGINAL"]);
  assert.equal(
    conditional.error!.message,
    "Parsing failed for define combination(s): no defines, ORIGINAL.",
  );
  assert.equal(
    conditional.validationDiagnosticScope,
    "intolerant-first-failing-combination",
  );
  assert.ok(
    documents
      .find((d) => d.file.endsWith("/invalid-signature.fsi"))!
      .error!.diagnostics.every((d) => d.range!.file === "tmp.fsi"),
  );
  assert.deepEqual(await fsharpSourceBytes(root, Object.keys(files)), before);
  assert.equal(report.sourceChanged, false);
});
test("dotnet-fsharp-format fixed acceptance", native, async (t) => {
  const root = await fsharpFormatFixture(t),
    broken = await run(root);
  assert.equal(broken.outcome, "failed");
  await repairFsharpFormatting(root, broken);
  const before = await fsharpSourceBytes(
      root,
      Object.keys(fsharpOriginalFiles),
    ),
    report = await run(root),
    packet = fsharpReportPacket(report);
  assert.equal(report.outcome, "passed", report.checks[0]!.reason);
  assert.equal(report.checks[0]!.findingsComplete, true);
  assert.deepEqual(report.checks[0]!.findings, []);
  assert.equal(fsharpReportNative(report).documents.length, 3);
  assert.ok(
    fsharpReportNative(report).documents.every(
      (d) =>
        d.validationInvoked &&
        d.formattingInvoked &&
        d.isValid &&
        !d.changed &&
        d.error === null,
    ),
  );
  assert.equal(packet.phases.length, 2);
  assert.equal(packet.marker.processId, packet.phases[1]!.pid);
  assert.equal(packet.firstDocument.formatterReturned, true);
  assert.deepEqual(
    await fsharpSourceBytes(root, Object.keys(fsharpOriginalFiles)),
    before,
  );
});
test("dotnet-fsharp-format near-miss acceptance", native, async (t) => {
  const marker = path.join(
      tmpdir(),
      "original-fsharp-source-must-not-execute-" + process.pid,
    ),
    files = {
      "unicode.fs": '\uFEFFmodule Unicode\n\nlet café = "λé😀"\n',
      "windows.fs": "module Windows\r\n\r\nlet value = 1\r\n",
      "signature.fsi": "module Public\n\nval café: string\n",
      "script.fsx": `#r "missing-synthetic-assembly.dll"\n#load "missing-synthetic-script.fsx"\nSystem.IO.File.WriteAllText("${marker}", "synthetic")\n`,
      "conditional.fs": fsharpOriginalFiles["conditional.fs"],
    },
    root = await fsharpFormatFixture(t, files);
  t.after(() => rm(marker, { force: true }));
  await writeFile(
    path.join(root, ".editorconfig"),
    "root = true\n[*.fs]\nindent_size = 31\n",
  );
  const before = await fsharpSourceBytes(root, Object.keys(files)),
    report = await run(root),
    documents = fsharpReportNative(report).documents;
  assert.equal(report.checks[0]!.findingsComplete, true);
  assert.ok(documents.every((d) => d.isValid && d.error === null));
  assert.equal(documents.length, 5);
  assert.equal(documents[0]!.utf8Bom, true);
  assert.equal(documents[0]!.text, files["unicode.fs"].slice(1));
  assert.equal(documents[1]!.text, files["windows.fs"]);
  assert.ok(documents[3]!.after!.includes("missing-synthetic-assembly.dll"));
  await assert.rejects(access(marker), { code: "ENOENT" });
  assert.deepEqual(await fsharpSourceBytes(root, Object.keys(files)), before);
  await repairFsharpFormatting(root, report);
  assert.equal((await run(root)).outcome, "passed");
});
test("dotnet-fsharp-format prerequisite acceptance", native, async (t) => {
  const root = await fsharpFormatFixture(t),
    configFile = path.join(root, "checktrail.fsharp-format.json"),
    original = await readFile(configFile, "utf8"),
    config = JSON.parse(original);
  for (const change of [
    { files: config.files.slice(1) },
    { files: [...config.files, config.files[0]] },
    { profile: "unsupported-profile" },
    { formatterDirectory: "../outside" },
    { files: [] },
  ]) {
    await writeFile(configFile, JSON.stringify({ ...config, ...change }));
    const check = (await createPlan(root)).plan.checks[0]!;
    assert.equal(check.commands.length, 0);
    assert.ok(check.unavailableReason);
  }
  await writeFile(configFile, original);
  const core = path.join(root, ".checktrail/formatter/Fantomas.Core.dll"),
    bytes = await readFile(core);
  await writeFile(core, Buffer.alloc(bytes.length));
  assert.equal((await createPlan(root)).plan.checks[0]!.commands.length, 0);
  await writeFile(core, bytes);
  await writeFile(
    path.join(root, ".checktrail/formatter/Unselected.dll"),
    "synthetic",
  );
  assert.equal((await createPlan(root)).plan.checks[0]!.commands.length, 0);
  await rm(path.join(root, ".checktrail/formatter/Unselected.dll"));
  await rm(core);
  await symlink("Fantomas.FCS.dll", core);
  assert.equal((await createPlan(root)).plan.checks[0]!.commands.length, 0);
  await rm(core);
  await writeFile(core, bytes);
  const check = (await createPlan(root)).plan.checks[0]!;
  assert.equal(check.commands.length, 1);
  const captured = await run(root),
    sdkRoot = fsharpReportPacket(captured).sdkRoot,
    copiedSdk = path.join(root, ".checktrail/selected-sdk");
  for (const pin of fsharpSdkPins) {
    const target = path.join(copiedSdk, pin.file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(sdkRoot, pin.file), target);
  }
  assert.equal(
    await verifyFsharpSdk(copiedSdk),
    path.join(copiedSdk, "dotnet"),
  );
  const foreignHost = path.join(copiedSdk, "host/fxr/10.0.99");
  await mkdir(foreignHost);
  await assert.rejects(verifyFsharpSdk(copiedSdk));
  await rm(foreignHost, { recursive: true });
  const extra = path.join(
    copiedSdk,
    "shared/Microsoft.NETCore.App/10.0.12/Unselected.dll",
  );
  await writeFile(extra, "synthetic");
  await assert.rejects(verifyFsharpSdk(copiedSdk));
  await rm(extra);
  const missing = await runProcess(
    root,
    { ...check.commands[0]!, env: { PATH: "/synthetic/no-sdk" } },
    { timeoutMs: 30000 },
  );
  assert.equal(evaluate(root, check, missing).status, "unavailable");
});
test("dotnet-fsharp-format stale acceptance", native, async (t) => {
  const root = await fsharpFormatFixture(t),
    check = (await createPlan(root)).plan.checks[0]!,
    report = await run(root),
    process = report.checks[0]!.processes[0]!;
  assert.equal(evaluate(root, check, process).status, "failed");
  const file = path.join(root, "implementation.fs"),
    before = await readFile(file);
  await writeFile(file, before.toString().replace("a+b", "a-b"));
  assert.equal(evaluate(root, check, process).status, "inconclusive");
  await writeFile(file, before);
  const configFile = path.join(root, "checktrail.fsharp-format.json"),
    config = await readFile(configFile);
  await writeFile(configFile, config.toString() + " ");
  assert.equal(evaluate(root, check, process).status, "inconclusive");
  await writeFile(configFile, config);
  const core = path.join(root, ".checktrail/formatter/FSharp.Core.dll"),
    bytes = await readFile(core),
    changed = Buffer.from(bytes);
  changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
  await writeFile(core, changed);
  assert.equal(evaluate(root, check, process).status, "inconclusive");
  await writeFile(core, bytes);
  for (const edit of [
    (n: ReturnType<typeof fsharpNativeSchema.parse>) => {
      n.documents[0]!.text = n.documents[0]!.text.replace("a+b", "a-b");
      n.documents[0]!.textSha256 = mavenHash(n.documents[0]!.text);
    },
    (n: ReturnType<typeof fsharpNativeSchema.parse>) => {
      n.documents[0]!.sourceSha256 = "0".repeat(64);
    },
    (n: ReturnType<typeof fsharpNativeSchema.parse>) => {
      n.loaded[0]!.file = "/synthetic/unselected.dll";
    },
  ])
    assert.equal(
      evaluate(root, check, fsharpRewriteNative(process, edit)).status,
      "inconclusive",
    );
  for (const edit of [
    (n: ReturnType<typeof fsharpNativeSchema.parse>) => {
      n.documents[0]!.text = n.documents[0]!.text.replace("a+b", "a-b");
    },
    (n: ReturnType<typeof fsharpNativeSchema.parse>) => {
      n.documents[1]!.signature = false;
    },
    (n: ReturnType<typeof fsharpNativeSchema.parse>) => {
      n.documents[1]!.sourceSha256 = "0".repeat(64);
    },
  ])
    assert.equal(
      evaluate(root, check, fsharpRewriteNative(process, edit)).status,
      "inconclusive",
    );
  for (const field of [
    "requestSha256",
    "sdkPinsSha256",
    "helperSourceSha256",
    "runtimeConfigSha256",
    "requestFileSha256",
  ] as const)
    assert.equal(
      evaluate(
        root,
        check,
        fsharpRewritePacket(process, (p) => {
          p[field] = "0".repeat(64);
        }),
      ).status,
      "inconclusive",
    );
  assert.equal(
    evaluate(
      root,
      check,
      fsharpRewritePacket(process, (p) => {
        p.firstDocument.sourceSha256 = "0".repeat(64);
      }),
    ).status,
    "inconclusive",
  );
  await writeFile(
    path.join(root, ".checktrail/formatter/Unselected.dll"),
    "synthetic",
  );
  assert.equal(evaluate(root, check, process).status, "inconclusive");
  await rm(path.join(root, ".checktrail/formatter/Unselected.dll"));
  assert.equal(evaluate(root, check, process).status, "failed");
});
test("dotnet-fsharp-format empty acceptance", native, async (t) => {
  const root = await fsharpFormatFixture(t),
    check = (await createPlan(root)).plan.checks[0]!,
    report = await run(root),
    process = report.checks[0]!.processes[0]!;
  for (const stdout of [
    "",
    "{}",
    process.stdout.slice(0, -1),
    '{"complete":true}',
  ])
    assert.equal(
      evaluate(root, check, { ...process, stdout }).findingsComplete,
      false,
    );
  for (const edit of [
    (n: ReturnType<typeof fsharpNativeSchema.parse>) => {
      n.documents = [];
    },
    (n: ReturnType<typeof fsharpNativeSchema.parse>) => {
      n.documents.pop();
    },
    (n: ReturnType<typeof fsharpNativeSchema.parse>) => {
      n.documents[0]!.changed = false;
    },
    (n: ReturnType<typeof fsharpNativeSchema.parse>) => {
      n.documents[0]!.afterSha256 = "0".repeat(64);
    },
    (n: ReturnType<typeof fsharpNativeSchema.parse>) => {
      n.documents[0]!.formattingInvoked = false as true;
    },
    (n: ReturnType<typeof fsharpNativeSchema.parse>) => {
      n.loaded = n.loaded.filter((a) => a.name !== "Fantomas.Core");
    },
  ])
    assert.equal(
      evaluate(root, check, fsharpRewriteNative(process, edit))
        .findingsComplete,
      false,
    );
  assert.equal(
    evaluate(
      root,
      check,
      fsharpRewriteNative(process, (n) => {
        n.loaded = n.loaded.filter((a) => a.name !== "System.Private.CoreLib");
      }),
    ).findingsComplete,
    false,
  );
  const badRoot = await fsharpFormatFixture(t, {
      "invalid.fs": "module Invalid\nlet missing =\n",
    }),
    badCheck = (await createPlan(badRoot)).plan.checks[0]!,
    bad = (await run(badRoot)).checks[0]!.processes[0]!;
  assert.equal(
    evaluate(
      badRoot,
      badCheck,
      fsharpRewriteNative(bad, (n) => {
        n.documents[0]!.error!.diagnostics = [];
      }),
    ).findingsComplete,
    false,
  );
  assert.equal(
    evaluate(
      badRoot,
      badCheck,
      fsharpRewriteNative(bad, (n) => {
        n.documents[0]!.diagnostics[0]!.range!.startLine = 100;
      }),
    ).findingsComplete,
    false,
  );
  assert.equal(
    evaluate(
      badRoot,
      badCheck,
      fsharpRewriteNative(bad, (n) => {
        n.documents[0]!.isValid = true;
      }),
    ).findingsComplete,
    false,
  );
  assert.equal(
    evaluate(
      badRoot,
      badCheck,
      fsharpRewriteNative(bad, (n) => {
        n.documents[0]!.diagnostics[0]!.range!.startLine = 2;
        n.documents[0]!.diagnostics[0]!.range!.startColumn = 10000;
      }),
    ).findingsComplete,
    false,
  );
  const conditionalRoot = await fsharpFormatFixture(t, {
      "conditional.fs":
        "#if ORIGINAL\nlet first =\n#else\nlet second =\n#endif\n",
    }),
    conditionalCheck = (await createPlan(conditionalRoot)).plan.checks[0]!,
    conditional = (await run(conditionalRoot)).checks[0]!.processes[0]!;
  assert.equal(
    evaluate(
      conditionalRoot,
      conditionalCheck,
      fsharpRewriteNative(conditional, (n) => {
        n.documents[0]!.error!.combinations.pop();
      }),
    ).findingsComplete,
    false,
  );
  const empty = await fsharpFormatFixture(t, {}),
    emptyReport = await run(empty);
  assert.notEqual(emptyReport.outcome, "passed");
  assert.notEqual(emptyReport.checks[0]!.findingsComplete, true);
});
test("dotnet-fsharp-format privacy acceptance", native, async (t) => {
  const root = await fsharpFormatFixture(t, {
    "canary.fs": "module Canary\nlet source_canary_original=1\n",
  });
  await assert.rejects(validate(root, { trusted: false }), /trust/i);
  const library = await run(root),
    summary = JSON.stringify(projectReport(library, false));
  assert.ok(
    !summary.includes(root) && !summary.includes("source_canary_original"),
  );
  assert.ok(
    JSON.stringify(projectReport(library, true)).includes(
      "source_canary_original",
    ),
  );
  const denied = spawnSync(process.execPath, [cli, "run", "--root", root], {
    encoding: "utf8",
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
      { encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1048576 },
    );
    assert.equal(response.status, 1, response.stderr);
    assert.equal(response.stdout.includes("source_canary_original"), detailed);
    assert.equal(response.stdout.includes(root), detailed);
    assert.equal(JSON.parse(response.stdout).outcome, "failed");
  }
  for (const { allow, detailed } of [
    { allow: false, detailed: false },
    { allow: true, detailed: false },
    { allow: true, detailed: true },
  ]) {
    const client = new Client(
      { name: "original-fsharp-formatter-client", version: "1.0.0" },
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
      const grant = await client.callTool({
        name: "validation_run",
        arguments: { trusted: true },
      });
      assert.equal(grant.isError, true);
      const response = await client.callTool({
        name: "validation_run",
        arguments: {},
      });
      const encoded = JSON.stringify(response);
      if (allow) {
        assert.notEqual(response.isError, true);
        assert.ok(encoded.includes("failed"));
        assert.equal(encoded.includes("source_canary_original"), detailed);
        assert.equal(encoded.includes(root), detailed);
        const disclose = await client.callTool({
          name: "validation_run",
          arguments: { detailed: true },
        });
        assert.equal(disclose.isError, true);
      } else assert.equal(response.isError, true);
    } finally {
      await client.close();
    }
  }
});
async function reached(owner: string) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    for (const command of await readdir(owner))
      if (command.startsWith("checktrail-command-")) {
        const base = path.join(owner, command);
        for (const directory of await readdir(base).catch(() => []))
          if (directory.startsWith("checktrail-fsharp-format-")) {
            const temporary = path.join(base, directory),
              file = path.join(
                temporary,
                "observer/body-entered.json.first-document.json",
              );
            try {
              const marker = JSON.parse(await readFile(file, "utf8"));
              if (
                marker.phase === "formatter-first-document-completed" &&
                marker.formatterReturned === true
              ) {
                const args = (
                  await readFile(`/proc/${marker.processId}/cmdline`)
                )
                  .toString()
                  .split("\0");
                assert.ok(
                  args.includes(
                    path.join(temporary, "observer/ChecktrailFsharpFormat.dll"),
                  ),
                );
                assert.ok(
                  args.includes(path.join(temporary, "observer/request.json")),
                );
                return {
                  pid: marker.processId as number,
                  temporary,
                  file,
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
  throw Error("Native first-document formatter completion was not reached");
}
test(
  "dotnet-fsharp-format lifecycle acceptance",
  { ...native, timeout: 120000 },
  async (t) => {
    const heavy =
      "module Heavy\n" +
      Array.from({ length: 2400 }, (_, i) => `let v${i} = ${i}+1\n`).join("");
    assert.ok(Buffer.byteLength(heavy) < 65536);
    for (const mode of ["cancel", "timeout", "output"] as const) {
      const root = await fsharpFormatFixture(t, {
          "first.fs": "module First\n\nlet value = 1\n",
          "heavy.fs": heavy,
        }),
        check = (await createPlan(root)).plan.checks[0]!,
        owner = await mkdtemp(
          path.join(tmpdir(), "original-fsharp-formatter-owned-"),
        ),
        previous = process.env.TMPDIR,
        abort = new AbortController();
      process.env.TMPDIR = owner;
      const pending = runProcess(root, check.commands[0]!, {
        timeoutMs: mode === "timeout" ? 10000 : 120000,
        maxOutputBytes: mode === "output" ? 1024 : 2 * 1048576,
        signal: abort.signal,
      });
      void pending.catch(() => {});
      try {
        const witness = await reached(owner);
        assert.equal(
          witness.sourceSha256,
          mavenHash("module First\n\nlet value = 1\n"),
        );
        process.kill(witness.pid, 0);
        if (mode !== "output") process.kill(witness.pid, "SIGSTOP");
        if (mode === "cancel") abort.abort();
        const result = await pending;
        assert.equal(result.cancelled, mode === "cancel");
        assert.equal(result.timedOut, mode === "timeout");
        assert.equal(result.truncated, mode === "output");
        assert.equal(evaluate(root, check, result).findingsComplete, false);
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
  "dotnet-fsharp-format installed acceptance",
  { ...native, timeout: 600000 },
  async () => {
    if (process.env.CHECKTRAIL_FSHARP_FORMAT_INSTALLED === "1") {
      assert.match(
        await realpath(
          fileURLToPath(new URL("../src/engine.js", import.meta.url)),
        ),
        /node_modules\/@stsepelin\/checktrail\/dist\/src\/engine\.js$/,
      );
      return;
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "dotnet-fsharp-format",
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
    assert.equal(installed.status, 0, installed.stderr.slice(0, 2000));
    const receipt = JSON.parse(installed.stdout);
    assert.equal(receipt.profile.complete, true);
    assert.equal(receipt.profile.required, 9);
    assert.equal(receipt.profile.passed, 9);
    assert.equal(receipt.offlineProductionInstall, true);
    assert.equal(receipt.harnessOutsideInstalledPackage, true);
    if (process.env.CHECKTRAIL_FSHARP_INSTALL_RECEIPT)
      await writeFile(
        process.env.CHECKTRAIL_FSHARP_INSTALL_RECEIPT,
        JSON.stringify(receipt),
      );
  },
);
