"""Real first-party children and explicit ownership near misses; no SDK code."""
from pathlib import Path
import hashlib,io,json,os,platform,resource,select,signal,subprocess,sys,tempfile,time,unittest
from unittest import mock
sys.path.insert(0,str(Path(__file__).resolve().parent))
import process_supervisor as N

OBSERVATIONS=[]
def firstparty(code):return [sys.executable,'-I','-c',code]
def live_family(payload):
 return "import os,signal,subprocess,sys,time\nchild=subprocess.Popen([sys.executable,'-I','-c','import time;time.sleep(5)'])\ndef stop(*args):\n child.terminate()\n child.wait(timeout=2)\n sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\nos.write(1,"+repr(payload)+")\nchild.wait()\n"

class LifecycleTests(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve();self.counter=0
 def tearDown(self):self.tmp.cleanup()
 def host(self):
  profile='synthetic-first-party-no-network';return {'buildUid':os.getuid()+1000000,'buildUser':'synthetic-not-used-as-build','qualifiedNetworkProfile':profile,'operatorQualifiedNetworkProfileSHA256':hashlib.sha256(profile.encode()).hexdigest(),'networkIPCProbeQualified':True}
 def native(self,code,expected=None,seconds=5,logcap=64):
  self.counter+=1;work=self.root/('native-'+str(self.counter));(work/'capture').mkdir(parents=True)
  limits={**N.LIMITS,'minimumFreeBytes':0,'logBytes':logcap,'sampledRssBytes':1024**3,'wholeSeconds':30}
  with mock.patch.dict(N.LIMITS,limits),mock.patch.object(N,'ps_rows',return_value=[]):
   instance=N.Native(work,self.host())
   if expected:
    with self.assertRaisesRegex(ValueError,expected):instance.run('firstparty',firstparty(code),{'PATH':'/usr/bin:/bin'},work,seconds,as_build=False)
   else:instance.run('firstparty',firstparty(code),{'PATH':'/usr/bin:/bin'},work,seconds,as_build=False)
  record=json.loads((work/'capture/PHASES.json').read_bytes())[0];OBSERVATIONS.append({'scope':'Native.run','record':record});return record
 def query(self,code,expected=None,seconds=5):
  self.counter+=1;work=self.root/('query-'+str(self.counter));work.mkdir()
  if expected:
   with self.assertRaisesRegex(ValueError,expected):N.capture_control_query(work,'firstparty',firstparty(code),{'PATH':'/usr/bin:/bin'},seconds)
  else:result=N.capture_control_query(work,'firstparty',firstparty(code),{'PATH':'/usr/bin:/bin'},seconds);self.assertEqual(0,result[0])
  record=json.loads((work/'firstparty.json').read_bytes());OBSERVATIONS.append({'scope':'capture_control_query','record':record});return record
 def settled(self,record):
  cleanup=record['ownedProcessCleanup'];self.assertTrue(cleanup['leaderReaped']);self.assertTrue(cleanup['groupAbsent']);self.assertEqual([],record.get('unreapedBuildUidProcesses',[]));return cleanup
 def test_native_fast_zero_is_reaped_and_never_signaled_after_wait(self):
  with mock.patch.object(N.os,'killpg',side_effect=AssertionError('no group signal after reap')):r=self.native("print('synthetic')")
  c=self.settled(r);self.assertTrue(r['success']);self.assertTrue(c['complete']);self.assertEqual(0,c['returncodeAtEntry']);self.assertEqual([],c['signals'])
 def test_capture_fast_zero_is_reaped_and_never_signaled_after_wait(self):
  with mock.patch.object(N.os,'killpg',side_effect=AssertionError('no group signal after reap')):r=self.query("print('synthetic')")
  c=self.settled(r);self.assertTrue(c['complete']);self.assertEqual(0,c['returncodeAtEntry']);self.assertEqual([],c['signals'])
 def test_native_real_fast_overflow_repeats_keep_log_guard_and_original_failure(self):
  for _ in range(8):
   r=self.native("import os;os.write(1,b'x'*1000);os._exit(0)",'log ceiling');c=self.settled(r);self.assertFalse(r['success']);self.assertEqual('ValueError',r['primaryFailure']['type']);self.assertIn('log ceiling',r['primaryFailure']['reason']);self.assertEqual(64,r['log']['bytes']);self.assertGreater(r['aggregateReachedLogBytes'],64);self.assertIsNone(c['returncodeAtEntry'])
 def test_capture_real_fast_child_deadline_never_becomes_a_cleanup_error(self):
  for _ in range(5):
   r=self.query("import os;os.write(1,b'synthetic');os._exit(0)",'deadline',seconds=.0001);self.settled(r);self.assertIsNotNone(r['primaryFailure']);self.assertLessEqual(r['streams'][0]['bytes'],65536)
 def test_native_two_live_same_session_processes_are_observed_and_reaped(self):
  # This busy ambient UID cannot necessarily fork after NPROC is lowered.
  # Construct two real actors first, then apply the unchanged production caps
  # to EACH before any test payload can arm the production cleanup guard.
  parent_ready=self.root/'parent-caps.json';child_ready=self.root/'child-caps.json'
  report="import json,os,resource,signal,sys,time\ndef report(path):\n value={'pid':os.getpid(),'uid':os.getuid(),'pgid':os.getpgid(0),'sid':os.getsid(0),'caps':{name:list(resource.getrlimit(getattr(resource,name))) for name in ('RLIMIT_NPROC','RLIMIT_NOFILE','RLIMIT_FSIZE','RLIMIT_CPU')}}\n with open(path+'.next','x') as f:\n  json.dump(value,f)\n  f.flush()\n  os.fchmod(f.fileno(),0o400)\n  os.fsync(f.fileno())\n os.replace(path+'.next',path)\n"
  child_code=report+"report(sys.argv[1])\ntime.sleep(5)\n"
  original_limits=N.child_limits
  def delayed_fixture_limits():
   child=os.fork()
   if child==0:
    original_limits();os.execve(sys.executable,[sys.executable,'-I','-c',child_code,str(child_ready)],{'PATH':'/usr/bin:/bin'})
   original_limits()
  parent_code=report+"report("+repr(str(parent_ready))+")\nuntil=time.monotonic()+2\nwhile not os.path.exists("+repr(str(child_ready))+"):\n if time.monotonic()>=until:raise RuntimeError('Synthetic second actor did not report caps')\n time.sleep(.005)\nwith open("+repr(str(child_ready))+") as f:child_pid=json.load(f)['pid']\ndef stop(*args):\n try:os.kill(child_pid,signal.SIGTERM)\n except ProcessLookupError:pass\n try:os.waitpid(child_pid,0)\n except ChildProcessError:pass\n sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\nos.write(1,b'x'*1000)\nos.waitpid(child_pid,0)\n"
  with mock.patch.object(N,'child_limits',delayed_fixture_limits):r=self.native(parent_code,'log ceiling')
  c=self.settled(r);parent=json.loads(parent_ready.read_bytes());child=json.loads(child_ready.read_bytes());expected={'RLIMIT_NPROC':[1024,1024],'RLIMIT_NOFILE':[4096,4096],'RLIMIT_FSIZE':[8*N.GIB,8*N.GIB],'RLIMIT_CPU':[21600,21600]}
  self.assertEqual(expected,parent['caps']);self.assertEqual(expected,child['caps']);self.assertEqual(c['pid'],parent['pid']);self.assertEqual(parent['pid'],parent['pgid']);self.assertEqual(parent['pgid'],child['pgid']);self.assertEqual(parent['sid'],child['sid']);self.assertEqual(os.getuid(),child['uid'])
  self.assertTrue(any(any(m['pid']==child['pid'] and not m['state'].startswith('Z') for m in f['members']) and len(f['members'])>=2 for f in c['observations']));self.assertTrue(any(s['kind']=='group' and s.get('sent') is True for s in c['signals']));self.assertEqual(hashlib.sha256(b'x'*64).hexdigest(),r['log']['sha256']);self.assertFalse(r['success'])
  OBSERVATIONS.append({'scope':'two-actor-cleanup-fixture-only','childLimitsPatchedAndDelayedForConstruction':True,'unchangedCapsAppliedToBothBeforeGuardArmed':True,'parent':parent,'child':child,'arbitraryNestedSpawnOrNativeBuildEligibilityClaimed':False})
 def test_real_production_preexec_limits_without_fixture_patch_or_nested_spawn_claim(self):
  code="import json,resource;print(json.dumps({name:list(resource.getrlimit(getattr(resource,name))) for name in ('RLIMIT_NPROC','RLIMIT_NOFILE','RLIMIT_FSIZE','RLIMIT_CPU')}))"
  p=subprocess.Popen(firstparty(code),stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,preexec_fn=N.child_limits)
  try:stdout,stderr=p.communicate(timeout=3)
  finally:
   if p.poll() is None:p.kill();p.wait(timeout=2)
  self.assertEqual(0,p.returncode);self.assertEqual(b'',stderr);actual=json.loads(stdout);self.assertEqual({'RLIMIT_NPROC':[1024,1024],'RLIMIT_NOFILE':[4096,4096],'RLIMIT_FSIZE':[8*N.GIB,8*N.GIB],'RLIMIT_CPU':[21600,21600]},actual)
  OBSERVATIONS.append({'scope':'real-production-preexec-limits-only','childLimitsPatchedOrDelayed':False,'observedCaps':actual,'arbitraryNestedSpawnOrNativeBuildEligibilityClaimed':False})
 def test_real_gated_fast_child_records_live_identity_then_exited_unreaped_signal_outcomes(self):
  code="import json,os,sys\nprint(json.dumps({'pid':os.getpid(),'ppid':os.getppid(),'uid':os.getuid(),'pgid':os.getpgid(0),'sid':os.getsid(0)}),flush=True)\nos.read(0,1)\nos.write(1,b'x'*1000)\nos._exit(0)\n"
  proc=subprocess.Popen(firstparty(code),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,preexec_fn=N.child_limits)
  try:
   self.assertTrue(select.select([proc.stdout],[],[],2)[0]);ready=json.loads(proc.stdout.readline(1025));self.assertEqual(proc.pid,ready['pid']);self.assertEqual(os.getpid(),ready['ppid']);self.assertEqual(os.getuid(),ready['uid']);self.assertEqual(proc.pid,os.getpgid(proc.pid));self.assertEqual(proc.pid,os.getsid(proc.pid))
   proc.stdin.write(b'x');proc.stdin.flush();proc.stdin.close();deadline=time.monotonic()+2;body=b'';eof=False
   while time.monotonic()<deadline and not eof:
    if select.select([proc.stdout],[],[],max(.001,deadline-time.monotonic()))[0]:
     part=os.read(proc.stdout.fileno(),1001-len(body));self.assertLessEqual(len(body)+len(part),1000);body+=part;eof=not part
   self.assertTrue(eof);self.assertEqual(b'x'*1000,body);self.assertIsNone(proc.returncode)
   # Observe the exact PID before ANY poll/wait; do not infer an old failed
   # run's state from this new first-party counterfactual.
   value=subprocess.run(['/bin/ps','-p',str(proc.pid),'-o','pid=,ppid=,pgid=,uid=,stat='],capture_output=True,timeout=1);self.assertEqual(0,value.returncode);self.assertLessEqual(len(value.stdout)+len(value.stderr),4096);fields=value.stdout.split();self.assertEqual(5,len(fields));observed={'pid':int(fields[0]),'ppid':int(fields[1]),'pgid':int(fields[2]),'uid':int(fields[3])&0xffffffff,'state':fields[4].decode()};self.assertEqual(proc.pid,observed['pid']);self.assertEqual(os.getpid(),observed['ppid']);self.assertEqual(os.getuid(),observed['uid']);self.assertEqual(proc.pid,observed['pgid']);self.assertTrue(observed['state'].startswith('Z'))
   try:observed.update(sid=os.getsid(proc.pid),sidStatus='observed')
   except OSError as error:observed.update(sid=None,sidStatus='unavailable-after-exit',sidErrorType=type(error).__name__,sidErrno=error.errno)
   signals=[]
   # The live identity was observed while blocked, and the unreaped owned PID
   # still reserves its original group/session ID. This deliberately probes
   # the preserved OLD signal-before-wait sequence on that one proved child.
   for sig in (0,signal.SIGTERM):
    try:os.killpg(proc.pid,sig);signals.append({'signal':int(sig),'requestAccepted':True})
    except OSError as error:signals.append({'signal':int(sig),'requestAccepted':False,'type':type(error).__name__,'errno':error.errno})
   before_wait=proc.returncode;cleanup=N.cleanup_owned(proc,{os.getuid()},seconds=2);self.assertTrue(cleanup['leaderReaped']);self.assertTrue(cleanup['groupAbsent']);self.assertEqual(0,proc.returncode)
   OBSERVATIONS.append({'scope':'new-firstparty-exited-unreaped-counterfactual-not-historical-inference','platform':{'system':platform.system(),'release':platform.release(),'macOS':platform.mac_ver()[0],'arch':platform.machine()},'childLimitsPatchedOrDelayed':False,'liveActualIdentity':ready,'preWaitActualPIDFrame':observed,'PopenReturncodeBeforeAnyPollOrWait':before_wait,'legacySignalBeforeWaitOutcomes':signals,'boundedNewCleanup':cleanup,'historicalFailedRunStateEstablishedByThisExperiment':False})
  finally:
   if proc.stdin and not proc.stdin.closed:proc.stdin.close()
   if proc.returncode is None:N.cleanup_owned(proc,{os.getuid()},seconds=2)
   proc.stdout.close();proc.stderr.close()
 def test_capture_two_live_same_session_processes_are_observed_and_reaped(self):
  r=self.query(live_family(b'synthetic\n'),'deadline',seconds=.05);c=self.settled(r)
  self.assertTrue(any(len(f['members'])>=2 for f in c['observations']));self.assertTrue(any(s['kind']=='group' and s.get('sent') is True for s in c['signals']));self.assertTrue(r['timedOut'])
 def test_native_denied_group_signal_is_retained_without_masking_log_failure(self):
  with mock.patch.object(N.os,'killpg',side_effect=PermissionError(1,'synthetic denied group signal')):r=self.native("import os,time;os.write(1,b'x'*1000);time.sleep(2)",'log ceiling')
  c=self.settled(r);self.assertTrue(any(e['type']=='PermissionError' and e['errno']==1 for e in c['errors']));self.assertIn('log ceiling',r['primaryFailure']['reason']);self.assertFalse(r['success'])
 def test_capture_denied_group_signal_is_retained_without_masking_deadline(self):
  with mock.patch.object(N.os,'killpg',side_effect=PermissionError(1,'synthetic denied group signal')):r=self.query('import time;time.sleep(2)','deadline',seconds=.05)
  c=self.settled(r);self.assertTrue(any(e['type']=='PermissionError' and e['errno']==1 for e in c['errors']));self.assertEqual('TimeoutExpired',r['primaryFailure']['type'])
 def test_native_unknown_group_query_reaps_only_proved_child_and_persists_both_failures(self):
  with mock.patch.object(N,'owned_group_frame',side_effect=OSError(5,'synthetic metadata unavailable')),mock.patch.object(N.os,'killpg',side_effect=AssertionError('no group authority from unknown query')):r=self.native("import os,time;os.write(1,b'x'*1000);time.sleep(2)",'log ceiling')
  c=r['ownedProcessCleanup'];self.assertTrue(c['leaderReaped']);self.assertFalse(c['complete']);self.assertTrue(c['ownershipUnknown']);self.assertTrue(c['errors']);self.assertIn('log ceiling',r['primaryFailure']['reason']);self.assertFalse(r['success'])
 def test_capture_unknown_group_query_reaps_only_proved_child_and_persists_timeout(self):
  with mock.patch.object(N,'owned_group_frame',side_effect=OSError(5,'synthetic metadata unavailable')),mock.patch.object(N.os,'killpg',side_effect=AssertionError('no group authority from unknown query')):r=self.query('import time;time.sleep(2)','deadline',seconds=.05)
  c=r['ownedProcessCleanup'];self.assertTrue(c['leaderReaped']);self.assertFalse(c['complete']);self.assertTrue(c['ownershipUnknown']);self.assertEqual('TimeoutExpired',r['primaryFailure']['type'])
 def reused_observer(self):
  calls=[0]
  def observe(pid,timeout):
   calls[0]+=1
   if calls[0]==1:return {'pgid':pid,'members':[{'pid':pid+10000,'ppid':1,'pgid':pid,'sid':pid,'sidStatus':'observed','uid':os.getuid(),'state':'S'}]}
   return {'pgid':pid,'members':[]}
  return observe
 def test_native_reaped_leader_cannot_authorize_matching_uid_reused_group(self):
  with mock.patch.object(N,'owned_group_frame',side_effect=self.reused_observer()),mock.patch.object(N.os,'killpg',side_effect=AssertionError('no post-reap group signals')):r=self.native('pass','cleanup incomplete',seconds=10)
  c=r['ownedProcessCleanup'];self.assertEqual(0,c['returncodeAtEntry']);self.assertTrue(c['ownershipUnknown']);self.assertFalse(c['complete']);self.assertEqual([],c['signals']);self.assertFalse(r['success'])
 def test_capture_reaped_leader_cannot_authorize_matching_uid_reused_group(self):
  with mock.patch.object(N,'owned_group_frame',side_effect=self.reused_observer()),mock.patch.object(N.os,'killpg',side_effect=AssertionError('no post-reap group signals')):r=self.query('pass','cleanup incomplete',seconds=10)
  c=r['ownedProcessCleanup'];self.assertEqual(0,c['returncodeAtEntry']);self.assertTrue(c['ownershipUnknown']);self.assertFalse(c['complete']);self.assertEqual([],c['signals'])
 def test_native_build_uid_query_failure_cannot_replace_original_log_failure(self):
  done=[False];cleanup=N.cleanup_owned
  def wrapped(*args,**kwargs):value=cleanup(*args,**kwargs);done[0]=True;return value
  def rows():
   if done[0]:raise OSError(5,'synthetic build UID query failed')
   return []
  work=self.root/'uid-failure';(work/'capture').mkdir(parents=True)
  with mock.patch.dict(N.LIMITS,{**N.LIMITS,'minimumFreeBytes':0,'logBytes':64}),mock.patch.object(N,'ps_rows',side_effect=rows),mock.patch.object(N,'cleanup_owned',side_effect=wrapped):
   instance=N.Native(work,self.host())
   with self.assertRaisesRegex(ValueError,'log ceiling'):instance.run('firstparty',firstparty("print('x'*1000)"),{'PATH':'/usr/bin:/bin'},work,5,as_build=False)
  r=json.loads((work/'capture/PHASES.json').read_bytes())[0];self.assertEqual('OSError',r['buildUidObservationError']['type']);self.assertIsNone(r['unreapedBuildUidProcesses']);self.assertFalse(r['success']);self.assertIn('log ceiling',r['primaryFailure']['reason'])
 def test_capture_nonzero_exit_and_output_limit_keep_original_contract(self):
  work=self.root/'nonzero';work.mkdir();code,stdout,stderr=N.capture_control_query(work,'firstparty',firstparty('import sys;sys.exit(7)'),{'PATH':'/usr/bin:/bin'},5);self.assertEqual(7,code);self.assertEqual(b'',stdout);self.assertEqual(b'',stderr)
  r=self.query("import os;os.write(1,b'x'*70000)",'output limit');self.assertGreaterEqual(r['streams'][0]['bytes'],65536);self.assertIsNotNone(r['primaryFailure'])
 def test_group_authority_rejects_foreign_uid_parent_sid_and_unknown_sid(self):
  for field,bad in [('uid',os.getuid()+1),('ppid',os.getpid()+1),('sid',1),('sidStatus','unavailable')]:
   proc=subprocess.Popen(firstparty('import time;time.sleep(2)'),stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
   observed=N.owned_group_frame;first=[True]
   def observer(pid,timeout):
    value=observed(pid,timeout)
    if first[0]:
     first[0]=False
     for row in value['members']:
      if field!='ppid' or row['pid']==pid:row[field]=bad
    return value
   try:
    with mock.patch.object(N.os,'killpg',side_effect=AssertionError('foreign metadata cannot grant group signaling')):c=N.cleanup_owned(proc,{os.getuid()},seconds=2,observer=observer)
    self.assertTrue(c['leaderReaped']);self.assertTrue(c['ownershipUnknown']);self.assertFalse(c['complete'])
   finally:
    if proc.poll() is None:proc.kill();proc.wait(timeout=2)

if __name__=='__main__':unittest.main()
