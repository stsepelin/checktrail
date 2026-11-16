import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "../" : "../../", import.meta.url),
);
const python = ["python3", "python"].find(
  (program) =>
    spawnSync(
      program,
      [
        "-I",
        "-S",
        "-B",
        "-c",
        "import sys; assert sys.version_info.major == 3",
      ],
      { timeout: 3000 },
    ).status === 0,
);

test(
  "GLIBC failed diagnostics retain only exact inert original outputs with strict replay and bounded custody",
  {
    skip:
      !process.getuid || !process.getgid
        ? "POSIX custody unavailable"
        : !python
          ? "Python3 synthetic collector unavailable"
          : false,
  },
  async (t) => {
    assert.ok(python);
    const root = await mkdtemp(
      path.join(await realpath(os.tmpdir()), "ct-failed-diagnostics-"),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const result = spawnSync(
      python,
      [
        "-I",
        "-S",
        "-B",
        "-c",
        String.raw`import hashlib, importlib.util, json, os, pathlib, stat, sys, tempfile
repo, root = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
checks=[]
def module(name,filename):
 spec=importlib.util.spec_from_file_location(name,repo/'scripts/producer-qualification'/filename)
 value=importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value
c=module('collector','c-producer-test-reports.py'); r=module('replay','c-producer-replay-evidence.py'); e=module('exporter','c-producer-export-evidence.py')
caller={'uid':os.getuid(),'gid':os.getgid()}
def check(name,condition):
 assert condition,name
 checks.append(name)
def fixture(name,content=b'FAIL: nptl/tst-synthetic\n',extra=None):
 base=root/name; source=base/'source'; work=base/'result/work'; work.mkdir(parents=True,mode=0o700);os.chown(work,caller['uid'],caller['gid'])
 report=source/'build-tree/amd64-libc/nptl/subdir-tests.sum'; report.parent.mkdir(parents=True);report.write_bytes(content)
 for name,raw in (extra or {}).items():
  p=source/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(raw)
 return source,work,report
def capture(source,work):
 c.collect('glibc-u13',source,work/'test-reports.json',caller)
 return json.loads((work/'test-reports.json').read_bytes()),json.loads((work/'failed-test-diagnostics.json').read_bytes())
def outputs(value):return [item for test in value['tests'] for item in test['outputs']]
def originals(raw=b'inert-original\0bytes\n'):
 return {'build-tree/amd64-libc/nptl/tst-synthetic.out':raw,'build-tree/amd64-libc/nptl/tst-synthetic.test-result':b'FAIL: nptl/tst-synthetic\n'}
source,work,report=fixture('exact',b'FAIL: nptl/tst-synthetic\r\nXFAIL: nptl/expected\rPASS: nptl/passed\nFAILURE: nptl/fake\n', originals())
(source/'build-tree/amd64-libc/tests.sum').write_bytes(b'FAIL: nptl/tst-synthetic\n')
(source/'build-tree/i386-libc/nptl').mkdir(parents=True)
(source/'build-tree/i386-libc/nptl/subdir-tests.sum').write_bytes(b'ERROR: nptl/tst-synthetic\nUNRESOLVED: nptl/tst-other\n')
(source/'build-tree/i386-libc/nptl/tst-synthetic.out').write_bytes(b'another ABI')
(source/'build-tree/i386-libc/nptl/tst-synthetic.test-result').write_bytes(b'ERROR: nptl/tst-synthetic\n')
(source/'build-tree/amd64-libc/nptl/tst-synthetic-extra.out').write_bytes(b'near miss must not enter')
manifest,value=capture(source,work)
check('original-report-schema-and-fail-count-preserved',manifest['schemaVersion']==3 and sum(x['counts']['FAIL'] for x in manifest['reports'])==2)
check('exact-statuses-and-abi-namespaces',[(x['configuration'],x['testId']) for x in value['tests']]==[('build-tree/amd64-libc','nptl/tst-synthetic'),('build-tree/i386-libc','nptl/tst-other'),('build-tree/i386-libc','nptl/tst-synthetic')])
check('duplicate-overall-and-subdir-failures-deduplicated',len(value['tests'][0]['origins'])==2 and len(value['tests'])==3)
check('missing-outputs-explicit-incomplete',not value['diagnosticsComplete'] and sum(x['state']=='missing' for x in outputs(value))==2)
check('opaque-original-bytes-never-executed',all((work/'failed-test-diagnostics'/x['pin']['file']).read_bytes()==(source/x['sourceFile']).read_bytes() for x in outputs(value) if x['state']=='retained') and not (source/'executed').exists())
check('near-miss-name-and-passing-outcome-excluded',len(c.validate_failed_diagnostics(value))==4)
# A separate positive has two exact original outputs and no unresolved identifiers.
source2,work2,_=fixture('positive',extra=originals(b'#!/bin/sh\ntouch executed\n'))
manifest2,positive=capture(source2,work2)
check('complete-exact-pair',positive['diagnosticsComplete'] and positive['retainedBytes']==sum(p['bytes'] for p in c.validate_failed_diagnostics(positive)))
# The original stem limit excludes the two fixed diagnostic suffixes. Both
# boundary files physically fit NAME_MAX and must follow the same ID policy.
for length in [128,129]:
 stem='x'*length;extra={'build-tree/amd64-libc/nptl/'+stem+extension:('inert '+extension).encode() for extension in c.DIAGNOSTIC_EXTENSIONS}
 s,w,_=fixture('stem-%d'%length,('FAIL: nptl/'+stem+'\n').encode(),extra);_,v=capture(s,w)
 if length==128:
  check('128-byte-stem-both-suffixes-retained',v['diagnosticsComplete'] and len(c.validate_failed_diagnostics(v))==2 and all(item['state']=='retained' and (w/'failed-test-diagnostics'/item['pin']['file']).read_bytes()==extra[item['sourceFile']] for item in outputs(v)))
 else:
  assert not v['tests'] and len(v['unresolvedRecords'])==1 and not v['diagnosticsComplete'] and all((s/name).is_file() for name in extra)
  root_fd=os.open(s,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  try:
   for name in extra:
    try:c.open_diagnostic_source(root_fd,name)
    except RuntimeError as error:assert str(error)=='unsafe-source-path'
    else:raise AssertionError('overlong original stem opened')
  finally:os.close(root_fd)
  checks.append('129-byte-stem-both-suffixes-refused')

# Unsafe and overlong summary IDs are accounted without filesystem admission.
unsafe=b'FAIL: ../outside\nFAIL: /absolute\nFAIL: nptl/../../outside\nFAIL: nptl\\outside\nFAIL: nptl/tst-synthetic with extra words\nFAIL: '+b'x'*3000+b'\n'
s,w,_=fixture('unsafe',unsafe,originals());_,v=capture(s,w)
check('unsafe-and-unrecognized-identifiers-refused',not v['tests'] and len(v['unresolvedRecords'])==6 and not v['diagnosticsComplete'])
# Prefix boundaries and CR/LF chunk boundaries are exact.
row={'file':'build-tree/amd64-libc/tests.sum','format':'original-sum'}
sel=c.failed_diagnostic_selection('glibc',[row],lambda row:iter([b'FAIL: nptl/tst-synthetic\r',b'\nERROR: nptl/tst-error\rUNRES',b'OLVED: nptl/tst-unresolved']))
check('chunk-split-crlf-and-status-preserved',len(sel['tests'])==3 and sum(len(x['origins']) for x in sel['tests'])==3)
sel=c.failed_diagnostic_selection('glibc',[row],lambda row:iter([b'FAIL:\vunsafe\nERROR:\funrecognized\n']))
check('every-counted-failure-prefix-accounted',len(sel['unresolvedRecords'])==2 and not sel['tests'])
for name,stream in [
 ('selection-record-ceiling',lambda:iter([b'FAIL: nptl/tst-synthetic\n'*4097])),
 ('selection-test-ceiling',lambda:iter([b''.join(('FAIL: nptl/tst-%04d\n'%i).encode() for i in range(513))])),
 ('selection-summary-byte-ceiling',lambda:iter([b'x'*1024**2]*17))]:
 try:c.failed_diagnostic_selection('glibc',[row],lambda row:stream())
 except RuntimeError:checks.append(name)
 else:raise AssertionError(name+' was not enforced')

for kind in ['symlink','directory','fifo','hardlink','parent-link','oversize','changed']:
 s,w,_=fixture(kind,extra=originals()); out=s/'build-tree/amd64-libc/nptl/tst-synthetic.out'
 outside=root/(kind+'-outside');outside.mkdir();(outside/'tst-synthetic.out').write_bytes(b'outside must not be read')
 if kind=='symlink':out.unlink();out.symlink_to(outside/'tst-synthetic.out')
 if kind=='directory':out.unlink();out.mkdir()
 if kind=='fifo':out.unlink();os.mkfifo(out)
 if kind=='hardlink':out.unlink();os.link(outside/'tst-synthetic.out',out)
 if kind=='parent-link':
  old=out.parent;old.rename(old.with_name('retained-original'));old.symlink_to(outside,target_is_directory=True)
 if kind=='oversize':
  with out.open('wb') as handle:handle.truncate(c.DIAGNOSTIC_LIMITS['fileBytes']+1)
 if kind=='changed':
  out.with_suffix('.test-result').unlink()
  original_read=c.os.read;target_inode=out.stat().st_ino;changed=[False]
  def changed_read(fd,n):
   raw=original_read(fd,n)
   if os.fstat(fd).st_ino==target_inode and not changed[0]:
    changed[0]=True
    with out.open('ab') as handle:handle.write(b'mutated')
   return raw
  c.os.read=changed_read
 try:_,v=capture(s,w)
 finally:
  if kind=='changed':c.os.read=original_read
 if kind=='changed':changed_work,changed_reports=w,_
 state=v['tests'][0]['outputs'][0]
 check(kind+'-source-refused',state['state']=='refused' and not v['diagnosticsComplete'] and not any(x['file'].endswith('.out') for x in c.validate_failed_diagnostics(v)))
# Family ceiling is independent of the existing report transport ceiling.
content=b''.join(('FAIL: nptl/tst-%02d\n'%i).encode() for i in range(17))
s,w,_=fixture('aggregate',content)
for i in range(17):
 for ext in c.DIAGNOSTIC_EXTENSIONS:
  p=s/('build-tree/amd64-libc/nptl/tst-%02d%s'%(i,ext))
  with p.open('wb') as h:
   if ext=='.out':h.truncate(c.DIAGNOSTIC_LIMITS['fileBytes'])
_,v=capture(s,w)
check('diagnostic-family-byte-ceiling-enforced',v['retainedBytes']==c.DIAGNOSTIC_LIMITS['totalBytes'] and any(x.get('reason')=='total-byte-bound-exceeded' for x in outputs(v)) and not v['diagnosticsComplete'])
# Replay uses the same inert IDs, original manifest hash, exact inventory and custody.
class Packet:
 def __init__(self,work):
  self.root=work.parent;self.files={};self.directories={}
  for file in self.root.rglob('*'):
   if file.is_file():self.files['result/'+file.relative_to(self.root).as_posix()]={'bytes':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()}
   elif file.is_dir():self.directories['result/'+file.relative_to(self.root).as_posix()]={}
 def read(self,name,maximum):
  raw=(self.root/name.removeprefix('result/')).read_bytes();assert len(raw)<=maximum;return raw
 def json(self,name,maximum):return json.loads(self.read(name,maximum))
 def custody(self,name,owner,directory=False):
  p=self.root/name.removeprefix('result/');st=p.stat();assert st.st_uid==owner['uid'] and st.st_gid==owner['gid'] and stat.S_IMODE(st.st_mode)==(0o700 if directory else 0o600)
# Mutate only the new first-party verifier's empty-directory guard. No target
# diagnostic content or historical implementation is executed.
replay_file=repo/'scripts/producer-qualification/c-producer-replay-evidence.py';replay_source=replay_file.read_text()
new_guard="require('.' in directories and set(directories) <= {'.','files'} and (not pins or 'files' in directories), 'Failed diagnostic ancestor custody differs')"
old_guard="require(set(directories) == ({'.','files'} if pins else {'.'}), 'Failed diagnostic ancestor custody differs')"
assert replay_source.count(new_guard)==1
old_namespace={'__name__':'synthetic_previous_diagnostic_guard','__file__':str(replay_file)}
exec(compile(replay_source.replace(new_guard,old_guard),'<synthetic-previous-diagnostic-guard>','exec'),old_namespace)
try:old_namespace['failed_test_diagnostics'](Packet(changed_work),'result/work/original-test-reports',changed_reports,caller,os.geteuid(),'glibc-u13')
except ValueError as error:
 assert str(error)=='Failed diagnostic ancestor custody differs'
 checks.append('previous-empty-directory-guard-reproduced')
else:raise AssertionError('previous guard did not reproduce valid-custody refusal')
partial=r.failed_test_diagnostics(Packet(changed_work),'result/work/original-test-reports',changed_reports,caller,os.geteuid(),'glibc-u13')
check('empty-owned-copy-directory-remains-incomplete',partial['state']=='incomplete' and partial['retainedFiles']==0 and not partial['diagnosticsComplete'])
packet=Packet(work2)
observed=r.failed_test_diagnostics(packet,'result/work/original-test-reports',manifest2,caller,os.geteuid(),'glibc-u13')
check('positive-replay-retains-failing-outcome',observed['state']=='retained' and observed['diagnosticsComplete'] and observed['originalOutcomesChanged'] is False and manifest2['reports'][0]['counts']['FAIL']==1)
companion=work2/'failed-test-diagnostics.json';raw_companion=companion.read_bytes()
def rejected(name,mutate):
 value=json.loads(raw_companion);mutate(value);companion.write_bytes(json.dumps(value).encode())
 try:
  r.failed_test_diagnostics(Packet(work2),'result/work/original-test-reports',manifest2,caller,os.geteuid(),'glibc-u13')
 except (RuntimeError,ValueError,AssertionError):checks.append(name)
 else:raise AssertionError(name+' unexpectedly admitted')
 finally:companion.write_bytes(raw_companion);companion.chmod(0o600)
rejected('changed-report-manifest-pin-refused',lambda v:v['sourceReportManifest'].update(sha256='0'*64))
rejected('invented-selected-test-refused',lambda v:v['tests'][0].update(testId='nptl/tst-invented'))
rejected('unknown-diagnostic-fields-refused',lambda v:v.update(rawOutput='synthetic'))
rejected('forged-completeness-refused',lambda v:v.update(diagnosticsComplete=False))
rejected('forged-owner-refused',lambda v:v['exportCustody']['files'][0]['ownership'].update(uid=caller['uid']+1))
first=positive['tests'][0]['outputs'][0]['pin']['file'];target=work2/'failed-test-diagnostics'/first;original=target.read_bytes();target.write_bytes(b'changed')
try:
 try:r.failed_test_diagnostics(Packet(work2),'result/work/original-test-reports',manifest2,caller,os.geteuid(),'glibc-u13')
 except (RuntimeError,ValueError):checks.append('changed-original-diagnostic-bytes-refused')
 else:raise AssertionError('changed bytes admitted')
finally:target.write_bytes(original);target.chmod(0o600)
packet=Packet(work2);packet.files.pop('result/work/failed-test-diagnostics.json')
try:r.failed_test_diagnostics(packet,'result/work/original-test-reports',manifest2,caller,os.geteuid(),'glibc-u13')
except (RuntimeError,ValueError):checks.append('orphan-diagnostic-bytes-refused')
else:raise AssertionError('orphan bytes admitted')
packet=Packet(work2);packet.files={k:v for k,v in packet.files.items() if '/failed-test-diagnostics' not in k}
old=r.failed_test_diagnostics(packet,'result/work/original-test-reports',manifest2,caller,os.geteuid(),'glibc-u13')
check('historical-absence-remains-unavailable',old['state']=='unavailable' and not old['diagnosticsComplete'])
# Export real retained members with their hashes; no compiler/subprocess executes.
base=work2.parent.parent;inputs=base/'inputs';common=base/'common';inputs.mkdir();common.mkdir();startup=base/'startup.json';startup.write_text('{}')
archive=base/'evidence.zip';e.export(repo,inputs,common,work2.parent,startup,archive,profile_name='glibc-u13')
import zipfile
with zipfile.ZipFile(archive) as z:
 exported=json.loads(z.read('manifest.json'));names=set(z.namelist())
 check('export-includes-companion-and-exact-inert-originals','result/work/failed-test-diagnostics.json' in names and all('result/work/failed-test-diagnostics/'+x['file'] in names for x in c.validate_failed_diagnostics(positive)))
 check('export-family-counts-include-diagnostics',exported['originalReportLogBytes']==sum(x['bytes'] for x in exported['rawFiles'] if x['file'].startswith(('result/work/original-test-reports/','result/work/failed-test-diagnostics/'))))
 # Packet's initial bounded transport admission is independent of successful build qualification.
 packet=r.Packet(archive);packet.close();checks.append('exported-archive-bounded-admission')
print(json.dumps({'checks':checks,'count':len(checks),'upstreamCompilerOrProjectExecution':False}))
`,
        repository,
        root,
      ],
      { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 },
    );
    assert.equal(
      result.status,
      0,
      [result.error?.message, result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n"),
    );
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.upstreamCompilerOrProjectExecution, false);
    assert.equal(observed.count, 37);
    assert.deepEqual(observed.checks, [
      "original-report-schema-and-fail-count-preserved",
      "exact-statuses-and-abi-namespaces",
      "duplicate-overall-and-subdir-failures-deduplicated",
      "missing-outputs-explicit-incomplete",
      "opaque-original-bytes-never-executed",
      "near-miss-name-and-passing-outcome-excluded",
      "complete-exact-pair",
      "128-byte-stem-both-suffixes-retained",
      "129-byte-stem-both-suffixes-refused",
      "unsafe-and-unrecognized-identifiers-refused",
      "chunk-split-crlf-and-status-preserved",
      "every-counted-failure-prefix-accounted",
      "selection-record-ceiling",
      "selection-test-ceiling",
      "selection-summary-byte-ceiling",
      "symlink-source-refused",
      "directory-source-refused",
      "fifo-source-refused",
      "hardlink-source-refused",
      "parent-link-source-refused",
      "oversize-source-refused",
      "changed-source-refused",
      "diagnostic-family-byte-ceiling-enforced",
      "previous-empty-directory-guard-reproduced",
      "empty-owned-copy-directory-remains-incomplete",
      "positive-replay-retains-failing-outcome",
      "changed-report-manifest-pin-refused",
      "invented-selected-test-refused",
      "unknown-diagnostic-fields-refused",
      "forged-completeness-refused",
      "forged-owner-refused",
      "changed-original-diagnostic-bytes-refused",
      "orphan-diagnostic-bytes-refused",
      "historical-absence-remains-unavailable",
      "export-includes-companion-and-exact-inert-originals",
      "export-family-counts-include-diagnostics",
      "exported-archive-bounded-admission",
    ]);
  },
);
