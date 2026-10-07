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
import {
  dotnetFormatFixture,
  replaceDotnetFormatSource,
} from "./dotnet-format-fixture.js";
const available =
  !!process.env.CHECKTRAIL_DOTNET_BUILD_CACHE &&
  spawnSync("dotnet", ["--list-sdks"], { encoding: "utf8" }).stdout?.includes(
    "10.0.401 [",
  );
const native = {
  skip: available
    ? false
    : "Pinned native .NET SDK/dependency cache not selected",
  timeout: 300000,
};
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
async function connect(root: string, allow: boolean) {
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
  "native .NET whitespace CLI and negotiated MCP preserve defects privacy and operator-only trust",
  native,
  async (t) => {
    const { root } = await dotnetFormatFixture(t),
      original = await replaceDotnetFormatSource(
        root,
        "CSharp/Counter.cs",
        "int value",
        "int  value",
      );
    const invoke = (trusted: boolean, detailed: boolean) =>
      spawnSync(
        process.execPath,
        [
          cli,
          "run",
          "--root",
          root,
          "--timeout-ms",
          "120000",
          ...(trusted ? ["--trust-project"] : []),
          ...(detailed ? ["--detailed"] : []),
        ],
        { encoding: "utf8", timeout: 150000, maxBuffer: 4 * 1024 * 1024 },
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
        (f) => f.ruleId === "dotnet-format/WHITESPACE",
      ).map((f) => [f.file, f.line]),
      [["CSharp/Counter.cs", 5]],
    );
    const summary = invoke(true, false);
    assert.equal(summary.status, 1, summary.stderr);
    const summarized = JSON.parse(summary.stdout);
    assert.equal(summarized.outcome, "failed");
    assert.ok(
      !summary.stdout.includes(root) &&
        !summary.stdout.includes("Counter.cs") &&
        !summary.stdout.includes("int  value"),
    );
    const client = await connect(root, true);
    try {
      const result = await client.callTool(
        { name: "validation_run", arguments: { timeoutMs: 120000 } },
        { timeout: 150000 },
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
          !JSON.stringify(result).includes("Counter.cs"),
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
      await writeFile(path.join(root, "CSharp/Counter.cs"), original);
      const fixed = await client.callTool(
        { name: "validation_run", arguments: { timeoutMs: 120000 } },
        { timeout: 150000 },
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
  "native .NET whitespace cancellation reaches the workspace BuildHost and reaps loader descendants and temporary outputs",
  native,
  async (t) => {
    const { root } = await dotnetFormatFixture(t),
      marker = path.join(root, ".checktrail/format-started"),
      control = path.join(root, "original-format-wait.cjs");
    const script = `const fs=require('node:fs');let pid=process.pid,observer=0,host=0;for(let count=0;count<32&&pid>1;count++){const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0');if(args.some(a=>a.endsWith('/BuildHost-netcore/Microsoft.CodeAnalysis.Workspaces.MSBuild.BuildHost.dll')))host=pid;if(args.some(a=>a.endsWith('/format/ChecktrailFormat.dll'))){observer=pid;break;}const parent=/^PPid:\\s+(\\d+)$/m.exec(fs.readFileSync('/proc/'+pid+'/status','utf8'));if(!parent)break;pid=Number(parent[1]);}const marker=process.env.CHECKTRAIL_DOTNET_FORMAT_STARTED;fs.writeFileSync(marker+'.prepared',JSON.stringify({pid:process.pid,observer,host,owned:observer>1&&host>1,scratch:process.env.TMPDIR,owner:process.env.CHECKTRAIL_TEMP}));fs.renameSync(marker+'.prepared',marker);setTimeout(()=>{},60000);`;
    await writeFile(control, script);
    const project = path.join(root, "CSharp/CSharp.csproj"),
      original = await readFile(project, "utf8");
    assert.equal(original.split("</Project>").length, 2);
    await writeFile(
      project,
      original.replace(
        "</Project>",
        `<Target Name="OriginalFormatPause" BeforeTargets="Compile" Condition="'$(DesignTimeBuild)' == 'true'"><Exec Command="node &quot;$(MSBuildProjectDirectory)/../original-format-wait.cjs&quot;" /></Target></Project>`,
      ),
    );
    await writeFile(
      path.join(root, "checktrail.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          {
            path: ".",
            checks: ["dotnet.format-whitespace"],
            environment: ["CHECKTRAIL_DOTNET_FORMAT_STARTED"],
          },
        ],
      }),
    );
    const commandTemporary = await mkdtemp(
        path.join(tmpdir(), "checktrail-dotnet-format-cancel-"),
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
        environment: { CHECKTRAIL_DOTNET_FORMAT_STARTED: marker },
      });
    let record:
      | {
          pid: number;
          observer: number;
          host: number;
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
          "Native workspace BuildHost was not reached: " +
            JSON.stringify(
              stopped.checks.map((c) => ({
                status: c.status,
                reason: c.reason,
                stderr: c.processes.map((p) => p.stderr.slice(0, 512)),
              })),
            ),
        );
      }
      assert.ok(
        record.scratch &&
          record.owner &&
          record.scratch.startsWith(record.owner + path.sep),
        "Native scratch belongs to the owned command directory",
      );
      assert.equal(
        record.owned,
        true,
        "Descendant belongs to the exact original observer and native SDK workspace BuildHost",
      );
      for (const pid of [record.pid, record.observer, record.host])
        assert.ok(Number.isSafeInteger(pid) && pid > 1);
    } finally {
      controller.abort();
      await running;
    }
    const report = await running;
    assert.equal(report.outcome, "incomplete");
    assert.ok(report.checks[0]!.processes.some((p) => p.cancelled));
    assert.deepEqual((await readdir(commandTemporary)).sort(), before);
    await assert.rejects(access(path.join(root, "CSharp/obj")));
    await assert.rejects(access(record!.scratch));
    for (const pid of [record!.pid, record!.host, record!.observer]) {
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
      assert.equal(alive, false, "Owned native process reaped: " + pid);
    }
  },
);
