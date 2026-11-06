import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { lifecycleChildBody } from "./lifecycle-child-fixture.js";

async function waitForFile(filename: string, child: ChildProcess) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    try {
      return await readFile(filename, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (child.exitCode !== null || child.signalCode !== null)
      throw Error("Original child exited before publication");
    await delay(10);
  }
  throw Error("Original child publication was not observed");
}

test("lifecycle child publication withholds empty and partial PID writes until complete", async (t) => {
  for (const state of ["empty", "partial"] as const) {
    await t.test(state, async (t) => {
      const root = await mkdtemp(
        path.join(tmpdir(), "checktrail-child-publication-"),
      );
      t.after(() => rm(root, { recursive: true, force: true }));
      const marker = path.join(root, "child"),
        opened = path.join(root, "opened"),
        release = path.join(root, "release");
      // Pause the real producer after opening its output, before the full PID write.
      const gate = `{const fs=require('node:fs'),original=fs.writeFileSync;fs.writeFileSync=(file,value,...options)=>{original(file,process.argv[4]==='empty'?'':String(process.pid).slice(0,-1));original(process.argv[2],'opened');while(!fs.existsSync(process.argv[3]))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);return original(file,value,...options);};}`;
      const child = spawn(
          process.execPath,
          ["-e", gate + lifecycleChildBody, marker, opened, release, state],
          { stdio: "ignore" },
        ),
        exited = once(child, "exit");
      try {
        await waitForFile(opened, child);
        await assert.rejects(access(marker), { code: "ENOENT" });
        await writeFile(release, "Original publication release");
        assert.equal(await waitForFile(marker, child), String(child.pid));
        await assert.rejects(access(marker + ".partial"), { code: "ENOENT" });
      } finally {
        child.kill("SIGKILL");
        await exited;
      }
    });
  }
});
