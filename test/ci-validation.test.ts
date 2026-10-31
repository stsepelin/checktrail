import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  access,
  rm,
  realpath,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parse } from "yaml";
import { fixtureGit } from "./git-fixture.js";
const {
  commandKey,
  validationPhases,
  validatePhases,
  runValidationLanes,
  runCiCommand,
} = await import(
  new URL("../../scripts/ci-validation.mjs", import.meta.url).href
);
const task = (script: string, args: string[] = []) => ({
  script,
  args,
  env: {},
});
async function repository(t: TestContext, scripts: Record<string, string>) {
  const outer = await mkdtemp(path.join(tmpdir(), "checktrail-ci-control-")),
    root = path.join(outer, "repo");
  t.after(() => rm(outer, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "dist/src"), { recursive: true });
  await mkdir(path.join(root, "node_modules"));
  await writeFile(
    path.join(root, ".gitignore"),
    "dist/\nnode_modules/\n.checktrail/\n",
  );
  await writeFile(path.join(root, "dist/src/subject.txt"), "original");
  for (const [name, body] of Object.entries(scripts))
    await writeFile(path.join(root, "scripts", name), body);
  fixtureGit(root, ["init", "--initial-branch=main"]);
  return { root: await realpath(root), outer };
}
const prelude = `import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import{setTimeout as delay}from'node:timers/promises';const file='dist/src/subject.txt';console.log(JSON.stringify({root:process.cwd(),tmp:process.env.TMPDIR}));`;

test("consumer impact retains its guard condition and fresh installed checks on every host matrix variant after cache preparation", async () => {
  const workflow = parse(
    await readFile(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    ),
  );
  type Step = { run?: string; if?: string };
  const checks: Step[] = workflow.jobs.checks.steps;
  const hosts: Step[] = workflow.jobs["host-validation"].steps;
  const guard = "node scripts/verify-consumer-impact-guards.mjs";
  const installed = "node scripts/verify-consumer-impact-package.mjs";
  assert.equal(checks.filter((step) => step.run === guard).length, 1);
  assert.equal(
    checks.find((step) => step.run === guard)!.if,
    "env.CHECKTRAIL_CI_MODE == 'full' && (runner.os == 'Linux' && matrix.node == '26')",
  );
  assert.ok(
    checks.findIndex((step) => step.run === guard) >
      checks.findIndex((step) => step.run === "npm run build"),
  );
  assert.equal(checks.filter((step) => step.run === installed).length, 0);
  assert.equal(hosts.filter((step) => step.run === installed).length, 1);
  assert.equal(
    hosts.find((step) => step.run === installed)!.if,
    undefined,
    "Every existing host variant must execute fresh consumer acceptance",
  );
  const cache = hosts.findIndex(
    (step) => step.run === "node scripts/prepare-package-cache.mjs",
  );
  const lanes = hosts.findIndex(
    (step) => step.run === "node scripts/run-ci-validation.mjs",
  );
  const consumer = hosts.findIndex((step) => step.run === installed);
  assert.ok(cache >= 0 && cache < lanes && lanes < consumer);
  assert.deepEqual(
    workflow.jobs["host-validation"].strategy.matrix,
    workflow.jobs.checks.strategy.matrix,
  );
});

test("CI lanes preserve every original matrix command and keep distinct package variants", async () => {
  const baseline = JSON.parse(
    await readFile(
      new URL(
        "../../test/fixtures/ci-matrix-validation.v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const keys = (phases: Record<string, unknown[]>) =>
    Object.values(phases).flat().map(commandKey).sort();
  const frozen = [
    ...baseline,
    task("scripts/verify-native-engine-journals.mjs"),
    task("scripts/verify-native-engine-journals-package.mjs"),
    task("scripts/verify-task-archives.mjs"),
    task("scripts/verify-task-archives-package.mjs"),
  ]
    .map(commandKey)
    .sort();
  validatePhases(validationPhases);
  assert.deepEqual(keys(validationPhases), frozen);
  assert.equal(validationPhases.mutations.length, 14);
  assert.equal(validationPhases.packages.length, 37);
  const missing = structuredClone(validationPhases);
  missing.packages.pop();
  assert.notDeepEqual(keys(missing), frozen);
  const duplicate = structuredClone(validationPhases);
  duplicate.packages.push(duplicate.packages[0]);
  assert.throws(() => validatePhases(duplicate), /repeated/);
  const empty = structuredClone(validationPhases);
  empty.mutations = [];
  assert.throws(() => validatePhases(empty), /nonempty/);
  const workflow = parse(
    await readFile(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    workflow.jobs["host-validation"].steps.filter(
      (s: { run?: string }) => s.run === "node scripts/run-ci-validation.mjs",
    ).length,
    1,
  );
  assert.equal(workflow.jobs.checks.strategy.matrix.include.length, 4);
  assert.deepEqual(
    workflow.jobs["host-validation"].strategy.matrix,
    workflow.jobs.checks.strategy.matrix,
  );
  assert.equal(workflow.jobs["host-validation"]["timeout-minutes"], 75);
  assert.deepEqual(workflow.jobs["host-validation"].needs, ["ci-plan"]);
  assert.deepEqual(workflow.jobs.checks.needs, ["ci-plan"]);
  assert.match(workflow.jobs["host-validation"].if, /mode == 'full'/);
  assert.equal(
    workflow.jobs.checks.steps.find((s: { run?: string }) =>
      s.run?.includes("--full-suite gate-inventory"),
    )?.if,
    "env.CHECKTRAIL_CI_MODE == 'full'",
  );
  assert.ok(
    !workflow.jobs.checks.steps.some(
      (s: { run?: string }) => s.run === "node scripts/run-ci-validation.mjs",
    ),
  );
  assert.equal(
    workflow.jobs.checks.timeoutMinutes ??
      workflow.jobs.checks["timeout-minutes"],
    75,
  );
  assert.ok(
    workflow.jobs.checks.steps.some((s: { run?: string }) =>
      s.run?.includes("--full-suite gate-inventory"),
    ),
  );
});
test("attempt output and native journal acceptance run once in the package lane on every existing host variant", async () => {
  const workflow = parse(
    await readFile(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    ),
  );
  const controllers = [
    "scripts/verify-attempt-outputs.mjs",
    "scripts/verify-attempt-outputs-package.mjs",
    "scripts/verify-native-attempt-journals.mjs",
    "scripts/verify-native-attempt-journals-package.mjs",
    "scripts/verify-native-engine-journals.mjs",
    "scripts/verify-native-engine-journals-package.mjs",
    "scripts/verify-task-archives.mjs",
    "scripts/verify-task-archives-package.mjs",
  ];
  for (const script of controllers) {
    assert.deepEqual(
      validationPhases.packages.filter(
        (command: { script: string }) => command.script === script,
      ),
      [task(script)],
      "Source and fresh installed acceptance must each run exactly once",
    );
    assert.equal(
      validationPhases.mutations.filter(
        (command: { script: string }) => command.script === script,
      ).length,
      0,
    );
    for (const id of ["checks", "host-validation"])
      assert.equal(
        workflow.jobs[id].steps.some((step: { run?: string }) =>
          step.run?.includes(script),
        ),
        false,
        "Controllers must use the shared lane rather than duplicate direct steps",
      );
  }
});
test("CI mutation and package lanes overlap in separate source and temporary namespaces and restore every byte", async (t) => {
  const { root, outer } = await repository(t, {
    "mutate.mjs":
      prelude +
      `const coord=process.argv[2];await fs.writeFile(file,'mutated');await fs.writeFile(path.join(coord,'mutation'),'started');while(!await fs.access(path.join(coord,'package')).then(()=>true,()=>false))await delay(10);assert.equal(await fs.readFile(file,'utf8'),'mutated');await fs.writeFile(file,'original');`,
    "package.mjs":
      prelude +
      `const coord=process.argv[2];while(!await fs.access(path.join(coord,'mutation')).then(()=>true,()=>false))await delay(10);assert.equal(await fs.readFile(file,'utf8'),'original');await fs.writeFile(path.join(coord,'package'),'observed-original');`,
  });
  const result = await runValidationLanes(root, {
    phases: {
      mutations: [task("scripts/mutate.mjs", [outer])],
      packages: [task("scripts/package.mjs", [outer])],
    },
    timeoutMs: 10000,
  });
  assert.equal(result.complete, true);
  assert.equal(result.maxConcurrentCommands, 2);
  assert.equal(
    await readFile(path.join(root, "dist/src/subject.txt"), "utf8"),
    "original",
  );
  const locations = await Promise.all(
    result.lanes.map(async (lane: { receipts: { log: string }[] }) =>
      JSON.parse((await readFile(lane.receipts[0]!.log, "utf8")).trim()),
    ),
  );
  assert.notEqual(locations[0].root, locations[1].root);
  assert.equal(locations[1].root, root);
  assert.notEqual(locations[0].tmp, locations[1].tmp);
  for (const location of locations)
    await assert.rejects(access(location.tmp), { code: "ENOENT" });
  await assert.rejects(access(locations[0].root), { code: "ENOENT" });
});
test("CI failure waits for the running peer and removes namespaces without manufacturing completion", async (t) => {
  const { root, outer } = await repository(t, {
    "fail.mjs": prelude + "process.exitCode=3;",
    "peer.mjs":
      prelude +
      `await delay(150);await fs.writeFile(process.argv[2],'peer-completed');`,
  });
  await assert.rejects(
    runValidationLanes(root, {
      phases: {
        mutations: [task("scripts/fail.mjs")],
        packages: [task("scripts/peer.mjs", [path.join(outer, "peer")])],
      },
      timeoutMs: 10000,
    }),
    /Required CI lanes failed/,
  );
  assert.equal(
    await readFile(path.join(outer, "peer"), "utf8"),
    "peer-completed",
  );
  const runs = await readdir(path.join(root, ".checktrail/ci-lanes"));
  assert.equal(runs.length, 1);
  for (const name of ["mutations-0.log", "packages-0.log"]) {
    const location = JSON.parse(
      (
        await readFile(
          path.join(root, ".checktrail/ci-lanes", runs[0]!, name),
          "utf8",
        )
      ).trim(),
    );
    await assert.rejects(access(location.tmp), { code: "ENOENT" });
  }

  assert.equal(
    await readFile(path.join(root, "dist/src/subject.txt"), "utf8"),
    "original",
  );
});
test("CI rejects unrestored mutation bytes and changes to the original source", async (t) => {
  for (const lane of ["mutations", "packages"] as const) {
    const { root } = await repository(t, {
      "change.mjs": prelude + "await fs.writeFile(file,'changed');",
      "read.mjs":
        prelude + "assert.equal(await fs.readFile(file,'utf8'),'original');",
    });
    const phases = {
      mutations: [
        task(lane === "mutations" ? "scripts/change.mjs" : "scripts/read.mjs"),
      ],
      packages: [
        task(lane === "packages" ? "scripts/change.mjs" : "scripts/read.mjs"),
      ],
    };
    await assert.rejects(
      runValidationLanes(root, { phases, timeoutMs: 10000 }),
      lane === "mutations" ? /not restored/ : /source bytes changed/,
    );
  }
});
test("CI command cancellation removes detached descendants after a physical start marker", async (t) => {
  const { root, outer } = await repository(t, {
    "hang.mjs": `import{spawn}from'node:child_process';import{writeFile,access}from'node:fs/promises';import{setTimeout as delay}from'node:timers/promises';const marker=process.argv[2];const child=spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});await writeFile(marker,'');while(!await access(marker+'.observed-empty').then(()=>true,()=>false))await delay(10);await writeFile(marker,String(child.pid));setInterval(()=>{},1000);`,
  });
  const abort = new AbortController(),
    marker = path.join(outer, "pid");
  const promise = runCiCommand(root, task("scripts/hang.mjs", [marker]), {
    signal: abort.signal,
    temporary: outer,
    log: path.join(outer, "hang.log"),
  });
  const observed = assert.rejects(promise, /failed or cancelled/);
  try {
    let pid = 0,
      observedEmpty = false;
    for (let i = 0; i < 200; i++) {
      const contents = await readFile(marker, "utf8").catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (contents === "") {
        observedEmpty = true;
        await writeFile(marker + ".observed-empty", "observed");
      } else if (contents !== undefined && /^[1-9]\d*$/.test(contents)) {
        pid = Number(contents);
        if (Number.isSafeInteger(pid) && pid > 1) break;
      }
      await delay(10);
    }
    assert.equal(observedEmpty, true);
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    abort.abort();
    await observed;
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    abort.abort();
    await observed;
  }
});

test("CI output accounting accepts the exact bound and rejects overflow without retaining excess bytes", async (t) => {
  const { root, outer } = await repository(t, {
    "output.mjs": "process.stdout.write('x'.repeat(Number(process.argv[2])));",
  });
  for (const bytes of [16, 17]) {
    const log = path.join(outer, "output-" + bytes + ".log");
    const invocation = runCiCommand(
      root,
      task("scripts/output.mjs", [String(bytes)]),
      {
        signal: new AbortController().signal,
        temporary: outer,
        log,
        maxOutputBytes: 16,
      },
    );
    if (bytes === 16) assert.equal((await invocation).outputBytes, 16);
    else await assert.rejects(invocation, /output limit exceeded/);
    assert.equal((await readFile(log)).length, 16);
  }
});

test("CI rejects an added mutation input even when all original bytes were restored", async (t) => {
  const { root } = await repository(t, {
    "extra.mjs":
      prelude + "await fs.writeFile('dist/src/extra.txt','unrestored');",
    "read.mjs":
      prelude + "assert.equal(await fs.readFile(file,'utf8'),'original');",
  });
  await assert.rejects(
    runValidationLanes(root, {
      phases: {
        mutations: [task("scripts/extra.mjs")],
        packages: [task("scripts/read.mjs")],
      },
      timeoutMs: 10000,
    }),
    /Mutation source inventory changed/,
  );
});
test("CI lane deadline terminates both physically started commands and cannot report complete", async (t) => {
  const { root, outer } = await repository(t, {
    "deadline.mjs":
      "import{writeFile,link}from'node:fs/promises';const marker=process.argv[2],partial=marker+'.partial';await writeFile(partial,JSON.stringify({pid:process.pid,tmp:process.env.TMPDIR}),{flag:'wx'});await link(partial,marker);setInterval(()=>{},1000);",
  });
  const markers = [path.join(outer, "mutation"), path.join(outer, "package")];
  await assert.rejects(
    runValidationLanes(root, {
      phases: {
        mutations: [task("scripts/deadline.mjs", [markers[0]!])],
        packages: [task("scripts/deadline.mjs", [markers[1]!])],
      },
      timeoutMs: 2000,
    }),
    /Required CI lanes failed/,
  );
  for (const marker of markers) {
    const started = JSON.parse(await readFile(marker, "utf8"));
    assert.ok(started.pid > 1);
    assert.throws(() => process.kill(started.pid, 0), { code: "ESRCH" });
    await assert.rejects(access(started.tmp), { code: "ENOENT" });
  }
});

test("CI reuses the restored mutation worker for packages, caps actual simultaneous bodies and records every index once", async (t) => {
  const body =
    prelude +
    `
const [coord,id]=process.argv.slice(2);const stateFile=path.join(coord,'body-state.json');
async function event(kind){const lock=path.join(coord,'body-lock');for(;;){try{await fs.mkdir(lock);break;}catch(e){if(e.code!=='EEXIST')throw e;await delay(5);}}
try{const s=await fs.readFile(stateFile,'utf8').then(JSON.parse,e=>{if(e.code!=='ENOENT')throw e;return{active:0,peak:0,events:[]}});s.active+=kind==='start'?1:-1;assert.ok(s.active>=0&&s.active<=2,'More than two actual command bodies overlapped');s.peak=Math.max(s.peak,s.active);s.events.push({kind,id,pid:process.pid,root:process.cwd(),tmp:process.env.TMPDIR});await fs.writeFile(stateFile,JSON.stringify(s));}finally{await fs.rm(lock,{recursive:true});}}
assert.equal(await fs.readFile(file,'utf8'),'original');await event('start');
if(id==='mutation'){await fs.writeFile(file,'mutated');while(!await fs.access(path.join(coord,'p0-started')).then(()=>true,()=>false))await delay(5);await fs.writeFile(file,'original');}
else if(id==='p0'){await fs.writeFile(path.join(coord,'p0-started'),'ready');while(!await fs.access(path.join(coord,'p1-started')).then(()=>true,()=>false))await delay(5);}
else if(id==='p1'){assert.equal(await fs.readFile(file,'utf8'),'original','Mutation must restore its source before taking package work');await fs.writeFile(path.join(coord,'p1-started'),'ready');await delay(30);}
else await delay(30);
await event('finish');`;
  const { root, outer } = await repository(t, { "queue.mjs": body });
  const result = await runValidationLanes(root, {
    phases: {
      mutations: [task("scripts/queue.mjs", [outer, "mutation"])],
      packages: Array.from({ length: 4 }, (_, index) =>
        task("scripts/queue.mjs", [outer, "p" + index]),
      ),
    },
    timeoutMs: 10000,
  });
  assert.equal(result.complete, true);
  assert.equal(result.peakConcurrentCommandAdmissions, 2);
  assert.equal(result.cleanupComplete, true);
  const observed = JSON.parse(
    await readFile(path.join(outer, "body-state.json"), "utf8"),
  ) as {
    active: number;
    peak: number;
    events: {
      kind: string;
      id: string;
      pid: number;
      root: string;
      tmp: string;
    }[];
  };
  assert.equal(observed.active, 0);
  assert.equal(observed.peak, 2);
  const starts = observed.events.filter((event) => event.kind === "start");
  const finishes = observed.events.filter((event) => event.kind === "finish");
  const ids = ["mutation", "p0", "p1", "p2", "p3"].sort();
  assert.deepEqual(starts.map((event) => event.id).sort(), ids);
  assert.deepEqual(finishes.map((event) => event.id).sort(), ids);
  assert.equal(new Set(starts.map((event) => event.pid)).size, ids.length);
  assert.equal(new Set(starts.map((event) => event.tmp)).size, ids.length);
  assert.equal(starts.find((event) => event.id === "p0")!.root, root);
  assert.equal(
    starts.find((event) => event.id === "p1")!.root,
    starts.find((event) => event.id === "mutation")!.root,
  );
  assert.notEqual(starts.find((event) => event.id === "p1")!.root, root);
  for (const started of starts)
    await assert.rejects(access(started.tmp), { code: "ENOENT" });
  await assert.rejects(
    access(starts.find((event) => event.id === "mutation")!.root),
    { code: "ENOENT" },
  );
  const packages = result.lanes.find(
    (lane: { lane: string }) => lane.lane === "packages",
  );
  assert.deepEqual(
    packages.receipts.map((receipt: { index: number }) => receipt.index),
    [0, 1, 2, 3],
  );
  assert.equal(
    new Set(packages.receipts.map((receipt: { log: string }) => receipt.log))
      .size,
    4,
  );
  assert.equal(packages.receipts[0].worker, "packages");
  assert.equal(packages.receipts[1].worker, "mutations");
  const retained = JSON.parse(
    await readFile(path.join(result.logs, "result.json"), "utf8"),
  );
  assert.deepEqual(retained, result);
  assert.equal(
    await readFile(path.join(root, "dist/src/subject.txt"), "utf8"),
    "original",
  );
});

test("CI package failure stops further admission while its already-running package peer completes and unrun indices remain explicit", async (t) => {
  const { root, outer } = await repository(t, {
    "mutation.mjs": prelude,
    "failure.mjs":
      prelude +
      `const coord=process.argv[2];await fs.writeFile(path.join(coord,'failure-ready'),'ready');while(!await fs.access(path.join(coord,'peer-ready')).then(()=>true,()=>false))await delay(5);process.exitCode=7;`,
    "peer.mjs":
      prelude +
      `const coord=process.argv[2];await fs.writeFile(path.join(coord,'peer-ready'),'ready');while(!await fs.access(path.join(coord,'failure-ready')).then(()=>true,()=>false))await delay(5);await delay(150);await fs.writeFile(path.join(coord,'peer-finished'),'finished');`,
    "unrun.mjs":
      prelude + `await fs.writeFile(process.argv[2],'incorrect admission');`,
  });
  let failure:
    | {
        result?: {
          complete: boolean;
          cleanupComplete: boolean;
          logs: string;
          lanes: {
            lane: string;
            commands: { index: number; state: string; temporary?: string }[];
          }[];
        };
      }
    | undefined;
  try {
    await runValidationLanes(root, {
      phases: {
        mutations: [task("scripts/mutation.mjs")],
        packages: [
          task("scripts/failure.mjs", [outer]),
          task("scripts/peer.mjs", [outer]),
          task("scripts/unrun.mjs", [path.join(outer, "unexpected")]),
        ],
      },
      timeoutMs: 10000,
    });
    assert.fail("The failed original command must fail the scheduler");
  } catch (error) {
    failure = error as typeof failure;
  }
  assert.ok(failure?.result);
  const result = failure.result;
  assert.equal(result.complete, false);
  assert.equal(result.cleanupComplete, true);
  assert.equal(
    await readFile(path.join(outer, "peer-finished"), "utf8"),
    "finished",
  );
  await assert.rejects(access(path.join(outer, "unexpected")), {
    code: "ENOENT",
  });
  const packages = result.lanes.find((lane) => lane.lane === "packages")!;
  assert.deepEqual(
    packages.commands.map((command) => [command.index, command.state]),
    [
      [0, "failed"],
      [1, "passed"],
      [2, "unrun"],
    ],
  );
  const retained = JSON.parse(
    await readFile(path.join(result.logs, "result.json"), "utf8"),
  );
  assert.equal(retained.complete, false);
  assert.deepEqual(retained.lanes, result.lanes);
  for (const lane of result.lanes)
    for (const command of lane.commands)
      if (command.temporary)
        await assert.rejects(access(command.temporary), { code: "ENOENT" });
});

test("CI cancellation after mutation completion stops both reached package workers and retains queued work as unrun", async (t) => {
  const { root, outer } = await repository(t, {
    "mutation.mjs": prelude,
    "hang.mjs":
      prelude +
      `const marker=process.argv[2],partial=marker+'.partial';await fs.writeFile(partial,'',{flag:'wx'});await fs.writeFile(marker+'.opened','opened',{flag:'wx'});while(!await fs.access(marker+'.release').then(()=>true,e=>{if(e.code!=='ENOENT')throw e;return false;}))await delay(5);await fs.writeFile(partial,JSON.stringify({pid:process.pid,tmp:process.env.TMPDIR,root:process.cwd()}));await fs.link(partial,marker);setInterval(()=>{},1000);`,
    "unrun.mjs":
      prelude + `await fs.writeFile(process.argv[2],'incorrect admission');`,
  });
  const controller = new AbortController();
  const markers = [path.join(outer, "p0"), path.join(outer, "p1")];
  const running = runValidationLanes(root, {
    phases: {
      mutations: [task("scripts/mutation.mjs")],
      packages: [
        task("scripts/hang.mjs", [markers[0]!]),
        task("scripts/hang.mjs", [markers[1]!]),
        task("scripts/unrun.mjs", [path.join(outer, "unexpected")]),
      ],
    },
    signal: controller.signal,
    timeoutMs: 10000,
  });
  let failure:
    | {
        result?: {
          complete: boolean;
          cleanupComplete: boolean;
          sourceStable: boolean;
          mutationsRestored: boolean;
          lanes: {
            lane: string;
            commands: { index: number; state: string }[];
          }[];
        };
      }
    | undefined;
  const finished = running.catch((error: unknown) => {
    failure = error as typeof failure;
  });
  try {
    for (const marker of markers) {
      let opened = false;
      for (let attempt = 0; attempt < 300; attempt++) {
        opened = await access(marker + ".opened").then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return false;
          },
        );
        if (opened) break;
        await delay(10);
      }
      assert.equal(
        opened,
        true,
        "Both actual package writers must open their partial start record",
      );
      await assert.rejects(
        access(marker),
        { code: "ENOENT" },
        "An opened but incomplete JSON record must not signal readiness",
      );
      assert.equal(await readFile(marker + ".partial", "utf8"), "");
    }
    await Promise.all(
      markers.map((marker) => writeFile(marker + ".release", "publish")),
    );
    for (const marker of markers) {
      let reached = false;
      for (let attempt = 0; attempt < 300; attempt++) {
        reached = await access(marker).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return false;
          },
        );
        if (reached) break;
        await delay(10);
      }
      assert.equal(
        reached,
        true,
        "Both actual package bodies must start before cancellation",
      );
    }
    controller.abort();
    await finished;
    assert.ok(failure?.result);
    assert.equal(failure.result.complete, false);
    assert.equal(failure.result.cleanupComplete, true);
    assert.equal(failure.result.sourceStable, true);
    assert.equal(failure.result.mutationsRestored, true);
    const packages = failure.result.lanes.find(
      (lane) => lane.lane === "packages",
    )!;
    assert.deepEqual(
      packages.commands.map((command) => [command.index, command.state]),
      [
        [0, "failed"],
        [1, "failed"],
        [2, "unrun"],
      ],
    );
    for (const marker of markers) {
      const reached = JSON.parse(await readFile(marker, "utf8"));
      assert.throws(() => process.kill(reached.pid, 0), { code: "ESRCH" });
      await assert.rejects(access(reached.tmp), { code: "ENOENT" });
    }
    await assert.rejects(access(path.join(outer, "unexpected")), {
      code: "ENOENT",
    });
  } finally {
    controller.abort();
    await finished;
  }
});
