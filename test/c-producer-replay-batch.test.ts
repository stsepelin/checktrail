import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const python = ["python3", "python"].find((name) => {
  const result = spawnSync(
    name,
    ["-I", "-S", "-B", "-c", "import sys; print(sys.version_info.major)"],
    {
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 65536,
    },
  );
  return (
    !result.error &&
    result.status === 0 &&
    result.signal === null &&
    result.stdout.trim() === "3"
  );
});

test(
  "C source replay batches ordered Git objects with physical byte, framing, pipe and deadline guards",
  {
    skip: python
      ? false
      : "Verified Python3 source replay controls unavailable",
  },
  async (t) => {
    const root = await realpath(await fixture(t, {}));
    const program = String.raw`
import copy,errno,hashlib,importlib.util,io,json,os,pathlib,subprocess,sys,threading,time,unittest
from unittest import mock
repo=pathlib.Path(sys.argv[1]);root=pathlib.Path(sys.argv[2])
spec=importlib.util.spec_from_file_location('source_replay',repo/'scripts/producer-qualification/c-producer-replay-evidence.py');r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
def frame(body,kind=b'blob',oid=None,size=None):
 return (oid or hashlib.sha1(b'blob '+str(len(body)).encode()+b'\0'+body).hexdigest().encode())+b' '+kind+b' '+(str(len(body)).encode()if size is None else size)+b'\n'+body+b'\n'
class Controls(unittest.TestCase):
 def setUp(self):
  self.directory=root/self._testMethodName;self.directory.mkdir();self.children=[]
 def child(self,body,request=b'',limit=4096,timeout=5):
  real=r.subprocess.Popen
  def start(*args,**kwargs):
   process=real(*args,**kwargs);self.children.append(process);return process
  with mock.patch.object(r.subprocess,'Popen',side_effect=start):
   return r.bounded_git_output(self.directory,[sys.executable,'-I','-S','-B','-c',body],request,limit,timeout)
 def tearDown(self):
  for child in self.children:
   self.assertIsNotNone(child.poll(),'bounded metadata child was not reaped')
 def test_valid_binary_and_empty_blob_frames(self):
  bodies=[b'first\n\0body',b''];r.source_batch_frames(b''.join(frame(b)for b in bodies),bodies)
 def test_missing_or_oversized_header_refuses(self):
  for raw in [b'no-newline',b'a'*128+b'\n']:
   with self.subTest(raw=raw):
    with self.assertRaisesRegex(ValueError,'header is incomplete or over bound'):r.source_batch_frames(raw,[b''])
 def test_exact_blob_type_canonical_size_and_oid_are_required(self):
  for raw in [frame(b'x',kind=b'tree'),frame(b'x',size=b'01'),frame(b'x',size=b'-1'),frame(b'x',size=b'2097153'),frame(b'x',oid=b'A'*40)]:
   with self.subTest(raw=raw):
    with self.assertRaisesRegex(ValueError,'header type/framing|object is absent or over bound'):r.source_batch_frames(raw,[b'x'])
  with self.assertRaisesRegex(ValueError,'object identity/order'):r.source_batch_frames(frame(b'x',oid=b'0'*40),[b'x'])
 def test_body_bytes_are_checked_separately_from_header(self):
  raw=frame(b'abc');raw=raw.replace(b'\nabc\n',b'\nabd\n')
  with self.assertRaisesRegex(ValueError,'not the original committed object'):r.source_batch_frames(raw,[b'abc'])
 def test_separator_truncation_and_trailing_objects_refuse(self):
  for raw in [frame(b'abc')[:-1],frame(b'abc')[:-2],frame(b'abc')[:-1]+b'x']:
   with self.subTest(raw=raw):
    with self.assertRaises(ValueError):r.source_batch_frames(raw,[b'abc'])
  for raw in [frame(b'abc')+b'x',frame(b'abc')+frame(b'')]:
   with self.subTest(raw=raw):
    with self.assertRaisesRegex(ValueError,'trailing or extra objects'):r.source_batch_frames(raw,[b'abc'])
 def test_object_order_and_count_are_checked(self):
  with self.assertRaisesRegex(ValueError,'identity/order'):r.source_batch_frames(frame(b'b')+frame(b'a'),[b'a',b'b'])
  with self.assertRaisesRegex(ValueError,'header is incomplete'):r.source_batch_frames(frame(b'a'),[b'a',b'b'])
 def test_actual_pipes_write_all_request_bytes_and_keep_complete_output(self):
  raw=self.child("import os,sys; b=sys.stdin.buffer.read(); assert b==b'one\\ntwo\\n'; os.write(2,b'bounded diagnostic'); os.write(1,b'complete')",b'one\ntwo\n',8)
  self.assertEqual(raw,b'complete')
 def test_first_zero_progress_stdin_write_refuses_and_reaps(self):
  real=r.os.write;attempts=[]
  def write(fd,body):
   if not attempts:attempts.append(True);return 0
   return real(fd,body)
  with mock.patch.object(r.os,'write',side_effect=write):
   with self.assertRaisesRegex(ValueError,'stdin made no progress'):self.child("import sys; sys.stdin.buffer.read(); sys.stdout.buffer.write(b'complete')",b'one',8)
  self.assertEqual(len(attempts),1)
 def test_actual_stdout_overflow_refuses_and_reaps(self):
  with self.assertRaisesRegex(ValueError,'stdout byte limit'):self.child("import os,time; os.write(1,b'x'*4096); time.sleep(10)",limit=8)
 def test_actual_stderr_overflow_refuses_and_reaps(self):
  with self.assertRaisesRegex(ValueError,'stderr byte limit'):self.child("import os,time; os.write(2,b'x'*70000); time.sleep(10)")
 def test_actual_deadline_refuses_valid_prefix_and_reaps_workers(self):
  before={thread.ident for thread in threading.enumerate()};start=time.monotonic()
  with self.assertRaisesRegex(ValueError,'operation deadline'):self.child("import os,time; os.write(1,b'valid-prefix'); time.sleep(10)",timeout=0.08)
  self.assertLess(time.monotonic()-start,1.5);self.assertEqual({thread.ident for thread in threading.enumerate()},before)
 def test_actual_nonzero_retains_original_stderr(self):
  with self.assertRaisesRegex(ValueError,'synthetic Git failure'):self.child("import os; os.write(2,b'synthetic Git failure'); raise SystemExit(3)")
 def test_spawn_and_thread_start_failures_preserve_primary(self):
  with mock.patch.object(r.subprocess,'Popen',side_effect=OSError('synthetic spawn failure')):
   with self.assertRaisesRegex(OSError,'synthetic spawn failure'):r.bounded_git_output(self.directory,['synthetic'],b'',8)
  real=r.subprocess.Popen
  def start(*args,**kwargs):
   child=real(*args,**kwargs);self.children.append(child);return child
  with mock.patch.object(r.subprocess,'Popen',side_effect=start),mock.patch.object(r.threading.Thread,'start',side_effect=RuntimeError('synthetic thread start failure')):
   with self.assertRaisesRegex(RuntimeError,'synthetic thread start failure'):r.bounded_git_output(self.directory,[sys.executable,'-I','-S','-B','-c','import time; time.sleep(10)'],b'',8)
 def test_current_regular_bytes_and_empty_file_are_valid_near_misses(self):
  for name,body in [('one',b'abc'),('empty',b'')]:
   file=self.directory/name;file.write_bytes(body);r.source_file_bytes(file,body)
 def test_growing_current_file_reads_only_length_plus_one(self):
  file=self.directory/'source';file.write_bytes(b'abc');real=r.os.read;observed=[];grew=[]
  def read(fd,count):
   if not grew:
    with file.open('ab')as out:out.write(b'z'*131072)
    grew.append(True)
   raw=real(fd,count);observed.append((count,len(raw)));return raw
  with mock.patch.object(r.os,'read',side_effect=read):
   with self.assertRaisesRegex(ValueError,'Stale or changed original source/harness bytes'):r.source_file_bytes(file,b'abc')
  self.assertEqual(observed,[(4,4)])
 def test_changed_named_source_identity_is_refused(self):
  file=self.directory/'source';file.write_bytes(b'abc');real=r.os.read;changed=[]
  def read(fd,count):
   body=real(fd,count)
   if not changed:os.utime(file,ns=(1,1));changed.append(True)
   return body
  with mock.patch.object(r.os,'read',side_effect=read):
   with self.assertRaisesRegex(ValueError,'source/harness identity'):r.source_file_bytes(file,b'abc')
 def test_current_read_primary_survives_secondary_close_failure(self):
  file=self.directory/'source';file.write_bytes(b'abc');real=r.os.close;closed=[]
  def close(fd):real(fd);closed.append(fd);raise OSError('synthetic secondary close')
  with mock.patch.object(r.os,'read',side_effect=OSError('synthetic primary read')),mock.patch.object(r.os,'close',side_effect=close):
   with self.assertRaisesRegex(OSError,'synthetic primary read')as error:r.source_file_bytes(file,b'abc')
  self.assertEqual(str(error.exception.__cause__),'synthetic secondary close');self.assertEqual(len(closed),1)
  with self.assertRaises(OSError)as missing:os.fstat(closed[0])
  self.assertEqual(missing.exception.errno,errno.EBADF)
 def test_pending_eperm_probe_schema_keeps_exact_types_and_bounds(self):
  value={'operation':'signal-zero','code':'EPERM','count':1,'absenceInferred':False,'signallingAuthorized':False};r.pending_group_probes(value);r.pending_group_probes({**value,'count':20000})
  for key,bad in [('count',0),('count',20001),('count',True),('count',1.0),('code','ESRCH'),('absenceInferred',0),('signallingAuthorized',0),('absenceInferred',True),('operation','signal')]:
   with self.subTest(key=key,bad=bad):
    with self.assertRaisesRegex(ValueError,'Invalid pending carrier'):r.pending_group_probes({**value,key:bad})
  with self.assertRaisesRegex(ValueError,'Invalid pending carrier'):r.pending_group_probes({**value,'extra':False})
 def test_real_git_batch_keeps_head_current_pins_order_and_original_blob(self):
  source=self.directory/'repository';source.mkdir();bodies={'one.txt':b'one\n','two.txt':b'two\n'}
  for name,body in bodies.items():(source/name).write_bytes(body)
  env=dict(os.environ);env.update(SKIP_CODEX_REVIEW='1',GIT_CONFIG_NOSYSTEM='1',GIT_CONFIG_GLOBAL=os.devnull)
  git=['git','-c','core.hooksPath='+os.devnull,'-c','core.fsmonitor=false','-c','commit.gpgsign=false']
  for args in [['init','--quiet'],['add','--',*bodies],['-c','user.name=Synthetic Frame','-c','user.email=synthetic@example.invalid','commit','--quiet','-m','Synthetic source frame']]:
   child=subprocess.run(git+args,cwd=source,env=env,capture_output=True,timeout=5);self.assertEqual(child.returncode,0,child.stderr)
  head=subprocess.check_output(git+['rev-parse','HEAD'],cwd=source,env=env).decode().strip()
  class Packet:
   def read(self,name,limit):
    self_outer.assertEqual(limit,2*r.MIB);return bodies[name.removeprefix('source/')]if hasattr(name,'removeprefix')else bodies[name[len('source/'):]]
  self_outer=self;startup={'gitHead':head,'sourcePins':[{'file':name,**r.pin(body)}for name,body in bodies.items()]};actual=r.bounded_git_output;calls=[]
  def observed(*args,**kwargs):calls.append(args);return actual(*args,**kwargs)
  with mock.patch.object(r,'SOURCE_FILES',list(bodies)),mock.patch.object(r,'bounded_git_output',side_effect=observed):
   self.assertEqual(r.source_frame(Packet(),source,startup)['exactOriginalGitSourcePins'],2)
   self.assertEqual([c[1][-2:]for c in calls],[['rev-parse','HEAD'],['cat-file','--batch']]);self.assertEqual(calls[1][2],b''.join((head+':'+name+'\n').encode()for name in bodies));self.assertEqual(calls[1][3],sum(len(b)+129 for b in bodies.values()))
   calls.clear();bad=copy.deepcopy(startup);bad['sourcePins'].reverse()
   with self.assertRaisesRegex(ValueError,'Incomplete source/harness inventory'):r.source_frame(Packet(),source,bad)
   self.assertEqual(calls,[])
   with self.assertRaisesRegex(ValueError,'checkout does not match'):r.source_frame(Packet(),source,{**startup,'gitHead':'0'*40})
   bad=copy.deepcopy(startup);bad['sourcePins'][0]['sha256']='0'*64
   with self.assertRaisesRegex(ValueError,'source/harness bytes'):r.source_frame(Packet(),source,bad)
   bodies['one.txt']=b'ONE\n';(source/'one.txt').write_bytes(bodies['one.txt']);changed={'gitHead':head,'sourcePins':[{'file':name,**r.pin(body)}for name,body in bodies.items()]}
   with self.assertRaisesRegex(ValueError,'object identity/order'):r.source_frame(Packet(),source,changed)
names=unittest.defaultTestLoader.getTestCaseNames(Controls);log=io.StringIO();result=unittest.TextTestRunner(stream=log,verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Controls))
if not result.wasSuccessful():print(log.getvalue(),file=sys.stderr);raise SystemExit(1)
assert result.testsRun==len(names) and not result.skipped
print(json.dumps({'controlsPassed':result.testsRun,'names':names,'skipped':0,'originalZipMutationCasesUnchanged':True,'producerBudgetsChanged':False}))
`;
    const result = spawnSync(
      python!,
      ["-I", "-S", "-B", "-c", program, repository, root],
      {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 65536,
      },
    );
    assert.equal(
      result.status,
      0,
      [result.error?.message, result.signal, result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n"),
    );
    const names = Array.from(
      program.matchAll(/^ def (test_[a-z_]+)\(/gmu),
      (match) => match[1],
    ).sort();
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed, {
      controlsPassed: names.length,
      names,
      skipped: 0,
      originalZipMutationCasesUnchanged: true,
      producerBudgetsChanged: false,
    });
  },
);
