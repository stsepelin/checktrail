import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const setup = String.raw`
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const api=await import(process.argv[1]);
const gatewayApi=await import(process.argv[2]);
const {analyzeSessionEvents}=await import(process.argv[3]);
const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'checktrail-enforced-')));
const encode=value=>JSON.stringify(value,null,2)+'\n';
const identity=sessionId=>({sessionId,provider:'synthetic',model:'fixture',version:'test',provenance:'orchestrator-declared'});
const usage={inputTokens:null,outputTokens:null,costUsd:null,elapsedMs:null,provenance:'reviewer-declared'};
const budget={wallSeconds:20,maxToolCalls:20,maxInputTokens:null,maxOutputTokens:100};
async function fixture(name='run') {
 const base=path.join(root,name),source=path.join(base,'source'),runtime=path.join(base,'runtime');
 await fs.mkdir(source,{recursive:true});await fs.mkdir(runtime);
 await fs.writeFile(path.join(source,'value.py'),'value = 1\nnext_value = 2\n');
 await fs.writeFile(path.join(source,'test_value.py'),'import unittest\n');
 await fs.writeFile(path.join(runtime,'public.txt'),'synthetic runtime');
 const artifact=path.join(base,'artifact');await fs.writeFile(artifact,'synthetic package');
 const profile={image:'sha256:'+'a'.repeat(64),runtimeSha256:await gatewayApi.treeDigest(runtime),dependenciesSha256:null,native:{executable:'python3',args:['-m','unittest']},languages:['python'],timeoutMs:1000,maxOutputBytes:65536};
 const plan={schemaVersion:1,id:name,purpose:'Synthetic enforcement regression',evidenceClass:'development',curatorSessionId:'curator',reviewerProfile:{provider:'synthetic',model:'fixture',version:'test',settings:'No inference'},environment:{platform:'synthetic',runtime:'synthetic',dependencies:'none'},engine:{package:'@stsepelin/checktrail',version:'synthetic',artifact,sha256:api.sha256(await fs.readFile(artifact))},isolation:'procedural',isolationEvidence:'Injected synthetic executor; no model inference',budget:{...budget,repetitions:1},executionProtocol:{kind:'gateway-v1',judgeBudget:budget,judgeProfile:profile},cases:[{id:'one',family:'python',group:'one',split:'development',root:source,files:['value.py','test_value.py'],task:'Review selected source',source:{repository:'https://example.org/synthetic',revision:'a'.repeat(40),license:'MIT'},reviewCommands:[],validators:[],exclusion:null,executionProfile:profile,nativeEvidence:{parser:'unittest',scope:['test_value.py']}}]};
 const labels=[{caseId:'one',scope:'Synthetic protocol only',provenance:'Synthetic',expectedDefects:[]}];
 const run=path.join(base,'frozen'),frozen=await api.freeze(plan,labels,run);
 return {base,source,runtime,profile,plan,run,frozen};
}
function receipt(f,index,findings=[]) {return {schemaVersion:1,assignmentId:f.frozen.manifest.assignments[index].id,manifestSha256:f.frozen.sha256,sourceSha256:f.frozen.manifest.cases[0].captured.sha256,reviewer:identity('review-'+index),status:'completed',findings,limitations:['Synthetic execution accounting only'],usage};}
async function evidence(f,index,callback,judge=false,mutateJudge) {
 const a=f.frozen.manifest.assignments[index];
 const dir=path.join(f.base,judge?'judge-evidence':'evidence-'+index);if(!judge)await api.beginAttempt(f.run,a.id,'review-'+index,dir);await fs.mkdir(dir);
 const source=judge?path.join(f.base,'judge-source'):f.source;
 let files=f.plan.cases[0].files;
 if(judge){await api.blind(f.run,source);files=['judging.json',...f.frozen.manifest.assignments.flatMap(item=>f.plan.cases[0].files.map(file=>item.blindId+'/source/'+file))];}
 if(judge&&mutateJudge){const filename=path.join(source,'judging.json');const packet=JSON.parse(await fs.readFile(filename,'utf8'));mutateJudge(packet);await fs.writeFile(filename,encode(packet));}
 const binding={manifestSha256:f.frozen.sha256,subjectId:judge?'judging':a.id,sessionId:judge?'judge':'review-'+index,role:judge?'judge':'reviewer'};
 const config={schemaVersion:1,source,files,audit:path.join(dir,'gateway-audit.jsonl'),image:f.profile.image,runtime:f.runtime,dependencies:null,treatment:judge?false:a.arm==='mcp',binding,native:f.profile.native,languages:['python'],timeoutMs:1000,maxOutputBytes:65536,maxCalls:20};
 const events=[];
 const execute=async(_root,command)=>{
  const output={command,exitCode:0,signal:null,stdout:'',stderr:'',durationMs:1,timedOut:false,cancelled:false,truncated:false};
  if(command.args[0]==='rm')return output;
  if(command.args.includes('/worker.mjs')){
   const report={outcome:'passed',sourceChanged:false,sourceError:false,sourceFingerprint:'b'.repeat(64),finalSourceFingerprint:'b'.repeat(64),checks:[{id:'python.unittest',status:'passed',tests:{total:1,passed:1,failed:0,skipped:0},processes:[output]}]};
   return {...output,stdout:JSON.stringify({server:{name:'checktrail',version:'synthetic'},action:'validation_run',result:{structuredContent:report},retainedReport:{structuredContent:report}})};
  }
  return {...output,stderr:'\nRan 1 test in 0.001s\n\nOK\n'};
 };
 const gateway=await gatewayApi.createGateway(config,{execute});
 const call=async(name,args={})=>{events.push({type:'assistant',message:{id:'message-'+events.length,content:[{type:'tool_use',id:'call-'+events.length,name:'mcp__eval__'+name,input:args}]}});return gateway.call(name,args);};
 let value;try{value=await callback(call,files);}finally{await gateway.close();}
 events.push({type:'result',subtype:'success',is_error:false,structured_output:value,modelUsage:{synthetic:{inputTokens:5,outputTokens:10,cacheReadInputTokens:0,cacheCreationInputTokens:0}}});
 const eventsText=events.map(value=>JSON.stringify(value)+'\n').join('');await fs.writeFile(path.join(dir,'events.jsonl'),eventsText);
 const metering={...analyzeSessionEvents(eventsText,{client:'claude',budget}),client:'claude',binding,elapsedMs:10,exitCode:0,exitSignal:null,stoppedReason:null,complete:true};
 await fs.writeFile(path.join(dir,'metering.json'),encode(metering));return {dir,value};
}
async function reviewed(f,index,withFinding=false) {
 return evidence(f,index,async call=>{
  const read=await call('evaluation_read',{file:'value.py'});
  await call('evaluation_native');
  if(f.frozen.manifest.assignments[index].arm==='mcp')await call('checktrail_validate');
  const probe=await call('evaluation_probe',{language:'python',code:'print(1)',sourceEvidenceIds:[read.evidenceId]});
  return receipt(f,index,withFinding?[{id:'finding',claim:'Synthetic observed value',citations:[{file:'value.py',line:1,endLine:1,quote:'value = 1'}],reproduction:'Synthetic executed probe',probeEvidenceIds:[probe.evidenceId]}]:[]);
 });
}
async function judged(f,mutateJudge) {
 return evidence(f,0,async(call)=>{
  const judgments=[];
  for(const a of f.frozen.manifest.assignments){
   const read=await call('evaluation_read',{file:a.blindId+'/source/value.py'});
   const probe=await call('evaluation_probe',{language:'python',code:'print(1)',sourceEvidenceIds:[read.evidenceId]});
   judgments.push({blindId:a.blindId,labelStatus:'accepted',findings:[],rationale:'Synthetic control execution',probeEvidenceIds:[probe.evidenceId]});
  }
  return {schemaVersion:1,manifestSha256:f.frozen.sha256,adjudicator:identity('judge'),status:'completed',judgments};
 },true,mutateJudge);
}
`;

function exercise(body: string) {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      setup +
        "\ntry {\n" +
        body +
        "\n} finally {await fs.rm(root,{recursive:true,force:true});}",
      ...[
        "agent-evaluation.mjs",
        "agent-evaluation-gateway.mjs",
        "agent-evaluation-session.mjs",
      ].map((file) => new URL("../../scripts/" + file, import.meta.url).href),
    ],
    { encoding: "utf8", timeout: 20000 },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
}

test("enforced sealing needs measured native/MCP evidence and leaves invalid attempts reviewable without changing their claims", () => {
  exercise(String.raw`
  const f=await fixture();
  const r=receipt(f,0);
  const missing=await api.preflight(f.run,r.assignmentId,r);
  assert.equal(missing.valid,false);assert.equal(missing.citationValid,true);
  await assert.rejects(api.seal(f.run,r.assignmentId,r),/enforced protocol/);
  const ready=await reviewed(f,0,true);
  const bad=structuredClone(ready.value);bad.findings[0].citations[0].line=2;bad.findings[0].citations[0].endLine=2;
  const before=JSON.stringify(bad);
  assert.equal((await api.preflight(f.run,r.assignmentId,bad,ready.dir)).valid,false);
  assert.equal(JSON.stringify(bad),before);
  await assert.rejects(fs.stat(path.join(f.run,'receipts',r.assignmentId+'.json')),{code:'ENOENT'});
  const prose=structuredClone(ready.value);prose.findings[0].claim='Edited after delivery';
  const edited=await api.preflight(f.run,r.assignmentId,prose,ready.dir);
  assert.equal(edited.valid,false);assert.ok(edited.protocol.problems.includes('Receipt differs from the client terminal submission.'));
  const passed=await api.preflight(f.run,r.assignmentId,ready.value,ready.dir);
  assert.equal(passed.valid,true,JSON.stringify(passed));
  const wrong=structuredClone(ready.value);wrong.findings[0].probeEvidenceIds=['evidence-3-'+'a'.repeat(12)];
  assert.equal((await api.preflight(f.run,r.assignmentId,wrong,ready.dir)).valid,false);
  await api.seal(f.run,r.assignmentId,ready.value,ready.dir);
  const next=receipt(f,1);next.status='incomplete';
  await api.seal(f.run,next.assignmentId,next);
  await api.blind(f.run,path.join(f.base,'blind'));
  const saved=JSON.parse(await fs.readFile(path.join(f.run,'receipts',next.assignmentId+'.json')));
  assert.equal(saved.protocol.complete,false);
  assert.deepEqual(saved.receipt,next);
 `);
});

test("enforced scores require judge control probes for valid cases and verified judge lifecycle, retaining raw matches separately", () => {
  exercise(String.raw`
  const f=await fixture();
  for(let index=0;index<2;index++){const review=await reviewed(f,index);await api.seal(f.run,review.value.assignmentId,review.value,review.dir);}
  const judge=await judged(f);
  let score=await api.score(f.run,judge.value,judge.dir);
  assert.equal(score.complete,true,JSON.stringify(score.judgeProtocol));assert.equal(score.protocolComplete,true);
  const edited=structuredClone(judge.value);edited.judgments[0].rationale='Changed after original delivery';
  const changed=await api.score(f.run,edited,judge.dir);assert.equal(changed.complete,false);assert.ok(changed.judgeProtocol.problems.includes('Judgments differ from the client terminal submission.'));
  assert.ok(score.observations.every(row=>row.protocol.complete&&row.usage.outputTokens===10));
  const noProof=structuredClone(judge.value);delete noProof.judgments[0].probeEvidenceIds;
  score=await api.score(f.run,noProof,judge.dir);
  assert.equal(score.complete,false);assert.ok(score.observations.every(row=>row.status==='incomplete'&&row.missed===null));
  const wrongCase=structuredClone(judge.value);wrongCase.judgments[0].probeEvidenceIds=wrongCase.judgments[1].probeEvidenceIds;
  assert.equal((await api.score(f.run,wrongCase,judge.dir)).complete,false);
  const auditFile=path.join(judge.dir,'gateway-audit.jsonl');
  const raw=await fs.readFile(auditFile,'utf8');await fs.writeFile(auditFile,raw.trimEnd().split('\n').slice(0,-1).join('\n')+'\n');
  score=await api.score(f.run,judge.value,judge.dir);
  assert.equal(score.complete,false);assert.ok(score.judgeProtocol.problems.includes('gateway-cleanup-incomplete'));
 `);
});

test("judge packet binding rejects altered labels, claims and instructions while identical source remains intact", () => {
  exercise(String.raw`
    const mutations=[
      ['unchanged',null],
      ['label',packet=>{packet.items[0].label.expectedDefects.push({id:'invented',description:'Altered label',evidence:['Unfrozen label evidence']});}],
      ['claim',packet=>{packet.items[0].findings.push({id:'invented',claim:'Unfrozen review claim',citations:[{file:'value.py',line:1,endLine:1,quote:'value = 1'}],reproduction:'Unfrozen reproduction'});}],
      ['instruction',packet=>{packet.instruction='Altered judging instructions';}],
    ];
    for(const [name,mutation] of mutations){
      const f=await fixture('packet-'+name);
      for(let index=0;index<2;index++){const review=await reviewed(f,index);await api.seal(f.run,review.value.assignmentId,review.value,review.dir);}
      const judge=await judged(f,mutation);
      const audit=JSON.parse((await fs.readFile(path.join(judge.dir,'gateway-audit.jsonl'),'utf8')).split('\n')[0]);
      for(const assignment of f.frozen.manifest.assignments)
        for(const file of f.frozen.manifest.cases[0].captured.files)
          assert.equal(audit.files.find(item=>item.file===assignment.blindId+'/source/'+file.file).sha256,file.sha256);
      const score=await api.score(f.run,judge.value,judge.dir);
      assert.equal(score.complete,mutation===null,JSON.stringify(score.judgeProtocol));
      assert.deepEqual(score.judgeProtocol.problems,mutation===null?[]:['gateway-source-mismatch']);
      if(mutation)assert.ok(score.observations.every(row=>row.status==='incomplete'&&row.missed===null));
    }
  `);
});

test("strict evidence rejects sibling assignment replay and source artifact tampering after sealing", () => {
  exercise(String.raw`
  const f=await fixture();const first=await reviewed(f,0);
  await assert.rejects(api.beginAttempt(f.run,first.value.assignmentId,'replacement',path.join(f.base,'replacement')),{code:'EEXIST'});
  const sibling=receipt(f,1);
  const invalid=await api.preflight(f.run,sibling.assignmentId,sibling,first.dir);
  assert.equal(invalid.valid,false);assert.ok(invalid.protocol.problems.includes('gateway-binding-mismatch'));
  await api.seal(f.run,first.value.assignmentId,first.value,first.dir);
  const file=path.join(f.run,'receipts',first.value.assignmentId+'.json');
  const saved=JSON.parse(await fs.readFile(file,'utf8'));saved.protocolEvidence.eventsText+='{}\n';await fs.writeFile(file,encode(saved));
  await assert.rejects(api.blind(f.run,path.join(f.base,'blind')),/protocol evidence changed/);
 `);
});

test("citation disclosure combines adjacent reads but rejects an undisclosed gap", () => {
  exercise(String.raw`
  for(const gap of [false,true]) {
    const f=await fixture(gap?'gap':'adjacent');
    const outcome=await evidence(f,0,async call=>{
      const first=await call('evaluation_read',{file:'value.py',line:1,count:1});
      const second=await call('evaluation_read',{file:'value.py',line:gap?3:2,count:1});
      await call('evaluation_native');
      if(f.frozen.manifest.assignments[0].arm==='mcp')await call('checktrail_validate');
      const probe=await call('evaluation_probe',{language:'python',code:'print(1)',sourceEvidenceIds:[first.evidenceId,second.evidenceId]});
      return receipt(f,0,[{id:'span',claim:'Synthetic spanning citation',reproduction:'Synthetic probe',probeEvidenceIds:[probe.evidenceId],citations:[{file:'value.py',line:1,endLine:gap?3:2,quote:'value = 1\nnext_value = 2'+(gap?'\n':'')}]}]);
    });
    const result=await api.preflight(f.run,outcome.value.assignmentId,outcome.value,outcome.dir);
    assert.equal(result.citationValid,true,JSON.stringify(result));
    assert.equal(result.valid,!gap,JSON.stringify(result));
    if(gap)assert.ok(result.protocol.problems.some(problem=>problem.includes('not disclosed')));
  }
 `);
});
