import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  readFile,
  readdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { validate } from "../src/engine.js";
import { reportSchema } from "../src/schemas.js";
import { dotnetGeneratedFixture } from "./dotnet-generated-fixture.js";
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
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
async function connect(root: string, allow: boolean) {
  const client = new Client(
    { name: "original-dotnet-generated-client", version: "1.0.0" },
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
        ],
        stderr: "pipe",
      }),
    );
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}
test(
  "native Roslyn CLI and negotiated MCP preserve generated regressions privacy and operator-only trust",
  native,
  async (t) => {
    const { root } = await dotnetGeneratedFixture(t, "dotnet.test"),
      file = path.join(root, "Generator/OriginalGenerator.cs"),
      original = await readFile(file, "utf8");
    assert.equal(original.split("=> value + 1;").length, 2);
    await writeFile(
      file,
      original.replace("=> value + 1;", "=> value < 0 ? value : value + 1;"),
    );
    const invoke = (trusted: boolean, detailed: boolean) =>
      spawnSync(
        process.execPath,
        [
          cli,
          "run",
          "--root",
          root,
          ...(trusted ? ["--trust-project"] : []),
          ...(detailed ? ["--detailed"] : []),
        ],
        { encoding: "utf8", timeout: 90000, maxBuffer: 4 * 1024 * 1024 },
      );
    const denied = invoke(false, false);
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /trust/i);
    const detailed = invoke(true, true);
    assert.equal(detailed.status, 1, detailed.stderr);
    const report = reportSchema.parse(JSON.parse(detailed.stdout));
    assert.equal(report.outcome, "failed");
    assert.equal(report.checks[0]!.status, "failed");
    assert.equal(report.checks[0]!.findingsComplete, true);
    assert.deepEqual(
      report.checks[0]!.findings?.filter(
        (f) => f.ruleId === "dotnet-test/case-failure",
      ).map((f) => f.file),
      ["CSharpTests/CounterTests.cs"],
    );
    const summary = invoke(true, false);
    assert.equal(summary.status, 1, summary.stderr);
    const summarized = JSON.parse(summary.stdout);
    assert.equal(summarized.outcome, "failed");
    assert.ok(
      !summary.stdout.includes(root) &&
        !summary.stdout.includes("CounterTests.cs") &&
        !summary.stdout.includes("value < 0"),
    );
    const client = await connect(root, true);
    try {
      const result = await client.callTool(
        { name: "validation_run", arguments: {} },
        { timeout: 90000 },
      );
      assert.notEqual(result.isError, true);
      assert.equal(
        (result.structuredContent as { outcome: string }).outcome,
        "failed",
      );
      assert.deepEqual(
        (result.structuredContent as { checks: unknown }).checks,
        summarized.checks,
      );
      assert.ok(
        !JSON.stringify(result).includes(root) &&
          !JSON.stringify(result).includes("CounterTests.cs"),
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
      await writeFile(file, original);
      const fixed = await client.callTool(
        { name: "validation_run", arguments: {} },
        { timeout: 90000 },
      );
      assert.equal(
        (fixed.structuredContent as { outcome: string }).outcome,
        "passed",
      );
    } finally {
      await client.close();
    }
    const untrusted = await connect(root, false);
    try {
      assert.equal(
        (await untrusted.callTool({ name: "validation_run", arguments: {} }))
          .isError,
        true,
      );
    } finally {
      await untrusted.close();
    }
  },
);
test(
  "native Roslyn cancellation reaches the original generator and reaps compiler descendants and temporary outputs",
  native,
  async (t) => {
    const { root } = await dotnetGeneratedFixture(t),
      marker = path.join(root, ".checktrail/generator-started"),
      control = path.join(root, "original-generator-wait.cjs"),
      file = path.join(root, "Generator/OriginalGenerator.cs"),
      original = await readFile(file, "utf8");
    const script = `const fs=require('node:fs');let pid=process.pid,compiler=0;for(let count=0;count<32&&pid>1;count++){const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0');if(args.some(a=>['/usr/share/dotnet/sdk/10.0.401/Roslyn/bincore/csc','/usr/share/dotnet/sdk/10.0.401/Roslyn/bincore/csc.dll'].includes(a))){compiler=pid;break;}const parent=/^PPid:\\s+(\\d+)$/m.exec(fs.readFileSync('/proc/'+pid+'/status','utf8'));if(!parent)break;pid=Number(parent[1]);}const marker=process.env.CHECKTRAIL_DOTNET_GENERATOR_STARTED;fs.writeFileSync(marker+'.prepared',JSON.stringify({pid:process.pid,compiler,producer:process.argv[2],owned:compiler>1&&process.argv[2].endsWith('/Generator/bin/Debug/net10.0/Original.Generator.dll'),scratch:process.env.TMPDIR,owner:process.env.CHECKTRAIL_TEMP}));fs.renameSync(marker+'.prepared',marker);setTimeout(()=>{},60000);`;
    const anchor = "var cs=compilation.Language==LanguageNames.CSharp;";
    assert.equal(original.split(anchor).length, 2);
    const wait = `var info = new System.Diagnostics.ProcessStartInfo("node") { UseShellExecute = false }; info.ArgumentList.Add(System.Environment.GetEnvironmentVariable("CHECKTRAIL_DOTNET_GENERATOR_CONTROL")!); info.ArgumentList.Add(typeof(OriginalGenerator).Assembly.Location); using var child = System.Diagnostics.Process.Start(info)!; child.WaitForExit(); `;
    await writeFile(control, script);
    await writeFile(file, original.replace(anchor, wait + anchor));
    await writeFile(
      path.join(root, "checktrail.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          {
            path: ".",
            checks: ["dotnet.build"],
            environment: [
              "CHECKTRAIL_DOTNET_GENERATOR_STARTED",
              "CHECKTRAIL_DOTNET_GENERATOR_CONTROL",
            ],
          },
        ],
      }),
    );
    const commandTemporary = await mkdtemp(
        path.join(tmpdir(), "checktrail-dotnet-generator-cancel-"),
      ),
      previous = process.env.TMPDIR;
    t.after(() => rm(commandTemporary, { recursive: true, force: true }));
    process.env.TMPDIR = commandTemporary;
    t.after(() => {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    });
    const before = (await readdir(commandTemporary)).sort(),
      controller = new AbortController(),
      running = validate(root, {
        trusted: true,
        timeoutMs: 120000,
        signal: controller.signal,
        environment: {
          CHECKTRAIL_DOTNET_GENERATOR_STARTED: marker,
          CHECKTRAIL_DOTNET_GENERATOR_CONTROL: control,
        },
      });
    let record:
      | {
          pid: number;
          compiler: number;
          producer: string;
          owned: boolean;
          scratch: string;
          owner: string;
        }
      | undefined;
    try {
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        try {
          record = JSON.parse(await readFile(marker, "utf8"));
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!record) {
        controller.abort();
        const stopped = await running;
        assert.fail(
          "Original native generator was not reached: " +
            JSON.stringify(
              stopped.checks.map((c) => ({
                status: c.status,
                reason: c.reason,
                stderr: c.processes.map((p) => p.stderr.slice(0, 512)),
              })),
            ),
        );
      }
      assert.equal(
        record.owned,
        true,
        "Reached child belongs to the actual native C# compiler and fresh original generator assembly: " +
          JSON.stringify(record),
      );
      assert.ok(
        record.scratch &&
          record.owner &&
          record.scratch.startsWith(record.owner + path.sep),
        "Native generator scratch belongs to its owned command directory",
      );
      for (const pid of [record.pid, record.compiler])
        assert.ok(Number.isSafeInteger(pid) && pid > 1);
    } finally {
      controller.abort();
      await running;
    }
    const report = await running;
    assert.equal(report.outcome, "incomplete");
    assert.ok(report.checks[0]!.processes.some((p) => p.cancelled));
    assert.deepEqual((await readdir(commandTemporary)).sort(), before);
    await assert.rejects(access(record!.scratch));
    await assert.rejects(access(path.join(root, "Generator/bin")));
    for (const pid of [record!.pid, record!.compiler]) {
      let alive = true;
      for (let n = 0; n < 100; n++) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            alive = false;
            break;
          }
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        alive,
        false,
        "Owned native generator descendant reaped: " + pid,
      );
    }
  },
);
