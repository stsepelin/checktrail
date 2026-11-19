"""Tree-copy first-party common.process family: synthetic children only."""
from pathlib import Path
import importlib.util,json,os,subprocess,sys,tempfile,time,unittest
from unittest import mock
HERE=Path(__file__).resolve().parent;spec=importlib.util.spec_from_file_location('common_candidate',HERE/'reused-sdk-crypto/common.py');C=importlib.util.module_from_spec(spec);spec.loader.exec_module(C)
OBSERVATIONS=[]
def command(code):return [sys.executable,'-I','-B','-c',code]
class CommonLifecycle(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory(prefix='checktrail-common-fixed-');self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.out=self.root/'one'
 def receipt(self):
  row=json.loads(self.out.with_suffix('.receipt.json').read_bytes());OBSERVATIONS.append(row);return row
 def test_fast_zero_no_group_signal_after_reap_and_exact_cap_near_miss(self):
  with mock.patch.object(C.os,'killpg',side_effect=AssertionError('no signals after reap')):row,path=C.process(command('import os;os.write(1,b"x"*64)'),self.out,time.monotonic()+5,cap=64)
  self.assertEqual(0,row['exitCode']);self.assertIsNone(row['reason']);self.assertEqual(b'x'*64,path.read_bytes());self.assertTrue(row['ownedProcessCleanup']['complete']);self.assertEqual([],row['ownedProcessCleanup']['signals']);self.assertFalse(self.out.with_suffix('.stderr').exists());self.receipt()
 def test_nonzero_exit_is_retained_and_not_relabelled_success(self):
  row,_=C.process(command('import sys;sys.exit(7)'),self.out,time.monotonic()+5);self.assertEqual(7,row['exitCode']);self.assertEqual(7,row['originalExitCodeBeforeCleanup']);self.assertIsNone(row['reason']);self.assertTrue(row['ownedProcessCleanup']['complete']);self.receipt()
 def test_deadline_denied_group_signal_preserves_primary_and_cleanup_errors(self):
  with mock.patch.object(C.os,'killpg',side_effect=PermissionError(1,'synthetic denied group')):row,_=C.process(command('import time;time.sleep(2)'),self.out,time.monotonic()+.05)
  self.assertIsNotNone(row['reason']);self.assertEqual('owned command deadline',row['primaryFailure']['reason']);self.assertIsNone(row['originalExitCodeBeforeCleanup']);cleanup=row['ownedProcessCleanup'];self.assertTrue(cleanup['leaderReaped']);self.assertTrue(cleanup['groupAbsent']);self.assertTrue(cleanup['complete']);self.assertTrue(any(e['type']=='PermissionError' for e in cleanup['errors']));self.receipt()
 def test_output_bound_denied_group_signal_preserves_refusal_and_accounting(self):
  with mock.patch.object(C.os,'killpg',side_effect=PermissionError(1,'synthetic denied group')):
   with self.assertRaisesRegex(C.Refusal,'owned command incomplete'):C.process(command('import os,time;os.write(1,b"x"*1000);time.sleep(2)'),self.out,time.monotonic()+5,cap=64)
  row=self.receipt();self.assertEqual('terminal command output bound',row['reason']);self.assertEqual('owned command output bound',row['primaryFailure']['reason']);self.assertTrue(row['ownedProcessCleanup']['complete']);self.assertGreater(row['stdoutBytes'],64)
 def test_unknown_group_query_never_grants_signal_but_reaps_child(self):
  with mock.patch.object(C,'owned_group_frame',side_effect=OSError(5,'synthetic unavailable')),mock.patch.object(C.os,'killpg',side_effect=AssertionError('no unknown-group signal')):
   with self.assertRaisesRegex(C.Refusal,'cleanup incomplete'):C.process(command('import time;time.sleep(2)'),self.out,time.monotonic()+.05)
  row=self.receipt();cleanup=row['ownedProcessCleanup'];self.assertTrue(cleanup['leaderReaped']);self.assertFalse(cleanup['complete']);self.assertTrue(cleanup['ownershipUnknown']);self.assertEqual('owned command deadline',row['primaryFailure']['reason'])
 def test_reused_group_after_reap_is_never_signalled(self):
  count=0
  def observe(pid,timeout):
   nonlocal count
   count+=1
   return {'pgid':pid,'members':[{'pid':pid+10000,'ppid':1,'pgid':pid,'sid':pid,'sidStatus':'observed','uid':os.getuid(),'state':'S'}] if count==1 else []}
  with mock.patch.object(C,'owned_group_frame',side_effect=observe),mock.patch.object(C.os,'killpg',side_effect=AssertionError('no reused-group signal')):
   with self.assertRaisesRegex(C.Refusal,'cleanup incomplete'):C.process(command('pass'),self.out,time.monotonic()+5)
  row=self.receipt();self.assertEqual(0,row['originalExitCodeBeforeCleanup']);self.assertEqual(0,row['exitCode']);self.assertFalse(row['ownedProcessCleanup']['complete']);self.assertTrue(row['ownedProcessCleanup']['ownershipUnknown']);self.assertEqual([],row['ownedProcessCleanup']['signals']);self.assertEqual('owned command cleanup incomplete',row['reason'])
 def test_two_live_same_session_members_are_observed_and_reaped(self):
  code="import os,signal,subprocess,sys,time\nchild=subprocess.Popen([sys.executable,'-I','-c','import time;time.sleep(5)'])\ndef stop(*args):\n try:os.kill(child.pid,signal.SIGTERM)\n except ProcessLookupError:pass\n try:os.waitpid(child.pid,0)\n except ChildProcessError:pass\n os._exit(0)\nsignal.signal(signal.SIGTERM,stop)\nos.write(1,b'x'*1000)\nos.waitpid(child.pid,0)\n"
  with self.assertRaisesRegex(C.Refusal,'owned command incomplete'):C.process(command(code),self.out,time.monotonic()+5,cap=64)
  row=self.receipt();cleanup=row['ownedProcessCleanup'];self.assertTrue(cleanup['leaderReaped']);self.assertTrue(cleanup['groupAbsent']);self.assertTrue(cleanup['complete']);self.assertTrue(any(len([m for m in frame['members'] if not m['state'].startswith('Z')])>=2 for frame in cleanup['observations']));self.assertTrue(any(s['kind']=='group' and s.get('sent') for s in cleanup['signals']));self.assertGreaterEqual(len([m for m in cleanup['observations'][0]['members'] if not m['state'].startswith('Z')]),2);self.assertTrue(all(m['uid']==os.getuid() and m['pgid']==cleanup['pid'] and m['sidStatus']=='observed' and m['sid']==cleanup['pid'] for m in cleanup['observations'][0]['members']))
 def test_foreign_uid_and_unknown_sid_do_not_grant_group_authority(self):
  for field,bad in [('uid',os.getuid()+1),('sidStatus','unavailable')]:
   with self.subTest(field=field):
    process=subprocess.Popen(command('import time;time.sleep(2)'),start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);original=C.owned_group_frame;first=True
    def observe(pid,timeout):
     nonlocal first
     frame=original(pid,timeout)
     if first:
      first=False
      for member in frame['members']:member[field]=bad
     return frame
    try:
     with mock.patch.object(C.os,'killpg',side_effect=AssertionError('foreign identity cannot signal')):cleanup=C.cleanup_owned(process,{os.getuid()},seconds=2,observer=observe)
     self.assertTrue(cleanup['leaderReaped']);self.assertFalse(cleanup['complete']);self.assertTrue(cleanup['ownershipUnknown'])
    finally:
     if process.poll() is None:process.kill();process.wait(timeout=2)
 def test_start_error_keeps_receipt_and_no_child_claim(self):
  with mock.patch.object(C.subprocess,'Popen',side_effect=OSError(2,'synthetic absent')):
   with self.assertRaisesRegex(C.Refusal,'incomplete'):C.process(command('pass'),self.out,time.monotonic()+5)
  row=self.receipt();self.assertEqual('FileNotFoundError',row['startOrSupervisionErrorType']);self.assertFalse(row['ownedChildStarted']);self.assertIsNone(row['ownedProcessCleanup']);self.assertEqual('FileNotFoundError',row['primaryFailure']['type'])
 def test_expired_admission_spawns_no_child(self):
  with mock.patch.object(C.subprocess,'Popen',side_effect=AssertionError('no child before admission')):
   with self.assertRaisesRegex(C.Refusal,'expired before start'):C.process(command('pass'),self.out,time.monotonic()-1)
  row=self.receipt();self.assertFalse(row['ownedChildStarted']);self.assertIsNone(row['exitCode'])
if __name__=='__main__':unittest.main()
