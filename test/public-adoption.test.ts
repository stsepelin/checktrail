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
      new URL("../../scripts/public-adoption-evidence.mjs", import.meta.url)
        .href,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("public adoption evidence rejects duplicate summaries and mismatched test accounting", () => {
  run(`
    import assert from 'node:assert/strict';
    const {nativeEvidence,compareNativeEvidence}=await import(process.argv[1]);
    const stdout='# tests 3\\n# pass 2\\n# fail 1\\n# skipped 0\\n';
    const native=[{exitCode:1,stdout,stderr:''}];
    const report={checks:[{id:'javascript.node-test',status:'failed',tests:{total:3,passed:2,failed:1,skipped:0},processes:[{stdout:'checktrail adoption sentinel',stderr:''}]}]};
    assert.equal(compareNativeEvidence('nanoid',native,report,true).negativeControlDetected,true);
    assert.throws(()=>nativeEvidence('nanoid',[{...native[0],stdout:stdout+'# tests 3\\n'}]));
    assert.throws(()=>nativeEvidence('nanoid',[{...native[0],stdout:stdout.replace('# pass 2','# pass 3')}]));
    const wrong=structuredClone(report);wrong.checks[0].tests.failed=0;
    assert.throws(()=>compareNativeEvidence('nanoid',native,wrong,true));
    const unrelated=structuredClone(report);unrelated.checks[0].processes[0].stdout='unrelated failure';
    assert.throws(()=>compareNativeEvidence('nanoid',native,unrelated,true));
  `);
});

test("public adoption distinguishes compiler startup errors from the intended type failure", () => {
  run(`
    import assert from 'node:assert/strict';
    const {compareNativeEvidence}=await import(process.argv[1]);
    const native=[{exitCode:2,stdout:'src/checktrail-adoption.ts(1,1): error TS2322: synthetic type error',stderr:''}];
    const report={checks:[{id:'javascript.typescript',status:'failed',processes:[{stdout:'error TS5023: Unknown compiler option',stderr:''}]}]};
    const result=compareNativeEvidence('mitt',native,report,true);
    assert.deepEqual(result.diagnosticCodes,['TS2322']);
    assert.deepEqual(result.wrapperDiagnosticCodes,['TS5023']);
    assert.equal(result.negativeControlDetected,false);
    report.checks[0].processes[0].stdout=native[0].stdout;
    assert.equal(compareNativeEvidence('mitt',native,report,true).negativeControlDetected,true);
  `);
});

test("public adoption preserves Go skips, exit-zero formatting findings and PHP syntax scope", () => {
  run(`
    import assert from 'node:assert/strict';
    const {nativeEvidence,compareNativeEvidence}=await import(process.argv[1]);
    const events=[{Package:'synthetic',Test:'One',Action:'pass'},{Package:'synthetic',Test:'Two',Action:'skip'}].map(x=>JSON.stringify(x)).join('\\n');
    const native=[{exitCode:0,stdout:'source.go\\n',stderr:''},{exitCode:0,stdout:'',stderr:''},{exitCode:0,stdout:events,stderr:''}];
    assert.deepEqual(nativeEvidence('uuid',native),{formattedFiles:['source.go'],tests:{total:2,passed:1,failed:0,skipped:1}});
    assert.throws(()=>nativeEvidence('uuid',[native[0],native[1],{...native[2],stdout:events+'\\n'+events}]));
    const php=[{exitCode:0,stdout:'No syntax errors',stderr:''},{exitCode:255,stdout:'checktrail-adoption-broken.php syntax error',stderr:''}];
    const report={checks:[{id:'php.syntax',status:'failed',processes:php}]};
    assert.deepEqual(compareNativeEvidence('psr-log',php,report,true),{files:2,passed:1,failed:1,negativeControlDetected:true});
    report.checks[0].processes=php.slice(1);
    assert.throws(()=>compareNativeEvidence('psr-log',php,report,true));
  `);
});

test("public adoption record retains every pinned project, incomplete coverage and wrong-signal control", () => {
  run(`
    import assert from 'node:assert/strict';
    import {readFileSync} from 'node:fs';
    import {createHash} from 'node:crypto';
    const scripts=new URL('./',process.argv[1]);
    const read=(relative)=>readFileSync(new URL(relative,scripts));
    const hash=(bytes)=>createHash('sha256').update(bytes).digest('hex');
    const plan=JSON.parse(read('public-adoption-plan.json'));
    const record=JSON.parse(read('../docs/measurements/public-adoption-alpha2.json'));
    assert.equal(record.planSha256,hash(read('public-adoption-plan.json')));
    assert.equal(record.harnessSha256,hash(read('measure-public-adoption.mjs')));
    assert.equal(record.evidenceParserSha256,hash(read('public-adoption-evidence.mjs')));
    assert.deepEqual(record.observations.map(x=>[x.id,x.commit]),plan.projects.map(x=>[x.id,x.commit]));
    for(const row of record.observations){
      assert.equal(row.trackedSourceUnchanged,true);
      assert.equal(row.preservation,'byte-identical');
      assert.equal(row.doctorPrepared.validationPerformed,false);
      assert.equal(row.negativeComparison.negativeControlDetected,row.id!=='mitt');
      const native=row.nativeComparison.tests;
      const wrapped=row.languageOnly.checks.find(x=>x.tests)?.tests;
      if(native&&wrapped) assert.deepEqual(wrapped,native);
      if(native) {
        assert.equal(native.total,native.passed+native.failed+native.skipped);
        assert.equal(row.negativeComparison.tests.total,native.total+1);
        assert.equal(row.negativeComparison.tests.failed,1);
      }
    }
    const typescript=record.observations.find(x=>x.id==='mitt');
    assert.equal(typescript.preparedTypeScript.nativeExitCode,0);
    assert.deepEqual(typescript.preparedTypeScript.comparison.wrapperDiagnosticCodes,['TS5023']);
    assert.notEqual(typescript.preparedTypeScript.wrapper.outcome,'passed');
    const go=record.observations.find(x=>x.id==='uuid');
    assert.equal(go.languageOnly.checks.find(x=>x.id==='go.test').status,'inconclusive');
    assert.equal(go.languageOnly.checks.find(x=>x.id==='go.format').status,'failed');
    for(const row of record.observations.filter(x=>['nanoid','more-itertools'].includes(x.id))) {
      assert.equal(row.fullPolicy.outcome,'incomplete');
      assert.equal(row.languageOnly.outcome,'passed');
      assert.ok(row.doctorLanguageOnly.issues.some(x=>x.code==='unselected-project'));
    }
    assert.doesNotMatch(JSON.stringify(record),/\\/Users\\/|\\/opt\\/homebrew\\/|\\/adoption\\//);
  `);
});
