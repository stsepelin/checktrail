import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "../" : "../../", import.meta.url),
);
const producer = await import(
  pathToFileURL(path.join(repository, "scripts/qualify-c-producer.mjs")).href
);
const profiles = await import(
  pathToFileURL(
    path.join(
      repository,
      "scripts/producer-qualification/c-producer-profile.mjs",
    ),
  ).href
);
const codec = await import(
  pathToFileURL(
    path.join(
      repository,
      "scripts/producer-qualification/c-producer-report-codec.mjs",
    ),
  ).href
);
const caller =
  process.getuid && process.getgid
    ? { uid: process.getuid(), gid: process.getgid() }
    : null;
const python = ["python3", "python"].find(
  (program) =>
    spawnSync(
      program,
      ["-I", "-S", "-B", "-c", "import sys; assert sys.version_info.major==3"],
      { encoding: "utf8", timeout: 3000 },
    ).status === 0,
);
const control = {
  skip: !caller
    ? "POSIX report copy custody unavailable"
    : !python
      ? "Python3 synthetic collector unavailable"
      : false,
};
const hash = (raw: Uint8Array) =>
  createHash("sha256").update(raw).digest("hex");
const diagnostic = (result: ReturnType<typeof spawnSync>) =>
  [
    result.error?.message,
    String(result.status),
    result.stdout?.toString(),
    result.stderr?.toString(),
  ]
    .filter(Boolean)
    .join("\n");
async function captured(t: TestContext) {
  assert.ok(caller && python);
  const root = await mkdtemp(
    path.join(await realpath(os.tmpdir()), "ct-report-transport-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"),
    result = path.join(root, "result");
  await mkdir(path.join(source, "build-tree/suite"), { recursive: true });
  await mkdir(path.join(result, "work"), { recursive: true, mode: 0o700 });
  const raw = Buffer.concat([
    Buffer.alloc(codec.cReportEncodingPolicy.limits.decodedChunkBytes - 1, 120),
    Buffer.from(
      "\r\nPASS: synthetic positive\rFAIL: synthetic retained failure\nUNSUPPORTED: synthetic platform\n",
    ),
  ]);
  const log = Buffer.alloc(
    codec.cReportEncodingPolicy.limits.decodedChunkBytes + 37,
    97,
  );
  await writeFile(path.join(source, "build-tree/suite/result.sum"), raw);
  await writeFile(path.join(source, "build-tree/suite/result.log"), log);
  const manifest = path.join(result, "work/test-reports.json");
  const output = spawnSync(
    python,
    [
      "-I",
      "-S",
      "-B",
      path.join(
        repository,
        "scripts/producer-qualification/c-producer-test-reports.py",
      ),
      "glibc",
      source,
      manifest,
      String(caller.uid),
      String(caller.gid),
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(output.status, 0, diagnostic(output));
  const value = JSON.parse(await readFile(manifest, "utf8"));
  assert.equal(value.schemaVersion, 3);
  assert.equal(value.retainedBytes, raw.length + log.length);
  assert.equal(value.reports[0].sha256, hash(raw));
  assert.equal(value.reports[0].log.sha256, hash(log));
  return {
    root,
    source,
    result,
    manifest,
    value,
    copies: path.join(result, "work/original-test-reports"),
  };
}

test(
  "C report JS verification drains real report and log chunks before crediting whole original identities",
  control,
  async (t) => {
    assert.ok(caller);
    const fixture = await captured(t);
    const { profile } = await profiles.loadCProducerProfile("glibc");
    const valid = await producer.verifyCProducerReports(
      fixture.value,
      fixture.copies,
      profile,
      caller,
    );
    assert.equal(valid.physicalBytesReconciled, true);
    assert.equal(valid.reports[0].counts.PASS, 1);
    assert.equal(valid.reports[0].counts.FAIL, 1);
    assert.equal(valid.reports[0].counts.UNSUPPORTED, 1);
    assert.equal(valid.reports[0].totalLines, 4);
    assert.equal(valid.reports[0].otherLines, 1);
    for (const member of ["report", "log"]) {
      const forged = structuredClone(fixture.value);
      const pin =
        member === "report" ? forged.reports[0] : forged.reports[0].log;
      assert.ok(pin.chunks.length >= 2);
      pin.sha256 = "0".repeat(64);
      await assert.rejects(
        producer.verifyCProducerReports(
          forged,
          fixture.copies,
          profile,
          caller,
        ),
        /whole original bytes\/hash differ/,
      );
    }
    const wrongLog = structuredClone(fixture.value);
    wrongLog.reports[0].log.file = "build-tree/suite/other-valid.log";
    await assert.rejects(
      producer.verifyCProducerReports(
        wrongLog,
        fixture.copies,
        profile,
        caller,
      ),
      /Associated original log identity differs/,
    );
    const reordered = structuredClone(fixture.value);
    reordered.reports[0].chunks.reverse();
    await assert.rejects(
      producer.verifyCProducerReports(
        reordered,
        fixture.copies,
        profile,
        caller,
      ),
      /Reordered or omitted C report physical chunks/,
    );
    const badChunk = structuredClone(fixture.value);
    badChunk.reports[0].log.chunks.at(-1).sha256 = "0".repeat(64);
    await assert.rejects(
      producer.verifyCProducerReports(
        badChunk,
        fixture.copies,
        profile,
        caller,
      ),
      /stored chunk bytes\/hash differ/,
    );
    const missing = fixture.value.reports[0].log.chunks.at(-1).file;
    const moved = path.join(fixture.root, "missing-chunk-control.gz");
    await rename(path.join(fixture.copies, missing), moved);
    try {
      await assert.rejects(
        producer.verifyCProducerReports(
          fixture.value,
          fixture.copies,
          profile,
          caller,
        ),
        { code: "ENOENT" },
      );
    } finally {
      await rename(moved, path.join(fixture.copies, missing));
    }
    const omitted = structuredClone(fixture.value);
    delete omitted.fullCompilerSdkBootstrapClosureVerified;
    await assert.rejects(
      producer.verifyCProducerReports(omitted, fixture.copies, profile, caller),
      /missing version3 original report manifest fields/,
    );
    const restored = await producer.verifyCProducerReports(
      fixture.value,
      fixture.copies,
      profile,
      caller,
    );
    assert.equal(restored.reports[0].counts.FAIL, 1);
    assert.equal(restored.gateAComplete, false);
  },
);

test(
  "C report source-bound Python ZIP replay refuses missing reordered forged and downgraded logical reports",
  control,
  async (t) => {
    assert.ok(caller && python);
    const fixture = await captured(t);
    const program = String.raw`
import copy,hashlib,importlib.util,json,os,pathlib,shutil,sys
repo=pathlib.Path(sys.argv[1]);root=pathlib.Path(sys.argv[2]);base_result=pathlib.Path(sys.argv[3]);source=pathlib.Path(sys.argv[4]);caller={'uid':os.getuid(),'gid':os.getgid()}
def module(name,path):
 spec=importlib.util.spec_from_file_location(name,path);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
r=module('actual_transport_replay',repo/'scripts/producer-qualification/c-producer-replay-evidence.py')
e=module('actual_transport_export',repo/'scripts/producer-qualification/c-producer-export-evidence.py')
collector=repo/'scripts/producer-qualification/c-producer-test-reports.py';current=[{'file':'scripts/producer-qualification/c-producer-test-reports.py',**r.pin(collector.read_bytes())}]
legacy=[{'file':'scripts/producer-qualification/c-producer-test-reports.py','bytes':18397,'sha256':'9dee7066707382c33ba971fe63ded57c407454c81ed38ab30aa66b95b558691c'}]
assert r.report_source_contract(current)=='gzip-chunks-v1' and r.report_source_contract(legacy)=='legacy-raw-v1'
controls=[]
def write(path,value):path.write_bytes(json.dumps(value).encode()+b'\n');path.chmod(0o600)
def packet(name,mutate=None,raw_legacy=False):
 case=root/name;case.mkdir();result=case/'result';shutil.copytree(base_result,result)
 manifest=result/'work/test-reports.json';value=json.loads(manifest.read_bytes())
 if raw_legacy:
  shutil.rmtree(result/'work/original-test-reports/encoded')
  files=[];directories={'.'}
  for row in [value['reports'][0],value['reports'][0]['log']]:
   row.pop('chunks');target=result/'work/original-test-reports'/row['file'];target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes((source/row['file']).read_bytes());target.chmod(0o600)
   parts=row['file'].split('/');directories.update('/'.join(parts[:n]) for n in range(1,len(parts)));files.append(row['file'])
  def owner(path,mode):
   info=path.stat();return {'uid':caller['uid'],'gid':caller['gid'],'mode':mode,'producerDevice':str(info.st_dev),'producerInode':str(info.st_ino)}
  custody=value['exportCustody'];custody['files']=[{'file':name,'ownership':owner(result/'work/original-test-reports'/name,0o600)}for name in files]
  custody['directories']=[]
  for name in sorted(directories):
   directory=result/'work/original-test-reports'/name;directory.chmod(0o700);custody['directories'].append({'directory':name,'ownership':owner(directory,0o700)})
  value['schemaVersion']=1;value.pop('encoding');value.pop('storedBytes')
 if mutate:mutate(value,result)
 write(manifest,value);startup=case/'startup.json';write(startup,{'state':'synthetic-report-component-not-native-qualification','caller':caller})
 for name in ['inputs','common']:(case/name).mkdir()
 archive=case/'reports.zip';e.export(repo,case/'inputs',case/'common',result,startup,archive,profile_name='glibc')
 return r.Packet(archive),value
prefix='result/work/original-test-reports'
def verify(name,mutation=None,reason=None,raw_legacy=False,pins=current):
 p,value=packet(name,mutation,raw_legacy)
 try:
  if reason is None:
   result=r.reports(p,prefix,p.json('result/work/test-reports.json',8*r.MIB),caller,caller['uid'],'glibc',pins);assert result['observedOutcomeLines']==3 and result['originalOutcomesPreserved'] is True
  else:
   try:r.reports(p,prefix,p.json('result/work/test-reports.json',8*r.MIB),caller,caller['uid'],'glibc',pins)
   except (RuntimeError,KeyError,OSError,ValueError) as error:assert reason in str(error),(name,str(error))
   else:raise AssertionError('Invalid transport qualified: '+name)
 finally:p.close()
 controls.append(name)
verify('valid-new')
verify('whole-report-last-yield',lambda v,_:v['reports'][0].update(sha256='0'*64),'whole original bytes/hash differ')
verify('whole-log-last-yield',lambda v,_:v['reports'][0]['log'].update(sha256='0'*64),'whole original bytes/hash differ')
verify('reordered',lambda v,_:v['reports'][0]['chunks'].reverse(),'Reordered or omitted C report physical chunks')
verify('forged-encoded-hash',lambda v,_:v['reports'][0]['log']['chunks'][-1].update(sha256='0'*64),'stored chunk bytes/hash differ')
verify('wrong-log-association',lambda v,_:v['reports'][0]['log'].update(file='build-tree/suite/other-valid.log'),'Associated original log identity differs')
def missing(v,result):
 row=v['reports'][0]['log']['chunks'][-1];(result/'work/original-test-reports'/row['file']).unlink()
verify('missing-physical-chunk',missing,'encoded/00000003.gz')
verify('known-legacy-valid',raw_legacy=True,pins=legacy)
verify('current-source-legacy-downgrade',raw_legacy=True,reason='Canonical C report collector source requires manifest schema3')
unknown=[{**current[0],'sha256':'f'*64}]
verify('unknown-source-legacy-downgrade',raw_legacy=True,pins=unknown,reason='Canonical C report collector source requires manifest schema3')
try:r.report_source_contract([{**legacy[0],'bytes':legacy[0]['bytes']+1}])
except ValueError as error:assert 'Historical C report collector byte length differs' in str(error)
else:raise AssertionError('Forged historical collector byte count admitted')
controls.append('historical-source-size-forgery')
print(json.dumps({'controls':controls,'actualPacketAndReportVerifier':True,'sameUidSyntheticOnly':True,'nativeLinuxCrossUidAcceptanceVerified':False,'modelCalls':0,'gateAComplete':False}))
`;
    const result = spawnSync(
      python,
      [
        "-I",
        "-S",
        "-B",
        "-c",
        program,
        repository,
        fixture.root,
        fixture.result,
        fixture.source,
      ],
      { encoding: "utf8", timeout: 60000, maxBuffer: 65536 },
    );
    assert.equal(result.status, 0, diagnostic(result));
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.controls.length, 11);
    assert.equal(observed.actualPacketAndReportVerifier, true);
    assert.equal(observed.sameUidSyntheticOnly, true);
    assert.equal(observed.nativeLinuxCrossUidAcceptanceVerified, false);
    assert.equal(observed.modelCalls, 0);
    assert.equal(observed.gateAComplete, false);
  },
);

test(
  "C report source selection and source rereads remain bounded across canonical FIFO inputs",
  control,
  async (t) => {
    assert.ok(python);
    const root = await mkdtemp(
      path.join(await realpath(os.tmpdir()), "ct-report-fifo-"),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const program = String.raw`
import importlib.util,json,os,pathlib,stat,sys,zipfile
repo=pathlib.Path(sys.argv[1]);root=pathlib.Path(sys.argv[2]);assert root.resolve()==root

def module(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

e=module('bounded_exporter_fifo',repo/'scripts/producer-qualification/c-producer-export-evidence.py')
r=module('bounded_replayer_fifo',repo/'scripts/producer-qualification/c-producer-replay-evidence.py')
controls=[]
fixture=root/'repo';file=fixture/'scripts/producer-qualification/c-producer-test-reports.py';file.parent.mkdir(parents=True)
os.mkfifo(file,0o600)
sys.stderr.write('canonical FIFO selector\n');sys.stderr.flush()
assert e.report_source_files(fixture)==e.SOURCE_FILES and stat.S_ISFIFO(file.lstat().st_mode)
controls.append('canonical-fifo-refused-before-blocking-open')
file.unlink();original=b'SYNTHETIC_SOURCE_METADATA = True\n';file.write_bytes(original);file.chmod(0o600);before=file.stat()
assert e.report_source_files(fixture)==e.SOURCE_FILES
assert file.read_bytes()==original and e.identity(file.stat())==e.identity(before)
controls.append('regular-unknown-source-near-miss-keeps-current-contract-and-bytes')
file.unlink();os.mkfifo(file,0o600)
for name in ['inputs','common','result']:(root/name).mkdir()
startup=root/'startup.json';startup.write_bytes(b'{"synthetic":true}\n');startup.chmod(0o600)
archive=root/'incomplete.zip';e.export(fixture,root/'inputs',root/'common',root/'result',startup,archive)
with zipfile.ZipFile(archive)as packet:manifest=json.loads(packet.read('manifest.json'))
assert any(row['file']=='source/scripts/producer-qualification/c-producer-test-reports.py' and row['errorClass']=='RuntimeError' and row['state']=='missing-inaccessible-or-outside-declared-bound' for row in manifest['unavailable'])
assert manifest['qualificationComplete'] is False and manifest['gateAComplete'] is False and stat.S_ISFIFO(file.lstat().st_mode)
controls.append('bad-source-export-retains-explicit-unavailable-state')
target=root/'tiny-source.mjs';expected=b'export const synthetic=true;\n';target.write_bytes(expected);target.chmod(0o600)
r.source_file_bytes(target,expected)
original_open=os.open;changed=False

def swap(path,flags,*args,**kwargs):
 global changed
 if pathlib.Path(path)==target and not changed:target.unlink();os.mkfifo(target,0o600);changed=True
 return original_open(path,flags,*args,**kwargs)

os.open=swap
try:
 sys.stderr.write('source-FD swap to FIFO\n');sys.stderr.flush()
 try:r.source_file_bytes(target,expected)
 except ValueError as error:assert 'Nonphysical current harness' in str(error)
 else:raise AssertionError('Swapped source FIFO admitted')
finally:os.open=original_open
assert changed and stat.S_ISFIFO(target.lstat().st_mode)
controls.append('replay-source-swap-refused-without-blocking')
target.unlink();target.write_bytes(expected);target.chmod(0o600)
r.source_file_bytes(target,expected);assert target.read_bytes()==expected
controls.append('restored-regular-source-bytes-remain-valid')
changed=False;os.open=swap
try:
 sys.stderr.write('export-FD swap to FIFO\n');sys.stderr.flush()
 try:e.export(fixture,root/'inputs',root/'common',root/'result',target,root/'raced.zip')
 except RuntimeError as error:assert 'C evidence member changed before export' in str(error)
 else:raise AssertionError('Swapped export FIFO admitted')
finally:os.open=original_open
assert changed and stat.S_ISFIFO(target.lstat().st_mode) and not(root/'raced.zip').exists()
controls.append('export-source-swap-refused-without-publication-or-blocking')
receipt_root=root/'receipt-case';receipt_root.mkdir();receipt=receipt_root/'receipt.json';receipt_raw=b'{"schemaVersion":1}\n';receipt.write_bytes(receipt_raw)
assert e.evidence_format(receipt_root)==(1,'schema1')
receipt_changed=False
def swap_receipt(path,flags,*args,**kwargs):
 global receipt_changed
 if pathlib.Path(path)==receipt and not receipt_changed:receipt.unlink();os.mkfifo(receipt,0o600);receipt_changed=True
 return original_open(path,flags,*args,**kwargs)
os.open=swap_receipt
try:
 sys.stderr.write('receipt-FD swap to FIFO\n');sys.stderr.flush()
 assert e.evidence_format(receipt_root)==(2,'unverified')
finally:os.open=original_open
assert receipt_changed and stat.S_ISFIFO(receipt.lstat().st_mode)
receipt.unlink();receipt.write_bytes(receipt_raw);assert e.evidence_format(receipt_root)==(1,'schema1')
controls.append('receipt-swap-stays-unverified-and-restored-regular-receipt-is-valid')
print(json.dumps({'controls':controls,'syntheticOnly':True,'sourceOrCompilerExecuted':False,'gateAComplete':False}))
`;
    const result = spawnSync(
      python,
      ["-I", "-S", "-B", "-c", program, repository, root],
      { encoding: "utf8", timeout: 8000, maxBuffer: 65536 },
    );
    assert.equal(result.error, undefined, diagnostic(result));
    assert.equal(result.status, 0, diagnostic(result));
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.controls.length, 7);
    assert.equal(observed.syntheticOnly, true);
    assert.equal(observed.sourceOrCompilerExecuted, false);
    assert.equal(observed.gateAComplete, false);
  },
);

test(
  "C report family recovery distinguishes empty namespaces from unmanifested files",
  control,
  async (t) => {
    const observation = await import(
      pathToFileURL(
        path.join(repository, "scripts/verify-c-producer-observation.mjs"),
      ).href
    );
    const root = await mkdtemp(
      path.join(await realpath(os.tmpdir()), "ct-report-empty-family-"),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const family = path.join(root, "original-test-reports");
    assert.equal(
      await observation.cObservationReportFamilyHasFiles(family),
      false,
    );
    await mkdir(path.join(family, "encoded/empty"), {
      recursive: true,
      mode: 0o700,
    });
    assert.equal(
      await observation.cObservationReportFamilyHasFiles(family),
      false,
    );
    await writeFile(path.join(family, "encoded/empty/unmanifested.gz"), "", {
      mode: 0o600,
    });
    assert.equal(
      await observation.cObservationReportFamilyHasFiles(family),
      true,
    );
    await rm(path.join(family, "encoded/empty/unmanifested.gz"));
    assert.equal(
      await observation.cObservationReportFamilyHasFiles(family),
      false,
    );
  },
);

test("C witnessed report families cannot disappear while an unwitnessed empty recovery namespace stays valid", async () => {
  const observation = await import(
    pathToFileURL(
      path.join(repository, "scripts/verify-c-producer-observation.mjs"),
    ).href
  );
  for (const schemaVersion of [2, 3]) {
    assert.throws(
      () =>
        observation.validateCObservationMissingReportFamily(
          { schemaVersion },
          "work/test-reports.json",
          false,
        ),
      /Original-trap raw report family was dropped/,
    );
    assert.equal(
      observation.validateCObservationMissingReportFamily(
        { schemaVersion },
        "work/post-stop-reports/test-reports.json",
        false,
      ),
      undefined,
    );
    assert.throws(
      () =>
        observation.validateCObservationMissingReportFamily(
          { schemaVersion, postStopRetention: {} },
          "work/post-stop-reports/test-reports.json",
          false,
        ),
      /Post-stop raw report family was dropped/,
    );
    assert.throws(
      () =>
        observation.validateCObservationMissingReportFamily(
          { schemaVersion },
          "work/post-stop-reports/test-reports.json",
          true,
        ),
      /Post-stop raw report family was dropped/,
    );
  }
});
