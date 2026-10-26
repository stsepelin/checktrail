import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import { runProcess } from "../src/runner.js";
import { processSnapshot, type ProcessIdentity } from "../src/process-tree.js";
import { fixture } from "./helpers.js";
import {
  cleanupLifecycleIdentities,
  lifecycleAlive,
  lifecycleWait,
} from "./lifecycle-platforms-fixture.js";

type Reached = { body: number; children: [number, number]; temp?: string };
async function nativeBody(t: TestContext) {
  const root = await realpath(await fixture(t, {})),
    control = await realpath(await fixture(t, {})),
    marker = path.join(control, "reached.json"),
    release = path.join(control, "release"),
    file = path.join(root, "original-worker.mjs");
  const leaf =
    "require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);setTimeout(()=>process.exit(0),60000);";
  await writeFile(
    file,
    `import{spawn}from'node:child_process';import{readFile,writeFile,rename}from'node:fs/promises';import{setTimeout as delay}from'node:timers/promises';
const control=${JSON.stringify(control)},marker=${JSON.stringify(marker)},release=${JSON.stringify(release)};
const children=[false,true].map((detached,i)=>spawn(process.execPath,['-e',${JSON.stringify(leaf)},control+'/leaf-'+i],{detached,stdio:'ignore'}));
for(let i=0;i<children.length;i++){for(;;){try{if(Number(await readFile(control+'/leaf-'+i,'utf8'))===children[i].pid)break;}catch(error){if(error.code!=='ENOENT')throw error;}await delay(10);}}
await writeFile(marker+'.partial',JSON.stringify({body:process.pid,children:children.map(child=>child.pid),temp:process.env.CHECKTRAIL_TEMP}));await rename(marker+'.partial',marker);
setInterval(()=>{},1000);for(;;){try{await readFile(release);break;}catch(error){if(error.code!=='ENOENT')throw error;}await delay(10);}for(;;){if(!process.stdout.write(Buffer.alloc(65536,120)))await new Promise(resolve=>process.stdout.once('drain',resolve));}
`,
  );
  const observe = async () =>
    await lifecycleWait(
      async () => {
        try {
          return JSON.parse(await readFile(marker, "utf8")) as Reached;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      },
      process.platform === "win32" ? 30000 : 7000,
    );
  const capture = async (reached: Reached) => {
    const ids = [...reached.children, reached.body];
    assert.equal(new Set(ids).size, 3);
    assert.ok(ids.every(lifecycleAlive));
    if (process.platform === "win32") return [];
    const all = await processSnapshot();
    return ids.map((pid) => {
      const row = all.find((value) => value.pid === pid);
      assert.ok(row);
      return row;
    });
  };
  const stopped = async (reached: Reached) =>
    await lifecycleWait(
      async () =>
        [...reached.children, reached.body].every((pid) => !lifecycleAlive(pid))
          ? true
          : undefined,
      process.platform === "win32" ? 10000 : 5000,
      "Original reached ordinary/detached lifecycle family survived interruption",
    );
  return { root, control, marker, release, file, observe, capture, stopped };
}
export async function lifecycleInterruption(t: TestContext) {
  const sibling = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    }),
    siblingExit = once(sibling, "exit");
  try {
    for (const mode of ["cancel", "deadline", "output"] as const) {
      const d = await nativeBody(t),
        controller = new AbortController();
      const running = runProcess(
        d.root,
        {
          executable: process.execPath,
          args: [d.file],
          cwd: ".",
          temporaryDirectory: true,
        },
        {
          timeoutMs:
            mode === "deadline"
              ? process.platform === "win32"
                ? 15000
                : 4000
              : 30000,
          maxOutputBytes: mode === "output" ? 1024 : 4096,
          signal: controller.signal,
          captureRawOutput: true,
        },
      );
      void running.catch(() => {});
      let rows: ProcessIdentity[] = [];
      try {
        const reached = await d.observe();
        rows = await d.capture(reached);
        assert.ok(reached.temp);
        assert.equal((await lstat(reached.temp!)).isDirectory(), true);
        if (mode === "cancel") controller.abort();
        if (mode === "output")
          await writeFile(d.release, "Original output release.");
        const result = await running;
        assert.equal(result.errorCode, undefined);
        assert.equal(result.cancelled, mode === "cancel");
        assert.equal(result.timedOut, mode === "deadline");
        assert.equal(result.truncated, mode === "output");
        if (mode === "output") {
          assert.ok(result.outputBytes > 1024);
          assert.equal(
            result.capturedOutput!.completeForObservedStreams,
            false,
          );
          assert.equal(
            result.capturedOutput!.stdout.bytes +
              result.capturedOutput!.stderr.bytes,
            1024,
          );
        }
        if (process.platform === "win32") {
          assert.equal(result.windowsExecution!.cleanup, "confirmed");
          assert.ok(result.windowsExecution!.activeBeforeCleanup! >= 3);
          assert.equal(result.windowsExecution!.activeAfterCleanup, 0);
        } else assert.equal(result.signal, "SIGKILL");
        await d.stopped(reached);
        await assert.rejects(access(reached.temp!), { code: "ENOENT" });
        assert.equal(lifecycleAlive(sibling.pid!), true);
      } finally {
        controller.abort();
        await Promise.allSettled([running]);
        await cleanupLifecycleIdentities(rows);
      }
    }
    const d = await nativeBody(t),
      controllerFile = path.join(d.control, "controller.mjs"),
      runner = import.meta.resolve("../src/runner.js");
    await writeFile(
      controllerFile,
      `import{runProcess}from${JSON.stringify(runner)};await runProcess(${JSON.stringify(d.root)},{executable:process.execPath,args:[${JSON.stringify(d.file)}],cwd:'.'},{timeoutMs:60000,captureRawOutput:true});`,
    );
    const controller = spawn(process.execPath, [controllerFile], {
        stdio: "ignore",
      }),
      exited = once(controller, "exit");
    let rows: ProcessIdentity[] = [];
    try {
      const reached = await d.observe();
      rows = await d.capture(reached);
      controller.kill("SIGKILL");
      await exited;
      await d.stopped(reached);
      assert.equal(lifecycleAlive(sibling.pid!), true);
    } finally {
      if (controller.exitCode === null && controller.signalCode === null)
        controller.kill("SIGKILL");
      await exited;
      await cleanupLifecycleIdentities(rows);
    }
  } finally {
    if (sibling.exitCode === null && sibling.signalCode === null)
      sibling.kill("SIGKILL");
    await siblingExit;
    await delay(20);
  }
}
