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
    const api=await import(process.argv[1]);
    const profile={image:'sha256:'+'a'.repeat(64),runtimeSha256:'b'.repeat(64),dependenciesSha256:null,
      native:{executable:'go',args:['test','-json','-count=1','./...']},languages:['go'],timeoutMs:1000,maxOutputBytes:65536};
    const output=(stdout,exitCode=0,extra={})=>({stdout,stderr:'',exitCode,signal:null,timedOut:false,truncated:false,cancelled:false,...extra});
    ${body}
  `,
      new URL("../../scripts/agent-evaluation-protocol.mjs", import.meta.url)
        .href,
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
}

test("Go evaluation native evidence requires complete real test event sequences and matching exits", () => {
  exercise(String.raw`
    const events=[{Action:'start',Package:'synthetic'},{Action:'run',Package:'synthetic',Test:'TestOne'},
      {Action:'pass',Package:'synthetic',Test:'TestOne'},{Action:'run',Package:'synthetic',Test:'TestTwo'},
      {Action:'pass',Package:'synthetic',Test:'TestTwo'},{Action:'pass',Package:'synthetic'}];
    const encode=rows=>rows.map(JSON.stringify).join('\n')+'\n';
    const expected={profile,nativeEvidence:{parser:'go-json',scope:['one_test.go','two_test.go']}};
    assert.equal(api.nativeComplete(output(encode(events)),expected),true);
    const broken=structuredClone(events);broken[4].Action='fail';broken[5].Action='fail';
    assert.equal(api.nativeComplete(output(encode(broken),1),expected),true);
    assert.equal(api.nativeComplete(output(encode(broken),0),expected),false);
    assert.equal(api.nativeComplete(output(encode(events),1),expected),false);
    for(const rows of [[],events.slice(0,-1),events.filter(x=>x.Action!=='run'),[...events,events[2]]])
      assert.equal(api.nativeComplete(output(encode(rows)),expected),false);
    const skipped=events.map(x=>({...x,Action:x.Action==='pass'?'skip':x.Action}));
    assert.equal(api.nativeComplete(output(encode(skipped)),expected),false);
    for(const extra of [{timedOut:true},{truncated:true},{cancelled:true},{errorCode:'ENOENT'},{signal:'SIGTERM'}])
      assert.equal(api.nativeComplete(output(encode(events),0,extra),expected),false);
    assert.equal(api.executionProfileSchema.safeParse({...profile,dependencyDirectory:'vendor'}).success,true);
  `);
});

test("PHP evaluation native evidence reconciles every source file for passing and failing PHPUnit runs", () => {
  exercise(String.raw`
    const expected={profile:{...profile,native:{executable:'php',args:['vendor/bin/phpunit']},languages:['php'],dependencyDirectory:'vendor'},
      nativeEvidence:{parser:'phpunit-junit',scope:['OneTest.php','TwoTest.php']}};
    const xml='<testsuite tests="2"><testcase name="one" file="/source/OneTest.php" assertions="1"/><testcase name="two" file="/source/TwoTest.php" assertions="1"/></testsuite>';
    assert.equal(api.nativeComplete(output(xml),expected),true);
    const broken=xml.replace('name="one" file="/source/OneTest.php" assertions="1"/>','name="one" file="/source/OneTest.php" assertions="1"><failure>authored failure</failure></testcase>');
    assert.equal(api.nativeComplete(output(broken,1),expected),true);
    assert.equal(api.nativeComplete(output(broken,0),expected),false);
    assert.equal(api.nativeComplete(output(broken.replace('assertions="1"','assertions="0"'),1),expected),false);
    assert.equal(api.nativeComplete(output(xml,1),expected),false);
    for(const text of [xml.replace('/source/OneTest.php','/foreign/OneTest.php'),broken.replace('/source/OneTest.php','/foreign/OneTest.php'),
      xml.replace('file="/source/OneTest.php"',''),xml.replace('assertions="1"','assertions="0"'),xml.slice(0,-5),'',xml+'not XML'])
      assert.equal(api.nativeComplete(output(text,text.includes('failure')?1:0),expected),false);
    assert.equal(api.nativeComplete(output(xml),{...expected,nativeEvidence:{parser:'phpunit-junit',scope:['OneTest.php','TwoTest.php','MissingTest.php']}}),false);
  `);
});

test("Pest native evidence uses stderr and preserves exact file boundaries when removing method suffixes", () => {
  exercise(String.raw`
    const expected={profile:{...profile,native:{executable:'php',args:['vendor/bin/pest']},languages:['php']},
      nativeEvidence:{parser:'pest-junit',scope:['ExampleTest.php']}};
    const xml='<testsuite tests="1"><testcase name="one" file="/source/ExampleTest.php::one" assertions="1"/></testsuite>';
    const valid=output('native progress',0,{stderr:xml});
    assert.equal(api.nativeComplete(valid,expected),true);
    const broken=xml.replace('assertions="1"/>','assertions="1"><failure>authored failure</failure></testcase>');
    assert.equal(api.nativeComplete(output('native failure',1,{stderr:broken}),expected),true);
    assert.equal(api.nativeComplete(output('',0,{stderr:xml.replace('::one','')}),expected),true);
    for(const stderr of [xml.replace('ExampleTest.php::','ExampleTest.php.backup::'),broken.replace('/source/','/outside/'),xml+'not XML'])
      assert.equal(api.nativeComplete(output('',stderr.includes('failure')?1:0,{stderr}),expected),false);
    assert.equal(api.nativeComplete(output(xml),expected),false);
  `);
});
