"""Protected PID-namespace supervisor; original SDK10 argv is unchanged."""
import argparse,json,os,pathlib,re,signal,subprocess,sys,time
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
from common import need,freeze,encoded,digest,hash_file,deadline_receipt,bundle_bytes

def clean_project_env(environment):
 return {k:v for k,v in environment.items() if not k.startswith(('GITHUB_','GH_','ACTIONS_')) and not re.search(r'TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL|API_KEY|ACCESS_KEY',k,re.I)}

def drop_to(uid,gid):
 def apply():
  os.setgroups([]);os.setgid(gid);os.setuid(uid)
  need(os.getuid()==uid and os.geteuid()==uid and os.getgid()==gid and uid!=0,'original child nonroot identity')
  status=pathlib.Path('/proc/self/status').read_text();caps={k:int(v,16) for k,v in re.findall(r'^(CapEff|CapPrm|CapInh|CapAmb):\s*([0-9a-f]+)$',status,re.M)}
  need(set(caps)=={'CapEff','CapPrm','CapInh','CapAmb'} and all(v==0 for v in caps.values()) and os.getgroups()==[],'original child has no effective/permitted/inheritable/ambient capabilities or supplementary groups')
  need(re.search(r'^NoNewPrivs:[ \t]*1$',status,re.M) is not None,'original child retains irreversible no-new-privileges')
 return apply

def supervise(argv,deadline,cwd,environment,control=None,binding=None,uid=None,gid=None):
 start=time.monotonic();child=None;timeout=False;interrupted=False;error=None;code=None;signal_error=None;wait_error=None;restore_errors=[];signal_attempted=False;signal_sent=False
 binding=dict(binding or {});base={'schemaVersion':2,'binding':binding,'originalArgv':argv,'originalCommandStarted':False,'originalExitCode':None,'ownChildReaped':False,'privatePIDNamespaceRequiredByController':True}
 def write(name,row):
  if control is not None:freeze(pathlib.Path(control)/name,encoded(row))
 if start>=deadline:
  row={**base,'timedOut':True,'supervisorExitCode':124,'elapsedSeconds':0,'reason':'original combined deadline expired before start'};write('RESULT.json',row);return row
 previous={}
 def cancelled(signum,frame):raise InterruptedError('owned supervisor interrupted')
 try:
  for sig in [signal.SIGTERM,signal.SIGINT]:previous[sig]=signal.signal(sig,cancelled)
  need(time.monotonic()<deadline,'deadline before original child admission')
  child=subprocess.Popen(argv,cwd=cwd,env=clean_project_env(environment),start_new_session=True,preexec_fn=drop_to(uid,gid) if uid is not None else None)
  base.update(originalCommandStarted=True,originalChildPID=child.pid,originalStartedWallTime=time.time(),originalStartedMonotonic=time.monotonic())
  write('START.json',base)
  try:code=child.wait(timeout=max(.001,deadline-time.monotonic()))
  except subprocess.TimeoutExpired:timeout=True
 except InterruptedError:interrupted=True
 except BaseException as e:error=type(e).__name__
 finally:
  if child is not None:
   if child.poll() is None:
    signal_attempted=True
    try:os.killpg(child.pid,signal.SIGKILL);signal_sent=True
    except ProcessLookupError:pass
    except BaseException as failure:signal_error=type(failure).__name__
   try:code=child.wait(timeout=5)
   except BaseException as failure:wait_error=type(failure).__name__
  for sig,handler in previous.items():
   try:signal.signal(sig,handler)
   except BaseException as failure:restore_errors.append(type(failure).__name__)
 if time.monotonic()>=deadline:timeout=True
 supervisor=124 if timeout else 130 if interrupted else 125 if error or signal_error or wait_error or restore_errors else code if code is not None and code>=0 else 128-code if code is not None else 125
 row={**base,'originalExitCode':code,'timedOut':timeout,'interrupted':interrupted,'supervisorErrorType':error,'supervisorSignalAttempted':signal_attempted,'supervisorSignalSent':signal_sent,'cleanupSignalErrorType':signal_error,'cleanupWaitErrorType':wait_error,'signalRestoreErrorTypes':restore_errors,'supervisorExitCode':supervisor,'elapsedSeconds':time.monotonic()-start,'ownChildReaped':child is not None and child.poll() is not None}
 if control is not None:row=deadline_receipt(pathlib.Path(control)/'RESULT.json',row,deadline,{'timedOut':True,'supervisorExitCode':124},start)
 return row

def protect_control(folder):
 folder=pathlib.Path(folder);need(folder.is_dir() and not folder.is_symlink(),'physical protected control directory');os.chown(folder,0,0);os.chmod(folder,0o700);need(not list(folder.iterdir()),'fresh root-owned protected control directory');return folder

def main():
 p=argparse.ArgumentParser();p.add_argument('--profile',required=True);p.add_argument('--phase',choices=['build','test'],required=True);p.add_argument('--deadline',type=float,required=True);p.add_argument('--uid',type=int,required=True);p.add_argument('--gid',type=int,required=True);p.add_argument('--binding-json',required=True);p.add_argument('--control',default='/native-control');a=p.parse_args();need(os.geteuid()==0 and a.uid>0 and a.gid>=0,'root-only protected supervisor/nonroot child');folder=protect_control(a.control);raw=bundle_bytes(a.profile);profile=json.loads(raw);binding=json.loads(a.binding_json);binding.update(phase=a.phase,profileSHA256=digest(raw),supervisorSHA256=digest(bundle_bytes(__file__)));result=supervise(profile['buildArgv' if a.phase=='build' else 'testArgv'],a.deadline,'/work/source',os.environ,folder,binding,a.uid,a.gid);return result['supervisorExitCode']
if __name__=='__main__':sys.exit(main())
