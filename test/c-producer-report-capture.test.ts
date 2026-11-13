import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const python = ["python3", "python"].find((name) => {
  const value = spawnSync(
    name,
    ["-I", "-S", "-B", "-c", "import sys;print(sys.version_info.major)"],
    { encoding: "utf8", timeout: 3000 },
  );
  return value.status === 0 && value.stdout.trim() === "3";
});
const options = {
  skip:
    process.platform === "win32"
      ? "POSIX capture custody controls unavailable"
      : python
        ? false
        : "Python3 original-report data collector unavailable",
};
const prelude = String.raw`
import gzip,hashlib,importlib.util,json,os,pathlib,re,sys,zlib
spec=importlib.util.spec_from_file_location('synthetic_original_capture',sys.argv[1]);c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
root=pathlib.Path(sys.argv[2]);caller=c.parse_caller_identity(str(os.geteuid()),str(os.getegid()));codec=c.report_codec();limits=codec.POLICY['limits'];chunk=limits['decodedChunkBytes']
def fingerprint(p):
 digest=hashlib.sha256()
 with p.open('rb')as f:
  while True:
   raw=f.read(chunk)
   if not raw:break
   digest.update(raw)
 return digest.hexdigest()
def source_state(source):
 return {p.relative_to(source).as_posix():((p.stat().st_dev,p.stat().st_ino,p.stat().st_mode,p.stat().st_uid,p.stat().st_gid,p.stat().st_nlink,p.stat().st_size,p.stat().st_mtime_ns,p.stat().st_ctime_ns),fingerprint(p)) for p in source.rglob('*') if p.is_file() and not p.is_symlink()}
def native_check(pin,retained):
 digest=hashlib.sha256();size=0
 for row in pin['chunks']:
  encoded=(retained/row['file']).read_bytes();assert len(encoded)==row['bytes'] and hashlib.sha256(encoded).hexdigest()==row['sha256'];decoder=zlib.decompressobj(31);raw=decoder.decompress(encoded,chunk+1);assert decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail and len(raw)==row['decodedBytes']<=chunk;assert hashlib.sha256(raw).hexdigest()==row['decodedSha256'];digest.update(raw);size+=len(raw)
 assert size==pin['bytes'] and digest.hexdigest()==pin['sha256']
def setup(name):
 source=root/name/'source';output=root/name/'output';(source/'build-tree').mkdir(parents=True);output.mkdir()
 (source/'build-tree/a.sum').write_bytes(b'PASS: first original\nFAIL: second original\n');(source/'build-tree/b.sum').write_bytes(b'UNSUPPORTED: second report\n')
 return source,output,source/'build-tree/a.log'
def manifest(output):return json.loads((output/'test-reports.json').read_bytes())
def failed(source,output,reason,file='build-tree/a.log'):
 try:c.collect('glibc',source,output/'test-reports.json',caller)
 except RuntimeError as error:
  text=str(error);assert '"file":"'+file+'"' in text and '"reason":"'+reason+'"' in text,text
 else:raise AssertionError('Failed capture produced complete evidence')
 assert not (output/'test-reports.json').exists();assert all(not p.name.startswith('.partial-') for p in output.rglob('*'))
`;
async function run(
  t: Parameters<typeof fixture>[0],
  program: string,
  timeout = 90000,
) {
  const root = await realpath(await fixture(t, {}));
  const value = spawnSync(
    python!,
    [
      "-I",
      "-S",
      "-B",
      "-c",
      prelude + program,
      path.join(
        repository,
        "scripts/producer-qualification/c-producer-test-reports.py",
      ),
      root,
    ],
    { encoding: "utf8", timeout, maxBuffer: 65536 },
  );
  assert.equal(
    value.status,
    0,
    [value.error?.message, value.signal, value.stdout, value.stderr]
      .filter(Boolean)
      .join("\n"),
  );
  return JSON.parse(value.stdout) as {
    controls: string[];
    originalProducerExecuted: false;
    decodedBytes?: number;
  };
}

test(
  "original C capture streams multiple chunks and files with mixed outcomes, a large original log and an explicit empty log",
  options,
  async (t) => {
    const value = await run(
      t,
      String.raw`
source=root/'source';output=root/'output';(source/'build/gcc/testsuite/gcc').mkdir(parents=True);(source/'build-jit/gcc').mkdir(parents=True);(source/'src').mkdir();output.mkdir()
raw=b'x'*(chunk-11)+b'\nPASS: one\r\nFAIL: two\rUNSUPPORTED: three\nPASS:near\nPASS:\n\n'
(source/'build/gcc/testsuite/gcc/gcc.sum').write_bytes(raw);log=source/'build/gcc/testsuite/gcc/gcc.log';pattern=b'original synthetic report log\n'*2048;remaining=64*1024**2+7
with log.open('wb')as f:
 while remaining:
  part=pattern[:min(remaining,len(pattern))];f.write(part);remaining-=len(part)
(source/'build-jit/gcc/jit.sum').write_bytes(b'FAIL: second original\nPASS: second control\n');(source/'build-jit/gcc/jit.log').write_bytes(b'');(source/'src/not-generated.sum').write_bytes(b'PASS: excluded source fixture\n')
before=source_state(source);c.collect('gcc-12',source,output/'test-reports.json',caller);v=manifest(output);closed=codec.validate_transport(v)
assert v['schemaVersion']==3 and len(v['reports'])==2 and len(closed['files'])==4 and len(closed['chunkFiles'])>2
first=v['reports'][0];assert first['counts']=={'PASS':2,'FAIL':1,'XFAIL':0,'XPASS':0,'UNSUPPORTED':1,'UNRESOLVED':0,'UNTESTED':0,'ERROR':0,'SKIP':0};assert first['totalLines']==7 and first['otherLines']==3
second=v['reports'][1];assert second['counts']['PASS']==1 and second['counts']['FAIL']==1 and second['totalLines']==2;assert second['log']['bytes']==0 and second['log']['chunks']==[] and second['log']['sha256']==hashlib.sha256(b'').hexdigest()
assert first['log']['bytes']==64*1024**2+7 and len(first['log']['chunks'])==65
for pin in closed['files']:native_check(pin,output/'original-test-reports');assert pin['sha256']==before[pin['file']][1]
assert source_state(source)==before;assert v['exportCustody']['newCopyOwnersVerified'] is True and v['exportCustody']['sourceTreePermissionsChanged'] is False
assert v['buildRootStates'][0]['state']=='present-with-reports' and v['buildRootStates'][2]['state']=='present-with-reports';assert all('src/' not in p['file'] for p in closed['files']);assert v['gateAComplete'] is False
print(json.dumps({'controls':['cross-chunk-CRLF-exact-outcomes','two-source-roots-four-logical-files','legacy64MiB-plus-seven-lossless','explicit-empty-associated-log','independent-native-gzip-whole-identities','original-modes-and-bytes-unchanged'],'decodedBytes':closed['decodedBytes'],'originalProducerExecuted':False}))
`,
    );
    assert.equal(value.controls.length, 6);
    assert.equal(value.originalProducerExecuted, false);
  },
);

test(
  "original C capture records precise FD and source failures without publishing complete or partial logical evidence",
  options,
  async (t) => {
    const value = await run(
      t,
      String.raw`
controls=[]
source,output,log=setup('oversized')
with log.open('wb')as f:f.truncate(limits['decodedFileBytes']+1)
original_open=c.os.open;opened=[]
def spy_open(file,*a,**k):
 if file==log:opened.append(file)
 return original_open(file,*a,**k)
c.os.open=spy_open
try:failed(source,output,'decoded-file-bytes-exceeded')
finally:c.os.open=original_open
assert not opened;controls.append('512MiB-plus-one-refused-before-source-open')
source,output,log=setup('link');outside=root/'outside';outside.write_bytes(b'unchanged');outside.chmod(0o600);before=outside.stat();log.symlink_to(outside);failed(source,output,'nonregular-source');assert outside.read_bytes()==b'unchanged' and outside.stat().st_mode==before.st_mode;controls.append('nonregular-link-target-untouched')
source,output,log=setup('missing');original_lstat=c.Path.lstat;removed=False
def disappearing(self,*a,**k):
 global removed
 if self==source/'build-tree/a.sum' and not removed:self.unlink();removed=True
 return original_lstat(self,*a,**k)
c.Path.lstat=disappearing
try:failed(source,output,'source-io-error','build-tree/a.sum')
finally:c.Path.lstat=original_lstat
controls.append('enumerated-source-disappearance')
for mutation in ['growth','swap','write-error','zero-write']:
 source,output,log=setup(mutation);log.write_bytes(os.urandom(chunk+19));initial=log.stat();read=c.os.read;write=c.os.write;requests=[];actual=[];changed=False;writes=0;write_fd=None
 def changed_read(fd,count):
  global changed
  info=os.fstat(fd);selected=(info.st_dev,info.st_ino)==(initial.st_dev,initial.st_ino)
  if selected:
   requests.append(count)
   if not changed:
    changed=True
    if mutation=='growth':
     with log.open('ab')as f:f.write(b'grew after fstat')
    elif mutation=='swap':
     replacement=log.with_name('replacement');replacement.write_bytes(log.read_bytes());replacement.replace(log)
  raw=read(fd,count)
  if selected:actual.append(len(raw))
  return raw
 def interrupted_write(fd,data):
  global writes,write_fd
  if mutation in ['write-error','zero-write']:
   if len(data)>100 and write_fd is None:write_fd=fd
   if fd==write_fd:
    writes+=1
    if mutation=='zero-write':return 0
    if writes==2:raise OSError(5,'synthetic second streamed-write interruption')
  return write(fd,data)
 c.os.read=changed_read;c.os.write=interrupted_write
 try:failed(source,output,{'growth':'source-size-changed','swap':'source-identity-changed','write-error':'copy-io-error','zero-write':'copy-failed'}[mutation])
 finally:c.os.read=read;c.os.write=write
 assert requests and max(requests)<=chunk and sum(actual)<=initial.st_size+1
 first=output/'original-test-reports/encoded/00000000.gz';assert gzip.decompress(first.read_bytes())==b'PASS: first original\nFAIL: second original\n' and first.stat().st_mode&0o7777==0o600
 if mutation in ['write-error','zero-write']:assert len(list((output/'original-test-reports/encoded').iterdir()))==1
 controls.append(mutation+'-actual-fault-refused-private-temp-clean')
print(json.dumps({'controls':controls,'originalProducerExecuted':False}))
`,
    );
    assert.equal(value.controls.length, 7);
    assert.equal(value.originalProducerExecuted, false);
  },
);

test(
  "original C capture enforces injected small budgets across real streams while preserving complete namespaces",
  options,
  async (t) => {
    const value = await run(
      t,
      String.raw`
controls=[];production_limits=dict(limits)
try:
 # Only this fresh private test-module instance has LOWER budgets. The pinned
 # policy file and decoder's independent production limits remain unchanged.
 limits.update(decodedFileBytes=4*chunk,decodedFamilyBytes=8*chunk,storedFamilyBytes=8*chunk)
 source,output,log=setup('injected-file-bound')
 with log.open('wb')as f:f.truncate(limits['decodedFileBytes'])
 (source/'build-tree/b.log').write_bytes(b'')
 c.collect('glibc',source,output/'test-reports.json',caller);v=manifest(output);closed=codec.validate_transport(v);assert v['reports'][0]['log']['bytes']==4*chunk;native_check(v['reports'][0]['log'],output/'original-test-reports');saved=(output/'test-reports.json').read_bytes();physical={p.relative_to(output).as_posix():fingerprint(p) for p in output.rglob('*') if p.is_file()};controls.append('injected4MiB-file-limit-real-native-roundtrip')
 failed_out=output.parent/'over-output';failed_out.mkdir()
 with log.open('ab')as f:f.write(b'X')
 failed(source,failed_out,'decoded-file-bytes-exceeded');assert (output/'test-reports.json').read_bytes()==saved and {p.relative_to(output).as_posix():fingerprint(p) for p in output.rglob('*') if p.is_file()}==physical;controls.append('injected-file-plus-one-keeps-prior-complete-cohort')
 source=root/'injected-family/source';output=root/'injected-family/output';(source/'build-tree').mkdir(parents=True);output.mkdir()
 for letter in 'ab':(source/('build-tree/'+letter+'.sum')).write_bytes(b'PASS: original\nFAIL: retained original\n')
 report_bytes=sum(p.stat().st_size for p in (source/'build-tree').glob('*.sum'))
 for letter in 'ab':
  with (source/('build-tree/'+letter+'.log')).open('wb')as f:f.truncate(4*chunk-(report_bytes if letter=='b'else 0))
 c.collect('glibc',source,output/'test-reports.json',caller);v=manifest(output);closed=codec.validate_transport(v);assert closed['decodedBytes']==8*chunk and len(closed['files'])==4;controls.append('injected8MiB-family-real-streamed-capture')
 failed_out=output.parent/'over-output';failed_out.mkdir()
 with (source/'build-tree/b.log').open('ab')as f:f.write(b'X')
 failed(source,failed_out,'decoded-family-bytes-exceeded','build-tree/b.log');controls.append('injected-family-plus-one-refused')
 limits['storedFamilyBytes']=2048
 source,output,log=setup('injected-encoded-bound');log.write_bytes(os.urandom(chunk+19))
 failed(source,output,'stored-family-bytes-exceeded');stored=sum(p.stat().st_size for p in (output/'original-test-reports').rglob('*.gz'));assert 0<stored<=2048;controls.append('injected2KiB-stored-budget-real-incompressible-overflow')
finally:
 limits.clear();limits.update(production_limits)
assert limits['decodedFileBytes']==536870912 and limits['decodedFamilyBytes']==2147483648 and limits['storedFamilyBytes']==536870912
print(json.dumps({'controls':controls,'originalProducerExecuted':False}))
`,
    );
    assert.equal(value.controls.length, 5);
    assert.equal(value.originalProducerExecuted, false);
  },
);
