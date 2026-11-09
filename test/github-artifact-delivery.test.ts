import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

function exercise(body: string) {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import {createHash} from 'node:crypto';
    const {createPinnedGitHubFetch,requestPinnedArtifactBytes}=await import(process.argv[1]);
    const scala=await import(new URL('./request-scala-archive.mjs',process.argv[1]));
    delete process.env.CHECKTRAIL_GITHUB_ARTIFACT_TOKEN;
    const token='SYNTHETIC_TOKEN'; const signal=AbortSignal.timeout(5000);
    const url='https://github.com/scala/scala/releases/download/v2.13.18/scala-2.13.18.zip';
    ${body}
  `,
      new URL("../../scripts/request-pinned-artifact.mjs", import.meta.url)
        .href,
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
}

test("pinned GitHub delivery authenticates only four exact API asset identities and strips credentials on every admitted redirect", () => {
  exercise(String.raw`
    const pins=[
      ['https://github.com/yannh/kubeconform/releases/download/v0.8.0/kubeconform-linux-arm64.tar.gz','https://api.github.com/repos/yannh/kubeconform/releases/assets/438612685'],
      ['https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize/v5.8.2/kustomize_v5.8.2_linux_arm64.tar.gz','https://api.github.com/repos/kubernetes-sigs/kustomize/releases/assets/600925223'],
      ['https://github.com/scala/scala3/releases/download/3.9.0/scala3-3.9.0.zip','https://api.github.com/repos/scala/scala3/releases/assets/530989006'],
      [url,'https://api.github.com/repos/scala/scala/releases/assets/317382229']];
    for(const [asset,api] of pins) for(const status of [200,301,302,303,307,308]) {
      const calls=[];let cancelled=0;
      const delivery=createPinnedGitHubFetch({token,fetchImpl:async(address,options)=>{
        calls.push({address,options}); assert.equal(options.signal,signal);assert.equal(options.redirect,'manual');
        if(calls.length===1) {
          assert.equal(address,api);assert.equal(options.headers.Authorization,'Bearer '+token);
          assert.equal(options.headers['X-GitHub-Api-Version'],'2026-03-10');
          if(status!==200) return new Response(new ReadableStream({cancel(){cancelled++;}}),{status,headers:{location:'https://release-assets.githubusercontent.com/assets/file?opaque=signed'}});
        } else {
          assert.equal(cancelled,1);assert.equal(options.headers.Authorization,undefined);
          assert.equal(options.headers['X-Private'],undefined);assert.equal(address,'https://release-assets.githubusercontent.com/assets/file?opaque=signed');
        }
        return new Response('original');
      }});
      const response=await delivery(asset,{signal,headers:{'X-Private':'must not forward'}});
      assert.equal(await response.text(),'original');assert.equal(calls.length,status===200?1:2);
    }
  `);
});

test("pinned GitHub delivery preserves anonymous operation and never authenticates neighboring URLs or non-GitHub hosts", () => {
  exercise(String.raw`
    for(const asset of [url.replace('v2.13.18','v2.13.19'),url+'.backup',url+'?extra=1',url.replace('github.com','github.com.evil.invalid'),'https://raw.githubusercontent.com/example/file','https://get.helm.sh/file']) {
      let calls=0;const delivery=createPinnedGitHubFetch({token,fetchImpl:async(address,options)=>{calls++;assert.equal(address,asset);assert.equal(options.headers?.Authorization,undefined);return new Response('ordinary');}});
      assert.equal(await (await delivery(asset,{signal})).text(),'ordinary');assert.equal(calls,1);
    }
    for(const credential of [undefined,'']) {
      let calls=0;const delivery=createPinnedGitHubFetch({token:credential,fetchImpl:async(address,options)=>{calls++;assert.equal(address,url);assert.equal(options.headers?.Authorization,undefined);return new Response('anonymous');}});
      assert.equal(await (await delivery(url,{signal})).text(),'anonymous');assert.equal(calls,1);
    }
    assert.throws(()=>createPinnedGitHubFetch({token:'PRIVATE_TOKEN\nmalformed'}),error=>!String(error).includes('PRIVATE_TOKEN'));
  `);
});

test("pinned GitHub delivery refuses unsafe missing and looping redirects before further requests", () => {
  exercise(String.raw`
    for(const target of ['http://objects.githubusercontent.com/a','https://objects.githubusercontent.com.evil.invalid/a','https://user@objects.githubusercontent.com/a','https://objects.githubusercontent.com:444/a','https://objects.githubusercontent.com/a#fragment','https://api.github.com/foreign','/relative']) {
      let calls=0;const delivery=createPinnedGitHubFetch({token,fetchImpl:async()=>{calls++;return new Response('',{status:302,headers:{location:target}});}});
      await assert.rejects(delivery(url,{signal}),/Unapproved pinned GitHub artifact redirect/);assert.equal(calls,1);
    }
    let calls=0;const missing=createPinnedGitHubFetch({token,fetchImpl:async()=>{calls++;return new Response('',{status:302});}});
    await assert.rejects(missing(url,{signal}),/requires a Location/);assert.equal(calls,1);
    calls=0;const loop=createPinnedGitHubFetch({token,fetchImpl:async(address,options)=>{calls++;assert.equal(Boolean(options.headers.Authorization),calls===1);return new Response('',{status:302,headers:{location:'https://objects.githubusercontent.com/again'}});}});
    await assert.rejects(loop(url,{signal}),/redirect limit/);assert.equal(calls,4);
  `);
});

test("authenticated delivery retains existing finite retry cancellation and exact size/hash checks", () => {
  exercise(String.raw`
    let calls=0;const waits=[];
    const delivery=createPinnedGitHubFetch({token,fetchImpl:async(address)=>{calls++;assert.equal(address,'https://api.github.com/repos/scala/scala/releases/assets/317382229');return calls<3?new Response('outage',{status:504}):new Response('original');}});
    const bytes=await requestPinnedArtifactBytes({asset:url,bytes:8},{signal,fetchImpl:delivery,delayImpl:async ms=>waits.push(ms)});
    assert.equal(bytes.toString(),'original');assert.equal(calls,3);assert.deepEqual(waits,[1000,3000]);
    calls=0;const always=createPinnedGitHubFetch({token,fetchImpl:async()=>{calls++;return new Response('outage',{status:504});}});
    await assert.rejects(requestPinnedArtifactBytes({asset:url,bytes:8},{signal,fetchImpl:always,delayImpl:async()=>{}}),error=>error.status===504);assert.equal(calls,3);
    const sha=value=>createHash('sha256').update(value).digest('hex');
    for(const payload of ['original','tampered']) {
      calls=0;const fetched=createPinnedGitHubFetch({token,fetchImpl:async()=>{calls++;return new Response(payload);}});
      const pin={url,bytes:8,sha256:sha('original')};
      if(payload==='original') assert.equal((await scala.requestScalaArchive(pin,{signal,fetchImpl:fetched})).toString(),'original');
      else await assert.rejects(scala.requestScalaArchive(pin,{signal,fetchImpl:fetched}),/Scala archive digest/);
      assert.equal(calls,1);
    }
    calls=0;const wrongSize=createPinnedGitHubFetch({token,fetchImpl:async()=>{calls++;return new Response('too large');}});
    await assert.rejects(requestPinnedArtifactBytes({asset:url,bytes:8},{signal,fetchImpl:wrongSize}),/byte limit/);assert.equal(calls,1);
    const controller=new AbortController();const reason=new Error('authored cancellation');
    calls=0;const blocked=createPinnedGitHubFetch({token,fetchImpl:async()=>{calls++;return {status:302,headers:new Headers({location:'https://objects.githubusercontent.com/file'}),body:{cancel:()=>new Promise(()=>{})}};}});
    const pending=blocked(url,{signal:controller.signal});setTimeout(()=>controller.abort(reason),10);
    await assert.rejects(pending,error=>error===reason);assert.equal(calls,1);
    const late=new AbortController();let cancelled=0;
    const lateHeaders=createPinnedGitHubFetch({token,fetchImpl:async()=>{late.abort(reason);return new Response(new ReadableStream({cancel(){cancelled++;}}),{status:302,headers:{location:'https://objects.githubusercontent.com/file'}});}});
    await assert.rejects(lateHeaders(url,{signal:late.signal}),error=>error===reason);assert.equal(cancelled,1);

  `);
});

test("CI artifact credentials are restricted to all infrastructure and Scala preparation steps", () => {
  const workflow = parse(
    readFileSync(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    ),
  );
  const key = "CHECKTRAIL_GITHUB_ARTIFACT_TOKEN";
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.env?.[key], undefined);
  let selected = 0;
  for (const job of Object.values(workflow.jobs) as {
    env?: Record<string, string>;
    steps?: { run?: string; env?: Record<string, string> }[];
  }[]) {
    assert.equal(job.env?.[key], undefined);
    for (const step of job.steps ?? []) {
      const preparation =
        /^node scripts\/(prepare-infra-tools-runtime|prepare-scala-tools|prepare-scala2-tools)\.mjs$/.test(
          step.run?.trim() ?? "",
        );
      if (preparation) {
        selected++;
        assert.equal(step.env?.[key], "${{ github.token }}");
      } else assert.equal(step.env?.[key], undefined);
    }
  }
  assert.equal(selected, 12);
});
