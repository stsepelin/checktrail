"""Real bounded synthetic child pipes/process family; Docker/source never executes."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('observer',ROOT/'scripts/producer-qualification/gcc-main05-observer.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
NAME='checktrail-gcc-native05-'+'a'*32
IDENTIFIER='b'*64
REAL_POPEN=subprocess.Popen
CHILD=r'''
import json,os,signal,subprocess,sys,time
from pathlib import Path
root=Path(sys.argv[1]);command=json.loads(sys.argv[2]);mode=sys.argv[3]
if mode=='prestart':sys.stdout.write('Synthetic launcher refusal\n');sys.exit(128)
records=root/'observations/original-commands.jsonl'
request={'schemaVersion':1,'label':'original-main05','command':command,'cwd':'/build/source','state':'requested','elapsedSeconds':0,'exitCode':None}
records.write_text(json.dumps(request)+'\n')
if mode=='early-eof':
 (root/'synthetic-eof-marker').write_text('closed-pipe')
 os.close(1);os.close(2);time.sleep(3)
if mode=='orphan-zero':
 child=subprocess.Popen([sys.executable,'-I','-B','-c','import time;time.sleep(60)'])
 (root/'synthetic-descendant.pid').write_text(str(child.pid))
 sys.stdout.write('Synthetic orphan ready\n');sys.stdout.flush();sys.exit(0)
if mode=='timeout':
 child=subprocess.Popen([sys.executable,'-I','-B','-c','import time;time.sleep(60)'])
 (root/'synthetic-descendant.pid').write_text(str(child.pid))
 def stop(sig,frame):
  child.wait(timeout=3);(root/'synthetic-descendant-reaped').write_text('reaped');raise SystemExit(0)
 signal.signal(signal.SIGTERM,stop)
 sys.stdout.write('Synthetic family ready\n');sys.stdout.flush();time.sleep(60)
else:
 terminal={**request,'state':'terminal','elapsedSeconds':0.01,'exitCode':3 if mode=='nonzero' else 0,'signal':None,'terminalObserved':True}
 with records.open('a') as f:f.write(json.dumps(terminal)+'\n')
 sys.stdout.write('x'*128 if mode=='log-limit' else 'Synthetic main05 stdout\n');sys.stdout.flush();sys.exit(1 if mode=='nonzero' else 0)
'''


def owner():
 return {'Id':IDENTIFIER,'Config':{'Labels':{'io.checktrail.gcc-staged-owner':NAME},'Entrypoint':['/usr/bin/env'],
  'Cmd':['-i',*[k+'='+v for k,v in m.body.stage.FIXED_ENVIRONMENT.items()],*m.BODY]},
  'State':{'Status':'created','Running':False,'Pid':0},'HostConfig':{'NetworkMode':'none','Privileged':False,'Init':True,
  'NanoCpus':4000000000,'Memory':6*m.h.GIB,'PidsLimit':1024}}


class Observations(unittest.TestCase):
 def execute(self,mode,*,maximum=10,log_bound=None):
  with tempfile.TemporaryDirectory() as name:
   root=Path(name).resolve();(root/'state').mkdir();(root/'state/synthetic-object').write_bytes(b'object');(root/'observations').mkdir()
   processes=[];calls=[]
   def popen(args,**kw):
    self.assertEqual(args,['/usr/bin/docker','start','--attach',NAME]);self.assertEqual(kw['env'],m.h.HOST_ENV)
    p=REAL_POPEN([sys.executable,'-I','-B','-c',CHILD,str(root),json.dumps(m.body.COMMAND),mode],**kw);processes.append(p);return p
   def docker(args,**kw):
    calls.append(args)
    if args==['inspect',NAME]:
     value=owner()
     if processes:
      code=processes[0].poll();self.assertIsNotNone(code)
      value['State']=({'Status':'created','Running':False,'Pid':0,'ExitCode':128,'OOMKilled':False,'Error':'Synthetic prestart refusal'} if mode=='prestart' else
                      {'Status':'exited','Running':False,'Pid':0,'ExitCode':code if code>=0 else 128-code,'OOMKilled':False,'Error':''})
     return json.dumps([value]).encode()
    self.assertEqual(args[:2],['kill','--signal']);self.assertEqual(args[-1],NAME)
    if processes and processes[0].poll() is None:os.killpg(processes[0].pid,getattr(signal,'SIG'+args[2]))
    return b''
   try:
    with mock.patch.object(m.h,'docker',side_effect=docker),mock.patch.object(m.subprocess,'Popen',side_effect=popen),\
         mock.patch.object(m.shutil,'disk_usage',return_value=SimpleNamespace(free=200*m.h.GIB)),\
         mock.patch.object(m.h,'LOG_CEILING',log_bound if log_bound is not None else m.h.LOG_CEILING):
     result=m.observe(root,NAME,IDENTIFIER,maximum,{'capturedMonotonic':time.monotonic(),'remainingSeconds':20000},sdk_seconds=50)
    self.assertEqual(json.loads((root/'MAIN05-ATTEMPT.json').read_bytes()),result)
    self.assertEqual(result['combinedSdkAndMainObservedSeconds'],50+result['observerElapsedSeconds'])
    self.assertFalse(result['checkpointCompleted']);self.assertFalse(result['phaseCompletionAssessed']);self.assertFalse(result['gateAComplete'])
    if mode=='timeout':self.assertEqual((root/'synthetic-descendant-reaped').read_text(),'reaped')
    if mode=='early-eof':self.assertEqual((root/'synthetic-eof-marker').read_text(),'closed-pipe')
    if mode=='orphan-zero':
     pid=int((root/'synthetic-descendant.pid').read_text());deadline=time.monotonic()+2
     while time.monotonic()<deadline:
      observed=subprocess.run(['ps','-o','stat=','-p',str(pid)],capture_output=True,text=True)
      if not observed.stdout.strip() or observed.stdout.strip().startswith('Z'):break
      time.sleep(0.02)
     self.assertTrue(not observed.stdout.strip() or observed.stdout.strip().startswith('Z'),'Owned synthetic orphan remains running')
    return result,calls
   finally:
    for process in processes:
     try:os.killpg(process.pid,signal.SIGKILL)
     except ProcessLookupError:pass
     process.wait(timeout=5)

 def test_real_original_zero_and_nonzero_are_separate_from_wrapper_exit(self):
  for mode,original,wrapper in [('zero',0,0),('nonzero',3,1)]:
   with self.subTest(mode=mode):
    result,calls=self.execute(mode)
    self.assertEqual(result['originalCommandExitCode'],original);self.assertEqual(result['attachExitCode'],wrapper)
    self.assertTrue(result['originalCommandTerminalObserved']);self.assertTrue(result['quiescenceObserved'])
    self.assertIsNone(result['cutoffOrRetentionError']);self.assertEqual(calls,[['inspect',NAME],['inspect',NAME]])
    self.assertEqual(result['originalCommandElapsedSeconds'],0.01);self.assertFalse(result['originalCommandWindowPromised'])
    self.assertTrue(result['bodyWindowIncludesAttachStartupPrechecksOriginalCommandPostchecksAndReap'])

 def test_launcher_created128_is_never_an_original_command_terminal(self):
  result,_=self.execute('prestart')
  self.assertEqual(result['attachExitCode'],128);self.assertFalse(result['quiescenceObserved'])
  self.assertFalse(result['originalCommandTerminalObserved']);self.assertIsNone(result['originalCommandExitCode'])
  self.assertEqual(result['containerState']['Status'],'created')

 def test_timeout_stops_real_owned_synthetic_family_and_cannot_accept_wrapper_zero(self):
  result,calls=self.execute('timeout',maximum=0.2)
  self.assertIn('cutoff',result['cutoffOrRetentionError']);self.assertTrue(result['quiescenceObserved'])
  self.assertIsNone(result['originalCommandExitCode']);self.assertFalse(result['originalCommandTerminalObserved'])
  self.assertEqual(result['containerState']['ExitCode'],0)
  self.assertEqual(result['attachExitCode'],0)
  self.assertIn(['kill','--signal','TERM',NAME],calls);self.assertIn(['kill','--signal','KILL',NAME],calls)

 def test_pipe_eof_uses_the_same_native_budget_instead_of_an_extra_wait(self):
  result,_=self.execute('early-eof',maximum=0.3)
  self.assertIn('cutoff',result['cutoffOrRetentionError']);self.assertLess(result['observerElapsedSeconds'],2)
  self.assertFalse(result['originalCommandTerminalObserved']);self.assertIsNone(result['originalCommandExitCode'])

 def test_already_zero_wrapper_cannot_leave_an_owned_host_descendant_running(self):
  result,_=self.execute('orphan-zero',maximum=0.3)
  self.assertIn('cutoff',result['cutoffOrRetentionError']);self.assertEqual(result['attachExitCode'],0)
  self.assertFalse(result['originalCommandTerminalObserved']);self.assertIsNone(result['originalCommandExitCode'])

 def test_retention_error_preserves_genuine_original_zero_without_checkpoint(self):
  result,_=self.execute('log-limit',log_bound=32)
  self.assertIn('stdout bound',result['cutoffOrRetentionError']);self.assertTrue(result['originalCommandTerminalObserved'])
  self.assertEqual(result['originalCommandExitCode'],0);self.assertFalse(result['checkpointCompleted'])

 def test_prestart_inspection_cannot_silently_shorten_the_declared_whole_body_window(self):
  with tempfile.TemporaryDirectory() as name:
   root=Path(name).resolve();maximum=10
   clock={'capturedMonotonic':1000,'remainingSeconds':m.policy.FINALIZE_SECONDS+m.policy.CLEANUP_RESERVE_SECONDS+maximum+2}
   with mock.patch.object(m.h,'docker',return_value=json.dumps([owner()]).encode()),mock.patch.object(m.time,'monotonic',side_effect=[1000,1003]),mock.patch.object(m.subprocess,'Popen') as start:
    with self.assertRaisesRegex(ValueError,'consumed promised whole-body'):m.observe(root,NAME,IDENTIFIER,maximum,clock,sdk_seconds=50)
    start.assert_not_called()

 def test_wrong_scope_resource_controls_and_stale_clock_refuse_before_start(self):
  with tempfile.TemporaryDirectory() as name:
   root=Path(name).resolve();clock={'capturedMonotonic':time.monotonic(),'remainingSeconds':20000}
   for section,key,value in [('Config','Cmd',['wrong']),('HostConfig','NetworkMode','host'),('HostConfig','Memory',0),('State','Running',True)]:
    actual=owner();actual[section][key]=value
    with self.subTest(key=key),mock.patch.object(m.h,'docker',return_value=json.dumps([actual]).encode()),mock.patch.object(m.subprocess,'Popen') as start:
     with self.assertRaises(ValueError):m.observe(root,NAME,IDENTIFIER,10,clock,sdk_seconds=50)
     start.assert_not_called()
   with mock.patch.object(m.h,'docker') as docker,mock.patch.object(m.subprocess,'Popen') as start:
    with self.assertRaisesRegex(ValueError,'Fresh actual'):m.observe(root,NAME,IDENTIFIER,10,{'capturedMonotonic':time.monotonic()-31,'remainingSeconds':20000},sdk_seconds=50)
    docker.assert_not_called();start.assert_not_called()


if __name__=='__main__':unittest.main(verbosity=2)
