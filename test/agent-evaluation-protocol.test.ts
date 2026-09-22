import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

function exercise(body: string) {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      String.raw`
    import assert from 'node:assert/strict';
    import {createHash} from 'node:crypto';
    import {promises as fs} from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    const api=await import(process.argv[1]);
    const {analyzeSessionEvents}=await import(new URL('./agent-evaluation-session.mjs',process.argv[1]));
    const hash=value=>createHash('sha256').update(value).digest('hex');
    const encode=value=>JSON.stringify(value)+'\n';
    const binding={manifestSha256:'a'.repeat(64),subjectId:'assignment',sessionId:'session',role:'reviewer'};
    const profile={image:'sha256:'+'b'.repeat(64),runtimeSha256:'c'.repeat(64),dependenciesSha256:null,native:{executable:'python3',args:['-B','-m','unittest']},languages:['python'],timeoutMs:1000,maxOutputBytes:1024};
    const budget={wallSeconds:1,maxToolCalls:10,maxInputTokens:100,maxOutputTokens:100};
    const files=[{file:'entry.py',sha256:hash('value = 1\n')}];
    const expected={binding,profile,budget,files,exactFiles:true,treatment:false,gatewaySha256:'d'.repeat(64),workerSha256:'e'.repeat(64),nativeEvidence:{parser:'unittest',scope:['entry.py']}};
    const output=(overrides={})=>({exitCode:0,signal:null,stdout:'',stderr:'',durationMs:1,timedOut:false,truncated:false,cancelled:false,...overrides});
    const identity={runtimeSha256:null,dependenciesSha256:null};
    const integrity={scope:'mounted-trees-per-execution',expected:identity,before:identity,after:identity,verified:true};
    function fixture({native=output({stderr:'Ran 1 test in 0.001s\n\nOK\n'}),probe=output({stdout:'1\n'}),terminal={input_tokens:100,output_tokens:100},extraTools=[],extraCalls=[],treatment=false}={}) {
      const records=[],invocations=[];
      const add=event=>{
        const content={sequence:records.length+1,previous:records.at(-1)?.sha256??null,...event};
        const record={...content,sha256:hash(encode(content))};records.push(record);
        return 'evidence-'+record.sequence+'-'+record.sha256.slice(0,12);
      };
      add({type:'start',auditVersion:2,integrityScope:'mounted-trees-per-execution',binding,profile,budget:{maxCalls:10,timeoutMs:1000,maxOutputBytes:1024},gatewaySha256:expected.gatewaySha256,workerSha256:expected.workerSha256,image:profile.image,runtimeSha256:profile.runtimeSha256,dependenciesSha256:null,treatment,files:files.map(file=>({...file,bytes:10}))});
      const call=(tool,args,value,ok=true)=>{
        invocations.push({tool,arguments:args});
        const attempt=add({type:'call',tool,arguments:args});
        if(!ok)add({type:'error',attempt,message:'Synthetic rejected request'});
        return add({type:'result',attempt,tool,result:ok?{ok:true,value}:{ok:false,error:'Rejected'}});
      };
      const read=call('evaluation_read',{file:'entry.py'},{file:'entry.py',line:1,endLine:2,text:'value = 1\n',lines:[{line:1,text:'value = 1'},{line:2,text:''}]});
      const nativeId=call('evaluation_native',{}, {...native,integrity});
      const probeId=call('evaluation_probe',{language:'python',code:'print(1)',sourceEvidenceIds:[read]},{...probe,integrity,sourceFiles:files});
      for(const extra of extraCalls)call(...extra);
      const executionCount=2+extraCalls.filter(([tool,,value,ok])=>ok!==false&&['evaluation_native','evaluation_probe','checktrail_validate','checktrail_plan'].includes(tool)).length;
      add({type:'end',cleanupCompleted:true,sourceSnapshotRemoved:true,integrityScope:'completed-execution-calls',calls:invocations.length,executionAttempts:executionCount,verifiedExecutions:executionCount,integrityFailures:0});
      const events=[...invocations.map((item,index)=>({type:'item.completed',item:{id:'tool-'+index,type:'mcp_tool_call',server:'eval',...item}})),...extraTools,{type:'turn.completed',usage:terminal}];
      const eventsText=events.map(encode).join('');
      const analysis=analyzeSessionEvents(Buffer.from(eventsText),{client:'codex',budget});
      const bundle={auditText:records.map(encode).join(''),eventsText,metering:{...analysis,client:'codex',binding,elapsedMs:1000,exitCode:0,exitSignal:null,stoppedReason:null,complete:true}};
      return {bundle,records,events,read,nativeId,probeId};
    }
    function rewrite(fixture,mutate) {
      mutate(fixture.records);
      let previous=null;
      const references=new Map();
      const replace=value=>{
        if(typeof value==='string')return references.get(value)??value;
        if(Array.isArray(value))return value.map(replace);
        if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,replace(item)]));
        return value;
      };
      fixture.records=fixture.records.map((record,index)=>{
        const {sha256,...content}=record;
        const fixed=replace(content);fixed.sequence=index+1;fixed.previous=previous;
        const updated={...fixed,sha256:hash(encode(fixed))};previous=updated.sha256;
        references.set('evidence-'+record.sequence+'-'+sha256.slice(0,12),'evidence-'+updated.sequence+'-'+updated.sha256.slice(0,12));
        return updated;
      });
      fixture.bundle.auditText=fixture.records.map(encode).join('');
      fixture.events=replace(fixture.events);
      fixture.bundle.eventsText=fixture.events.map(encode).join('');
      fixture.bundle.metering={...fixture.bundle.metering,...analyzeSessionEvents(Buffer.from(fixture.bundle.eventsText),{client:'codex',budget})};
      return fixture.bundle;
    }
    const verify=(value,override={})=>api.verifyProtocolEvidence(value,{...expected,...override});
    const incomplete=(value,problem,override={})=>{const result=verify(value,override);assert.equal(result.complete,false,JSON.stringify(result));if(problem)assert.ok(result.problems.includes(problem),JSON.stringify(result));return result;};
    ${body}
  `,
      new URL("../../scripts/agent-evaluation-protocol.mjs", import.meta.url)
        .href,
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
}

test("enforced protocol binds execution, numbered source and exact inclusive budgets", () => {
  exercise(String.raw`
    const fixture1=fixture();
    const result=verify(fixture1.bundle,{budget:{...budget,repetitions:1}});
    assert.equal(result.complete,true,JSON.stringify(result));
    assert.deepEqual(result.probes,[fixture1.probeId]);
    assert.deepEqual(result.probeSources,{[fixture1.probeId]:['entry.py']});
    assert.deepEqual(result.native,[fixture1.nativeId]);
    assert.deepEqual(result.reads,[{evidenceId:fixture1.read,file:'entry.py',line:1,endLine:2}]);
    assert.equal(result.usage.costUsd,null);
    assert.equal(result.usage.elapsedMs,1000);
    assert.equal(result.toolCalls,3);
    const rejected=fixture({extraCalls:[['evaluation_read',{file:'missing.py'},null,false]]});
    assert.equal(verify(rejected.bundle).complete,true,JSON.stringify(verify(rejected.bundle)));
    const unknownRead=fixture({extraCalls:[['evaluation_probe',{language:'python',code:'print(1)',sourceEvidenceIds:['evidence-3-000000000000']},null,false]]});
    assert.equal(verify(unknownRead.bundle).complete,true,JSON.stringify(verify(unknownRead.bundle)));
    incomplete(fixture({terminal:{input_tokens:101,output_tokens:100}}).bundle,'session-input-token-budget');
    incomplete(fixture({terminal:{input_tokens:100,output_tokens:101}}).bundle,'session-output-token-budget');
    const wall=fixture();wall.bundle.metering.elapsedMs=1001;
    incomplete(wall.bundle,'wall-time-budget-exceeded');
    const unknown=fixture({terminal:{input_tokens:100}});
    incomplete(unknown.bundle,'required-token-usage-unknown');
    for(const field of ['inputTokens','outputTokens','toolCalls','eventsSha256','eventsBytes','parserVersion']){
      const forged=fixture();forged.bundle.metering[field]=field==='parserVersion'?'fake':-1;
      incomplete(forged.bundle,'metering-'+field+'-mismatch');
    }
    const foreign=fixture();foreign.bundle.metering.binding={...binding,sessionId:'foreign'};
    incomplete(foreign.bundle,'metering-binding-mismatch');
    const stopped=fixture();stopped.bundle.metering.stoppedReason='wall-time-budget';
    incomplete(stopped.bundle,'session-process-incomplete');
    const forgedComplete=fixture();forgedComplete.bundle.metering.complete=false;
    assert.equal(verify(forgedComplete.bundle).complete,true);
    const defaults=fixture();
    assert.equal(verify(rewrite(defaults,records=>{records[1].arguments={file:'entry.py',line:1,count:100}})).complete,true);
    const sdkRejected=fixture({extraTools:[{type:'item.completed',item:{id:'invalid',type:'mcp_tool_call',server:'eval',tool:'evaluation_read',arguments:{file:'entry.py',line:0}}}]});
    assert.equal(verify(sdkRejected.bundle).complete,true);
    const unrecorded=fixture({extraTools:[{type:'item.completed',item:{id:'absent',type:'mcp_tool_call',server:'eval',tool:'evaluation_files',arguments:{}}}]});
    incomplete(unrecorded.bundle,'client-gateway-dispatch-missing');
  `);
});

test("enforced protocol rejects wrong bindings, source, profiles, audit chains and lifecycle counters", () => {
  exercise(String.raw`
    for(const [change,problem] of [
      [records=>{records[0].binding={...binding,subjectId:'sibling'}},'gateway-binding-mismatch'],
      [records=>{records[0].files[0].sha256='f'.repeat(64)},'gateway-source-mismatch'],
      [records=>{records[0].profile={...profile,native:{executable:'python3',args:['different.py']}}},'gateway-profile-mismatch'],
      [records=>{records[0].gatewaySha256='f'.repeat(64)},'gateway-implementation-mismatch'],
      [records=>{records[0].budget.maxCalls=11},'gateway-budget-mismatch'],
      [records=>{records.at(-1).calls++},'gateway-counters-mismatch'],
      [records=>{records.at(-1).executionAttempts++},'gateway-counters-mismatch'],
      [records=>{records.at(-1).verifiedExecutions--},'gateway-counters-mismatch'],
      [records=>{records.at(-1).integrityFailures++},'gateway-execution-integrity-failed'],
      [records=>{records.at(-1).cleanupCompleted=false},'gateway-cleanup-incomplete'],
      [records=>{records.at(-1).sourceSnapshotRemoved=false},'gateway-cleanup-incomplete'],
      [records=>{records.pop()},'gateway-cleanup-incomplete'],
      [records=>{records.push({...records.at(-1),type:'unknown'})},'gateway-cleanup-incomplete'],
    ]) incomplete(rewrite(fixture(),change),problem);
    const chain=fixture();chain.bundle.auditText=chain.bundle.auditText.replace('value = 1','value = 2');
    incomplete(chain.bundle,'gateway-chain-invalid');
    const resultLink=fixture();
    incomplete(rewrite(resultLink,records=>{records[2].attempt='evidence-999-000000000000'}),'gateway-result-link-invalid');
    const malformed=fixture();malformed.bundle.auditText='not JSON\n';
    incomplete(malformed.bundle,'protocol-evidence-malformed');
    const missing=fixture();missing.bundle.auditText=null;
    incomplete(missing.bundle,'gateway-audit-missing');
    const extra=fixture();
    const subset={...expected,files:[],exactFiles:false};
    assert.equal(api.verifyProtocolEvidence(extra.bundle,subset).complete,true);
    incomplete(extra.bundle,'gateway-source-mismatch',{files:[],exactFiles:true});
  `);
});

test("enforced native evidence needs real positive test counts and probe source bindings", () => {
  exercise(String.raw`
    const failed=fixture({native:output({exitCode:1,stderr:'Ran 2 tests in 0.001s\n\nFAILED (failures=1)\n'})});
    assert.deepEqual(verify(failed.bundle).native,[failed.nativeId]);
    for(const native of [output(),output({stderr:'Ran 0 tests in 0.001s\n\nOK\n'}),output({stderr:'Ran 1 test in 0.001s\n\nOK (skipped=1)\n'}),output({exitCode:1,stderr:'Ran 1 test in 0.001s\n\nOK\n'}),output({stderr:'Ran 1 test in 0.001s\n\nFAILED (failures=1)\n'}),output({truncated:true,stderr:'Ran 1 test in 0.001s\n\nOK\n'})])
      assert.deepEqual(verify(fixture({native}).bundle).native,[]);
    const nonzero=fixture({probe:output({exitCode:1})});
    assert.deepEqual(verify(nonzero.bundle).probes,[]);
    const wrongSource=fixture();
    assert.deepEqual(verify(rewrite(wrongSource,records=>{records[6].result.value.sourceFiles=[]})).probes,[]);
    const truncated=fixture();truncated.bundle.eventsText=truncated.bundle.eventsText.slice(0,-20);
    incomplete(truncated.bundle);
    const forbidden=fixture({extraTools:[{type:'item.completed',item:{id:'shell',type:'command_execution',command:'cat /private/secret'}}]});
    incomplete(forbidden.bundle,'client-unexpected-tool');
    const resource=fixture({extraTools:[{type:'item.completed',item:{id:'resources',type:'list_mcp_resources',arguments:{}}}]});
    incomplete(resource.bundle,'client-unexpected-tool');
    const dispatch=fixture();dispatch.bundle.eventsText=dispatch.bundle.eventsText.replace('print(1)','print(2)');
    dispatch.bundle.metering={...dispatch.bundle.metering,...analyzeSessionEvents(Buffer.from(dispatch.bundle.eventsText),{client:'codex',budget})};
    incomplete(dispatch.bundle,'client-gateway-dispatch-mismatch');
    assert.equal(api.probeEvidenceIds.safeParse(['evidence-3-aaaaaaaaaaaa','evidence-3-aaaaaaaaaaaa']).success,false);
  `);
});

test("protocol MCP and Vitest comparators need conclusive retained positive test evidence", () => {
  exercise(String.raw`
    const engineIdentity={runtimeSha256:profile.runtimeSha256,dependenciesSha256:null};
    const engineIntegrity={scope:'mounted-trees-per-execution',expected:engineIdentity,before:engineIdentity,after:engineIdentity,verified:true};
    const report={schemaVersion:1,runId:'synthetic',engineVersion:'synthetic-engine',sourceChanged:false,sourceError:false,sourceFingerprint:'frozen',finalSourceFingerprint:'frozen',outcome:'passed',checks:[{id:'python.unittest',status:'passed',tests:{total:1,passed:1,failed:0,skipped:0},processes:[output()]}]};
    function mcp(overrides={}) {
      const value=output({integrity:engineIntegrity,trace:{server:{name:'checktrail',version:'synthetic-engine'},action:'validation_run',result:{structuredContent:report},retainedReport:{structuredContent:report}},...overrides});
      return fixture({treatment:true,extraCalls:[['checktrail_validate',{},value]]});
    }
    const passing=mcp();
    const passResult=verify(passing.bundle,{treatment:true,engineVersion:'synthetic-engine'});
    assert.equal(passResult.complete,true,JSON.stringify(passResult));
    assert.equal(passResult.validations.length,1);
    assert.deepEqual(verify(passing.bundle,{treatment:true,engineVersion:'wrong-engine'}).validations,[]);
    for(const mutate of [
      value=>{value.trace.retainedReport.structuredContent={...report,runId:'other'}},
      value=>{value.trace.action='validation_plan'},
      value=>{value.trace.result.isError=true},
      value=>{value.trace.result.structuredContent.sourceChanged=true},
      value=>{value.trace.result.structuredContent.sourceError=true},
      value=>{value.trace.result.structuredContent.finalSourceFingerprint='changed'},
      value=>{value.trace.result.structuredContent.checks=[]},
      value=>{value.trace.result.structuredContent.checks[0].tests={total:0,passed:0,failed:0,skipped:0}},
      value=>{value.trace.result.structuredContent.checks[0].tests={total:1,passed:0,failed:0,skipped:1}},
      value=>{value.trace.result.structuredContent.checks[0].status='inconclusive'},
      value=>{value.trace.result.structuredContent.checks[0].processes[0].truncated=true},
    ]) {
      const current=mcp();
      const mutated=rewrite(current,records=>{const value=records[8].result.value;value.trace=structuredClone(value.trace);mutate(value);if(value.trace.action==='validation_run'&&value.trace.retainedReport.structuredContent.runId==='synthetic')value.trace.retainedReport.structuredContent=structuredClone(value.trace.result.structuredContent)});
      assert.deepEqual(verify(mutated,{treatment:true}).validations,[]);
    }
    const vitest={success:true,numTotalTests:1,numPassedTests:1,numFailedTests:0,numPendingTests:0,numTodoTests:0,numTotalTestSuites:1,numPassedTestSuites:1,numFailedTestSuites:0,numPendingTestSuites:0,testResults:[{name:'/source/entry.py',status:'passed',assertionResults:[{fullName:'example',status:'passed'}]}]};
    const native=fixture({native:output({stdout:JSON.stringify(vitest)})});
    assert.equal(verify(native.bundle,{nativeEvidence:{parser:'vitest-json',scope:['entry.py']}}).native.length,1);
    assert.deepEqual(verify(native.bundle,{nativeEvidence:{parser:'vitest-json',scope:['other.py']}}).native,[]);
  `);
});

test("protocol evidence import rejects missing files and symlink artifacts without losing incompleteness", () => {
  exercise(String.raw`
    const temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'checktrail-protocol-')));
    try{
      const {bundle}=fixture();
      await fs.writeFile(path.join(temporary,'gateway-audit.jsonl'),bundle.auditText);
      await fs.writeFile(path.join(temporary,'events.jsonl'),bundle.eventsText);
      await fs.writeFile(path.join(temporary,'metering.json'),JSON.stringify(bundle.metering));
      assert.equal(verify(await api.readProtocolEvidence(temporary)).complete,true);
      await fs.writeFile(path.join(temporary,'metering.json'),JSON.stringify({...bundle.metering,padding:'x'.repeat(70000)}));
      assert.equal(verify(await api.readProtocolEvidence(temporary)).complete,true);
      await fs.rename(path.join(temporary,'metering.json'),path.join(temporary,'hidden.json'));
      await fs.symlink('hidden.json',path.join(temporary,'metering.json'));
      incomplete(await api.readProtocolEvidence(temporary),'metering.json-unavailable-or-invalid');
      await fs.unlink(path.join(temporary,'events.jsonl'));
      incomplete(await api.readProtocolEvidence(temporary),'events.jsonl-unavailable-or-invalid');
      const absent=await api.readProtocolEvidence(path.join(temporary,'absent'));
      incomplete(absent,'evidence-directory-unavailable');
      await fs.unlink(path.join(temporary,'metering.json'));
      await fs.writeFile(path.join(temporary,'metering.json'),JSON.stringify({padding:'x'.repeat(32*1024*1024)}));
      incomplete(await api.readProtocolEvidence(temporary),'metering.json-unavailable-or-invalid');
    }finally{await fs.rm(temporary,{recursive:true,force:true});}
  `);
});
