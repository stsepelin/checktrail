import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("producer cleanup confirms exact owned absence through concurrent removal and keeps every failure bounded", () => {
  const modulePath = fileURLToPath(
    new URL("../../scripts/qualify-binutils-producer.mjs", import.meta.url),
  );
  const program = String.raw`
    import assert from 'node:assert/strict';
    import cp from 'node:child_process';
    import {promisify} from 'node:util';
    import {syncBuiltinESMExports} from 'node:module';
    import {performance} from 'node:perf_hooks';
    import timers from 'node:timers/promises';
    import fs from 'node:fs/promises';
    import os from 'node:os';
    import path from 'node:path';
    import {pathToFileURL} from 'node:url';
    let clock=0, dispatch, calls=[];
    Object.defineProperty(performance,'now',{value:()=>clock,configurable:true});
    timers.setTimeout=async ms=>{assert.ok(ms>0&&ms<=100);clock+=ms;};
    const fake=()=>{throw Error('Unexpected non-promisified Docker call');};
    fake[promisify.custom]=async (exe,args,opts)=>{
      assert.equal(exe,'docker');assert.ok(opts.timeout>0&&opts.timeout<=15000);
      calls.push({args:[...args],timeout:opts.timeout,clock});return dispatch(args,opts);
    };
    cp.execFile=fake;syncBuiltinESMExports();
    const target=process.argv[1];process.argv[1]=path.join(os.tmpdir(),'synthetic-cleanup-worker.mjs');
    const api=await import(pathToFileURL(target).href);
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'checktrail-cleanup-test-')));
    const owner='00000000-0000-4000-8000-000000000001';
    const id='a'.repeat(64), other='b'.repeat(64), name='checktrail-producer-'+owner;
    const cid=path.join(root,'id');await fs.writeFile(cid,id+'\n');
    const present=(role='producer')=>({stdout:JSON.stringify([{Id:id,Name:'/checktrail-'+role+'-'+owner,Config:{Labels:{'io.checktrail.producer-attempt':owner,...(role==='retention'?{'io.checktrail.producer-role':'retention-observer'}:{})}}}]),stderr:''});
    function failure(message,code=1,extra={}){return Object.assign(new Error(message),{stderr:message,code,signal:null,killed:false,...extra});}
    const missing=(ref=id)=>failure('Error: No such object: '+ref+'\n');
    const progress=()=>failure('Error response from daemon: removal of container '+id+' is already in progress\n');
    const reset=()=>{clock=0;calls=[];};
    try {
      reset();let inspects=0;
      dispatch=async args=>{if(args[0]==='rm')throw progress();if(++inspects<3)return present();throw missing();};
      assert.deepEqual(await api.cleanupContainer(cid,owner),{state:'removed',id});
      assert.deepEqual(calls.map(x=>x.args),[['inspect',id],['rm','--force',id],['inspect',id],['inspect',id]],'Concurrent removal requires independent exact absence observations');
      assert.equal(clock,100,'Concurrent removal must be observed, not assumed');

      reset();inspects=0;
      dispatch=async args=>{if(args[0]==='rm')throw missing();if(++inspects===1)return present();throw missing();};
      assert.deepEqual(await api.cleanupContainer(cid,owner),{state:'removed',id});
      assert.deepEqual(calls.map(x=>x.args),[['inspect',id],['rm','--force',id],['inspect',id]]);

      reset();dispatch=async()=>{throw missing();};
      assert.deepEqual(await api.cleanupContainer(cid,owner),{state:'absent',id});assert.equal(calls.length,1);

      reset();inspects=0;
      dispatch=async args=>{if(args[0]==='rm')return{stdout:id+'\n',stderr:''};if(++inspects===1)return present();throw missing();};
      assert.deepEqual(await api.cleanupContainer(cid,owner),{state:'removed',id});

      const invalid=[missing(other),failure('diagnostic prefix No such object: '+id+'\n'),missing(id+'suffix'),Object.assign(missing(),{code:2}),Object.assign(missing(),{killed:true,signal:'SIGTERM'})];
      for(const err of invalid){reset();dispatch=async()=>{throw err;};await assert.rejects(api.cleanupContainer(cid,owner),e=>e===err,'Wrong container absence diagnostics must remain failures');assert.equal(calls.length,1);}

      reset();dispatch=async()=>{const v=present();const rows=JSON.parse(v.stdout);rows[0].Config.Labels['io.checktrail.producer-attempt']='foreign';return{...v,stdout:JSON.stringify(rows)};};
      await assert.rejects(api.cleanupContainer(cid,owner),/different owner/,'Foreign owners must remain unavailable');assert.equal(calls.length,1);

      reset();dispatch=async()=>{const v=present();const rows=JSON.parse(v.stdout);rows[0].Id=other;return{...v,stdout:JSON.stringify(rows)};};
      await assert.rejects(api.cleanupContainer(cid,owner),/identity/);assert.equal(calls.length,1);

      reset();inspects=0;
      dispatch=async args=>{if(args[0]==='rm')return{stdout:'',stderr:''};if(++inspects===1)return present('retention');throw missing();};
      assert.deepEqual(await api.cleanupContainer(cid,owner,'retention'),{state:'removed',id});
      reset();dispatch=async()=>{const v=present('retention');const rows=JSON.parse(v.stdout);rows[0].Config.Labels['io.checktrail.producer-role']='retention-observer-extra';return{...v,stdout:JSON.stringify(rows)};};
      await assert.rejects(api.cleanupContainer(cid,owner,'retention'),/retention/,'Retention role suffix must be rejected');assert.equal(calls.length,1);

      for(const err of [failure('Error response from daemon: removal of container '+other+' is already in progress\n'),failure('diagnostic prefix removal of container '+id+' is already in progress\n'),Object.assign(progress(),{code:2}),failure('Error response from daemon: permission denied\n')]){
        reset();dispatch=async args=>{if(args[0]==='rm')throw err;return present();};
        await assert.rejects(api.cleanupContainer(cid,owner),e=>e===err);assert.equal(calls.length,2);
      }
      for(const rows of [[],[JSON.parse(present().stdout)[0],JSON.parse(present().stdout)[0]]]){
        reset();dispatch=async()=>({stdout:JSON.stringify(rows),stderr:''});
        await assert.rejects(api.cleanupContainer(cid,owner),/inspection/,'Malformed inspect framing must remain unavailable');assert.equal(calls.length,1);
      }
      reset();inspects=0;
      dispatch=async args=>{if(args[0]==='rm')throw progress();if(++inspects===1)return present();const v=present();const rows=JSON.parse(v.stdout);rows[0].Config.Labels['io.checktrail.producer-attempt']='foreign';return{...v,stdout:JSON.stringify(rows)};};
      await assert.rejects(api.cleanupContainer(cid,owner),/different owner/);assert.equal(calls.length,3);
      reset();dispatch=async()=>{clock=45001;throw missing();};
      await assert.rejects(api.cleanupContainer(cid,owner),/cleanup deadline/,'Late absence cannot bypass the cleanup deadline');assert.equal(calls.length,1);

      await fs.unlink(cid);reset();inspects=0;
      dispatch=async args=>{if(args[0]==='rm'){assert.deepEqual(args,['rm','--force',id],'Cleanup must remove the inspected immutable ID');return{stdout:'',stderr:''};}if(++inspects===1){assert.equal(args[1],name);return present();}assert.equal(args[1],id);throw missing();};
      assert.deepEqual(await api.cleanupContainer(cid,owner),{state:'removed',id});
      await fs.writeFile(cid,id+'\n');

      reset();inspects=0;
      dispatch=async args=>{if(args[0]==='rm')throw progress();if(++inspects===1){clock+=14950;return present();}clock+=Math.min(14000,45000-clock);return present();};
      await assert.rejects(api.cleanupContainer(cid,owner),/cleanup deadline/);
      assert.ok(clock<=45000);assert.equal(calls.filter(x=>x.args[0]==='rm').length,1);
      assert.ok(calls.at(-1).timeout<=45000-calls.at(-1).clock,'RPC must use remaining shared allowance');
      console.log(JSON.stringify({passed:true,actualDocker:false}));
    } finally {await fs.rm(root,{recursive:true,force:true});}
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", program, modulePath],
    {
      cwd: path.dirname(modulePath),
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1048576,
    },
  );
  assert.equal(result.error?.message, undefined);
  assert.equal(result.status, 0, (result.stdout + result.stderr).slice(-8000));
  assert.equal(JSON.parse(result.stdout).actualDocker, false);
});
