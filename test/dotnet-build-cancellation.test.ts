import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { validate } from "../src/engine.js";
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
