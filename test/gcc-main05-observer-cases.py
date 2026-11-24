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
_carrier_spec=importlib.util.spec_from_file_location('carrier_cases',ROOT/'test/gcc-hosted-carrier-cases.py')
CARRIER_CASES=importlib.util.module_from_spec(_carrier_spec);_carrier_spec.loader.exec_module(CARRIER_CASES)
NAME='checktrail-gcc-native05-'+'a'*32
IDENTIFIER='b'*64
FOREIGN='f'*64
REAL_POPEN=subprocess.Popen
CHILD=r'''
import json,os,signal,subprocess,sys,time
from pathlib import Path
root=Path(sys.argv[1]);command=json.loads(sys.argv[2]);mode=sys.argv[3]
import atexit;atexit.register(lambda:(root/'synthetic-leader-exited').write_text('exited'))
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


def running(process,root):
 """Report a live leader without reaping it; poll() would release its PID.

 The observer may signal the attach group only while its own Popen child is
 unreaped, so a harness that reaps here would hide whether that group is closed.
 The synthetic leader marks its own exit, so no process-table access is needed.
 """
 return process.returncode is None and not (root/'synthetic-leader-exited').exists()


def owner():
 return {'Id':IDENTIFIER,'Config':{'Labels':{'io.checktrail.gcc-staged-owner':NAME},'Entrypoint':['/usr/bin/env'],
  'Cmd':['-i',*[k+'='+v for k,v in m.body.stage.FIXED_ENVIRONMENT.items()],*m.BODY]},
  'State':{'Status':'created','Running':False,'Pid':0},'HostConfig':{'NetworkMode':'none','Privileged':False,'Init':True,
  'NanoCpus':4000000000,'Memory':6*m.h.GIB,'PidsLimit':1024}}


def foreign():
 value=owner();value['Id']=FOREIGN;value['Config']['Labels']={'io.checktrail.synthetic-foreign-owner':'unrelated-137'}
 value['State']={'Status':'created','Running':False,'Pid':0};return value


class Observations(unittest.TestCase):
 def execute(self,mode,*,maximum=10,log_bound=None,rebind=None,transient=False):
  """Docker resolves a reference by name or by ID, as the daemon does.

  `rebind` moves the owned name to FOREIGN just before the start request
  ('before-start') or right after the TERM request ('between-signals').
  self.effects records the container each start/kill actually reached.
  """
  bound={NAME:IDENTIFIER};self.effects=effects=[]
  def resolve(reference):
   target=bound.get(reference,reference);self.assertIn(target,(IDENTIFIER,FOREIGN));return target
  with tempfile.TemporaryDirectory() as name:
   root=Path(name).resolve();(root/'state').mkdir();(root/'state/synthetic-object').write_bytes(b'object');(root/'observations').mkdir()
   if transient:(root/'state/cc1-transient.s').write_bytes(b't'*9137)
   # The running build unlinks its temporary after the sampler listed it.
   racing=CARRIER_CASES.listed_then_unlinked(root/'state',['cc1-transient.s'] if transient else [])
   processes=[];calls=[]
   def popen(args,**kw):
    if rebind=='before-start':bound[NAME]=FOREIGN
    self.assertEqual(args[:3],['/usr/bin/docker','start','--attach']);self.assertEqual(len(args),4);self.assertEqual(kw['env'],m.h.HOST_ENV)
    effects.append(('start',resolve(args[3])));calls.append(['start','--attach',args[3]])
    p=REAL_POPEN([sys.executable,'-I','-B','-c',CHILD,str(root),json.dumps(m.body.COMMAND),mode],**kw);processes.append(p);return p
   def docker(args,**kw):
    calls.append(args)
    if args[0]=='inspect':
     self.assertEqual(len(args),2)
     if resolve(args[1])==FOREIGN:return json.dumps([foreign()]).encode()
     value=owner()
     if processes:
      code=processes[0].poll();self.assertIsNotNone(code)
      value['State']=({'Status':'created','Running':False,'Pid':0,'ExitCode':128,'OOMKilled':False,'Error':'Synthetic prestart refusal'} if mode=='prestart' else
                      {'Status':'exited','Running':False,'Pid':0,'ExitCode':code if code>=0 else 128-code,'OOMKilled':False,'Error':''})
     return json.dumps([value]).encode()
    self.assertEqual(args[:2],['kill','--signal']);self.assertEqual(len(args),4);target=resolve(args[3]);effects.append((args[2],target))
    if target==IDENTIFIER and processes and running(processes[0],root):os.killpg(processes[0].pid,getattr(signal,'SIG'+args[2]))
    if rebind=='between-signals' and args[2]=='TERM':bound[NAME]=FOREIGN
    return b''
   try:
    with mock.patch.object(m.h,'docker',side_effect=docker),mock.patch.object(m.subprocess,'Popen',side_effect=popen),\
         mock.patch.object(m.shutil,'disk_usage',return_value=SimpleNamespace(free=200*m.h.GIB)),\
         mock.patch.object(m.h,'LOG_CEILING',log_bound if log_bound is not None else m.h.LOG_CEILING),\
         mock.patch.object(m.h.os,'scandir',racing):
     result=m.observe(root,NAME,IDENTIFIER,maximum,{'capturedMonotonic':time.monotonic(),'remainingSeconds':20000},sdk_seconds=50)
    self.assertEqual(json.loads((root/'MAIN05-ATTEMPT.json').read_bytes()),result)
    self.samples=json.loads((root/'resource-samples.json').read_bytes())['samples']
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
     if process.returncode is None:
      try:os.killpg(process.pid,signal.SIGKILL)
      except (ProcessLookupError,PermissionError):pass
     process.wait(timeout=5)

 def test_real_original_zero_and_nonzero_are_separate_from_wrapper_exit(self):
  for mode,original,wrapper in [('zero',0,0),('nonzero',3,1)]:
   with self.subTest(mode=mode):
    result,calls=self.execute(mode)
    self.assertEqual(result['originalCommandExitCode'],original);self.assertEqual(result['attachExitCode'],wrapper)
    self.assertTrue(result['originalCommandTerminalObserved']);self.assertTrue(result['quiescenceObserved'])
    self.assertIsNone(result['cutoffOrRetentionError'])
    self.assertEqual(calls,[['inspect',NAME],['start','--attach',IDENTIFIER],['inspect',IDENTIFIER]])
    self.assertEqual(result['originalCommandElapsedSeconds'],0.01);self.assertFalse(result['originalCommandWindowPromised'])
    self.assertTrue(result['bodyWindowIncludesAttachStartupPrechecksOriginalCommandPostchecksAndReap'])

 def test_live_sample_tolerates_a_build_temporary_unlinked_mid_walk(self):
  result,calls=self.execute('zero',transient=True)
  self.assertIsNone(result['cutoffOrRetentionError']);self.assertEqual(calls,[['inspect',NAME],['start','--attach',IDENTIFIER],['inspect',IDENTIFIER]])
  self.assertEqual(result['originalCommandExitCode'],0);self.assertTrue(result['originalCommandTerminalObserved'])
  self.assertEqual(self.samples[0]['vanishedEntries'],1);self.assertEqual(self.samples[0]['logicalBytes'],len(b'object'))

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
  self.assertIn(['kill','--signal','TERM',IDENTIFIER],calls);self.assertIn(['kill','--signal','KILL',IDENTIFIER],calls)

 def rebound(self,mode,rebind,**kw):
  try:outcome=self.execute(mode,rebind=rebind,**kw)
  except ValueError as error:outcome=error
  self.assertEqual([effect for effect in self.effects if effect[1]==FOREIGN],[],'An unrelated container was started or signalled')
  self.assertNotIsInstance(outcome,ValueError,str(outcome));return outcome

 def test_name_rebound_before_start_never_starts_the_foreign_container(self):
  result,calls=self.rebound('zero','before-start')
  self.assertEqual(self.effects,[('start',IDENTIFIER)]);self.assertEqual(result['containerId'],IDENTIFIER)
  self.assertEqual(result['originalCommandExitCode'],0);self.assertTrue(result['quiescenceObserved'])
  self.assertEqual(calls[-1],['inspect',IDENTIFIER])

 def test_name_rebound_between_term_and_kill_never_signals_the_foreign_container(self):
  result,calls=self.rebound('timeout','between-signals',maximum=0.2)
  self.assertEqual(self.effects,[('start',IDENTIFIER),('TERM',IDENTIFIER),('KILL',IDENTIFIER)])
  self.assertIn('cutoff',result['cutoffOrRetentionError']);self.assertTrue(result['quiescenceObserved'])
  self.assertEqual(calls[-1],['inspect',IDENTIFIER])

 def test_unchanged_name_runs_the_normal_cutoff_flow_through_the_admitted_id(self):
  result,calls=self.rebound('timeout',None,maximum=0.2)
  self.assertEqual(self.effects,[('start',IDENTIFIER),('TERM',IDENTIFIER),('KILL',IDENTIFIER)])
  self.assertEqual(calls,[['inspect',NAME],['start','--attach',IDENTIFIER],['kill','--signal','TERM',IDENTIFIER],
                          ['kill','--signal','KILL',IDENTIFIER],['inspect',IDENTIFIER]])
  self.assertEqual(result['containerState']['Status'],'exited');self.assertEqual(result['containerId'],IDENTIFIER)

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


 def fake_child_cleanup(self,*,reaped):
  """A late refusal after wait() reaped the client, or a cutoff while it is unreaped."""
  with tempfile.TemporaryDirectory() as name:
   root=Path(name).resolve();(root/'state').mkdir();(root/'observations').mkdir()
   reader,writer=os.pipe();os.close(writer);stream=os.fdopen(reader,'rb',buffering=0)
   child=SimpleNamespace(pid=424242,returncode=None,stdout=stream);clock=[5000.0];calls=[]
   def wait(timeout):
    if timeout!=5 and not reaped:raise subprocess.TimeoutExpired('docker',timeout)
    if child.returncode is None:
     child.returncode=0 if reaped else -signal.SIGKILL
     clock[0]+=137 # The wrapper terminal arrives after the native window.
    return child.returncode
   child.wait=mock.Mock(side_effect=wait)
   def docker(args,**kw):
    calls.append(args)
    if args[0]=='inspect':
     self.assertEqual(args,['inspect',NAME] if len(calls)==1 else ['inspect',IDENTIFIER])
     value=owner()
     if child.returncode is not None:value['State']={'Status':'exited','Running':False,'Pid':0,'ExitCode':0,'OOMKilled':False,'Error':''}
     return json.dumps([value]).encode()
    return b''
   with mock.patch.object(m.h,'docker',side_effect=docker),mock.patch.object(m.subprocess,'Popen',return_value=child),\
        mock.patch.object(m.shutil,'disk_usage',return_value=SimpleNamespace(free=200*m.h.GIB)),mock.patch.object(m.os,'killpg') as kill,\
        mock.patch.object(m.time,'monotonic',side_effect=lambda:clock[0]),mock.patch.object(m.time,'sleep'):
    try:result=m.observe(root,NAME,IDENTIFIER,10,{'capturedMonotonic':5000.0,'remainingSeconds':20000},sdk_seconds=50)
    finally:stream.close()
   return result,calls,kill,child

 def test_late_deadline_after_reaping_the_attach_client_never_signals_its_reusable_group(self):
  result,calls,kill,child=self.fake_child_cleanup(reaped=True)
  kill.assert_not_called();self.assertIn('Late main05 wrapper terminal',result['cutoffOrRetentionError'])
  self.assertEqual(result['attachExitCode'],0);self.assertEqual(child.wait.call_count,2)
  # Owned container cleanup is by the admitted ID, independent of the group decision.
  self.assertIn(['kill','--signal','TERM',IDENTIFIER],calls);self.assertIn(['kill','--signal','KILL',IDENTIFIER],calls)

 def test_cutoff_with_the_attach_client_still_unreaped_signals_its_reserved_group(self):
  result,calls,kill,child=self.fake_child_cleanup(reaped=False)
  kill.assert_called_once_with(424242,signal.SIGKILL);self.assertIn('native/source-service cutoff',result['cutoffOrRetentionError'])
  self.assertEqual(result['attachExitCode'],-signal.SIGKILL)
  self.assertIn(['kill','--signal','TERM',IDENTIFIER],calls);self.assertIn(['kill','--signal','KILL',IDENTIFIER],calls)


if __name__=='__main__':unittest.main(verbosity=2)
