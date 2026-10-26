import assert from "node:assert/strict";
import { test } from "node:test";
import { windowsResourceUsageSchema } from "../src/windows-execution.js";
import { runProcess } from "../src/runner.js";
import { fixture } from "./helpers.js";

const native = { skip: process.platform !== "win32", timeout: 60000 };
test(
  "native Windows resource receipt binds direct CPU and working set separately from two reaped descendants and job CPU",
  native,
  async (t) => {
    const root = await fixture(t, {});
    const { spawnSync } = await import("node:child_process");
    const { writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    // Compile this independent read-only job observer before starting the
    // measured job. Its two invocations are accounted for as actual members.
    const observerSource = path.join(root, "ObserveJob.cs"),
      observer = path.join(root, "ObserveJob.exe");
    await writeFile(
      observerSource,
      String.raw`using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ObserveJob {
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long User, Kernel, PeriodUser, PeriodKernel;
    public uint Faults, Total, Active, Terminated;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(
    IntPtr job, int kind, out Accounting info, uint length, IntPtr returned);
  public static void Main() {
    Accounting info;
    if (!QueryInformationJobObject(IntPtr.Zero, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    Console.WriteLine("{\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id +
      ",\"user100ns\":" + info.User + ",\"kernel100ns\":" + info.Kernel +
      ",\"active\":" + info.Active + ",\"total\":" + info.Total + "}");
  }
}`,
    );
    const compiler = String.raw`$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[void][Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$data=([Web.Script.Serialization.JavaScriptSerializer]::new()).DeserializeObject([Console]::In.ReadToEnd())
Add-Type -Path $data.source -OutputAssembly $data.output -OutputType ConsoleApplication
`;
    const compiled = spawnSync(
      path.win32.join(
        process.env.SystemRoot ?? process.env.SYSTEMROOT!,
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(compiler, "utf16le").toString("base64"),
      ],
      {
        encoding: "utf8",
        input: JSON.stringify({ source: observerSource, output: observer }),
        timeout: 15000,
      },
    );
    assert.equal(compiled.error, undefined);
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    // A short userspace loop can leave Windows' sampled kernel CPU at zero.
    // Arm both fields through observed work rather than weakening comparisons.
    const kernelWitness = String.raw`const fs=require('node:fs');const kernelStart=process.cpuUsage().system,kernelDeadline=performance.now()+5000;while(process.cpuUsage().system-kernelStart<20000&&performance.now()<kernelDeadline){for(let i=0;i<100;i++)fs.statSync(process.execPath);}if(process.cpuUsage().system-kernelStart<20000)throw Error('Original Windows kernel CPU witness did not reach its observed minimum');`;
    const childSource = String.raw`const b=Buffer.alloc(Number(process.argv[1])*1024*1024,7);${kernelWitness}const end=performance.now()+150;while(performance.now()<end){};console.log(JSON.stringify({pid:process.pid,cpu:process.cpuUsage(),rss:process.resourceUsage().maxRSS,bytes:b.length}));`;
    const source = String.raw`const {spawnSync}=require('node:child_process');const touched=Buffer.alloc(32*1024*1024,7),reserved=Buffer.allocUnsafe(256*1024*1024),children=[];const observe=()=>{const r=spawnSync(process.argv[1],[],{encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);return JSON.parse(r.stdout);};const beforeJob=observe();
for(const size of [64,96]){const r=spawnSync(process.execPath,['-e',${JSON.stringify(childSource)},String(size)],{encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);children.push(JSON.parse(r.stdout));}
const afterJob=observe();${kernelWitness}const end=performance.now()+150;while(performance.now()<end){};console.log(JSON.stringify({pid:process.pid,cpu:process.cpuUsage(),rss:process.resourceUsage().maxRSS,touched:touched.length,reserved:reserved.length,children,beforeJob,afterJob}));`;
    const result = await runProcess(
      root,
      {
        executable: process.execPath,
        args: ["-e", source, observer],
        cwd: ".",
      },
      { timeoutMs: 45000 },
    );
    assert.equal(result.errorCode, undefined, result.stderr);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.timedOut, false);
    assert.equal(result.truncated, false);
    const receipt = result.windowsExecution!;
    assert.equal(receipt.phase, "completed");
    assert.equal(receipt.cleanup, "confirmed");
    assert.equal(receipt.activeAfterCleanup, 0);
    const usage = windowsResourceUsageSchema.parse(receipt.resources);
    assert.equal(usage.state, "collected", JSON.stringify(usage));
    if (usage.state !== "collected") throw Error("Native counters unavailable");
    const own = JSON.parse(result.stdout);
    assert.equal(own.pid, receipt.childPid);
    assert.equal(
      new Set([
        own.pid,
        own.beforeJob.pid,
        own.afterJob.pid,
        ...own.children.map((c: { pid: number }) => c.pid),
      ]).size,
      5,
    );
    assert.deepEqual(
      own.children.map((c: { bytes: number }) => c.bytes),
      [64, 96].map((n) => n * 1024 * 1024),
    );
    assert.equal(own.beforeJob.total, 2);
    assert.equal(own.afterJob.total, 5);
    assert.equal(own.beforeJob.active, 2);
    assert.equal(own.afterJob.active, 2);
    assert.equal(usage.totalJobProcesses, 5);
    for (const [field, nativeField] of [
      ["user", "user100ns"],
      ["system", "kernel100ns"],
    ] as const) {
      assert.ok(own.cpu[field] > 0);
      assert.ok(usage.processCpu[nativeField] >= own.cpu[field] * 10);
      const childCpu = own.children.reduce(
        (n: number, c: { cpu: { user: number; system: number } }) =>
          n + c.cpu[field],
        0,
      );
      assert.ok(childCpu > 0);
      assert.ok(Number.isSafeInteger(own.beforeJob[nativeField]));
      assert.ok(Number.isSafeInteger(own.afterJob[nativeField]));
      assert.ok(own.beforeJob[nativeField] >= 0);
      assert.ok(
        own.afterJob[nativeField] > own.beforeJob[nativeField],
        "The same native job counter must observe work while descendants run",
      );
      assert.ok(
        usage.jobCpu[nativeField] >= own.afterJob[nativeField],
        "Final job CPU must retain the independent earlier observation of that exact job",
      );
    }
    assert.ok(usage.peakWorkingSetBytes >= own.rss * 1024);
    assert.ok(
      usage.peakWorkingSetBytes <= own.rss * 1024 + 8 * 1024 * 1024,
      "Direct peak working set must match the target's own native RSS observation, rather than job commit or summed child peaks",
    );
    assert.ok(
      usage.peakWorkingSetBytes <
        own.children.reduce(
          (n: number, c: { rss: number }) => n + c.rss * 1024,
          0,
        ),
    );
  },
);

test(
  "native Windows resource collection preserves a failed target exit and collects only after owned-job cleanup",
  native,
  async (t) => {
    const root = await fixture(t, {});
    const result = await runProcess(
      root,
      {
        executable: process.execPath,
        args: [
          "-e",
          "const b=Buffer.alloc(16*1024*1024,7);const end=performance.now()+100;while(performance.now()<end){};process.stdout.write(String(b.length));process.exit(7);",
        ],
        cwd: ".",
      },
      { timeoutMs: 30000 },
    );
    assert.equal(result.errorCode, undefined, result.stderr);
    assert.equal(result.exitCode, 7);
    assert.equal(result.stdout, String(16 * 1024 * 1024));
    assert.equal(result.windowsExecution!.cleanup, "confirmed");
    const usage = windowsResourceUsageSchema.parse(
      result.windowsExecution!.resources,
    );
    assert.equal(usage.state, "collected", JSON.stringify(usage));
    if (usage.state !== "collected") throw Error("Native counters unavailable");
    assert.ok(usage.peakWorkingSetBytes >= 16 * 1024 * 1024);
    assert.equal(usage.totalJobProcesses, 1);
  },
);

test(
  "native Windows source integrity refuses changed fixed compiler bytes before project execution",
  native,
  async (t) => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const root = await fixture(t, {
      "check.mjs": String.raw`import assert from'node:assert/strict';import{createRequire,syncBuiltinESMExports}from'node:module';import{appendFileSync,existsSync}from'node:fs';import path from'node:path';const cp=createRequire(import.meta.url)('node:child_process');const original=cp.spawn;let reached=0;cp.spawn=function(executable,args,options){if(args[0]==='-e'&&args[1].includes('const supervisor=process.argv[1]')){appendFileSync(path.join(options.cwd,'native.cs'),'\n');reached++;}return original.call(this,executable,args,options);};syncBuiltinESMExports();try{const{runProcess}=await import(process.argv[2]);const r=await runProcess(process.cwd(),{executable:process.execPath,args:['-e',"require('node:fs').writeFileSync('must-not-run.txt','Original execution marker');"],cwd:'.'},{timeoutMs:15000});assert.equal(reached,1);assert.equal(existsSync('must-not-run.txt'),false,'Changed fixed source must refuse before project execution');assert.notEqual(r.errorCode,undefined);assert.equal(r.exitCode,null);}finally{cp.spawn=original;syncBuiltinESMExports();}`,
    });
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "check.mjs"),
        new URL("../src/runner.js", import.meta.url).href,
      ],
      { cwd: root, env, encoding: "utf8", timeout: 20000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  },
);

test(
  "native Windows bootstrap protects a new workspace under a broadly readable temp parent before writing source or request data",
  native,
  async (t) => {
    const { realpath, readdir } = await import("node:fs/promises");
    const { createRequire, syncBuiltinESMExports } =
      await import("node:module");
    const path = await import("node:path");
    const { ensureWindowsTaskAccess } =
      await import("../src/windows-task-access.js");
    const { windowsKeeperSource } = await import("../src/windows-native.js");
    const cp = createRequire(import.meta.url)(
      "node:child_process",
    ) as typeof import("node:child_process");
    const root = await realpath(await fixture(t, {})),
      parent = await realpath(await fixture(t, {}));
    ensureWindowsTaskAccess(parent, "directory", true);
    const script = String.raw`$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[void][Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$json=[Web.Script.Serialization.JavaScriptSerializer]::new()
$r=$json.DeserializeObject([Console]::In.ReadToEnd())
$item=[IO.DirectoryInfo]::new($r.path)
$acl=$item.GetAccessControl()
$rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[Security.AccessControl.FileSystemRights]::ReadAndExecute,[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
$item.SetAccessControl($acl)
`;
    const broaden = cp.spawnSync(
      path.win32.join(
        process.env.SystemRoot ?? process.env.SYSTEMROOT!,
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        encoding: "utf8",
        input: JSON.stringify({ path: parent }),
        timeout: 15000,
      },
    );
    assert.equal(broaden.status, 0, broaden.stderr);
    assert.throws(
      () => ensureWindowsTaskAccess(parent, "directory", false),
      "The inheritable broad-parent condition must actually be armed",
    );
    const previous = Object.fromEntries(
      ["TMPDIR", "TMP", "TEMP"].map((k) => [k, process.env[k]]),
    );
    const original = cp.spawn;
    let inspected = 0,
      namespace: string | undefined;
    const intercept: typeof cp.spawn = (...args: unknown[]) => {
      const argv = Array.isArray(args[1]) ? args[1] : [],
        options = (Array.isArray(args[1]) ? args[2] : args[1]) as
          { cwd?: string } | undefined;
      if (argv[0] === "-e" && argv[1] === windowsKeeperSource) {
        namespace = String(options?.cwd);
        ensureWindowsTaskAccess(namespace, "directory", false);
        inspected++;
      }
      return Reflect.apply(original, cp, args);
    };
    try {
      for (const name of Object.keys(previous)) process.env[name] = parent;
      cp.spawn = intercept;
      syncBuiltinESMExports();
      const result = await runProcess(
        root,
        {
          executable: process.execPath,
          args: ["-e", "process.stdout.write('Original private bootstrap.');"],
          cwd: ".",
        },
        { timeoutMs: 45000 },
      );
      assert.equal(result.errorCode, undefined, result.stderr);
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, "Original private bootstrap.");
      assert.equal(result.windowsExecution!.cleanup, "confirmed");
      assert.equal(inspected, 1);
      assert.throws(
        () => ensureWindowsTaskAccess(parent, "directory", false),
        "The runner must protect only its newly owned namespace and preserve its existing parent",
      );
      assert.deepEqual(await readdir(parent), []);
      assert.ok(namespace);
    } finally {
      cp.spawn = original;
      syncBuiltinESMExports();
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  },
);
