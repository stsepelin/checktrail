import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

test("Ruby acceptance shards retain every native source and installed case exactly once and reject changed inventories", async () => {
  const root = new URL("../../", import.meta.url);
  const profiles = JSON.parse(
    await readFile(new URL("scripts/required-native-tests.json", root), "utf8"),
  );
  const requirements = profiles["ruby-extensions"] as {
    file: string;
    name: string;
  }[];
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    const {selectRubyExtensionAcceptance:select}=await import(process.argv[1]);
    const original=JSON.parse(process.argv[2]);
    const expected=["broken","fixed","near-miss","prerequisite","stale","empty","privacy","lifecycle","installed"].map(kind=>({file:"dist/test/gate-ruby-extensions.test.js",name:"ruby-extensions "+kind+" acceptance"}));
    assert.deepEqual(original,expected);
    for(const mode of ["source","installed"]){
      const shards=["1","2","3"].map(shard=>select(original,mode,shard));
      const union=shards.flat();
      const all=mode==="source"?expected.slice(0,-1):expected;
      assert.equal(new Set(union.map(item=>item.name)).size,all.length);
      assert.deepEqual(union.map(item=>item.name).sort(),all.map(item=>item.name).sort());
      assert.deepEqual(select(original,mode,"all"),all);
      assert.deepEqual(shards.map(shard=>shard.map(item=>item.name)),[
        [expected[0].name,expected[3].name,expected[6].name],
        [expected[1].name,expected[4].name,expected[7].name],
        mode==="source"?[expected[2].name,expected[5].name]:[expected[2].name,expected[5].name,expected[8].name]
      ]);
    }
    for(const bad of [[],original.slice(1),[...original,original[0]],original.map((item,i)=>i===1?original[0]:item),original.toReversed(),original.map((item,i)=>i===0?{...item,file:"other.test.js"}:item)])
      assert.throws(()=>select(bad,"source","1"));
    for(const shard of ["0","4","01","1;exit 0",undefined])assert.throws(()=>select(original,"source",shard));
    for(const mode of ["other",undefined])assert.throws(()=>select(original,mode,"1"));
    console.log(JSON.stringify({source:8,installed:9,shards:3}));
  `,
      new URL("scripts/ruby-extensions-acceptance-selection.mjs", root).href,
      JSON.stringify(requirements),
    ],
    { env: environment, encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.error, undefined, result.error?.message ?? "");
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    source: 8,
    installed: 9,
    shards: 3,
  });
  const ci = parse(
    await readFile(new URL(".github/workflows/ci.yml", root), "utf8"),
  );
  const job = ci.jobs["ruby-extensions-arm64"];
  assert.equal(job.strategy["fail-fast"], false);
  assert.deepEqual(job.strategy.matrix.phase, [
    "acceptance-1",
    "acceptance-2",
    "acceptance-3",
    "baseline-1",
    "baseline-2",
    "baseline-3",
    "guards-1",
    "guards-2",
    "guards-3",
  ]);
  assert.equal(
    job.steps.filter(
      (step: { run?: string }) =>
        step.run ===
        "node scripts/verify-ruby-extensions-container.mjs ${{ matrix.phase }}",
    ).length,
    1,
  );
});
