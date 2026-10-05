import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { validate } from "../src/engine.js";
import { reportSchema } from "../src/schemas.js";
import { dotnetBuildFixture } from "./dotnet-build-fixture.js";
const available =
  !!process.env.CHECKTRAIL_DOTNET_BUILD_CACHE &&
  spawnSync("dotnet", ["--list-sdks"], { encoding: "utf8" }).stdout?.includes(
    "10.0.401 [",
  );
const native = {
  skip: available
    ? false
    : "Pinned native .NET SDK/dependency cache not selected",
  timeout: 180000,
};
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
async function connect(root: string, allow: boolean) {
  const client = new Client(
    { name: "original-dotnet-build-client", version: "1.0.0" },
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
  "native .NET build CLI and negotiated MCP preserve source failures privacy and operator-only trust",
  native,
  async (t) => {
    const { root } = await dotnetBuildFixture(t),
      source = path.join(root, "CSharp/Counter.cs"),
      original = await readFile(source);
    await writeFile(
      source,
      "namespace Example; public static class Counter { public static int Next(int value) => original_missing_symbol; }\n",
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
        { encoding: "utf8", timeout: 40000, maxBuffer: 4 * 1024 * 1024 },
      );
    const denied = invoke(false, false);
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /trust/i);
    const detailed = invoke(true, true);
    assert.equal(detailed.status, 1, detailed.stderr);
    const report = reportSchema.parse(JSON.parse(detailed.stdout));
    assert.equal(report.outcome, "failed");
    assert.equal(report.checks[0]!.status, "failed");
    assert.equal(report.checks[0]!.findingsComplete, false);
    const summary = invoke(true, false);
    assert.equal(summary.status, 1, summary.stderr);
    const summarized = JSON.parse(summary.stdout);
    assert.equal(summarized.outcome, "failed");
    assert.ok(
      !summary.stdout.includes(root) &&
        !summary.stdout.includes("original_missing_symbol") &&
        !summary.stdout.includes("Counter.cs"),
    );
    const client = await connect(root, true);
    try {
      const result = await client.callTool({
        name: "validation_run",
        arguments: {},
      });
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
          !JSON.stringify(result).includes("original_missing_symbol"),
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
      await writeFile(source, original);
      const fixed = await client.callTool({
        name: "validation_run",
        arguments: {},
      });
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
  "native .NET build cancellation reaches the owned MSBuild client and removes descendants and temporary outputs",
  native,
  async (t) => {
    const { root } = await dotnetBuildFixture(t),
      marker = path.join(root, ".checktrail/started"),
      control = path.join(root, "original-wait.cjs");
    const script = `const fs=require('node:fs');let pid=process.pid,build=0;for(let count=0;count<32&&pid>1;count++){const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0');if(args.includes('/usr/share/dotnet/sdk/10.0.401/MSBuild.dll')){build=pid;break;}const parent=/^PPid:\\s+(\\d+)$/m.exec(fs.readFileSync('/proc/'+pid+'/status','utf8'));if(!parent)break;pid=Number(parent[1]);}const marker=process.env.CHECKTRAIL_DOTNET_STARTED;fs.writeFileSync(marker+'.prepared',JSON.stringify({pid:process.pid,build,owned:build>1,scratch:process.env.TMPDIR,owner:process.env.CHECKTRAIL_TEMP}));fs.renameSync(marker+'.prepared',marker);setTimeout(()=>{},60000);`;
    await writeFile(control, script);
    const project = path.join(root, "CSharp/CSharp.csproj"),
      xml = await readFile(project, "utf8");
    await writeFile(
      project,
      xml.replace(
        "</Project>",
        '<Target Name="OriginalWait" BeforeTargets="CoreCompile"><Exec Command="node ../original-wait.cjs" /></Target></Project>',
      ),
    );
    await writeFile(
      path.join(root, "checktrail.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          {
            path: ".",
            checks: ["dotnet.build"],
            environment: ["CHECKTRAIL_DOTNET_STARTED"],
          },
        ],
      }),
    );
    const commandTemporary = path.join(root, ".checktrail/cancel-temporary"),
      previous = process.env.TMPDIR;
    await mkdir(commandTemporary);
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
        environment: { CHECKTRAIL_DOTNET_STARTED: marker },
      });
    let record:
      | {
          pid: number;
          build: number;
          owned: boolean;
          scratch: string;
          owner: string;
        }
      | undefined;
    try {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        try {
          record = JSON.parse(await readFile(marker, "utf8"));
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(record, "Native project target reached before cancellation");
      assert.ok(
        record.scratch &&
          record.owner &&
          record.scratch.startsWith(record.owner + path.sep),
        "Native scratch belongs to the owned command directory",
      );
      assert.equal(
        record.owned,
        true,
        "Descendant belongs to the exact selected MSBuild client",
      );
      assert.ok(
        Number.isSafeInteger(record.pid) &&
          record.pid > 1 &&
          Number.isSafeInteger(record.build) &&
          record.build > 1,
      );
    } finally {
      controller.abort();
      await running;
    }
    const report = await running;
    assert.equal(report.outcome, "incomplete");
    assert.ok(report.checks[0]!.processes.some((process) => process.cancelled));
    assert.deepEqual((await readdir(commandTemporary)).sort(), before);
    await assert.rejects(access(path.join(root, "CSharp/obj")));
    await assert.rejects(access(record!.scratch));
    for (const pid of [record!.pid, record!.build]) {
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
