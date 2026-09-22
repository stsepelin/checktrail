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
    const api = await import(process.argv[1]);
    const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'checktrail-gateway-test-')));
    const source = path.join(temporary, 'source');
    const runtime = path.join(temporary, 'runtime');
    await fs.mkdir(source); await fs.mkdir(runtime);
    await fs.writeFile(path.join(source, 'entry.py'), 'value = 1\\n');
    await fs.writeFile(path.join(temporary, 'withheld-answer.py'), 'SECRET_SIBLING');
    await fs.writeFile(path.join(runtime, 'public-tool.txt'), 'synthetic runtime');
    const config = {schemaVersion:1, source, files:['entry.py'], audit:path.join(temporary,'audit.jsonl'),
      image:'sha256:'+'a'.repeat(64), runtime, dependencies:null, treatment:false,
      native:{executable:'python3',args:['-B','entry.py']}, languages:['python'], timeoutMs:1000, maxCalls:20};
    const executions = [];
    const execute = async (root, command, options) => {
      executions.push({root, command, options});
      return {command, exitCode:0, stdout:'ok', stderr:'', timedOut:false, truncated:false, cancelled:false};
    };
    let gateway;
    try { ${body} }
    finally { await gateway?.close(); await fs.rm(temporary,{recursive:true,force:true}); }
  `,
      new URL("../../scripts/agent-evaluation-gateway.mjs", import.meta.url)
        .href,
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
}

test("evaluation gateway reads captured bytes only and withholds sibling names and contents", () => {
  exercise(String.raw`
    gateway = await api.createGateway(config, {execute});
    await fs.writeFile(path.join(source,'entry.py'), 'host_changed = True\n');
    const listed = await gateway.call('evaluation_files', {});
    assert.deepEqual(listed.value.map(item=>item.file), ['entry.py']);
    const read = await gateway.call('evaluation_read', {file:'entry.py'});
    assert.equal(read.value.text, 'value = 1\n');
    for (const file of ['../withheld-answer.py', '/etc/passwd', 'withheld-answer.py', './entry.py', 'nested/../entry.py']) {
      const denied = await gateway.call('evaluation_read', {file});
      assert.equal(denied.ok, false);
      assert.ok(!JSON.stringify(denied).includes('SECRET_SIBLING'));
    }
    assert.equal(executions.length, 0);
  `);
});

test("evaluation gateway rejects symlinks, duplicate files, mutable image tags and audit disclosure before execution", () => {
  exercise(String.raw`
    await fs.symlink(path.join(temporary, 'withheld-answer.py'), path.join(source, 'link.py'));
    for (const override of [{files:['link.py']}, {files:['entry.py','entry.py']}, {files:['../withheld-answer.py']}, {image:'node:latest'}, {audit:path.join(runtime,'leaked-audit')}, {native:{executable:'sh',args:['-c','echo unsafe']}}]) {
      await assert.rejects(api.createGateway({...config,...override}, {execute}));
    }
    await assert.rejects(fs.stat(config.audit), {code:'ENOENT'});
    assert.equal(executions.length, 0);
    await fs.symlink(path.join(temporary,'withheld-answer.py'), path.join(runtime,'escape'));
    await assert.rejects(api.createGateway(config, {execute}), /leaves mount/);
  `);
});

test("gateway grants neither treatment tools nor new commands or languages through tool arguments", () => {
  exercise(String.raw`
    gateway = await api.createGateway(config, {execute});
    assert.ok(!gateway.tools.includes('checktrail_validate'));
    for (const [name,args] of [['checktrail_validate',{}], ['evaluation_native',{executable:'sh'}], ['evaluation_probe',{language:'javascript',code:'1'}], ['evaluation_probe',{language:'python',code:'x'.repeat(16001)}]]) {
      assert.equal((await gateway.call(name,args)).ok, false);
    }
    assert.equal(executions.length,0);
    const result = await gateway.call('evaluation_native',{});
    assert.equal(result.ok,true);
    assert.equal(executions.length,2);
    const args = executions[0].command.args;
    assert.deepEqual(args.slice(-3),['python3','-B','entry.py']);
    assert.ok(args.includes('none')); assert.ok(args.includes('--read-only'));
    assert.ok(args.includes('65532:65532')); assert.ok(args.includes('ALL'));
    assert.equal(args.filter(item=>item.startsWith('type=bind,')).length,1);
    assert.ok(!args.some(item=>item.includes(config.runtime)));
    assert.ok(!args.includes('/worker.mjs'));
    assert.ok(!args.some(item=>item.includes(config.source)));
    assert.ok(!JSON.stringify(result).includes(temporary));
    assert.deepEqual(executions[1].command.args.slice(0,2),['rm','--force']);
  `);
});

test("gateway preserves incomplete execution and cleans up containers on runner failure", () => {
  exercise(String.raw`
    let attempts=0;
    const failing = async (...args) => {
      attempts++;
      if(args[1].args[0]==='run') throw new Error('private host path');
      return execute(...args);
    };
    gateway = await api.createGateway(config,{execute:failing});
    const result = await gateway.call('evaluation_native',{});
    assert.equal(result.ok,false); assert.ok(!JSON.stringify(result).includes('private host path'));
    assert.equal(attempts,2);
    await gateway.close(); gateway=undefined;
    gateway = await api.createGateway({...config,audit:config.audit+'2'},{execute:async (...args)=>({...await execute(...args), timedOut:args[1].args[0]==='run'})});
    const timed = await gateway.call('evaluation_native',{});
    assert.equal(timed.value.timedOut,true);
  `);
});

test("gateway audits rejected calls and results with chained evidence IDs and detects runtime mutation", () => {
  exercise(String.raw`
    gateway = await api.createGateway({...config,maxCalls:1}, {execute});
    const first = await gateway.call('evaluation_files',{});
    assert.match(first.evidenceId,/^evidence-3-/);
    assert.equal((await gateway.call('evaluation_files',{})).ok,false);
    await gateway.close(); gateway=undefined;
    const records=(await fs.readFile(config.audit,'utf8')).trim().split('\n').map(JSON.parse);
    let previous=null;
    for(const record of records){
      const {sha256,...content}=record;
      assert.equal(content.previous,previous);
      assert.equal(sha256,createHash('sha256').update(JSON.stringify(content)+'\n').digest('hex'));
      previous=sha256;
    }
    assert.equal(records.at(-1).runtimeUnchanged,true);
    await assert.rejects(api.createGateway(config,{execute}),{code:'EEXIST'});
    gateway=await api.createGateway({...config,audit:config.audit+'changed'},{execute});
    await fs.writeFile(path.join(runtime,'public-tool.txt'),'changed');
    await assert.rejects(gateway.close(),/Runtime changed/);
    gateway=undefined;
  `);
});

test("gateway retains output-limit evidence through Docker auto-removal races and keeps full audit output", () => {
  exercise(String.raw`
    let removals = 0;
    const raced = async (...args) => {
      const result = await execute(...args);
      if (args[1].args[0] === 'run') return {...result, truncated:true, stdout:'x'.repeat(12000)};
      removals++;
      return {...result, exitCode:1, stderr:removals === 1 ? 'removal of container is already in progress' : 'No such container'};
    };
    gateway=await api.createGateway(config,{execute:raced});
    const result=await gateway.call('evaluation_native',{});
    assert.equal(result.value.truncated,true);
    assert.equal(result.value.stdout.length,8000);
    assert.equal(result.value.stdoutDisplayOmittedCharacters,4000);
    assert.equal(removals,2);
    const records=(await fs.readFile(config.audit,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records.at(-1).result.value.stdout.length,12000);
    const trace={server:{version:'synthetic'},action:'validation_run',result:{structuredContent:{outcome:'incomplete'},content:[]},retainedReport:{structuredContent:{outcome:'incomplete'}}};
    assert.deepEqual(api.projectEvidence({ok:true,value:{trace}}).value.trace,{server:trace.server,action:trace.action,result:{outcome:'incomplete'},retainedReportVerified:true});
    assert.ok(trace.result.structuredContent);
  `);
});

test("gateway rejects an audit parent symlink into a disclosed runtime", () => {
  exercise(String.raw`
    const alias=path.join(temporary,'alias');
    await fs.symlink(runtime,alias);
    await assert.rejects(api.createGateway({...config,audit:path.join(alias,'audit.jsonl')},{execute}),/Canonical audit/);
    await assert.rejects(fs.stat(path.join(runtime,'audit.jsonl')),{code:'ENOENT'});
  `);
});
