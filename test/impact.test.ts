import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fixture } from "./helpers.js";

test("impact metrics reconcile retained, omitted, changed and incomplete failures without dropping observations", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    const {summarizeImpact} = await import(process.argv[1]);
    const cases = [{id:'one',graph:'declared-complete'}];
    const check = (project,status) => ({project,status});
    const rows = [{id:'one',repetition:0,
      full:{outcome:'failed',wallMs:10,checks:[check('a','failed'),check('b','failed'),check('c','failed'),check('d','passed')]},
      selected:{outcome:'failed',wallMs:8,selection:{mode:'affected'},checks:[check('a','failed'),check('c','inconclusive'),check('d','failed')]}}];
    const [summary] = summarizeImpact(cases,rows,1);
    assert.equal(summary.fullFailures,3);
    assert.equal(summary.retainedFailures,1);
    assert.equal(summary.missedFailures,1);
    assert.equal(summary.changedFailureResults,1);
    assert.equal(summary.fullFailures, summary.retainedFailures+summary.missedFailures+summary.changedFailureResults);
    assert.equal(summary.inconclusiveChecks,1);
    assert.equal(summary.unexpectedFailures,1);
    assert.deepEqual(summary.failureRetention,{numerator:1,denominator:3,fraction:1/3});
    assert.deepEqual(summary.omittedChecks,{numerator:1,denominator:4,fraction:1/4});
    assert.equal(summary.totalWallRatio,0.8);
    for (const invalid of [[],[...rows,...rows],[{...rows[0],id:'missing'}],[{...rows[0],repetition:1}]]) assert.throws(()=>summarizeImpact(cases,invalid,1));
    for (const modify of [row=>row.selected.outcome='passed',row=>row.selected.wallMs=NaN,
      row=>row.selected.checks.push(check('unknown','passed')),row=>row.selected.checks.push(check('a','failed')),
      row=>row.full.checks[0].status='unknown']) {
      const changed=structuredClone(rows);modify(changed[0]);assert.throws(()=>summarizeImpact(cases,changed,1));
    }
    assert.throws(()=>summarizeImpact([],[],1));
  `,
      new URL("../../scripts/impact-metrics.mjs", import.meta.url).href,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("native impact measurement retains a transitive assertion failure and exposes a misdeclared graph", async (t) => {
  const root = await fixture(t, {});
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import {mkdir,readFile} from 'node:fs/promises';
    import path from 'node:path';
    import {execFileSync} from 'node:child_process';
    import {fileURLToPath} from 'node:url';
    const root=process.argv[1], scripts=process.argv[2];
    const {prepareImpactFixture,projects}=await import(new URL('impact-fixture.mjs',scripts));
    const corpus=JSON.parse(await readFile(new URL('impact-corpus.json',scripts),'utf8'));
    const run=(directory,base)=>JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('impact-worker.mjs',scripts)),directory,base],{encoding:'utf8'}));
    for(const id of ['producer-defect','misdeclared-graph']) {
      const specification=corpus.cases.find(item=>item.id===id);
      const directory=path.join(root,id);await mkdir(directory);
      const fixture=await prepareImpactFixture(directory,specification);
      const baseline=run(directory,'full');assert.equal(baseline.outcome,'passed');assert.equal(baseline.checks.length,projects.length);
      await fixture.applyChanges();
      const full=run(directory,'full'), selected=run(directory,fixture.base);
      assert.equal(full.outcome,'failed');
      assert.deepEqual(full.checks.filter(check=>check.status==='failed').map(check=>check.project),['service','web']);
      assert.deepEqual(full.checks.filter(check=>check.status==='failed').flatMap(check=>check.assertions),['service contract','web contract']);
      assert.deepEqual(selected.checks.map(check=>check.project),specification.selectedProjects);
      assert.equal(selected.outcome,id==='producer-defect'?'failed':'passed');
      assert.equal(full.sourceFingerprint,selected.sourceFingerprint);
      assert.equal(full.policyFingerprint,selected.policyFingerprint);
    }
  `,
      root,
      new URL("../../scripts/", import.meta.url).href,
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("impact snapshots account for each paired observation, assertion identity and frozen case", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import {readFile} from 'node:fs/promises';
    import {createHash} from 'node:crypto';
    const root=process.argv[1];
    const corpusBytes=await readFile(new URL('scripts/impact-corpus.json',root));
    const corpus=JSON.parse(corpusBytes);
    const {summarizeImpact}=await import(new URL('scripts/impact-metrics.mjs',root));
    const projects=['core','other','service','utility','web'];
    for(const name of ['impact-darwin-arm64-node26.json','impact-linux-arm64-node22.json']) {
      const text=await readFile(new URL('docs/measurements/'+name,root),'utf8'), report=JSON.parse(text);
      assert.equal(report.corpus.id,corpus.id);
      assert.equal(report.corpus.cases,corpus.cases.length);
      assert.equal(report.identities.corpusSha256,createHash('sha256').update(corpusBytes).digest('hex'));
      assert.deepEqual(report.summaries,summarizeImpact(corpus.cases,report.observations,report.corpus.repetitions));
      assert.equal(report.baselines.length,corpus.cases.length);
      assert.equal(new Set(report.baselines.map(item=>item.id)).size,corpus.cases.length);
      for(const specification of corpus.cases) {
        const baseline=report.baselines.find(item=>item.id===specification.id);
        assert.equal(baseline.outcome,'passed');
        assert.deepEqual(baseline.checks.map(check=>check.project),projects);
        assert.ok(baseline.checks.every(check=>check.status==='passed' && check.tests.total===1 && check.tests.passed===1 && !check.tests.skipped && !check.assertions.length));
        const observations=report.observations.filter(item=>item.id===specification.id);
        assert.equal(observations.length,report.corpus.repetitions);
        for(const observation of observations) {
          assert.deepEqual([...observation.order].sort(),['full','selected']);
          assert.equal(observation.full.sourceFingerprint,observation.selected.sourceFingerprint);
          assert.equal(observation.full.policyFingerprint,observation.selected.policyFingerprint);
          assert.equal(observation.selected.selection.mode,specification.mode);
          assert.deepEqual(observation.selected.selection.projects,specification.selectedProjects);
          assert.deepEqual(observation.selected.selection.changedFiles,Object.keys(specification.changes).sort());
          assert.equal(observation.selected.selection.gitVersion,report.environment.git);
          for(const mode of ['full','selected']) {
            const run=observation[mode], expected=mode==='full'?projects:specification.selectedProjects;
            assert.deepEqual(run.checks.map(check=>check.project),expected);
            for(const check of run.checks) {
              const failed=Number(specification.failingProjects.includes(check.project));
              assert.equal(check.status,failed?'failed':'passed');
              assert.deepEqual(check.tests,{total:1,passed:1-failed,failed,skipped:0});
              assert.deepEqual(check.assertions,failed?[check.project+' contract']:[]);
              assert.deepEqual(check.tools,[{name:'node',version:report.environment.node}]);
            }
            for(const metric of ['wallMs','engineMs','engineCpuMs','engineMaxRssKiB']) assert.ok(Number.isFinite(run[metric]) && run[metric]>=0);
          }
        }
      }
      for(const group of report.summaries) assert.equal(group.fullFailures,group.retainedFailures+group.missedFailures+group.changedFailureResults);
      assert.ok(!['/Users/','/private/','/workspace/','/tmp/','/home/'].some(prefix=>text.includes(prefix)));
    }
  `,
      new URL("../../", import.meta.url).href,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 0, result.stderr);
});
