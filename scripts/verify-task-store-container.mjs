import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const image =
  "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";
const native = [
  "run",
  "--rm",
  "--network",
  "none",
  "--mount",
  `type=bind,src=${repository},target=/workspace,readonly`,
  "--workdir",
  "/workspace",
  image,
];
assert.equal(
  execFileSync("docker", [...native, "node", "--version"], {
    encoding: "utf8",
  }).trim(),
  "v22.23.2",
);
const output = execFileSync(
  "docker",
  [...native, "node", "scripts/verify-required-native-tests.mjs", "tasks"],
  { encoding: "utf8", maxBuffer: 1024 * 1024 },
);
process.stdout.write(output);
const temporary = await mkdtemp(
  path.join(tmpdir(), "repo-verifier-task-package-"),
);
try {
  const [packed] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      { cwd: repository, encoding: "utf8" },
    ),
  );
  const consumer = path.join(temporary, "consumer");
  await mkdir(consumer);
  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      path.join(temporary, packed.filename),
    ],
    { cwd: consumer, stdio: "pipe" },
  );
  const program = `
    import assert from 'node:assert/strict';
    import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
    import {tmpdir} from 'node:os';
    import path from 'node:path';
    import {openTaskStore, openValidationTasks, createPlan, validate, projectReport} from '@stsepelin/repo-verifier';
    const temporary = await mkdtemp(path.join(tmpdir(), 'task-consumer-'));
    const root = path.join(temporary, 'project'); await mkdir(root);
    const options = {root, directory:path.join(temporary,'store')};
    let store; let tasks;
    try {
      await writeFile(path.join(root,'package.json'), JSON.stringify({type:'module',scripts:{test:'node --test'}}));
      await writeFile(path.join(root,'sum.test.js'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; test('sum',()=>assert.equal(2+3,5));");
      store = await openTaskStore(options);
      const {plan} = await createPlan(root); const task = store.create(plan.sourceFingerprint);
      const report = await validate(root, {trusted:true}); assert.equal(report.outcome,'passed');
      assert.equal(store.complete(task.taskId,report),'updated');
      const unfinished = store.create(plan.sourceFingerprint);
      store.close(); store = await openTaskStore(options);
      assert.deepEqual(store.get(task.taskId).result.structuredContent,projectReport(report,false));
      assert.equal(store.get(unfinished.taskId).result.isError,true);
      assert.equal(store.get(unfinished.taskId).result.structuredContent,undefined);
      store.close(); store = undefined;
      tasks = await openValidationTasks({...options,allowExecution:true});
      const running = await tasks.start();
      let result;
      for (let attempt=0;attempt<200;attempt++) {
        result = await tasks.get(running.taskId);
        if(result.status !== 'working') break;
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      assert.equal(result.status,'completed'); assert.equal(result.result.structuredContent.outcome,'passed');
      await tasks.close(); tasks = await openValidationTasks({...options,allowExecution:false});
      assert.deepEqual(await tasks.get(running.taskId),result);
      await assert.rejects(tasks.start(),/denied/);
      console.log(JSON.stringify({durableWorker:'passed',installedLibrary:'passed',nativeValidation:'passed',reopen:'passed',interruption:'explicit-tool-error',mcpTasks:'not-advertised'}));
    } finally {await tasks?.close(); store?.close(); await rm(temporary,{recursive:true,force:true});}
  `;
  process.stdout.write(
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--mount",
        `type=bind,src=${consumer},target=/consumer,readonly`,
        "--workdir",
        "/consumer",
        image,
        "node",
        "--input-type=module",
        "-e",
        program,
      ],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    ),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
