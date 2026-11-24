"""Scoped adaptation of reviewed macOS process/UID supervisor; not a sandbox claim."""
import hashlib,json,os,re,resource,selectors,shutil,signal,stat,subprocess,time
from pathlib import Path
GIB=1024**3
LIMITS={'wholeSeconds':18000,'logBytes':256*1024**2,'minimumFreeBytes':8*GIB,'sampledRssBytes':6*GIB}
def need(v,m):
 if not v:raise ValueError(m)
def atomic_json(path,value,mode=0o600):
 body=(json.dumps(value,sort_keys=True,indent=2)+'\n').encode();temporary=path.with_suffix(path.suffix+'.next')
 descriptor=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(descriptor,'wb') as stream:os.fchmod(stream.fileno(),mode);stream.write(body);stream.flush();os.fsync(stream.fileno())
 os.replace(temporary,path)


def metadata_query_limits():
 resource.setrlimit(resource.RLIMIT_FSIZE,(65536,65536))
 resource.setrlimit(resource.RLIMIT_CPU,(30,30))


def owned_group_frame(pid,timeout=1):
 """Bounded kernel metadata only; raw process commands are never retained."""
 query=subprocess.run(['/bin/ps','-axo','pid=,ppid=,pgid=,uid=,stat='],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
 need(query.returncode==0 and len(query.stdout)+len(query.stderr)<=2*1024**2,'Owned process metadata query failed or exceeded bound')
 members=[]
 for line in query.stdout.splitlines():
  fields=line.split();need(len(fields)==5 and all(v.lstrip(b'-').isdigit() for v in fields[:4]),'Owned process metadata row malformed')
  actual,parent,group,uid=map(int,fields[:4])
  if group!=pid:continue
  need(len(members)<128 and 0<len(fields[4])<=16,'Owned process group metadata bound')
  row={'pid':actual,'ppid':parent,'pgid':group,'uid':uid&0xffffffff,'state':fields[4].decode('ascii')}
  try:row.update(sid=os.getsid(actual),sidStatus='observed')
  except ProcessLookupError:row.update(sid=None,sidStatus='vanished-during-observation')
  except PermissionError:row.update(sid=None,sidStatus='unavailable')
  members.append(row)
 return {'pgid':pid,'members':members}


def cleanup_owned(process,allowed_uids,seconds=5,observer=None):
 """A held Popen child authorizes its original group, never a reused group.

 Before wait/poll consumes that token, prove actual PGID/SID/parent/UID. Signal
 failure is retained. An unknown group only permits bounded teardown of the
 proved Popen child PID; it never authorizes signaling other group members.
 """
 observer=observer or owned_group_frame;start=time.monotonic();deadline=start+seconds
 record={'pid':process.pid,'expectedPGID':process.pid,'expectedSID':process.pid,'controllerPid':os.getpid(),'controllerUid':os.getuid(),'allowedGroupUIDs':sorted(allowed_uids),'returncodeAtEntry':process.returncode,'observations':[],'observationCount':0,'signals':[],'errors':[],'leaderReaped':process.returncode is not None,'groupAbsent':False,'ownershipUnknown':False,'complete':False}
 def error(stage,e):record['errors'].append({'stage':stage,'type':type(e).__name__,'errno':e.errno if isinstance(e,OSError) else None})
 def remaining():return max(.001,deadline-time.monotonic())
 def observe():
  frame=observer(process.pid,timeout=min(1,remaining()));record['observationCount']+=1
  if len(record['observations'])<8:record['observations'].append(frame)
  else:record['observations'][-1]=frame
  return frame
 def wait_owned(timeout):
  try:process.wait(timeout=min(timeout,remaining()));record['leaderReaped']=process.returncode is not None;return record['leaderReaped']
  except subprocess.TimeoutExpired:return False
  except (OSError,subprocess.SubprocessError) as e:error('wait-proved-child',e);return False
 def authority(frame):
  need(process.returncode is None,'Reaped child cannot authorize another group signal')
  leader=[r for r in frame['members'] if r['pid']==process.pid]
  need(len(leader)==1 and leader[0]['ppid']==os.getpid(),'Proved Popen leader missing or parent changed')
  need(all(r['uid'] in allowed_uids and r['sidStatus']=='observed' and r['sid']==process.pid and r['pgid']==process.pid for r in frame['members']),'Owned process UID/PGID/SID changed or unknown')
  need(os.getpgid(process.pid)==process.pid and os.getsid(process.pid)==process.pid,'Current proved-child PGID/SID changed')
 def signal_group(frame,sig):
  authority(frame);row={'authority':'unreaped-proved-child-and-current-PGID-SID-UID-frame','kind':'group','pid':process.pid,'signal':int(sig)};record['signals'].append(row)
  try:os.killpg(process.pid,sig);row['sent']=True;return True
  except (ProcessLookupError,PermissionError) as e:row.update(sent=False,errorType=type(e).__name__,errno=e.errno);error('group-signal',e);return False
 try:
  frame=observe()
  # Once already reaped, even a numerically equal group with matching UID/SID
  # is not this invocation's authority token. Observe only; never signal it.
  if process.returncode is not None:
   record['groupAbsent']=not frame['members']
   if frame['members']:record['ownershipUnknown']=True
  else:
   for sig in (signal.SIGTERM,signal.SIGKILL):
    if time.monotonic()>=deadline:break
    if not frame['members'] or (len(frame['members'])==1 and frame['members'][0]['pid']==process.pid and frame['members'][0]['state'].startswith('Z')):
     wait_owned(1);break
    if not signal_group(frame,sig):break
    until=min(deadline,time.monotonic()+1)
    while time.monotonic()<until:
     frame=observe()
     live=[r for r in frame['members'] if not r['state'].startswith('Z')]
     if not live:
      # Hold the unreaped leader while live descendants could still retain its
      # session/group. When all have stopped, consume only our own wait token.
      wait_owned(1);break
     time.sleep(min(.05,remaining()))
    if process.returncode is not None:break
    frame=observe()
 except (OSError,subprocess.SubprocessError,ValueError) as e:
  error('group-inspection-or-authority',e);record['ownershipUnknown']=True
 # Bound/reap the specific child even when group inspection or group signaling
 # failed. Popen's per-PID signal method polls under its own child-wait lock;
 # it does not signal a PID after learning that child has already been reaped.
 for sig in (signal.SIGTERM,signal.SIGKILL):
  if process.returncode is not None or time.monotonic()>=deadline:break
  row={'authority':'proved-Popen-child-PID-only','kind':'child-pid','pid':process.pid,'signal':int(sig)};record['signals'].append(row)
  try:
   process.send_signal(sig);row.update(methodReturnedWithoutError=True,actualSignalSyscallPerformed=None,returncodeAfterMethod=process.returncode)
  except (OSError,subprocess.SubprocessError) as e:row.update(methodReturnedWithoutError=False,errorType=type(e).__name__);error('proved-child-signal',e)
  if wait_owned(1):break
 record['leaderReaped']=process.returncode is not None;record['leaderExitCode']=process.returncode
 if record['leaderReaped']:
  try:
   while time.monotonic()<deadline:
    frame=observe();record['groupAbsent']=not frame['members']
    if record['groupAbsent']:break
    # No mutation after reaping: a surviving/reused/foreign group is unresolved.
    time.sleep(min(.05,remaining()))
  except (OSError,subprocess.SubprocessError,ValueError) as e:error('post-wait-group-inspection',e);record['ownershipUnknown']=True
 record['observationsTruncated']=record['observationCount']>len(record['observations']);record['elapsedSeconds']=time.monotonic()-start
 record['complete']=record['leaderReaped'] and record['groupAbsent'] and not record['ownershipUnknown'] and record['elapsedSeconds']<seconds
 return record


def capture_control_query(capture,name,args,env,seconds=30,cwd=None):
 need(re.fullmatch('[a-z][a-z-]+',name),'Fixed controller query name required')
 paths=[capture/(name+'.stdout'),capture/(name+'.stderr')];started=time.monotonic();code=None;timed_out=False;primary=None;cleanup=None
 with paths[0].open('xb') as stdout,paths[1].open('xb') as stderr:
  process=subprocess.Popen(args,env=env,cwd=cwd,stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr,start_new_session=True,preexec_fn=metadata_query_limits)
  try:
   try:code=process.wait(timeout=seconds)
   except subprocess.TimeoutExpired as e:timed_out=True;primary=e
   except BaseException as e:primary=e
  finally:
   cleanup=cleanup_owned(process,{os.getuid()},seconds=4)
  stdout.flush();stderr.flush();os.fsync(stdout.fileno());os.fsync(stderr.fileno())
 elapsed=time.monotonic()-started
 if primary is None and elapsed>=seconds:primary=ValueError('Controller metadata query deadline')
 if primary is None and any(p.stat().st_size>=65536 for p in paths):primary=ValueError('Controller metadata query output limit reached')
 record={'argv':args,'exitCode':code,'timedOut':timed_out,'elapsedSeconds':elapsed,'secondsLimit':seconds,'maximumBytesPerStream':65536,'streams':[physical_file(p) for p in paths],'ownedProcessCleanup':cleanup,'primaryFailure':{'type':type(primary).__name__,'reason':str(primary) if isinstance(primary,ValueError) else None} if primary else None}
 atomic_json(capture/(name+'.json'),record)
 if primary is not None and not timed_out:raise primary
 need(not timed_out and record['elapsedSeconds']<seconds,'Controller metadata query deadline')
 need(cleanup['complete'],'Controller query owned-process cleanup incomplete')
 need(all(p.stat().st_size<65536 for p in paths),'Controller metadata query output limit reached')
 return code,paths[0].read_bytes(),paths[1].read_bytes()


def quick(args,env=None,timeout=30):
 result=subprocess.run(args,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout,check=False)
 need(len(result.stdout)+len(result.stderr)<=2*1024**2,'Probe output limit')
 need(result.returncode==0,'Native metadata probe failed: '+args[0]+': '+result.stderr.decode(errors='replace')[:1000])
 return result.stdout.decode('utf-8').strip()


def physical_file(path,deadline=None):
 path=Path(path).resolve(strict=True);s=path.lstat();need(stat.S_ISREG(s.st_mode),'Tool must resolve to regular file')
 h=hashlib.sha256()
 with path.open('rb') as stream:
  while True:
   need(deadline is None or time.monotonic()<deadline,'Native observation capture deadline')
   b=stream.read(65536)
   if not b:break
   h.update(b)
 return {'path':str(path),'bytes':s.st_size,'sha256':h.hexdigest(),'mode':stat.S_IMODE(s.st_mode),'uid':s.st_uid,'gid':s.st_gid}


def ps_rows():
 rows=[]
 for line in quick(['/bin/ps','-axo','pid=,ppid=,pgid=,uid=,rss=,command=']).splitlines():
  parts=line.split(None,5)
  if len(parts)==6:
   row=dict(zip(['pid','ppid','pgid','uid','rssKiB'],map(int,parts[:5])),command=parts[5]);row['uid']&=0xffffffff;rows.append(row)
 return rows


def child_limits():
 os.umask(0o022)
 resource.setrlimit(resource.RLIMIT_NOFILE,(4096,4096))
 resource.setrlimit(resource.RLIMIT_NPROC,(1024,1024))
 resource.setrlimit(resource.RLIMIT_FSIZE,(8*GIB,8*GIB))
 resource.setrlimit(resource.RLIMIT_CPU,(21600,21600))


def phase_journal(journal):
 if not os.path.lexists(journal):return []
 s=journal.lstat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==os.getuid(),'Controller-owned native phase journal');prior=json.loads(journal.read_bytes());need(isinstance(prior,list) and all(isinstance(r,dict) for r in prior),'Native phase journal shape');return prior


def append_phase_receipt(journal,record):
 """Volume, source and detach phases use separate Native instances on one work
 directory; every completed phase record is appended in completion order."""
 atomic_json(journal,[*phase_journal(journal),record])


class Native:
 def __init__(self,work,host):
  need(host.get('operatorQualifiedNetworkProfileSHA256')==hashlib.sha256(host.get('qualifiedNetworkProfile','').encode()).hexdigest() and host.get('networkIPCProbeQualified') is True,'Qualified operator network/owned-cache IPC profile required');self.work=work;self.host=host;self.started=time.monotonic();self.spent=0;self.receipts=[]
  self.baseline_nobody={r['pid'] for r in ps_rows() if r['uid']==host['buildUid']}
 def run(self,name,args,env,cwd,seconds,as_build=True):
  need(re.fullmatch('[a-z][a-z0-9-]{0,95}',name) and seconds>0,'Fixed native phase name and positive deadline');need(not os.path.lexists(self.work/'capture'/(name+'.log')),'Fresh native phase log')
  need(time.monotonic()-self.started<LIMITS['wholeSeconds'] and shutil.disk_usage(self.work).free>=LIMITS['minimumFreeBytes'],'Native whole/capacity admission exhausted')
  # A phase whose receipt could not be journaled is never started.
  phase_journal(self.work/'capture'/'PHASES.json')
  if as_build:
   need(self.host['buildUser']=='nobody','Unexpected build account')
   args=['/usr/bin/sudo','-n','-u','nobody','/usr/bin/env','-i',*[k+'='+v for k,v in sorted(env.items())],'/usr/bin/sandbox-exec','-p',self.host['qualifiedNetworkProfile'],*args]
  log=self.work/'capture'/(name+'.log');start=time.monotonic();record={'phase':name,'argv':args,'cwd':str(cwd),'uid':self.host['buildUid'] if as_build else os.getuid(),'success':False,'sampledAggregateRssBytes':0,'sampledCapacityGuard':True,'secondsLimit':seconds,'wholeSecondsLimit':LIMITS['wholeSeconds']}
  process=subprocess.Popen(args,cwd=cwd,env=env if not as_build else {'PATH':'/usr/bin:/bin'},stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True,preexec_fn=child_limits)
  record['pid']=process.pid;record['processGroup']=process.pid;self.receipts.append(record)
  selector=selectors.DefaultSelector();selector.register(process.stdout,selectors.EVENT_READ);code=None;primary=None
  try:
   with log.open('xb') as stream:
    while selector.get_map():
     need(time.monotonic()-start<seconds and time.monotonic()-self.started<LIMITS['wholeSeconds'],'Native phase/whole deadline')
     need(all(shutil.disk_usage(p).free>=LIMITS['minimumFreeBytes'] for p in [self.work,*self.host.get('capacityRoots',[])]),'Native backing/volume free-space reserve exhausted')
     processes=[r for r in ps_rows() if r['pgid']==process.pid or (r['uid']==self.host['buildUid'] and r['pid'] not in self.baseline_nobody)]
     rss=sum(r['rssKiB'] for r in processes)*1024;record['sampledAggregateRssBytes']=max(record['sampledAggregateRssBytes'],rss)
     need(rss<=LIMITS['sampledRssBytes'],'Sampled native RSS ceiling')
     for key,_ in selector.select(timeout=1):
      remaining=LIMITS['logBytes']-self.spent
      body=os.read(key.fileobj.fileno(),min(65536,remaining+1))
      if not body:selector.unregister(key.fileobj);continue
      stream.write(body[:remaining]);self.spent+=len(body);record['aggregateReachedLogBytes']=self.spent
      if len(body)>remaining:record['firstOmittedOverrunByteHex']=body[remaining:remaining+1].hex()
      need(self.spent<=LIMITS['logBytes'],'Native aggregate log ceiling')
    stream.flush();os.fsync(stream.fileno())
   code=process.wait(timeout=5);record['exitCode']=code
   need(time.monotonic()-start<seconds and time.monotonic()-self.started<LIMITS['wholeSeconds'],'Native phase/whole deadline')
   need(code==0,'Native phase failed: '+name)
   record['success']=True
  except BaseException as error:
   primary=error;record['primaryFailure']={'type':type(error).__name__,'reason':str(error)[:1024] if isinstance(error,ValueError) else None}
  finally:
   selector.close()
   record['ownedProcessCleanup']=cleanup_owned(process,{os.getuid(),self.host['buildUid']} if as_build else {os.getuid()},seconds=5)
   process.stdout.close()
   # A detached build-UID process is incomplete cleanup, not a permitted daemon.
   end=time.monotonic()+5
   survivors=None
   try:
    while True:
     survivors=[r for r in ps_rows() if r['uid']==self.host['buildUid'] and r['pid'] not in self.baseline_nobody]
     if not survivors or time.monotonic()>=end:break
     time.sleep(0.1)
   except BaseException as error:record['buildUidObservationError']={'type':type(error).__name__};survivors=None
   record.update(elapsedSeconds=time.monotonic()-start,log=physical_file(log),unreapedBuildUidProcesses=survivors)
   if survivors is None or survivors or not record['ownedProcessCleanup']['complete'] or record['elapsedSeconds']>=seconds or time.monotonic()-self.started>=LIMITS['wholeSeconds']:record['success']=False
   if primary is None and (record['elapsedSeconds']>=seconds or time.monotonic()-self.started>=LIMITS['wholeSeconds']):
    primary=ValueError('Native phase/whole deadline');record['primaryFailure']={'type':'ValueError','reason':str(primary)}
   # A journal read/format/write failure is kept beside the phase's own failure
   # (its exit, or the cleanup refusal below) on the in-memory receipt, and is
   # raised only when the phase and its cleanup passed. A timeout or interrupt
   # during the append is never replaced: it stops the whole controller.
   try:append_phase_receipt(self.work/'capture'/'PHASES.json',record)
   except (OSError,ValueError) as error:
    record['success']=False;record['phaseJournalFailure']={'type':type(error).__name__,'reason':str(error)[:1024] if isinstance(error,ValueError) else None}
    if isinstance(error,TimeoutError) or (primary is None and record['ownedProcessCleanup']['complete'] and survivors is not None and not survivors):raise
  if primary is not None:raise primary
  need(record['ownedProcessCleanup']['complete'],'Owned native process cleanup incomplete; trusted packaging forbidden')
  need(survivors is not None and not survivors,'Build-UID descendants remain or observation unavailable; trusted packaging forbidden')
  need(record['elapsedSeconds']<seconds and time.monotonic()-self.started<LIMITS['wholeSeconds'],'Native phase/whole deadline')
  return record
