import assert from "node:assert/strict";
import { access, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import { validate } from "../src/engine.js";
import { processSnapshot, type ProcessIdentity } from "../src/process-tree.js";
import { fixture, nodeManifest } from "./helpers.js";

export const lifecycleCanary = "Original lifecycle diagnostic 8e71.";
export type LifecycleReached = {
  body: number;
  driver: number;
  children: [number, number];
};
export async function lifecycleWait<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 10000,
  reason = "Original lifecycle body readiness was not observed",
): Promise<T> {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(15);
  }
  throw Error(reason);
}
export function lifecycleAlive(pid: number) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
export async function cleanupLifecycleIdentities(rows: ProcessIdentity[]) {
  for (const row of rows) {
    const current = (await processSnapshot(row.pid)).find(
      (p) => p.pid === row.pid,
    );
    if (current?.identity !== row.identity || current.group !== row.group)
      continue;
    try {
      process.kill(row.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await delay(25);
  }
}
export async function lifecycleProject(
  t: TestContext,
  options: { broken?: boolean; stale?: boolean; file?: string } = {},
) {
  const control = await realpath(await fixture(t, {})),
    marker = path.join(control, "reached.json"),
    release = path.join(control, "release"),
    file = options.file ?? "quota.test.js";
  const implementation = options.broken
    ? "export const visible = rows => rows.length;\n"
    : "export const visible = rows => rows.filter(row => row.enabled).length;\n";
  const childBody =
    "require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);setTimeout(()=>process.exit(0),60000);";
  const root = await realpath(
    await fixture(t, {
      "package.json": nodeManifest,
      "quota.js": implementation,
      [file]: `import{test}from'node:test';import assert from'node:assert/strict';import{spawn}from'node:child_process';import{readFile,writeFile,rename,appendFile}from'node:fs/promises';import{setTimeout as delay}from'node:timers/promises';import{visible}from'./quota.js';
test('original two enabled and one disabled quota',async()=>{
const control=${JSON.stringify(control)},marker=${JSON.stringify(marker)},release=${JSON.stringify(release)};
const children=[0,1].map(i=>spawn(process.execPath,['-e',${JSON.stringify(childBody)},control+'/child-'+i],{stdio:'ignore'}));
for(let i=0;i<children.length;i++){for(;;){try{assert.equal(Number(await readFile(control+'/child-'+i,'utf8')),children[i].pid);break;}catch(error){if(error.code!=='ENOENT')throw error;}await delay(10);}children[i].unref();}
await writeFile(marker+'.partial',JSON.stringify({body:process.pid,driver:process.ppid,children:children.map(child=>child.pid)}));await rename(marker+'.partial',marker);
for(;;){try{await readFile(release);break;}catch(error){if(error.code!=='ENOENT')throw error;}await delay(10);}
${options.stale ? "await appendFile(new URL('./quota.js',import.meta.url),'// Original source changed during execution.\\n');" : ""}
assert.equal(process.env.CHECKTRAIL_LIFECYCLE_SYNTHETIC_SECRET,undefined,'Unlisted operator environment reached the original project');
assert.equal(visible([{enabled:true},{enabled:true},{enabled:false}]),2,${JSON.stringify(lifecycleCanary)});
});\n`,
    }),
  );
  const observe = async () =>
    await lifecycleWait(async () => {
      try {
        return JSON.parse(await readFile(marker, "utf8")) as LifecycleReached;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    });
  const identities = async (reached: LifecycleReached) => {
    const ids = [...reached.children, reached.body, reached.driver];
    assert.equal(new Set(ids).size, 4);
    assert.ok(ids.every((pid) => pid !== process.pid && lifecycleAlive(pid)));
    if (process.platform === "win32") return [];
    const rows = await processSnapshot(ids);
    return ids.map((pid) => {
      const found = rows.find((row) => row.pid === pid);
      assert.ok(found, "Every reached native process must be observable");
      return found;
    });
  };

  return {
    root,
    control,
    marker,
    release,
    file,
    observe,
    identities,
    cleanup: cleanupLifecycleIdentities,
    continue: () => writeFile(release, "Original operator release."),
  };
}
export async function lifecycleExecute<T>(
  project: Awaited<ReturnType<typeof lifecycleProject>>,
  start: (signal: AbortSignal) => Promise<T>,
) {
  const controller = new AbortController(),
    running = start(controller.signal);
  void running.catch(() => {});
  let rows: ProcessIdentity[] = [];
  try {
    const reached = await project.observe();
    rows = await project.identities(reached);
    await project.continue();
    const value = await running;
    await lifecycleWait(
      async () => {
        const ids = [...reached.children, reached.body, reached.driver];
        return ids.every((pid) => !lifecycleAlive(pid)) ? true : undefined;
      },
      2500,
      "Original reached lifecycle processes survived completion",
    );
    await access(project.release);
    return { project, value, reached };
  } finally {
    controller.abort();
    await Promise.allSettled([running]);
    await project.cleanup(rows);
  }
}
export async function validateLifecycleProject(
  t: TestContext,
  options: Parameters<typeof lifecycleProject>[1] = {},
) {
  const project = await lifecycleProject(t, options);
  const observed = await lifecycleExecute(project, (signal) =>
    validate(project.root, {
      trusted: true,
      timeoutMs: process.platform === "win32" ? 30000 : 15000,
      signal,
    }),
  );
  return {
    project: observed.project,
    report: observed.value,
    reached: observed.reached,
  };
}
