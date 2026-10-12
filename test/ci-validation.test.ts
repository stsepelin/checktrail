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
  const frozen = baseline.map(commandKey).sort();
  validatePhases(validationPhases);
  assert.deepEqual(keys(validationPhases), frozen);
  assert.equal(validationPhases.mutations.length, 14);
  assert.equal(validationPhases.packages.length, 29);
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
  assert.equal(workflow.jobs["host-validation"].needs, undefined);
  assert.equal(workflow.jobs.checks.needs, undefined);
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
    "hang.mjs": `import{spawn}from'node:child_process';import{writeFile}from'node:fs/promises';const child=spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});await writeFile(process.argv[2],String(child.pid));setInterval(()=>{},1000);`,
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
    for (let i = 0; i < 200; i++) {
      if (
        await access(marker).then(
          () => true,
          () => false,
        )
      )
        break;
      await delay(10);
    }
    const pid = Number(await readFile(marker, "utf8"));
    assert.ok(pid > 1);
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
      "import{writeFile}from'node:fs/promises';await writeFile(process.argv[2],JSON.stringify({pid:process.pid,tmp:process.env.TMPDIR}));setInterval(()=>{},1000);",
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
