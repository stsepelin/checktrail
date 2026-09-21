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

test("external case extraction preserves constructor settings, diagnostics and excluded denominators without executing source", () => {
  run(`
    import assert from 'node:assert/strict';
    const {extractRuleCases} = await import(new URL('external-evaluation-extract.mjs',process.argv[1]));
    const wrap=(valid,invalid,config='{}')=>'const ruleTester = new RuleTester('+config+'); ruleTester.run("sample-rule", rule, {valid:['+valid+'],invalid:['+invalid+']});';
    const limits={maxCasesPerRule:20,maxSourceBytes:100};
    const source=wrap('"var a;", {code:"let a;",languageOptions:{ecmaVersion:6}}, {code:(globalThis.EXECUTED=true)}, {code:"x",languageOptions:{parser:customParser}}, {code:"x",before:()=>{globalThis.EXECUTED=true}}', '{code:"bad",errors:[{messageId:"specific",line:1,column:2,data:arbitraryFunction(),suggestions:alsoNotEvaluated()}]}', '{languageOptions:{ecmaVersion:5,sourceType:"script"}}');
    const extracted=extractRuleCases(source,'sample-rule',limits);
    assert.equal(globalThis.EXECUTED,undefined);
    assert.equal(extracted.total,6);
    assert.equal(extracted.cases.length,3);
    assert.equal(extracted.excluded.length,3);
    assert.deepEqual(extracted.cases[0].languageOptions,{ecmaVersion:5,sourceType:'script'});
    assert.deepEqual(extracted.cases[1].languageOptions,{ecmaVersion:6,sourceType:'script'});
    assert.deepEqual(extracted.cases[2].expected,[{messageId:'specific',line:1,column:2}]);
    assert.deepEqual(extracted.excluded.map(x=>x.reason),['nonliteral-value','nonliteral-value','unsupported-case-settings']);
    assert.equal(new Set([...extracted.cases,...extracted.excluded].map(x=>x.id)).size,6);
    const mapped=wrap('"valid"','{code:"bad",errors:[{messageId:"specific"}]}').replace('invalid:[{code:"bad",errors:[{messageId:"specific"}]}]', 'invalid:[{code:"bad",errors:[{messageId:"specific"}]}].map(item=>Object.assign({output:null},item))');
    assert.equal(extractRuleCases(mapped,'sample-rule',limits).cases.length,2);
    for(const input of [mapped.replace('output:null','code:"changed"'),mapped.replace('.map(','.filter('),mapped.replace('},item)','},other)'),source.replace('valid:[','valid:[...extra,'),source.replace('sample-rule','another-rule')]) assert.throws(()=>extractRuleCases(input,'sample-rule',limits));
    const malformed=extractRuleCases(wrap('{code:"a",code:"b"}, {code:"x",languageOptions:{sourceType:"module",extra:true}}','{code:"bad",errors:1}'),'sample-rule',limits);
    assert.equal(malformed.cases.length,0);
    assert.equal(malformed.excluded.length,3);
    assert.throws(()=>extractRuleCases(source,'sample-rule',{...limits,maxCasesPerRule:1}));
    assert.equal(extractRuleCases(wrap('"too long"',''),'sample-rule',{...limits,maxSourceBytes:1}).excluded.length,1);
  `);
});

test("external evaluation matrices retain missing signals, malformed observations and non-executable cases", () => {
  run(`
    import assert from 'node:assert/strict';
    const {summarizeExternalCases}=await import(new URL('external-evaluation-extract.mjs',process.argv[1]));
    const cases=['defect','defect','defect','defect','valid','valid','valid'].map((label,index)=>({id:String(index),rule:'sample-rule',label,expected:label==='defect'?[{messageId:'expected',line:1}]:[]}));
    const diagnostic={file:'case.js',ruleId:'sample-rule',messageId:'expected',severity:2,line:1,column:1};
    const outcomes=['failed','failed','passed','incomplete','passed','failed','incomplete'];
    const observations=cases.flatMap((item,index)=>['native','verifier'].map(system=>({id:item.id,system,outcome:outcomes[index],wallMs:1,diagnostics:[0,1,5].includes(index)?[{...diagnostic,messageId:index===1?'wrong':'expected'}]:[]})));
    const excluded=[{id:'excluded',rule:'sample-rule',label:'defect',reason:'nonliteral-source'}];
    const result=summarizeExternalCases(cases,observations,excluded);
    for(const row of result.totals) {
      assert.equal(row.count,8);assert.equal(row.defect,5);assert.equal(row.valid,3);
      assert.equal(row.detected,1);assert.equal(row['wrong-signal'],1);assert.equal(row.missed,1);
      assert.equal(row.incomplete,2);assert.equal(row.clean,1);assert.equal(row['false-positive'],1);assert.equal(row.excluded,1);
    }
    for(const bad of [observations.slice(1),[...observations.slice(1),observations[1]],[...observations.slice(1),{...observations[0],id:'unknown'}]]) assert.throws(()=>summarizeExternalCases(cases,bad));
    for(const bad of [{outcome:'unknown'},{wallMs:NaN},{diagnostics:[{}]},{diagnostics:[{...diagnostic,source:'must not appear'}]}]) {
      const copy=structuredClone(observations);Object.assign(copy[0],bad);assert.throws(()=>summarizeExternalCases(cases,copy));
    }
    assert.throws(()=>summarizeExternalCases([],[]));
    assert.throws(()=>summarizeExternalCases(cases,observations,[{...excluded[0],id:'0'}]));
    const changed=structuredClone(observations);changed[0].diagnostics[0].line=2;
    assert.equal(summarizeExternalCases(cases,changed).rows[0].classification,'wrong-signal');
    changed[0].diagnostics[0].line=1;changed[0].diagnostics[0].ruleId='sample-rule-extra';
    assert.equal(summarizeExternalCases(cases,changed).rows[0].classification,'wrong-signal');
  `);
});

test("external native evidence requires complete file accounting and strips raw messages and source", () => {
  run(`
    import assert from 'node:assert/strict';
    const {normalizeExternalDiagnostics}=await import(new URL('external-evaluation-evidence.mjs',process.argv[1]));
    const root='/synthetic';
    const message={ruleId:'sample-rule',messageId:'specific',severity:2,line:1,column:3,endLine:1,endColumn:4,message:'private prose',source:'private source'};
    const rows=[{filePath:root+'/case.js',messages:[message],errorCount:1,warningCount:0,fatalErrorCount:0},{filePath:root+'/eslint.config.cjs',messages:[],errorCount:0,warningCount:0,fatalErrorCount:0}];
    const result=normalizeExternalDiagnostics(rows,root);
    assert.equal(result.length,1);assert.equal(result[0].file,'case.js');
    assert.ok(!JSON.stringify(result).includes('private'));assert.ok(!JSON.stringify(result).includes(root));
    for(const data of [rows.slice(1),[rows[0],rows[0]],[{...rows[0],filePath:'/outside.js'},rows[1]],[{...rows[0],errorCount:0},rows[1]],[{...rows[0],fatalErrorCount:1},rows[1]],[{...rows[0],messages:[{...message,line:0}]},rows[1]]]) assert.throws(()=>normalizeExternalDiagnostics(data,root));
  `);
});

test("external evaluation snapshots reconcile every observation, exclusion and frozen input identity", () => {
  run(`
    import assert from 'node:assert/strict';
    import {readFile} from 'node:fs/promises';
    const base=new URL('../',process.argv[1]);
    const {summarizeExternalCases,sha256}=await import(new URL('external-evaluation-extract.mjs',process.argv[1]));
    const plan=JSON.parse(await readFile(new URL('scripts/external-evaluation-plan.json',base),'utf8'));
    const inputs=JSON.parse(await readFile(new URL('scripts/external-evaluation-inputs.json',base),'utf8'));
    assert.equal(sha256(JSON.stringify(plan,null,2)+'\\n'),inputs.planSha256);
    let first;
    for(const name of ['external-eslint-darwin-arm64-node26.json','external-eslint-linux-arm64-node22.json']) {
      const text=await readFile(new URL('docs/measurements/'+name,base),'utf8');
      const report=JSON.parse(text);
      assert.equal(report.planSha256,inputs.planSha256);
      assert.equal(report.identities.inputsSha256,sha256(JSON.stringify(inputs)));
      for(const [key,value] of Object.entries(plan.frozenVerifier)) assert.equal(report.identities[key],value);
      assert.equal(report.corpusSha256,sha256(JSON.stringify({manifest:report.manifest,excluded:report.excluded})));
      const summary=summarizeExternalCases(report.manifest,report.observations,report.excluded);
      assert.deepEqual(report.totals,summary.totals);assert.deepEqual(report.rows,summary.rows);
      assert.equal(report.extraction.reduce((n,x)=>n+x.total,0),report.manifest.length+report.excluded.length);
      for(const row of report.extraction) {
        assert.equal(row.total,row.selected+row.excluded);
        assert.equal(row.selected,report.manifest.filter(x=>x.rule===row.rule).length);
        assert.equal(row.excluded,report.excluded.filter(x=>x.rule===row.rule).length);
      }
      for(const item of report.manifest) {
        const paired=report.observations.filter(x=>x.id===item.id);
        assert.equal(paired.length,2);assert.equal(paired[0].sourceFingerprint,paired[1].sourceFingerprint);
        for(const value of paired) assert.match(value.outputSha256,/^[a-f0-9]{64}$/);
      }
      assert.ok(!['/Users/','/private/','/workspace/','/tmp/','/home/','"code":','"source":'].some(prefix=>text.includes(prefix)));
      if(first) {assert.equal(report.corpusSha256,first.corpusSha256);assert.deepEqual(report.totals,first.totals);assert.equal(report.identities.harnessSha256,first.identities.harnessSha256);}
      else first=report;
    }
  `);
});
