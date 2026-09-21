import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

function run(source: string): void {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      source,
      new URL("../../scripts/", import.meta.url).href,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("external Ruff snapshot extraction rejects unsupported locations and rule boundaries", () => {
  run(`
    import assert from 'node:assert/strict';
    const {extractRuffSnapshot}=await import(new URL('external-ruff-evidence.mjs',process.argv[1]));
    const header='---\\nsource: crates/ruff_linter/src/rules/pyflakes/mod.rs\\n---\\n';
    const body='F401 [*] Synthetic unused import\\n --> F401_0.py:2:8\\n  |\\n2 | import fictional_module\\n  |        ^^^^^^^^^^^^^^^^\\n';
    const snapshot=header+body;
    assert.deepEqual(extractRuffSnapshot(snapshot,'F401','F401_0.py'),[{code:'F401',file:'F401_0.py',line:2,column:8}]);
    assert.deepEqual(extractRuffSnapshot(header,'F401','F401_0.py'),[]);
    assert.deepEqual(extractRuffSnapshot(snapshot.replaceAll('\\n','\\r\\n'),'F401','F401_0.py'),extractRuffSnapshot(snapshot,'F401','F401_0.py'));
    for(const value of [snapshot.replace('F401 [','F4010 ['),snapshot.replace(':2:8',':0:8'),snapshot.replace(':2:8',':2:9007199254740992'),snapshot.replace('--> F401_0.py','--> F401_0.py.backup'),snapshot.replace('--> F401_0.py','--> F821_0.py'),snapshot+' --> F401_0.py:3:1\\n',snapshot.replace(' -->',' unrelated\\n -->'),header+'unrecognized diagnostic',snapshot.replace('mod.rs','other.rs')]) assert.throws(()=>extractRuffSnapshot(value,'F401','F401_0.py'));
  `);
});

test("external Ruff normalization retains exact identities and locations without raw content", () => {
  run(`
    import assert from 'node:assert/strict';
    const {normalizeRuffDiagnostics,compareRuffDiagnostics}=await import(new URL('external-ruff-evidence.mjs',process.argv[1]));
    const input={filename:'/synthetic/F401_0.py',code:'F401',location:{row:2,column:8},message:'private prose',fix:{content:'private source'}};
    const expected=[{code:'F401',file:'F401_0.py',line:2,column:8}];
    assert.deepEqual(normalizeRuffDiagnostics([input],'/synthetic','F401_0.py'),expected);
    assert.equal(normalizeRuffDiagnostics([{...input,code:null}],'/synthetic','F401_0.py')[0].code,'syntax-error');
    for(const value of [{...input,filename:'/outside/F401_0.py'},{...input,code:'F401-suffix'},{...input,location:{row:2,column:0}}]) assert.throws(()=>normalizeRuffDiagnostics([value],'/synthetic','F401_0.py'));
    assert.deepEqual(compareRuffDiagnostics(expected,expected),{expected:1,observed:1,matched:1,missing:[],unexpected:[]});
    for(const change of [{code:'F4010'},{line:3},{column:9},{file:'F821_0.py'}]) {
      const result=compareRuffDiagnostics(expected,[{...expected[0],...change}]);
      assert.equal(result.matched,0);assert.equal(result.missing.length,1);assert.equal(result.unexpected.length,1);
    }
    assert.equal(compareRuffDiagnostics(expected,[...expected,...expected]).unexpected.length,1);
    assert.equal(compareRuffDiagnostics([...expected,...expected],expected).missing.length,1);
  `);
});

test("external Ruff summary accounts for different, incomplete and excluded system results", () => {
  run(`
    import assert from 'node:assert/strict';
    const {summarizeRuffEvaluation}=await import(new URL('external-ruff-evidence.mjs',process.argv[1]));
    const cases=[{rule:'F401',file:'F401_0.py',expected:[{code:'F401',file:'F401_0.py',line:2,column:8}]},{rule:'F821',file:'F821_0.py',expected:[]},{rule:'F841',file:'F841_0.py',expected:null,exclusion:'unsupported-snapshot'}];
    const observations=cases.slice(0,2).flatMap(item=>['native','verifier'].map(system=>({rule:item.rule,system,outcome:item.expected.length?'failed':'passed',complete:true,diagnostics:item.expected})));
    let summary=summarizeRuffEvaluation(cases,observations);
    assert.deepEqual(summary.counts,{files:3,excludedFiles:1,systemFileResults:6,matched:4,different:0,incomplete:0,excluded:2});
    const changed=structuredClone(observations);changed[0].complete=false;changed[1].diagnostics[0].column=9;
    summary=summarizeRuffEvaluation(cases,changed);
    assert.deepEqual(summary.rows.map(x=>x.classification),['incomplete','different','matched','matched','excluded','excluded']);
    assert.equal(summary.counts.systemFileResults,summary.counts.matched+summary.counts.different+summary.counts.incomplete+summary.counts.excluded);
    for(const bad of [observations.slice(1),[...observations,observations[0]],[...observations,{...observations[0],rule:'F999'}],[...observations,{...observations[0],rule:'F841'}]]) assert.throws(()=>summarizeRuffEvaluation(cases,bad));
    for(const change of [{outcome:'passed'},{complete:'true'},{outcome:'unknown'}]) {const bad=structuredClone(observations);Object.assign(bad[0],change);assert.throws(()=>summarizeRuffEvaluation(cases,bad));}
    assert.throws(()=>summarizeRuffEvaluation([],[]));
    assert.throws(()=>summarizeRuffEvaluation([...cases,cases[0]],observations));
  `);
});

test("external Ruff recorded results reconcile frozen inputs, locations and both platforms", () => {
  run(`
    import assert from 'node:assert/strict';
    import {readFile} from 'node:fs/promises';
    import {createHash} from 'node:crypto';
    const base=new URL('../',process.argv[1]);
    const read=async file=>JSON.parse(await readFile(new URL(file,base),'utf8'));
    const hash=value=>createHash('sha256').update(value).digest('hex');
    const {summarizeRuffEvaluation}=await import(new URL('external-ruff-evidence.mjs',process.argv[1]));
    const plan=await read('scripts/external-ruff-plan.json');
    const inputs=await read('scripts/external-ruff-inputs.json');
    assert.equal(hash(JSON.stringify(plan,null,2)+'\\n'),inputs.planSha256);
    let first;
    for(const name of ['external-ruff-darwin-arm64-node26.json','external-ruff-linux-arm64-node22.json']) {
      const report=await read('docs/measurements/'+name);
      assert.equal(report.startedFromDeclaredPlan,inputs.planSha256);
      assert.equal(report.inputsSha256,hash(JSON.stringify(inputs)));
      for(const [key,value] of Object.entries(plan.frozenVerifier)) assert.equal(report.identities[key],value);
      assert.deepEqual(report.upstream,plan.upstream);
      assert.deepEqual(report.cases.map(x=>x.rule),plan.rules);
      for(const item of report.cases) {
        const selected=plan.cases.find(x=>x.rule===item.rule);
        assert.equal(item.sourceSha256,inputs.files.find(x=>x.file===selected.source).sha256);
        assert.equal(item.snapshotSha256,inputs.files.find(x=>x.file===selected.snapshot).sha256);
        const paired=report.observations.filter(x=>x.rule===item.rule);
        if(item.expected!==null) {assert.equal(paired.length,2);assert.equal(paired[0].sourceFingerprint,paired[1].sourceFingerprint);}
      }
      const result=summarizeRuffEvaluation(report.cases,report.observations);
      assert.deepEqual(report.counts,result.counts);assert.deepEqual(report.rows,result.rows);
      const text=JSON.stringify(report);
      for(const prefix of ['/Users/','/private/','/workspace/','/tmp/','/home/','"message":','"source":']) assert.ok(!text.includes(prefix));
      assert.deepEqual(report.model,{calls:0,tokens:0,providerCost:0});
      if(first) {assert.deepEqual(report.cases,first.cases);assert.deepEqual(report.rows,first.rows);assert.equal(report.identities.harnessSha256,first.identities.harnessSha256);}
      else first=report;
    }
  `);
});
