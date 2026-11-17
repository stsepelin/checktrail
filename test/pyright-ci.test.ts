import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";
import { fixture } from "./helpers.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const controller = path.join(repository, "scripts/verify-pyright-package.mjs");

test("Pyright CI selects its exact pinned compiler and requires source plus fresh installed cohorts before completion", async () => {
  const workflow = parse(
    await readFile(path.join(repository, ".github/workflows/ci.yml"), "utf8"),
  );
  const job = workflow.jobs.pyright;
  assert.deepEqual(job.needs, ["ci-plan", "actionlint"]);
  assert.match(job.if, /selected\['pyright'\]/);
  assert.ok(workflow.jobs["ci-complete"].needs.includes("pyright"));
  const commands = job.steps.map((step: { run?: string }) => step.run ?? "");
  const source = commands.indexOf("node scripts/verify-pyright-container.mjs");
  const installed = commands.indexOf("node scripts/verify-pyright-package.mjs");
  assert.ok(source >= 0 && installed > source);
  for (const step of job.steps.filter((step: { run?: string }) =>
    /verify-pyright/.test(step.run ?? ""),
  )) {
    assert.equal(step["continue-on-error"], undefined);
    assert.equal(step.if, undefined);
  }
  const manifest = JSON.parse(
    await readFile(
      path.join(repository, "scripts/pyright-tools/package.json"),
      "utf8",
    ),
  );
  const lock = JSON.parse(
    await readFile(
      path.join(repository, "scripts/pyright-tools/package-lock.json"),
      "utf8",
    ),
  );
  assert.deepEqual(manifest.dependencies, { pyright: "1.1.414" });
  assert.equal(lock.packages["node_modules/pyright"].version, "1.1.414");
  assert.equal(
    lock.packages["node_modules/pyright"].integrity,
    "sha512-FPZZb51jepDX4eP7TEYDeNFtmE3WgwkkEcJpvH3/QmUSsj0EAy3LXu+xB4T/FWDejtsXlCfFr/rbWFjwuwuXww==",
  );
  assert.ok(
    commands.some((command: string) =>
      command.includes(
        "npm ci --prefix .checktrail/pyright-tools --ignore-scripts",
      ),
    ),
  );
});

for (const mode of ["complete", "skipped", "missing-compiler"] as const) {
  test(`Pyright fresh package ${mode} preserves installed-root binding and refuses incomplete native qualification`, async (t) => {
    const root = await fixture(t, {
      "compiler/package.json": JSON.stringify({
        name: "pyright",
        version: "1.1.414",
      }),
      "compiler/index.js":
        "throw Error('Synthetic compiler must never execute in controller wiring controls');",
      "docker-control.mjs": `import assert from 'node:assert/strict';
import child from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {readFileSync,realpathSync,writeFileSync} from 'node:fs';
import path from 'node:path';
const original=child.execFileSync;
child.execFileSync=(command,args,options)=>{
 if(command!=='docker') return original(command,args,options);
 if(args[0]==='image'){assert.deepEqual(args.slice(0,2),['image','inspect']);return 'sha256:'+'1'.repeat(64);}
 assert.equal(args[0],'run');assert.ok(args.includes('--rm'));assert.equal(args[args.indexOf('--network')+1],'none');
 const mounts=args.filter((x,i)=>args[i-1]==='--mount');
 const consumer=mounts.find(x=>x.endsWith(',target=/consumer,readonly'))?.slice('type=bind,src='.length).split(',target=')[0];
 assert.ok(consumer,'Consumer must be an explicit read-only mount');
 const installed=realpathSync(path.join(consumer,'dist/src'));
 assert.equal(installed,realpathSync(path.join(consumer,'node_modules/@stsepelin/checktrail/dist/src')));
 assert.notEqual(installed,${JSON.stringify(path.join(repository, "dist/src"))});
 assert.ok(mounts.some(x=>x.endsWith(',target=/tools/pyright,readonly')));
 assert.ok(args.includes('CHECKTRAIL_PYRIGHT_PACKAGE=/tools/pyright'));
 assert.deepEqual(args.slice(-3),['node','scripts/verify-required-native-tests.mjs','pyright']);
 const required=JSON.parse(readFileSync(path.join(consumer,'scripts/required-native-tests.json'))).pyright;
 const originalRequired=JSON.parse(readFileSync(${JSON.stringify(path.join(repository, "scripts/required-native-tests.json"))})).pyright;
 assert.deepEqual(required,originalRequired);assert.equal(required.length,7);
 for(const file of ['pyright.test.js','pyright-evidence.test.js','helpers.js'])
  assert.deepEqual(readFileSync(path.join(consumer,'dist/test',file)),readFileSync(path.join(${JSON.stringify(repository)},'dist/test',file)));
 const client=JSON.parse(readFileSync(path.join(consumer,'dist/node_modules/@modelcontextprotocol/client/package.json')));
 const lock=JSON.parse(readFileSync(${JSON.stringify(path.join(repository, "package-lock.json"))}));
 assert.equal(client.version,lock.packages['node_modules/@modelcontextprotocol/client'].version);
 writeFileSync(process.env.CHECKTRAIL_PYRIGHT_CONTROL_OUTPUT,JSON.stringify({consumer,installedRootBound:true,callbacks:required.length,lockedClient:true}));
 return JSON.stringify({required:7,passed:${mode === "skipped" ? 6 : 7},problems:${mode === "skipped" ? "['synthetic required callback skipped']" : "[]"},complete:${mode !== "skipped"}});
};syncBuiltinESMExports();`,
    });
    const preloader = path.join(root, "docker-control.mjs");
    const result = spawnSync(
      process.execPath,
      ["--import", preloader, controller],
      {
        cwd: repository,
        env: {
          ...process.env,
          CHECKTRAIL_PYRIGHT_PACKAGE: path.join(
            root,
            mode === "missing-compiler" ? "absent" : "compiler",
          ),
          CHECKTRAIL_PYRIGHT_IMAGE: "original-synthetic-image",
          CHECKTRAIL_PYRIGHT_CONTROL_OUTPUT: path.join(
            root,
            "controller-observation.json",
          ),
        },
        encoding: "utf8",
        timeout: 90000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.error, undefined);
    assert.equal(result.status, mode === "complete" ? 0 : 1, result.stderr);
    if (mode === "missing-compiler") {
      await assert.rejects(
        access(path.join(root, "controller-observation.json")),
        { code: "ENOENT" },
      );
      assert.equal(result.stdout, "");
      return;
    }
    const observed = JSON.parse(
      await readFile(path.join(root, "controller-observation.json"), "utf8"),
    );
    assert.equal(observed.installedRootBound, true);
    assert.equal(observed.callbacks, 7);
    assert.equal(observed.lockedClient, true);
    await assert.rejects(access(observed.consumer), { code: "ENOENT" });
    if (mode === "skipped") assert.equal(result.stdout, "");
    else {
      const report = JSON.parse(result.stdout);
      assert.equal(report.offlineProductionInstall, true);
      assert.equal(report.harnessOutsideInstalledPackage, true);
      assert.equal(report.profile.passed, 7);
    }
  });
}
