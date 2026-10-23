import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers.js";
const { captureCompiledEngine, requireUnchangedCompiledEngine } = await import(
  new URL("../../scripts/compiled-engine-evidence.mjs", import.meta.url).href
);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

test("compiled engine snapshots bind every relative file and raw bytes without certifying dependencies or module loads", async (t) => {
  const root = await fixture(t, {
    "src/z.js": "export const end = 2;\r\n",
    "src/a.d.ts": "export declare const start: number;\n",
    "src/nested/entry.js": "export const start = 1;\n",
  });
  const first = await captureCompiledEngine(path.join(root, "src"));
  assert.deepEqual(
    first.files.map((f: { file: string }) => f.file),
    ["a.d.ts", "nested/entry.js", "z.js"],
  );
  assert.equal(first.fileCount, 3);
  assert.equal(
    first.bytes,
    Buffer.byteLength(
      "export const end = 2;\r\nexport declare const start: number;\nexport const start = 1;\n",
    ),
  );
  assert.equal(first.files[2].sha256, digest("export const end = 2;\r\n"));
  assert.equal(
    first.treeSha256,
    digest(
      JSON.stringify(
        first.files.map((f: { file: string; sha256: string }) => [
          f.file,
          f.sha256,
        ]),
      ),
    ),
  );
  const unchanged = requireUnchangedCompiledEngine(
    first,
    await captureCompiledEngine(path.join(root, "src")),
  );
  assert.equal(unchanged.beforeAfterByteIdentitiesMatch, true);
  assert.equal(unchanged.dependencyBytesCaptured, false);
  assert.equal(unchanged.actualModuleLoadsTraced, false);
  assert.equal(unchanged.producerSourceBuildVerified, false);
  assert.ok(!JSON.stringify(unchanged).includes(root));
  await writeFile(
    path.join(root, "notes.txt"),
    "outside the declared compiled artifact scope",
  );
  assert.deepEqual(await captureCompiledEngine(path.join(root, "src")), first);
});

test("compiled engine snapshots reject changed removed and renamed files and admit exact restoration", async (t) => {
  const root = await fixture(t, {
      "src/entry.js": "export const value = 1;\n",
      "src/other.d.ts": "export {};\n",
    }),
    dir = path.join(root, "src"),
    file = path.join(dir, "entry.js");
  const before = await captureCompiledEngine(dir);
  await writeFile(file, "export const value = 2;\n");
  const changed = await captureCompiledEngine(dir);
  assert.throws(
    () => requireUnchangedCompiledEngine(before, changed),
    /Compiled engine bytes changed/,
  );
  await writeFile(file, "export const value = 1;\n");
  assert.deepEqual(
    requireUnchangedCompiledEngine(before, await captureCompiledEngine(dir))
      .files,
    before.files,
  );
  await rm(file);
  const removed = await captureCompiledEngine(dir);
  assert.throws(
    () => requireUnchangedCompiledEngine(before, removed),
    /Compiled engine bytes changed/,
  );
  await writeFile(file, "export const value = 1;\n");
  await rename(file, path.join(dir, "renamed.js"));
  const renamed = await captureCompiledEngine(dir);
  assert.throws(
    () => requireUnchangedCompiledEngine(before, renamed),
    /Compiled engine bytes changed/,
  );
  await rename(path.join(dir, "renamed.js"), file);
  await writeFile(path.join(dir, "extra.js"), "export const extra = true;\n");
  const extra = await captureCompiledEngine(dir);
  assert.throws(
    () => requireUnchangedCompiledEngine(before, extra),
    /Compiled engine bytes changed/,
  );
});

test("compiled engine snapshots resolve the installed root alias while refusing nested file and directory links", async (t) => {
  const root = await fixture(t, {
    "package/dist/src/entry.js": "export const value = 1;\n",
    "foreign/secret.js": "opaque outside input",
  });
  const installed = path.join(root, "package/dist/src"),
    alias = path.join(root, "engine-alias");
  await symlink(
    installed,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.deepEqual(
    await captureCompiledEngine(alias),
    await captureCompiledEngine(installed),
  );
  await symlink(
    path.join(root, "foreign/secret.js"),
    path.join(installed, "nested-file.js"),
    process.platform === "win32" ? "file" : undefined,
  );
  await assert.rejects(captureCompiledEngine(alias), /nested link/);
  await rename(
    path.join(installed, "nested-file.js"),
    path.join(root, "preserved-link"),
  );
  await symlink(
    path.join(root, "foreign"),
    path.join(installed, "nested-dir"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(captureCompiledEngine(alias), /nested link/);
});

test("compiled engine snapshot limits reject empty absent oversized deep and excessive directory inputs", async (t) => {
  const root = await fixture(t, {
    "valid/entry.js": "export const value = 1;\n",
  });
  await mkdir(path.join(root, "empty"));
  await assert.rejects(
    captureCompiledEngine(path.join(root, "empty")),
    /artifact is empty/,
  );
  await assert.rejects(
    captureCompiledEngine(path.join(root, "absent")),
    /filesystem observation unavailable/,
  );
  const first = await captureCompiledEngine(path.join(root, "valid"));
  const oversized = path.join(root, "valid/oversized.js");
  await writeFile(oversized, "");
  await truncate(oversized, first.limits.fileBytes + 1);
  await assert.rejects(
    captureCompiledEngine(path.join(root, "valid")),
    /file byte limit/,
  );
  const deep = path.join(
    root,
    "deep",
    ...Array.from({ length: first.limits.depth + 1 }, () => "level"),
  );
  await mkdir(deep, { recursive: true });
  await writeFile(path.join(deep, "entry.js"), "x");
  await assert.rejects(
    captureCompiledEngine(path.join(root, "deep")),
    /directory depth/,
  );
  const entries = path.join(root, "entries");
  await mkdir(entries);
  for (let i = 0; i <= first.limits.entries; i += 128)
    await Promise.all(
      Array.from(
        { length: Math.min(128, first.limits.entries + 1 - i) },
        (_, j) => mkdir(path.join(entries, "empty-" + (i + j))),
      ),
    );
  await assert.rejects(captureCompiledEngine(entries), /directory entry limit/);
});

async function nativeHarness(
  t: Parameters<typeof fixture>[0],
  installed: boolean,
  mutation: boolean,
) {
  const root = await fixture(t, {
    "package.json": JSON.stringify({ type: "module" }),
    "scripts/required-native-tests.json": JSON.stringify({
      "original-byte-profile": [
        {
          file: "dist/test/original.test.js",
          name: "original byte identity callback",
        },
      ],
    }),
    "dist/test/original.test.js": `import {test} from 'node:test';import assert from 'node:assert/strict';import {writeFile} from 'node:fs/promises';test('original byte identity callback',async()=>{assert.equal(3+5,8);${mutation ? "await writeFile(new URL('../src/entry.js',import.meta.url),'export const changed = true;\\n');" : ""}});`,
    [installed
      ? "node_modules/@stsepelin/checktrail/dist/src/entry.js"
      : "dist/src/entry.js"]: "export const original = true;\n",
  });
  for (const name of [
    "verify-required-native-tests.mjs",
    "required-test-evidence.mjs",
    "compiled-engine-evidence.mjs",
  ])
    await cp(
      path.join(repository, "scripts", name),
      path.join(root, "scripts", name),
    );
  if (installed)
    await symlink(
      path.join(root, "node_modules/@stsepelin/checktrail/dist/src"),
      path.join(root, "dist/src"),
      process.platform === "win32" ? "junction" : "dir",
    );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ["scripts/verify-required-native-tests.mjs", "original-byte-profile"],
    { cwd: root, env, encoding: "utf8", timeout: 30000, maxBuffer: 1048576 },
  );
  return { root, result };
}

test("native source and fresh-install runners actually emit the matching compiled engine byte manifest", async (t) => {
  const reports = [];
  for (const installed of [false, true]) {
    const { root, result } = await nativeHarness(t, installed, false);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.complete, true);
    assert.equal(report.required, 1);
    assert.equal(report.passed, 1);
    assert.equal(
      report.ledger.cases[0].name,
      "original byte identity callback",
    );
    assert.deepEqual(report.compiledEngine.files, [
      {
        file: "entry.js",
        bytes: Buffer.byteLength("export const original = true;\n"),
        sha256: digest("export const original = true;\n"),
      },
    ]);
    assert.equal(report.compiledEngine.beforeAfterByteIdentitiesMatch, true);
    assert.equal(report.compiledEngine.dependencyBytesCaptured, false);
    assert.ok(!result.stdout.includes(root));
    reports.push(report.compiledEngine);
  }
  assert.deepEqual(reports[0], reports[1]);
});

test("native source and fresh-install runners refuse a passing callback after compiled engine bytes change", async (t) => {
  for (const installed of [false, true]) {
    const { result } = await nativeHarness(t, installed, true);
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      /Compiled engine bytes changed during required test execution/,
    );
    assert.equal(result.stdout, "");
  }
});

test("compiled engine byte ceilings admit exact bounds and reject an extra byte or file", async (t) => {
  const root = await fixture(t, { "seed/entry.js": "export {};\n" });
  const snapshot = await captureCompiledEngine(path.join(root, "seed"));
  const bounded = path.join(root, "bounded");
  await mkdir(bounded);
  for (
    let i = 0;
    i < snapshot.limits.totalBytes / snapshot.limits.fileBytes;
    i++
  ) {
    const file = path.join(bounded, "part-" + i + ".js");
    await writeFile(file, "");
    await truncate(file, snapshot.limits.fileBytes);
  }
  const atLimit = await captureCompiledEngine(bounded);
  assert.equal(atLimit.bytes, snapshot.limits.totalBytes);
  await writeFile(path.join(bounded, "one-extra-byte.js"), "x");
  await assert.rejects(captureCompiledEngine(bounded), /total byte limit/);
  const many = path.join(root, "many");
  await mkdir(many);
  for (let i = 0; i <= snapshot.limits.files; i += 128)
    await Promise.all(
      Array.from(
        { length: Math.min(128, snapshot.limits.files + 1 - i) },
        (_, j) => writeFile(path.join(many, "file-" + (i + j) + ".js"), "x"),
      ),
    );
  await assert.rejects(captureCompiledEngine(many), /file count/);
});

test("compiled engine observations arm file-change guards before and during reads and close owned handles", async (t) => {
  const original = "export const value = 1;\n";
  const root = await fixture(t, {
    "engine/entry.js": original,
    "observer.mjs": `import{registerHooks}from'node:module';const target=process.argv[2],root=process.argv[3],mode=process.argv[4];globalThis.originalReadMutation={armed:0,closed:0};
const stub=\`import*as fs from'node:fs/promises';export const lstat=fs.lstat,opendir=fs.opendir,realpath=fs.realpath;export async function open(...args){const handle=await fs.open(...args);const arm=async()=>{if(!globalThis.originalReadMutation.armed){globalThis.originalReadMutation.armed++;await fs.appendFile(args[0],'x');}};if(\${JSON.stringify(mode)}==='before')await arm();return{stat:(...args)=>handle.stat(...args),read:async(...args)=>{const result=await handle.read(...args);if(\${JSON.stringify(mode)}==='during')await arm();return result;},close:async()=>{globalThis.originalReadMutation.closed++;await handle.close();}}}\`;
registerHooks({resolve(specifier,context,next){if(context.parentURL===target&&specifier==='node:fs/promises')return{url:'data:text/javascript,'+encodeURIComponent(stub),shortCircuit:true};return next(specifier,context);}});
const{captureCompiledEngine}=await import(target);let result,error;try{result=await captureCompiledEngine(root);}catch(value){error=value.message;}console.log(JSON.stringify({result,error,...globalThis.originalReadMutation}));`,
  });
  const target = new URL(
    "../../scripts/compiled-engine-evidence.mjs",
    import.meta.url,
  ).href;
  for (const mode of ["before", "during"]) {
    const file = path.join(root, "engine/entry.js");
    await writeFile(file, original);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "observer.mjs"),
        target,
        path.join(root, "engine"),
        mode,
      ],
      { env, encoding: "utf8", timeout: 15000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.armed, 1);
    assert.equal(observed.closed, 1);
    assert.equal(observed.result, undefined);
    assert.match(
      observed.error,
      mode === "before"
        ? /identity changed before reading/
        : /file changed while reading/,
    );
    assert.ok(!result.stdout.includes(root));
    await writeFile(file, original);
    const restored = await captureCompiledEngine(path.join(root, "engine"));
    assert.equal(restored.files[0].sha256, digest(original));
  }
});
