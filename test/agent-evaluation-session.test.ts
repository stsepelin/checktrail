import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

function exercise(body: string) {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import assert from 'node:assert/strict';
      import {promises as fs} from 'node:fs';
      import os from 'node:os';
      import path from 'node:path';
      import {createHash} from 'node:crypto';
      import {spawnSync} from 'node:child_process';
      import {fileURLToPath} from 'node:url';
      const api = await import(process.argv[1]);
      const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'checktrail-meter-test-')));
      const budget = {wallSeconds:3,maxToolCalls:2,maxInputTokens:20,maxOutputTokens:10};
      const binding = {manifestSha256:'a'.repeat(64),subjectId:'synthetic-case',sessionId:'synthetic-session',role:'reviewer'};
      const terminal = {type:'turn.completed',usage:{input_tokens:20,output_tokens:10,cached_input_tokens:9}};
      const tool = {type:'item.started',item:{id:'call-1',type:'mcp_tool_call',server:'eval',tool:'evaluation_native',arguments:{}}};
      const encode = events => events.map(e=>JSON.stringify(e)).join('\\n')+'\\n';
      const analyze = (events,client='codex',override={}) => api.analyzeSessionEvents(encode(events),{client,budget,...override});
      const run = (code, override={}) => api.runSession({client:'codex',executable:process.execPath,args:['-e',code],cwd:temporary,environment:{},outputDirectory:path.join(temporary,'output'),binding,budget,killGraceMs:50,...override});
      try { ${body} }
      finally { await fs.rm(temporary,{recursive:true,force:true}); }
      `,
      new URL("../../scripts/agent-evaluation-session.mjs", import.meta.url)
        .href,
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
}

test("meter counts failed tool attempts once and preserves exact boundary totals without double counting Codex cached tokens", () => {
  exercise(String.raw`
    const result = analyze([tool,tool,{...tool,type:'item.completed',item:{...tool.item,status:'failed',error:{message:'synthetic'}}},terminal,terminal]);
    assert.equal(result.toolCalls,1);
    assert.deepEqual(result.tools,[{id:'call-1',name:'mcp__eval__evaluation_native',arguments:{}}]);
    assert.equal(result.inputTokens,20); assert.equal(result.outputTokens,10);
    assert.deepEqual(result.violations,[]); assert.equal(result.terminalObserved,true);
    assert.deepEqual(analyze([tool,{...tool,item:{...tool.item,arguments:{other:true}}},terminal]).violations,['conflicting-tool-event']);
    assert.equal(analyze([{type:'item.completed',item:{id:'command-1',type:'command_execution',command:'false',exit_code:1}},terminal]).toolCalls,1);
  `);
});

test("Claude cumulative terminal accounting includes all cache components and deduplicates streamed messages and tool IDs", () => {
  exercise(String.raw`
    const events = [
      {type:'stream_event',event:{type:'message_start',message:{id:'m1',usage:{input_tokens:2,cache_read_input_tokens:4,cache_creation_input_tokens:3}}}},
      {type:'stream_event',event:{type:'content_block_start',content_block:{type:'tool_use',id:'t1',name:'mcp__eval__evaluation_read',input:{}}}},
      {type:'stream_event',event:{type:'message_delta',usage:{output_tokens:3}}},
      {type:'assistant',uuid:'event1',message:{id:'m1',content:[{type:'tool_use',id:'t1',name:'mcp__eval__evaluation_read',input:{file:'sample.py'}}],usage:{input_tokens:2,output_tokens:3,cache_read_input_tokens:4,cache_creation_input_tokens:3}}},
      {type:'assistant',message:{id:'m2',content:[{type:'tool_use',id:'t2',name:'StructuredOutput',input:{answer:'ok'}}],usage:{input_tokens:1,output_tokens:2}}},
      {type:'result',subtype:'success',is_error:false,modelUsage:{first:{inputTokens:2,cacheReadInputTokens:4,cacheCreationInputTokens:3,outputTokens:3},second:{inputTokens:1,outputTokens:2}}}
    ];
    events.splice(4,0,events[3]);
    const result=analyze(events,'claude');
    assert.equal(result.inputTokens,10); assert.equal(result.outputTokens,5); assert.equal(result.toolCalls,2); assert.deepEqual(result.violations,[]);
    assert.deepEqual(result.tools[0].arguments,{file:'sample.py'});
    const regressed=structuredClone(events);regressed.at(-1).modelUsage.first.outputTokens=1;
    assert.ok(analyze(regressed,'claude').violations.includes('terminal-usage-regression'));
    const overshot=structuredClone(events); overshot[3].message.usage.output_tokens=11;overshot[4]=overshot[3];
    assert.ok(analyze(overshot,'claude').violations.includes('output-token-budget'));
  `);
});

test("meter fails closed for missing usage, malformed streams, conflicting IDs and late telemetry", () => {
  exercise(String.raw`
    assert.deepEqual(analyze([]).violations,['missing-terminal']);
    assert.equal(analyze([{type:'turn.completed'}]).inputTokens,null);
    assert.ok(analyze([{type:'turn.completed'}]).violations.includes('missing-terminal-usage'));
    assert.ok(analyze([terminal,tool]).violations.includes('event-after-terminal'));
    assert.ok(analyze([{...terminal,usage:{input_tokens:0,output_tokens:-1}}]).violations.includes('missing-terminal-usage'));
    assert.ok(analyze([terminal,{...terminal,usage:{input_tokens:30,output_tokens:20}}]).violations.includes('output-token-budget'));
    assert.ok(analyze([{...tool,event_id:'a'},{...tool,event_id:'a',item:{...tool.item,tool:'other'}}]).violations.includes('conflicting-event-id'));
    assert.ok(analyze([{...tool,item:{id:'bad',type:'mcp_tool_call'}},terminal]).violations.includes('invalid-tool-event'));
    assert.ok(api.analyzeSessionEvents('not-json\n',{client:'codex',budget}).violations.includes('malformed-jsonl'));
    assert.ok(api.analyzeSessionEvents(Buffer.from([0xff,10]),{client:'codex',budget}).violations.includes('malformed-jsonl'));
    assert.ok(api.analyzeSessionEvents('x'.repeat(50),{client:'codex',budget,maxLineBytes:20}).violations.includes('line-overflow'));
    const bytes=encode([tool,terminal]); const monitor=api.createSessionMonitor({client:'codex',budget});
    for(const byte of Buffer.from(bytes))monitor.feed(Buffer.from([byte]));
    assert.deepEqual(monitor.finish(),api.analyzeSessionEvents(bytes,{client:'codex',budget}));
    assert.equal(monitor.finish(),monitor.finish()); assert.throws(()=>monitor.feed(''),/finalized/);
    const bounded=api.createSessionMonitor({client:'codex',budget,maxEventsBytes:100});
    for(const byte of Buffer.from(bytes))bounded.feed(Buffer.from([byte]));
    assert.deepEqual(bounded.finish(),api.analyzeSessionEvents(bytes,{client:'codex',budget,maxEventsBytes:100}));
  `);
});

test("meter preserves the original provider submission without silently repairing text or accepting a late replacement", () => {
  exercise(String.raw`
    const submission={status:'completed',findings:[{id:'original',claim:'Synthetic original claim'}]};
    const answer={type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(submission)}};
    assert.deepEqual(analyze([answer,terminal]).submission,submission);
    assert.equal(analyze([terminal]).submission,null);
    assert.equal(analyze([{...answer,item:{...answer.item,text:'not JSON'}},terminal]).submission,null);
    assert.equal(analyze([{...answer,item:{...answer.item,text:'[1]'}},terminal]).submission,null);
    const late=analyze([answer,terminal,{...answer,item:{...answer.item,text:JSON.stringify({changed:true})}}]);
    assert.deepEqual(late.submission,submission);assert.ok(late.violations.includes('event-after-terminal'));assert.ok(late.violations.includes('conflicting-submission-event'));
    const changed=analyze([answer,{...answer,item:{...answer.item,text:JSON.stringify({changed:true})}},terminal]);
    assert.ok(changed.violations.includes('conflicting-submission-event'));
    assert.deepEqual(analyze([answer,{...answer,item:{...answer.item,id:'last-answer',text:'{"last":true}'}},answer,terminal]).submission,{last:true});
    const result={type:'result',subtype:'success',is_error:false,usage:{input_tokens:0,output_tokens:0},structured_output:submission,result:JSON.stringify({alternate:true})};
    assert.deepEqual(analyze([result],'claude').submission,submission);
    assert.deepEqual(analyze([{...result,structured_output:undefined,result:JSON.stringify(submission)}],'claude').submission,submission);
    assert.equal(analyze([{...result,structured_output:[] }],'claude').submission,null);
    assert.equal(analyze([{...result,structured_output:undefined,result:String.fromCharCode(96).repeat(3)+'json\n'+JSON.stringify(submission)+'\n'+String.fromCharCode(96).repeat(3)}],'claude').submission,null);
  `);
});

test("meter rejects unsupported work and schema variants instead of silently omitting their usage", () => {
  exercise(String.raw`
    for(const event of [
      {type:'tool_call',name:'exec_command',arguments:{cmd:'echo synthetic'}},
      {type:'item.started',item:{id:'unknown',type:'new_work_tool',arguments:{code:'synthetic'}}}
    ])assert.ok(analyze([event,terminal]).violations.some(v=>v.startsWith('unsupported-')));
    for(const event of [
      {type:'system',subtype:'unrecognized_work'},
      {type:'assistant',message:{id:'m1',content:[{type:'new_tool',id:'t1'}]}},
      {type:'user',message:{content:[{type:'tool_use',id:'t1',name:'host',input:{}}]}},
      {type:'stream_event',event:{type:'new_work_event'}},
      {type:'stream_event',event:{type:'content_block_start',content_block:{type:'new_tool'}}},
      {type:'stream_event',event:{type:'content_block_delta',delta:{type:'new_action'}}}
    ])assert.ok(analyze([event,{type:'result',subtype:'success',is_error:false,usage:{input_tokens:0,output_tokens:0}}],'claude').violations.some(v=>v.startsWith('unsupported-')));
    assert.deepEqual(analyze([{type:'system',subtype:'init'},{type:'system',subtype:'thinking_tokens'},{type:'rate_limit_event'},{type:'user',message:{content:[{type:'tool_result',content:'synthetic result'}]}},{type:'result',subtype:'success',is_error:false,usage:{input_tokens:0,output_tokens:0}}],'claude').violations,[]);
    const stopped=await run('console.log(JSON.stringify({type:"tool_call",name:"exec_command"}));setInterval(()=>{},1000)');
    assert.equal(stopped.complete,false);assert.equal(stopped.stoppedReason,'unsupported-event-type');
  `);
});

test("supervisor persists independently reproducible metering and reserves its output directory before execution", () => {
  exercise(String.raw`
    const bytes=encode([tool,terminal]);
    const result=await run('process.stdout.write('+JSON.stringify(bytes)+');process.stderr.write("synthetic stderr");');
    assert.equal(result.complete,true);assert.equal(result.stoppedReason,null);assert.deepEqual(result.binding,binding);
    const retained=await fs.readFile(path.join(temporary,'output/events.jsonl'));
    assert.equal(result.eventsSha256,createHash('sha256').update(retained).digest('hex'));
    const recomputed=api.analyzeSessionEvents(retained,{client:'codex',budget});
    for(const [key,value] of Object.entries(recomputed))assert.deepEqual(result[key],value);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(temporary,'output/metering.json'),'utf8')),result);
    assert.equal(await fs.readFile(path.join(temporary,'output/stderr.txt'),'utf8'),'synthetic stderr');
    await assert.rejects(run('require("fs").writeFileSync("should-not-exist","bad")'),{code:'EEXIST'});
    await assert.rejects(fs.stat(path.join(temporary,'should-not-exist')),{code:'ENOENT'});
  `);
});

test("supervisor terminates on live tools and terminal token overruns, including late authoritative totals", () => {
  exercise(String.raw`
    for (const [name,events,expected] of [
      ['tools',[tool,{...tool,item:{...tool.item,id:'t2'}},{...tool,item:{...tool.item,id:'t3'}}],'tool-call-budget'],
      ['tokens',[{...terminal,usage:{input_tokens:21,output_tokens:10}}],'input-token-budget'],
      ['output',[{...terminal,usage:{input_tokens:20,output_tokens:11}}],'output-token-budget'],
      ['malformed',[],'malformed-jsonl']
    ]) {
      const text=name==='malformed'?'broken\n':encode(events);
      const result=await run('process.stdout.write('+JSON.stringify(text)+');setInterval(()=>{},1000);',{outputDirectory:path.join(temporary,name)});
      assert.equal(result.complete,false);assert.equal(result.stoppedReason,expected);assert.ok(result.elapsedMs<2000);
    }
  `);
});

test("supervisor enforces byte limits, missing terminal usage, nonzero exits and pre-cancellation", () => {
  exercise(String.raw`
    for(const [name,code,extra,reason] of [
      ['events','process.stdout.write("x".repeat(10000));setInterval(()=>{},1000)',{maxEventsBytes:100},'events-overflow'],
      ['stderr','process.stderr.write("x".repeat(10000));setInterval(()=>{},1000)',{maxStderrBytes:100},'stderr-overflow'],
      ['empty','process.exit(0)',{},'missing-terminal'],
      ['usage','console.log(JSON.stringify({type:"turn.completed"}))',{},'missing-terminal-usage'],
      ['cancel','require("fs").writeFileSync("should-not-exist","bad")',{signal:AbortSignal.abort()},'cancelled'],
      ['spawn','',{executable:path.join(temporary,'missing-command')},'spawn-error']
    ]){
      const result=await run(code,{outputDirectory:path.join(temporary,name),...extra});
      assert.equal(result.complete,false);assert.equal(result.stoppedReason,reason);
      if(name==='events') assert.equal((await fs.stat(path.join(temporary,name,'events.jsonl'))).size,100);
      if(name==='stderr') assert.equal((await fs.stat(path.join(temporary,name,'stderr.txt'))).size,100);
    }
    const failed=await run('console.log('+JSON.stringify(JSON.stringify(terminal))+');process.exitCode=2;');
    assert.equal(failed.exitCode,2);assert.equal(failed.complete,false);
    await assert.rejects(fs.stat(path.join(temporary,'should-not-exist')),{code:'ENOENT'});
  `);
});

test("wall and explicit cancellation kill a SIGTERM-resistant child process group", () => {
  exercise(String.raw`
    for(const cancel of [false,true]){
      const name=cancel?'cancel':'wall';
      const controller=new AbortController();
      const childCode='process.on("SIGTERM",()=>{});require("fs").writeFileSync("'+name+'.pid",String(process.pid));setInterval(()=>{},1000)';
      const parentCode='process.on("SIGTERM",()=>{});require("child_process").spawn(process.execPath,["-e",'+JSON.stringify(childCode)+'],{stdio:"inherit"});setInterval(()=>{},1000)';
      const started=run(parentCode,{outputDirectory:path.join(temporary,name),budget:{...budget,wallSeconds:1},signal:controller.signal});
      if(cancel){
        for(let i=0;i<100;i++){try{await fs.stat(path.join(temporary,name+'.pid'));break;}catch{await new Promise(r=>setTimeout(r,5));}}
        controller.abort();
      }
      const result=await started;
      assert.equal(result.stoppedReason,cancel?'cancelled':'wall-budget');assert.equal(result.complete,false);assert.ok(result.elapsedMs<2500);
      const pid=Number(await fs.readFile(path.join(temporary,name+'.pid'),'utf8'));
      let alive=true;
      for(let i=0;i<100&&alive;i++){try{process.kill(pid,0);await new Promise(r=>setTimeout(r,10));}catch(e){assert.equal(e.code,'ESRCH');alive=false;}}
      assert.equal(alive,false,'descendant survived supervisor');
    }
  `);
});

test("session CLI requires operator trust before execution and emits only a bounded public summary", () => {
  exercise(String.raw`
    const config={client:'codex',executable:process.execPath,args:['-e','require("fs").writeFileSync("marker","executed");console.log('+JSON.stringify(JSON.stringify(terminal))+');'],cwd:temporary,environment:{SYNTHETIC_SECRET:'must-not-print'},outputDirectory:path.join(temporary,'output'),binding,budget};
    const configFile=path.join(temporary,'session.json');
    await fs.writeFile(configFile,JSON.stringify(config));
    const script=fileURLToPath(process.argv[1]);
    const denied=spawnSync(process.execPath,[script,configFile],{encoding:'utf8',timeout:5000});
    assert.equal(denied.status,2);assert.match(denied.stderr,/--trust-client/);
    await assert.rejects(fs.stat(path.join(temporary,'marker')),{code:'ENOENT'});
    await assert.rejects(fs.stat(config.outputDirectory),{code:'ENOENT'});
    const accepted=spawnSync(process.execPath,[script,configFile,'--trust-client'],{encoding:'utf8',timeout:5000});
    assert.equal(accepted.status,0,accepted.stderr);
    const summary=JSON.parse(accepted.stdout);
    assert.equal(summary.complete,true);
    assert.deepEqual(Object.keys(summary).sort(),['complete','elapsedMs','inputTokens','outputTokens','stoppedReason','toolCalls'].sort());
    assert.equal(accepted.stderr,'');assert.ok(!accepted.stdout.includes('must-not-print'));
    assert.equal(await fs.readFile(path.join(temporary,'marker'),'utf8'),'executed');
    const receipt=JSON.parse(await fs.readFile(path.join(config.outputDirectory,'metering.json'),'utf8'));
    assert.equal(receipt.complete,true);assert.deepEqual(receipt.binding,binding);
    await fs.writeFile(configFile,JSON.stringify({...config,binding:{...binding,manifestSha256:'SYNTHETIC_SECRET'}}));
    const invalid=spawnSync(process.execPath,[script,configFile,'--trust-client'],{encoding:'utf8',timeout:5000});
    assert.equal(invalid.status,2);assert.ok(!invalid.stderr.includes('SYNTHETIC_SECRET'));
  `);
});

test("successful parent exit grants bounded graceful cleanup to children before forcing resistant orphans", () => {
  exercise(String.raw`
    for (const resistant of [false,true]) {
      const name=resistant?'resistant':'graceful';
      const childCode='const fs=require("fs");let closing=false;process.on("SIGTERM",()=>{'+(resistant?'':'if(closing)return;closing=true;setTimeout(()=>{fs.writeFileSync("'+name+'.finished","clean");process.exit(0)},60);')+'});fs.writeFileSync("'+name+'.ready",String(process.pid));setInterval(()=>{},1000)';
      const parentCode='const fs=require("fs");const child=require("child_process").spawn(process.execPath,["-e",'+JSON.stringify(childCode)+'],{stdio:"ignore"});child.unref();const timer=setInterval(()=>{if(!fs.existsSync("'+name+'.ready"))return;clearInterval(timer);process.stdout.write('+JSON.stringify(encode([terminal]))+');process.exit(0)},5)';
      const result=await run(parentCode,{outputDirectory:path.join(temporary,name),killGraceMs:200});
      assert.equal(result.complete,!resistant,JSON.stringify(result));
      assert.equal(result.stoppedReason,resistant?'cleanup-timeout':null);
      if(!resistant)assert.equal(await fs.readFile(path.join(temporary,name+'.finished'),'utf8'),'clean');
      const pid=Number(await fs.readFile(path.join(temporary,name+'.ready'),'utf8'));
      let alive=true;
      for(let i=0;i<100&&alive;i++){try{process.kill(pid,0);await new Promise(r=>setTimeout(r,10));}catch(e){assert.equal(e.code,'ESRCH');alive=false;}}
      assert.equal(alive,false,'orphan survived bounded cleanup');
      assert.ok(result.elapsedMs<2000);
    }
  `);
});

test("cleanup polls transient EPERM existence probes but does not accept a persistently unverified group", () => {
  exercise(String.raw`
    const originalKill=process.kill;
    try {
      for(const persistent of [false,true]) {
        let injected=0;
        process.kill=function(pid,signal){
          if(pid<0&&signal===0&&(persistent||injected===0)){
            injected++;
            throw Object.assign(new Error('Synthetic permission result during group exit'),{code:'EPERM'});
          }
          return originalKill.call(this,pid,signal);
        };
        const result=await run('process.stdout.write('+JSON.stringify(encode([terminal]))+')',{
          outputDirectory:path.join(temporary,persistent?'persistent':'transient'),killGraceMs:50,
        });
        assert.ok(injected>0);
        assert.equal(result.complete,!persistent,JSON.stringify(result));
        assert.equal(result.stoppedReason,persistent?'cleanup-timeout':null);
      }
    } finally { process.kill=originalKill; }
  `);
});
