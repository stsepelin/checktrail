import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import {
  acquisitionPlan,
  fetchOriginal,
  inventory,
  preparationLimits,
  toolObserverProgram,
  catalog,
} from "./web-runtime-inputs.mjs";
import {
  baseIdentity,
  assemblyDockerfile,
  assemblyCommand,
  inspectLocalIdentity,
} from "./web-runtime-image.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const hash = (body) => createHash("sha256").update(body).digest("hex");
const temp = async (t) => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "checktrail-runtime-inputs-pure-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};
const pin = (body) => ({
  url: "https://example.invalid/original.tgz",
  file: "synthetic/archive",
  bytes: Buffer.byteLength(body),
  sha256: hash(body),
});
const signal = () => new globalThis.AbortController().signal;
const response = (body) =>
  new globalThis.Response(body, {
    status: 200,
    headers: { "content-length": String(Buffer.byteLength(body)) },
  });
function diagnostic(value) {
  return [
    value.error?.message,
    `status=${value.status} signal=${value.signal}`,
    value.stdout,
    value.stderr,
  ]
    .filter(Boolean)
    .join("\n");
}

test("public acquisition is a fixed unique bounded data plan with all global qualification flags false", () => {
  const p = acquisitionPlan();
  assert.equal(p.downloads.length, 558);
  assert.equal(p.downloadBytes, 1201087034);
  assert.ok(p.downloadBytes <= 2 * 1024 ** 3);
  assert.equal(p.limits, preparationLimits);
  assert.equal(p.compilerExecuted, false);
  assert.equal(p.projectCodeExecuted, false);
  assert.equal(p.gateAComplete, false);
  assert.equal(
    new Set(p.downloads.map((row) => row.file)).size,
    p.downloads.length,
  );
  assert.equal(catalog.npm.length, 253);
  assert.equal(catalog.cargo.length, 291);
  assert.equal(catalog.cargoIndices.length, 280);
  assert.ok(
    catalog.npm.every(
      (row) => new URL(row.url).origin === "https://registry.npmjs.org",
    ),
  );
  assert.ok(
    catalog.cargo.every(
      (row) => new URL(row.url).origin === "https://static.crates.io",
    ),
  );
});
test("frozen Cargo index rows preserve every original locked checksum without claiming a mutable server snapshot", () => {
  const actual = catalog.cargoIndices.flatMap((row) =>
    row.entries.map((line) => JSON.parse(line)),
  );
  assert.equal(actual.length, 291);
  assert.equal(
    new Set(actual.map((row) => row.name + "@" + row.vers)).size,
    291,
  );
  for (const row of catalog.cargo) {
    const matches = actual.filter(
      (value) => value.name === row.name && value.vers === row.version,
    );
    assert.equal(matches.length, 1);
    assert.equal(matches[0].cksum, row.checksum);
  }
  assert.equal(catalog.cargoRegistry, "index.crates.io-1949cf8c6b5b557f");
  assert.equal(
    catalog.cargoIndexEncoding.registryCanonicalUrl,
    "sparse+https://index.crates.io/",
  );
  assert.equal(
    catalog.cargoIndexEncoding.historicalServerSnapshotClaimed,
    false,
  );
});
test("actual finite HTTP body publishes exclusively only after complete original byte identity", async (t) => {
  const root = await temp(t),
    target = path.join(root, "archive"),
    body = "synthetic original bytes";
  const actual = await fetchOriginal(pin(body), target, signal(), async () =>
    response(body),
  );
  assert.equal(actual.bytes, Buffer.byteLength(body));
  assert.equal(await readFile(target, "utf8"), body);
  await assert.rejects(
    fetchOriginal(pin(body), target, signal(), async () => response(body)),
    { code: "EEXIST" },
  );
  assert.equal(await readFile(target, "utf8"), body);
});
test("changed short oversized encoded and unavailable bodies preserve failure without publishing a target", async (t) => {
  const root = await temp(t),
    body = "abcdef",
    cases = [
      () => response("mutate"),
      () => new globalThis.Response("abc", { status: 200 }),
      () => new globalThis.Response("abcdefg", { status: 200 }),
      () =>
        new globalThis.Response(body, {
          status: 200,
          headers: { "content-encoding": "gzip" },
        }),
      () => new globalThis.Response("unavailable", { status: 503 }),
    ];
  for (const [i, make] of cases.entries()) {
    const target = path.join(root, String(i));
    await assert.rejects(
      fetchOriginal(pin(body), target, signal(), async () => make()),
    );
    await assert.rejects(readFile(target), { code: "ENOENT" });
  }
});
test("redirect host boundaries refuse credentials ports and lookalike names before a second request", async (t) => {
  const root = await temp(t);
  let calls = 0;
  for (const location of [
    "http://storage.googleapis.com/a",
    "https://storage.googleapis.com.evil.invalid/a",
    "https://x@storage.googleapis.com/a",
    "https://storage.googleapis.com:444/a",
  ]) {
    calls = 0;
    await assert.rejects(
      fetchOriginal(
        pin("body"),
        path.join(root, String(root.length) + String(location.length)),
        signal(),
        async () => {
          calls++;
          return new globalThis.Response(null, {
            status: 302,
            headers: { location },
          });
        },
      ),
    );
    assert.equal(calls, 1);
  }
  let first = true;
  await fetchOriginal(
    pin("body"),
    path.join(root, "allowed"),
    signal(),
    async () => {
      if (first) {
        first = false;
        return new globalThis.Response(null, {
          status: 302,
          headers: { location: "https://storage.googleapis.com/public" },
        });
      }
      return response("body");
    },
  );
  assert.equal(await readFile(path.join(root, "allowed"), "utf8"), "body");
});
test("physical cache inventory includes every adjacent filename and rejects changed bytes", async (t) => {
  const root = await temp(t);
  await writeFile(path.join(root, "one"), "one");
  const first = await inventory(root);
  assert.equal(first.files.length, 1);
  await writeFile(path.join(root, "one-extra"), "two");
  const second = await inventory(root);
  assert.equal(second.files.length, 2);
  assert.notEqual(first.manifestSha256, second.manifestSha256);
  await writeFile(path.join(root, "one"), "two");
  assert.notEqual(
    (await inventory(root)).manifestSha256,
    second.manifestSha256,
  );
});
test("actual controller and worker CLI entrypoints reach admission without the import-cycle deadlock", async (t) => {
  const root = await temp(t),
    config = path.join(root, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      schemaVersion: 1,
      task: "checktrail-runtime-controller-synthetic",
      recipe: "github",
      artifacts: [],
      runtime: null,
      offlineInputs: null,
    }),
  );
  for (const [file, args, expected] of [
    [
      "web-runtime-controller.mjs",
      ["prepare", config, path.join(root, "plan.json")],
      /0 !== 12/u,
    ],
    ["web-runtime-worker.mjs", [], /--operator-trust-execution/u],
  ]) {
    const child = spawnSync(
      process.execPath,
      [
        "--permission",
        "--allow-fs-read=" + here,
        "--allow-fs-read=" + root,
        path.join(here, file),
        ...args,
      ],
      { encoding: "utf8", timeout: 5000, maxBuffer: 1048576 },
    );
    const message = diagnostic(child);
    assert.equal(child.error, undefined, message);
    assert.equal(child.signal, null, message);
    assert.equal(child.status, 1, message);
    assert.match(child.stderr, expected, message);
    assert.doesNotMatch(
      child.stderr,
      /unsettled top-level await|ERR_ACCESS_DENIED/u,
      message,
    );
  }
});
test("metadata observer program is syntactically valid builtins-only data and does not invoke subprocesses", () => {
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--check"],
    { input: toolObserverProgram, encoding: "utf8", timeout: 5000 },
  );
  assert.equal(child.status, 0, diagnostic(child));
  assert.doesNotMatch(
    toolObserverProgram,
    /child_process|execFile|spawn|fetch\(|https?:|import\(/u,
  );
  assert.match(toolObserverProgram, /readFileSync/u);
  assert.match(toolObserverProgram, /realpathSync/u);
});
const failures = [];
const python = ["python3", "python"].find((executable) => {
  const child = spawnSync(
    executable,
    ["-c", "import sys; print(sys.version_info.major)"],
    { encoding: "utf8", timeout: 3000, maxBuffer: 65536 },
  );
  if (
    !child.error &&
    child.status === 0 &&
    child.signal === null &&
    child.stdout.trim() === "3"
  )
    return true;
  failures.push(diagnostic(child));
  return false;
});
test(
  "actual Python data primitives refuse traversal malformed cache rows and changed physical input",
  {
    skip: python
      ? false
      : "Verified Python 3 unavailable: " + failures.join("; "),
  },
  async (t) => {
    const root = await temp(t);
    const program = String.raw`import importlib.util,json,pathlib,sys
spec=importlib.util.spec_from_file_location('preparation',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
r=pathlib.Path(sys.argv[2]);count=0
for bad in ['', '/absolute', '../escape', 'a/../b', 'a//b', 'a/./b', 'a\\b', 'a:b', 'a\x00b']:
 try:m.safe_parts(bad)
 except AssertionError:count+=1
 else:raise AssertionError('Bad path admitted: '+repr(bad))
assert m.safe_parts('a..b/data')==['a..b','data'];count+=1
line=json.dumps({'name':'synthetic','vers':'1.0.0','cksum':'a'*64},separators=(',',':'));body=m.encode_index([line]);assert body[:5]==b'\x03\x02\x00\x00\x00';count+=1
for entries in [[],[line,line],[line.replace('1.0.0','1.0.0\\u0000escape')]]:
 try:m.encode_index(entries)
 except AssertionError:count+=1
 else:raise AssertionError('Malformed index admitted')
p=r/'file';m.write(p,b'original');assert m.regular(p)==b'original';count+=1
try:m.write(p,b'overwrite')
except FileExistsError:count+=1
else:raise AssertionError('Existing file overwritten')
assert p.read_bytes()==b'original';count+=1
try:m.regular(p,2)
except AssertionError:count+=1
else:raise AssertionError('Oversized file admitted')
import io,tarfile
archive=r/'safe.tgz'
with tarfile.open(archive,'w:gz') as out:
 member=tarfile.TarInfo('.');member.type=tarfile.DIRTYPE;out.addfile(member)
 member=tarfile.TarInfo('./LICENSE');member.size=7;out.addfile(member,io.BytesIO(b'license'))
assert [parts for opened,member,parts in m.archive(archive)]==[['LICENSE']];count+=1
archive=r/'escape.tgz'
with tarfile.open(archive,'w:gz') as out:
 member=tarfile.TarInfo('./../escape');member.size=1;out.addfile(member,io.BytesIO(b'x'))
try:list(m.archive(archive))
except AssertionError:count+=1
else:raise AssertionError('Leading-dot traversal admitted')
for bad in [False,True]:
 archive=r/('package-bad.tgz' if bad else 'package-good.tgz')
 with tarfile.open(archive,'w:gz') as out:
  body=b'{"name":"synthetic","version":"1.0.0"}';member=tarfile.TarInfo('types-root/package.json');member.size=len(body);out.addfile(member,io.BytesIO(body))
  if bad:
   member=tarfile.TarInfo('other-root/data');member.size=1;out.addfile(member,io.BytesIO(b'x'))
 if bad:
  try:m.package_data(archive)
  except AssertionError:count+=1
  else:raise AssertionError('Mixed package roots admitted')
 else:assert m.package_data(archive)=={'name':'synthetic','version':'1.0.0'};count+=1
# Real TAR members exercise the unchanged default and the exact large-notice exception.
def notice(archive_name, member_name, body, link=False):
 stream=io.BytesIO()
 with tarfile.open(fileobj=stream,mode='w') as out:
  entry=tarfile.TarInfo(member_name)
  if link:entry.type=tarfile.SYMTYPE;entry.linkname='other'
  else:entry.size=len(body)
  out.addfile(entry,None if link else io.BytesIO(body))
 stream.seek(0)
 with tarfile.open(fileobj=stream,mode='r:') as opened:
  return m.read_notice(opened,opened.next(),archive_name)
known_archive='components/rustc-1.98.1-x86_64-unknown-linux-gnu.tar.xz'
known_member='rustc-1.98.1-x86_64-unknown-linux-gnu/rustc/share/doc/rust/COPYRIGHT.html'
assert m.MAX_NOTICE==4194304 and len(m.LARGE_ORIGINAL_NOTICES)==1
assert m.LARGE_ORIGINAL_NOTICES[(known_archive,known_member)]=={'bytes':15380909,'sha256':'5b0c93fc4e6d4b072eaa521b1762d1e746f4c368f65e81a0e5308e2772dac85e'}
assert notice('synthetic.tgz','LICENSE',b'x'*m.MAX_NOTICE)==b'x'*m.MAX_NOTICE;count+=1
for archive_name,member_name,body,link,reason in [
 ('synthetic.tgz','LICENSE',b'x'*(m.MAX_NOTICE+1),False,'Unregistered oversized original notice'),
 ('components/rustc-1.98.2-x86_64-unknown-linux-gnu.tar.xz',known_member,b'x'*(m.MAX_NOTICE+1),False,'Unregistered oversized original notice'),
 (known_archive,known_member+'.other',b'x'*(m.MAX_NOTICE+1),False,'Unregistered oversized original notice'),
 (known_archive,known_member,b'x'*m.MAX_NOTICE,False,'Pinned original notice size differs'),
 (known_archive,known_member,b'x'*15380909,False,'Pinned original notice bytes differ'),
 ('synthetic.tgz','LICENSE',b'',True,'Only regular original notice bytes are retained'),
]:
 try:notice(archive_name,member_name,body,link)
 except AssertionError as error:
  assert str(error)==reason,'Notice refusal reason differs: '+str(error)+' expected '+reason
  count+=1
 else:raise AssertionError('Unqualified original notice admitted: '+archive_name+'/'+member_name)
print(json.dumps({'passed':count,'compilerExecuted':False,'projectCodeExecuted':False}))`;
    const child = spawnSync(
      python,
      ["-c", program, path.join(here, "web-runtime-prepare.py"), root],
      { encoding: "utf8", timeout: 10000, maxBuffer: 1048576 },
    );
    assert.equal(child.error, undefined, diagnostic(child));
    assert.equal(child.status, 0, diagnostic(child));
    assert.deepEqual(JSON.parse(child.stdout), {
      passed: 29,
      compilerExecuted: false,
      projectCodeExecuted: false,
    });
  },
);
test("local-derived metadata requires the exact shared cryptographic base and COPY-only assembly", () => {
  const pin = { file: "/synthetic/control", bytes: 1, sha256: "a".repeat(64) };
  const local = {
    ...Object.fromEntries(
      [
        "buildReceipt",
        "iidFile",
        "baseInspection",
        "resultInspection",
        "dockerfile",
        "assemblyControl",
        "copyManifest",
        "authenticationReceipt",
      ].map((key) => [key, { ...pin }]),
    ),
    inputs: catalog.components.map((row) => ({
      id: row.name,
      file: "/synthetic/" + row.name,
      bytes: row.bytes,
      sha256: row.sha256,
    })),
    authentication: [],
    baseRef: baseIdentity.selectedImage,
    baseImageId: baseIdentity.configDigest,
    rootfsDiffIds: [...baseIdentity.rootfsDiffIds, "sha256:" + "f".repeat(64)],
    baseRootfsDiffIds: [...baseIdentity.rootfsDiffIds],
    rawManifestConfigVerified: false,
  };
  inspectLocalIdentity(local);
  for (const change of [
    (value) => (value.baseRef += "-other"),
    (value) => (value.baseImageId = "sha256:" + "0".repeat(64)),
    (value) => (value.baseRootfsDiffIds[0] = "sha256:" + "0".repeat(64)),
    (value) => (value.rootfsDiffIds[0] = "sha256:" + "0".repeat(64)),
    (value) => value.inputs.pop(),
    (value) => (value.inputs[0].sha256 = "b".repeat(64)),
    (value) => (value.rawManifestConfigVerified = true),
  ]) {
    const value = globalThis.structuredClone(local);
    change(value);
    assert.throws(() => inspectLocalIdentity(value));
  }
  assert.ok(
    assemblyDockerfile.startsWith(
      "FROM " + baseIdentity.selectedImage + "\nCOPY overlay/ /\n",
    ),
  );
  assert.doesNotMatch(assemblyDockerfile, /^(?:RUN|ADD|ONBUILD)\b/mu);
  assert.deepEqual(assemblyCommand("/synthetic/iid", "/synthetic/context"), [
    "build",
    "--pull=false",
    "--network=none",
    "--platform=linux/amd64",
    "--no-cache",
    "--iidfile",
    "/synthetic/iid",
    "/synthetic/context",
  ]);
});
