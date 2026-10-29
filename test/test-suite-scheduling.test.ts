import assert from "node:assert/strict";
import { readFile, mkdir, cp, writeFile, rm } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { fixture } from "./helpers.js";
test("full test entry point retains every ordinary and exclusive body after success failure and an empty inventory", async (t) => {
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  for (const [failed, exclusiveFailed] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ] as const) {
    const root = await fixture(t, {
      "package.json": '{"type":"module"}',
      "dist/test/ordinary.test.js": `import{test}from'node:test';import assert from'node:assert/strict';import{appendFileSync}from'node:fs';test('original ordinary body',()=>{appendFileSync('reached.jsonl',JSON.stringify({body:'ordinary',pid:process.pid})+String.fromCharCode(10));assert.equal(${failed},false);});`,
      "dist/test/gate-resource-release-readiness.test.js": `import{test}from'node:test';import assert from'node:assert/strict';import{appendFileSync}from'node:fs';test('original exclusive body',()=>{appendFileSync('reached.jsonl',JSON.stringify({body:'exclusive',pid:process.pid})+String.fromCharCode(10));assert.equal(${exclusiveFailed},false);});`,
    });
    await mkdir(path.join(root, "scripts"));
    for (const file of ["run-test-suite.mjs", "required-test-evidence.mjs"])
      await cp(
        path.join(repository, "scripts", file),
        path.join(root, "scripts", file),
      );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["scripts/run-test-suite.mjs"], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 1048576,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(
      result.status,
      failed || exclusiveFailed ? 1 : 0,
      result.stdout + result.stderr,
    );
    const bodies = (await readFile(path.join(root, "reached.jsonl"), "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      bodies.map((row) => row.body),
      ["ordinary", "exclusive"],
    );
    assert.equal(new Set(bodies.map((row) => row.pid)).size, 2);
  }
  const empty = await fixture(t, { "package.json": '{"type":"module"}' });
  await mkdir(path.join(empty, "dist/test"), { recursive: true });
  await mkdir(path.join(empty, "scripts"));
  for (const file of ["run-test-suite.mjs", "required-test-evidence.mjs"])
    await cp(
      path.join(repository, "scripts", file),
      path.join(empty, "scripts", file),
    );
  assert.throws(
    () =>
      execFileSync(process.execPath, ["scripts/run-test-suite.mjs"], {
        cwd: empty,
        encoding: "utf8",
        stdio: "pipe",
      }),
    (error: unknown) => {
      assert.equal((error as { status: number }).status, 1);
      assert.match(
        (error as { stderr: string }).stderr,
        /Compiled full suite is empty/,
      );
      return true;
    },
  );
});

test("native process full-suite bodies wait for the shared wave and retain every callback after a failure", async (t) => {
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const root = await fixture(t, {
    "package.json": '{"type":"module"}',
    "dist/test/gate-lifecycle-platforms-extra.test.js": `import{test}from'node:test';import{writeFileSync}from'node:fs';test('adjacent shared body',async()=>{await new Promise(r=>setTimeout(r,250));writeFileSync('adjacent-shared-finished','yes');});`,
    "dist/test/ordinary.test.js": `import{test}from'node:test';import{writeFileSync}from'node:fs';test('shared body',async()=>{await new Promise(r=>setTimeout(r,250));writeFileSync('shared-finished','yes');});`,
  });
  const files = [
    "process-tree.test.js",
    "clang.test.js",
    "gate-go-extensions.test.js",
    "gate-lifecycle-platforms.test.js",
    "go-matrix.test.js",
    "review-json-probe.test.js",
    "review-probe.test.js",
  ].sort();
  for (const [index, file] of files.entries())
    await writeFile(
      path.join(root, "dist/test", file),
      `import{test}from'node:test';import assert from'node:assert/strict';import{readFileSync,appendFileSync,existsSync,writeFileSync,unlinkSync}from'node:fs';test('native body ${index}',async()=>{assert.equal(readFileSync('shared-finished','utf8'),'yes','Shared work must finish before native admission');assert.equal(readFileSync('adjacent-shared-finished','utf8'),'yes','Adjacent names must remain in the shared wave');assert.equal(existsSync('native-active'),false,'Native files must not overlap');writeFileSync('native-active','yes');try{await new Promise(r=>setTimeout(r,100));appendFileSync('native-events','${index}\\n');assert.equal(${index},0,'Original later-file failure must remain a failure');}finally{unlinkSync('native-active');}});test('unlisted body ${index}',()=>appendFileSync('native-events','unlisted-${index}\\n'));`,
    );
  await mkdir(path.join(root, "scripts"));
  for (const file of ["run-test-suite.mjs", "required-test-evidence.mjs"])
    await cp(
      path.join(repository, "scripts", file),
      path.join(root, "scripts", file),
    );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["scripts/run-test-suite.mjs"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 1048576,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(
    (await readFile(path.join(root, "native-events"), "utf8"))
      .trim()
      .split("\n"),
    files.flatMap((_, index) => [String(index), "unlisted-" + index]),
  );
  await rm(path.join(root, "native-events"));
  await rm(path.join(root, "shared-finished"));
  await rm(path.join(root, "adjacent-shared-finished"));
  const collected = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const {runRequiredTests}=await import(process.argv[1]);const root=process.argv[2],files=JSON.parse(process.argv[3]);console.log(JSON.stringify(await runRequiredTests([{file:root+'/dist/test/ordinary.test.js',name:'shared body'}],{timeoutMs:15000,additionalFiles:[root+'/dist/test/gate-lifecycle-platforms-extra.test.js',...files.map(file=>root+'/dist/test/'+file)]})));",
      pathToFileURL(path.join(root, "scripts/required-test-evidence.mjs")).href,
      root,
      JSON.stringify(files),
    ],
    { cwd: root, env, encoding: "utf8", timeout: 20000, maxBuffer: 1048576 },
  );
  assert.equal(collected.error, undefined);
  assert.equal(collected.status, 0, collected.stdout + collected.stderr);
  const report = JSON.parse(collected.stdout);
  assert.equal(
    report.complete,
    false,
    "Native failures cannot be promoted to success",
  );
  assert.equal(report.exclusiveFullSuiteFileCount, files.length);
  // Node can additionally report file-level failures. Count the actual named
  // callbacks exactly and retain every other terminal event in the full ledger.
  assert.equal(report.ledger.terminalEventCount, report.ledger.events.length);
  assert.equal(report.ledger.truncated, false);
  const expected = [
    { name: "shared body", outcome: "passed" },
    { name: "adjacent shared body", outcome: "passed" },
    ...files.flatMap((_, index) => [
      {
        name: "native body " + index,
        outcome: index === 0 ? "passed" : "failed",
      },
      { name: "unlisted body " + index, outcome: "passed" },
    ]),
  ];
  const names = new Set(expected.map((event) => event.name));
  const named = report.ledger.events
    .filter((event: { name: string }) => names.has(event.name))
    .map(({ name, outcome }: { name: string; outcome: string }) => ({
      name,
      outcome,
    }));
  const order = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name);
  assert.deepEqual(named.sort(order), expected.sort(order));
  assert.deepEqual(
    (await readFile(path.join(root, "native-events"), "utf8"))
      .trim()
      .split("\n"),
    files.flatMap((_, index) => [String(index), "unlisted-" + index]),
  );
});
