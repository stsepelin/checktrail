import assert from "node:assert/strict";
import childProcesses, { spawn, type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import {
  access,
  cp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runProcess } from "../src/runner.js";
import {
  processSnapshot,
  stopDescendants,
  type ProcessIdentity,
} from "../src/process-tree.js";
import { fixture } from "./helpers.js";
const posix = ["darwin", "linux"].includes(process.platform),
  runner = new URL("../src/runner.js", import.meta.url).href;
async function waitFor<T>(
  read: () => Promise<T | undefined>,
  ms = 7000,
): Promise<T> {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    const result = await read();
    if (result !== undefined) return result;
    await delay(10);
  }
  throw Error("Original POSIX owner readiness was not reached");
}
async function marker(file: string) {
  return await waitFor(async () => {
    try {
      return JSON.parse(await readFile(file, "utf8")) as {
        pid: number;
        ordinary: number;
        detached: number;
        keeper?: number;
      };
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof SyntaxError)
      )
        throw error;
    }
  });
}
async function identities(pids: number[]) {
  const snapshot = await processSnapshot(pids);
  return pids.map((pid) => {
    const r = snapshot.find((r) => r.pid === pid);
    assert.ok(r, "Reached original process identity must be observable");
    return r;
  });
}
async function gone(rows: ProcessIdentity[]) {
  if (rows.length === 0) return;
  await waitFor(async () => {
    const current = await processSnapshot(rows.map((row) => row.pid));
    return rows.every(
      (row) =>
        !current.some((p) => p.pid === row.pid && p.identity === row.identity),
    )
      ? true
      : undefined;
  });
}
async function killOwned(rows: ProcessIdentity[]) {
  for (const row of rows) {
    const current = (await processSnapshot(row.pid)).find(
      (p) => p.pid === row.pid,
    );
    if (current?.identity === row.identity && current.group === row.group) {
      process.kill(row.pid, "SIGSTOP");
      await stopDescendants(row.pid, undefined, () => {
        try {
          process.kill(row.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      });
    }
  }
  await gone(rows);
}
async function originalTree(t: TestContext) {
  const root = await realpath(await fixture(t, {})),
    ready = path.join(root, "ready.json"),
    target = path.join(root, "target.mjs");
  await writeFile(
    target,
    `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const args=['-e','setInterval(()=>{},1000)'];const ordinary=spawn(process.execPath,args,{stdio:'ignore'}),detached=spawn(process.execPath,args,{detached:true,stdio:'ignore'});writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,ordinary:ordinary.pid,detached:detached.pid}));setInterval(()=>{},1000);`,
  );
  return { root, ready, target };
}
test(
  "native POSIX parent loss reaps reached ordinary and detached workers and the actual owner while preserving unrelated siblings",
  { skip: !posix, timeout: 60000 },
  async (t) => {
    const d = await originalTree(t),
      ownerFile = path.join(d.root, "controller.mjs");
    await writeFile(
      ownerFile,
      `import{runProcess}from${JSON.stringify(runner)};await runProcess(${JSON.stringify(d.root)},{executable:process.execPath,args:[${JSON.stringify(d.target)}],cwd:'.'},{timeoutMs:60000,captureRawOutput:true});`,
    );
    const sibling = spawn(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        { stdio: "ignore" },
      ),
      siblingExit = once(sibling, "exit"),
      owner = spawn(process.execPath, [ownerFile], { stdio: "ignore" }),
      ownerExit = once(owner, "exit");
    let owned: ProcessIdentity[] = [];
    try {
      const reached = await marker(d.ready);
      owned = await identities([
        reached.detached,
        reached.ordinary,
        reached.pid,
      ]);
      const parent = owned[2]!.parent;
      if (parent !== owner.pid) owned.push(...(await identities([parent])));
      assert.equal(new Set(owned.slice(0, 3).map((p) => p.pid)).size, 3);
      const siblingIdentity = (await identities([sibling.pid!]))[0]!;
      owner.kill("SIGKILL");
      await ownerExit;
      await gone(owned);
      assert.ok(
        (await processSnapshot()).some(
          (p) =>
            p.pid === siblingIdentity.pid &&
            p.identity === siblingIdentity.identity,
        ),
      );
    } finally {
      await killOwned(owned);
      if (owner.exitCode === null && owner.signalCode === null)
        owner.kill("SIGKILL");
      await ownerExit;
      sibling.kill();
      await siblingExit;
    }
  },
);
test(
  "native POSIX parent loss during a stopped real owner bootstrap reaches no project code after that owner resumes",
  { skip: !posix, timeout: 60000 },
  async (t) => {
    const d = await originalTree(t),
      file = path.join(d.root, "bootstrap.mjs"),
      held = path.join(d.root, "held.json");
    await writeFile(
      file,
      `import cp from'node:child_process';import{writeFileSync}from'node:fs';import{syncBuiltinESMExports}from'node:module';const original=cp.fork;cp.fork=(...args)=>{const child=Reflect.apply(original,cp,args);child.kill('SIGSTOP');writeFileSync(${JSON.stringify(held)},JSON.stringify({keeper:child.pid}));return child;};syncBuiltinESMExports();const{runProcess}=await import(${JSON.stringify(runner)});await runProcess(${JSON.stringify(d.root)},{executable:process.execPath,args:[${JSON.stringify(d.target)}],cwd:'.'},{timeoutMs:60000});`,
    );
    const owner = spawn(process.execPath, [file], { stdio: "ignore" }),
      exit = once(owner, "exit");
    let owned: ProcessIdentity[] = [];
    try {
      const reached = await marker(held);
      assert.ok(reached.keeper && reached.keeper > 1);
      owned = await identities([reached.keeper!]);
      await assert.rejects(access(d.ready), { code: "ENOENT" });
      owner.kill("SIGKILL");
      await exit;
      process.kill(reached.keeper!, "SIGCONT");
      await gone(owned);
      await assert.rejects(access(d.ready), { code: "ENOENT" });
    } finally {
      await killOwned(owned);
      if (owner.exitCode === null && owner.signalCode === null)
        owner.kill("SIGKILL");
      await exit;
    }
  },
);
test(
  "native POSIX completed roots release ordinary orphaned group members before returning original output and status",
  { skip: !posix, timeout: 30000 },
  async (t) => {
    const root = await realpath(await fixture(t, {})),
      ready = path.join(root, "child.json");
    let owned: ProcessIdentity[] = [];
    try {
      const result = await runProcess(
        root,
        {
          executable: process.execPath,
          args: [
            "-e",
            `const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:child.pid}));child.unref();process.stdout.write('Original completed body.');`,
          ],
          cwd: ".",
        },
        { timeoutMs: 10000, captureRawOutput: true },
      );
      const value = JSON.parse(await readFile(ready, "utf8")) as {
        pid: number;
      };
      const current = await processSnapshot(value.pid);
      owned = current.filter((p) => p.pid === value.pid);
      assert.equal(result.exitCode, 0);
      assert.equal(result.errorCode, undefined);
      assert.equal(result.cancelled, false);
      assert.equal(result.timedOut, false);
      assert.equal(result.stdout, "Original completed body.");
      assert.equal(result.capturedOutput!.completeForObservedStreams, true);
      assert.equal(
        owned.length,
        0,
        "The actual ordinary child must be reaped before completion",
      );
    } finally {
      await killOwned(owned);
    }
  },
);
async function copiedRuntime(t: TestContext) {
  const root = await realpath(
    await fixture(t, { "package.json": '{"type":"module"}' }),
  );
  await cp(
    fileURLToPath(new URL("../src", import.meta.url)),
    path.join(root, "src"),
    { recursive: true, dereference: true },
  );
  await symlink(
    fileURLToPath(new URL("../../node_modules", import.meta.url)),
    path.join(root, "node_modules"),
    "dir",
  );
  return {
    root,
    run: (await import(
      pathToFileURL(path.join(root, "src/runner.js")).href
    )) as typeof import("../src/runner.js"),
  };
}
test(
  "native POSIX absent and malformed private owners remain unavailable before project execution",
  { skip: !posix, timeout: 30000 },
  async (t) => {
    for (const mode of [
      "absent",
      "null",
      "foreign",
      "bad-digest",
      "bad-observed",
      "bad-text",
      "foreign-receipt",
      "wrong-pid",
      "wrong-parent",
      "wrong-group",
      "empty-identity",
      "long-identity",
    ]) {
      const d = await copiedRuntime(t),
        mark = path.join(d.root, "project-marker"),
        helper = path.join(d.root, "src/posix-owner-keeper.js");
      if (mode === "absent") await rm(helper);
      else if (mode === "null")
        await writeFile(
          helper,
          "process.send(null);setTimeout(()=>process.exit(0),1500);",
        );
      else if (
        [
          "foreign",
          "wrong-pid",
          "wrong-parent",
          "wrong-group",
          "empty-identity",
          "long-identity",
        ].includes(mode)
      )
        await writeFile(
          helper,
          `import{processSnapshot}from'./process-tree.js';import{spawn}from'node:child_process';const identity=(await processSnapshot(process.pid)).find(p=>p.pid===process.pid),mode=${JSON.stringify(mode)};let nonce=process.argv[2];if(mode==='foreign')nonce='original-foreign-nonce';if(mode==='wrong-pid')identity.pid+=1;if(mode==='wrong-parent')identity.parent+=1;if(mode==='wrong-group')identity.group+=1;if(mode==='empty-identity')identity.identity='';if(mode==='long-identity')identity.identity='x'.repeat(129);process.on('message',request=>{if(request.kind==='run'){const child=spawn(request.command.executable,request.command.args,{stdio:'ignore'});child.once('exit',()=>{if(process.connected)process.disconnect();});}});process.send({kind:'ready',nonce,identity});setTimeout(()=>process.exit(0),1500);`,
        );
      else
        await writeFile(
          helper,
          `import{processSnapshot}from'./process-tree.js';import{createHash}from'node:crypto';const nonce=process.argv[2],identity=(await processSnapshot(process.pid)).find(p=>p.pid===process.pid);process.send({kind:'ready',nonce,identity});process.once('message',request=>{const digest=b=>createHash('sha256').update(b).digest('hex'),blob=b=>({base64:b.toString('base64'),bytes:b.length,sha256:digest(b)});const result={command:request.command,exitCode:0,signal:null,stdout:'x',stderr:'',durationMs:1,timedOut:false,cancelled:false,truncated:false,outputBytes:1,capturedOutput:{profile:'bounded-physical-process-output-v1',stdout:blob(Buffer.from('x')),stderr:blob(Buffer.alloc(0)),observedBytes:1,completeForObservedStreams:true}};const mode=${JSON.stringify(mode)};if(mode==='bad-digest')result.capturedOutput.stdout.sha256='0'.repeat(64);if(mode==='bad-observed')result.outputBytes=2;if(mode==='bad-text')result.stdout='z';if(mode==='foreign-receipt')result.windowsExecution={profile:'original-foreign'};process.send({kind:'result',nonce,result},()=>process.disconnect());});`,
        );
      const result = await d.run.runProcess(
        d.root,
        {
          executable: process.execPath,
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(mark)},'unreachable')`,
          ],
          cwd: ".",
        },
        { timeoutMs: 10000, captureRawOutput: true },
      );
      assert.equal(result.exitCode, null);
      assert.equal(result.timedOut, false);
      assert.equal(result.cancelled, false);
      assert.equal(
        result.errorCode,
        mode === "absent"
          ? "POSIX_OWNER_UNAVAILABLE"
          : "POSIX_OWNER_PROTOCOL_INVALID",
      );
      await assert.rejects(access(mark), { code: "ENOENT" });
    }
  },
);

test(
  "native POSIX owner deadline resolves from actual bootstrap exit and IPC disconnect without requiring close",
  { skip: !posix, timeout: 15000 },
  async (t) => {
    const cp = await import("node:child_process"),
      { syncBuiltinESMExports } = await import("node:module"),
      api = cp.default,
      original = api.fork;
    const root = await realpath(await fixture(t, {})),
      marker = path.join(root, "unreached"),
      events: string[] = [];
    let child: ReturnType<typeof original> | undefined,
      resume: NodeJS.Timeout | undefined;
    const observer = t.mock.method(
      api,
      "fork",
      (...args: Parameters<typeof original>) => {
        const actual = Reflect.apply(original, api, args) as ReturnType<
          typeof original
        >;
        child = actual;
        actual.on("message", (message) => {
          if ((message as { kind?: string })?.kind === "ready")
            events.push("ready");
        });
        for (const name of ["exit", "disconnect", "close"])
          actual.on(name, () => events.push(name));
        actual.kill("SIGSTOP");
        resume = setTimeout(() => actual.kill("SIGCONT"), 400);
        return actual;
      },
    );
    syncBuiltinESMExports();
    const controller = new AbortController();
    let running: ReturnType<typeof runProcess> | undefined;
    try {
      running = runProcess(
        root,
        {
          executable: process.execPath,
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unreachable')`,
          ],
          cwd: ".",
        },
        { timeoutMs: 100, signal: controller.signal, captureRawOutput: true },
      );
      const result = await running;
      assert.equal(result.timedOut, true);
      assert.equal(result.cancelled, false);
      assert.equal(result.exitCode, null);
      assert.equal(result.signal, null);
      assert.ok(events.includes("exit") && events.includes("disconnect"));
      assert.equal(
        events.includes("ready"),
        false,
        "The actual owner must have lost its channel before readiness",
      );
      await assert.rejects(access(marker), { code: "ENOENT" });
    } finally {
      controller.abort();
      if (resume) clearTimeout(resume);
      observer.mock.restore();
      syncBuiltinESMExports();
      if (child && child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      if (running) await Promise.allSettled([running]);
    }
  },
);

test(
  "native POSIX missing owner interpreter reports unavailable and releases its private channel before any target starts",
  { skip: !posix, timeout: 15000 },
  async (t) => {
    const cp = (await import("node:child_process")).default,
      { syncBuiltinESMExports } = await import("node:module"),
      original = cp.fork;
    const root = await realpath(await fixture(t, {})),
      marker = path.join(root, "unreached");
    const observer = t.mock.method(
      cp,
      "fork",
      (
        file: string | URL,
        args: readonly string[],
        options: Parameters<typeof original>[2],
      ) =>
        Reflect.apply(original, cp, [
          file,
          args,
          {
            ...options,
            execPath: path.join(root, "original-absent-owner-interpreter"),
          },
        ]) as ReturnType<typeof original>,
    );
    syncBuiltinESMExports();
    try {
      const result = await runProcess(
        root,
        {
          executable: process.execPath,
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unreachable')`,
          ],
          cwd: ".",
        },
        { timeoutMs: 10000, captureRawOutput: true },
      );
      assert.equal(result.errorCode, "POSIX_OWNER_UNAVAILABLE");
      assert.equal(result.exitCode, null);
      assert.equal(result.signal, null);
      assert.equal(result.cancelled, false);
      assert.equal(result.timedOut, false);
      await assert.rejects(access(marker), { code: "ENOENT" });
    } finally {
      observer.mock.restore();
      syncBuiltinESMExports();
    }
  },
);

test(
  "native POSIX delayed owner bootstrap distinguishes an expired request from an actually missing executable",
  { skip: !posix, timeout: 45000 },
  async (t) => {
    const root = await realpath(await fixture(t, {})),
      executable = path.join(root, "missing-original-controlled-tool"),
      originalFork = childProcesses.fork,
      expectedOwner = await realpath(
        fileURLToPath(new URL("../src/posix-owner-keeper.js", import.meta.url)),
      );
    await assert.rejects(access(executable), { code: "ENOENT" });
    try {
      for (const timeoutMs of [5000, 15000]) {
        let child: ChildProcess | undefined,
          exit: Promise<unknown> | undefined,
          reached: ProcessIdentity | undefined,
          resume: ReturnType<typeof setTimeout> | undefined,
          resumeError: unknown,
          readinessFailure: unknown;
        childProcesses.fork = ((...args: Parameters<typeof originalFork>) => {
          assert.equal(String(args[0]), expectedOwner);
          const owner = Reflect.apply(
            originalFork,
            childProcesses,
            args,
          ) as ChildProcess;
          assert.ok(owner.pid);
          assert.equal(owner.kill("SIGSTOP"), true);
          child = owner;
          exit = once(owner, "exit");
          return owner;
        }) as typeof originalFork;
        syncBuiltinESMExports();
        const started = performance.now();
        const pending = runProcess(
          root,
          { executable, args: [], cwd: "." },
          { timeoutMs },
        );
        void pending.catch((error) => {
          readinessFailure = error;
        });
        try {
          reached = await waitFor(async () => {
            if (readinessFailure) throw readinessFailure;
            if (!child?.pid) return;
            const row = (await processSnapshot(child.pid)).find(
              (row) => row.pid === child!.pid,
            );
            return row?.state === "stopped" ? row : undefined;
          });
          assert.equal(reached.parent, process.pid);
          assert.equal(reached.group, child!.pid);
          resume = setTimeout(
            () => {
              void (async () => {
                const current = (await processSnapshot(reached!.pid)).find(
                  (row) => row.pid === reached!.pid,
                );
                if (
                  current?.identity === reached!.identity &&
                  current.group === reached!.group
                )
                  assert.equal(child!.kill("SIGCONT"), true);
              })().catch((error) => {
                resumeError = error;
              });
            },
            Math.max(1, 6500 - (performance.now() - started)),
          );
          const result = await pending;
          assert.equal(resumeError, undefined);
          assert.equal(result.cancelled, false);
          assert.equal(
            result.timedOut,
            timeoutMs === 5000,
            JSON.stringify(result),
          );
          assert.equal(
            result.errorCode,
            timeoutMs === 5000 ? undefined : "ENOENT",
            JSON.stringify(result),
          );
          if (timeoutMs === 5000) assert.equal(result.exitCode, null);
          else assert.notEqual(result.exitCode, 0);
          assert.equal(result.stdout, "");
          assert.equal(result.stderr, "");
          assert.equal(result.outputBytes, 0);
          await exit;
          await gone([reached]);
        } finally {
          clearTimeout(resume);
          childProcesses.fork = originalFork;
          syncBuiltinESMExports();
          if (
            child?.pid &&
            child.exitCode === null &&
            child.signalCode === null
          ) {
            const current = (await processSnapshot(child.pid)).find(
              (row) => row.pid === child!.pid,
            );
            if (current?.parent === process.pid && current.group === child.pid)
              await killOwned([current]);
          }
          await pending.catch(() => {});
          if (exit) await exit;
        }
      }
    } finally {
      childProcesses.fork = originalFork;
      syncBuiltinESMExports();
    }
  },
);

test(
  "native POSIX owner bootstrap uses only its own identity and refuses a failed selected identity without starting project code",
  { skip: !posix, timeout: 30000 },
  async (t) => {
    for (const mode of ["global-unavailable", "selected-unavailable"]) {
      const d = await copiedRuntime(t),
        helper = path.join(d.root, "src/posix-owner-keeper.js"),
        mark = path.join(d.root, "reached-target");
      const original = await readFile(helper, "utf8");
      const prefix = `
        import bootstrapCp from 'node:child_process';
        import bootstrapFs from 'node:fs/promises';
        import {syncBuiltinESMExports as syncBootstrapExports} from 'node:module';
        let bootstrapReady = false;
        const bootstrapMode = ${JSON.stringify(mode)};
        const bootstrapSend = process.send.bind(process);
        process.send = (value,...rest) => {
          if (value && value.kind === 'ready') bootstrapReady = true;
          return bootstrapSend(value,...rest);
        };
        const bootstrapSpawn = bootstrapCp.spawnSync;
        bootstrapCp.spawnSync = (executable,args,options) => {
          if (!bootstrapReady && executable === '/bin/ps' &&
              ((bootstrapMode === 'global-unavailable' && args[0] === '-axo') ||
               (bootstrapMode === 'selected-unavailable' && args[0] === '-p')))
            return {status:null,signal:'SIGTERM',error:Object.assign(Error('original snapshot timeout'),{code:'ETIMEDOUT'}),stdout:'',stderr:'',pid:0};
          return bootstrapSpawn(executable,args,options);
        };
        const bootstrapReaddir = bootstrapFs.readdir;
        bootstrapFs.readdir = (filename,...options) => {
          if (!bootstrapReady && bootstrapMode === 'global-unavailable' && filename === '/proc')
            throw Object.assign(Error('original global snapshot unavailable'),{code:'EIO'});
          return bootstrapReaddir(filename,...options);
        };
        const bootstrapRead = bootstrapFs.readFile;
        bootstrapFs.readFile = (filename,...options) => {
          if (!bootstrapReady && bootstrapMode === 'selected-unavailable' && filename === '/proc/'+process.pid+'/stat')
            throw Object.assign(Error('original selected identity unavailable'),{code:'EIO'});
          return bootstrapRead(filename,...options);
        };
        syncBootstrapExports();
      `;
      await writeFile(helper, prefix + original);
      const result = await d.run.runProcess(
        d.root,
        {
          executable: process.execPath,
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(mark)},'actual target')`,
          ],
          cwd: ".",
        },
        { timeoutMs: 10000, captureRawOutput: true },
      );
      assert.equal(result.timedOut, false);
      assert.equal(result.cancelled, false);
      if (mode === "global-unavailable") {
        assert.equal(result.errorCode, undefined);
        assert.equal(result.exitCode, 0);
        assert.equal(await readFile(mark, "utf8"), "actual target");
        assert.equal(result.capturedOutput!.completeForObservedStreams, true);
      } else {
        assert.equal(result.errorCode, "POSIX_OWNER_UNAVAILABLE");
        assert.equal(result.exitCode, null);
        await assert.rejects(access(mark), { code: "ENOENT" });
      }
    }
  },
);
