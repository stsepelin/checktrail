import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  cleanupFixtureProcessGroup,
  fixture,
  type FixtureCleanupControl,
  type FixtureProcessGroup,
} from "./helpers.js";
import type { ProcessIdentity } from "../src/process-tree.js";
const owner: ProcessIdentity = {
    pid: 41001,
    parent: 1,
    group: 41001,
    identity: "synthetic-owner",
  },
  child: ProcessIdentity = {
    pid: 41002,
    parent: 41001,
    group: 41001,
    identity: "synthetic-child",
  };
const group: FixtureProcessGroup = { owner, members: [child] };
function control(overrides: Partial<FixtureCleanupControl> = {}) {
  let elapsed = 0;
  const queries: number[][] = [],
    signals: number[] = [],
    existence: number[] = [];
  const io: FixtureCleanupControl = {
    snapshot: async (pids) => {
      queries.push([...pids]);
      return [child, owner].filter((row) => pids.includes(row.pid));
    },
    exists: (pid) => {
      existence.push(pid);
      return false;
    },
    kill: (pid) => {
      signals.push(pid);
    },
    now: () => elapsed,
    wait: async (ms) => {
      elapsed += ms;
    },
    ...overrides,
  };
  return { io, queries, signals, existence, elapsed: () => elapsed };
}
test("fixture cleanup proves absent captured processes without inspecting unrelated host identities", async (t) => {
  const root = await fixture(t, {
    "observe.mjs": `import assert from'node:assert/strict';import{registerHooks}from'node:module';
const target=process.argv[2],group=JSON.parse(process.argv[3]),checked=[];
registerHooks({resolve(specifier,context,next){if(context.parentURL===target&&specifier==='../src/process-tree.js')return{url:'data:text/javascript,'+encodeURIComponent("export async function processSnapshot(){throw Error('Unrelated host snapshot must not run');}"),shortCircuit:true};return next(specifier,context);}});
process.kill=(pid,signal)=>{assert.equal(signal,0);checked.push(pid);throw Object.assign(new Error('Original physical ESRCH'),{code:'ESRCH'});};
const{cleanupFixtureProcessGroup}=await import(target);await cleanupFixtureProcessGroup(group);
assert.deepEqual([...new Set(checked)].sort(),[group.owner.pid,...group.members.map(row=>row.pid)].sort());
console.log(JSON.stringify({checked,unrelatedSnapshots:0}));`,
  });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "observe.mjs"),
      new URL("./helpers.js", import.meta.url).href,
      JSON.stringify(group),
    ],
    { env, encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).unrelatedSnapshots, 0);
});

test("fixture cleanup queries and signals only its surviving captured identity and never a reused PID", async () => {
  let alive = true;
  const c = control();
  c.io.exists = (pid) => alive && pid === child.pid;
  c.io.kill = (pid) => {
    c.signals.push(pid);
    alive = false;
  };
  await cleanupFixtureProcessGroup(group, c.io);
  assert.deepEqual(c.signals, [child.pid]);
  assert.deepEqual(c.queries, [[child.pid]]);
  const reused = control({
    exists: (pid) => pid === child.pid,
    snapshot: async (pids) => {
      assert.deepEqual(pids, [child.pid]);
      return [{ ...child, identity: "synthetic-replacement" }];
    },
  });
  await cleanupFixtureProcessGroup(group, reused.io);
  assert.deepEqual(reused.signals, []);
});
test("fixture cleanup refuses unreadable changed-group and late identity observations without signaling", async () => {
  for (const mode of ["missing", "unavailable", "changed-group", "late"]) {
    const c = control({ exists: (pid) => pid === child.pid });
    c.io.snapshot = async (pids, budget) => {
      assert.deepEqual(pids, [child.pid]);
      assert.ok(budget > 0 && budget <= 1000);
      if (mode === "missing") return [];
      if (mode === "unavailable") throw Error("Original snapshot unavailable");
      if (mode === "late") {
        await c.io.wait(5000);
        return [child];
      }
      return [{ ...child, group: child.group + 1 }];
    };
    await assert.rejects(
      cleanupFixtureProcessGroup(group, c.io),
      /identity unavailable|snapshot unavailable|changed group|survived cleanup/,
      mode,
    );
    assert.deepEqual(c.signals, [], mode);
  }
});
test("fixture cleanup requires physical reaping and keeps every surviving identity inside its original deadline", async () => {
  for (const reaps of [true, false]) {
    const c = control();
    c.io.exists = (pid) => pid === child.pid && (!reaps || c.elapsed() < 50);
    c.io.snapshot = async (pids, budget) => {
      assert.deepEqual(pids, [child.pid]);
      assert.ok(budget > 0 && budget <= 1000);
      return c.signals.length
        ? [{ ...child, state: "exited", parent: 0, group: -1 }]
        : [child];
    };
    const running = cleanupFixtureProcessGroup(group, c.io);
    if (reaps) await running;
    else await assert.rejects(running, /survived cleanup/);
    assert.deepEqual(c.signals, [child.pid]);
    assert.ok(c.elapsed() >= 50);
    assert.ok(c.elapsed() <= 5000);
  }
});
