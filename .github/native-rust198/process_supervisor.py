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


def capture_control_query(capture,name,args,env,seconds=30,cwd=None):
 need(re.fullmatch('[a-z][a-z-]+',name),'Fixed controller query name required')
 paths=[capture/(name+'.stdout'),capture/(name+'.stderr')];started=time.monotonic();code=None;timed_out=False
 with paths[0].open('xb') as stdout,paths[1].open('xb') as stderr:
  process=subprocess.Popen(args,env=env,cwd=cwd,stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr,start_new_session=True,preexec_fn=metadata_query_limits)
  try:
   try:code=process.wait(timeout=seconds)
   except subprocess.TimeoutExpired:timed_out=True
  finally:
   try:os.killpg(process.pid,signal.SIGTERM)
   except ProcessLookupError:pass
   try:process.wait(timeout=2)
   except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=2)
  stdout.flush();stderr.flush();os.fsync(stdout.fileno());os.fsync(stderr.fileno())
 record={'argv':args,'exitCode':code,'timedOut':timed_out,'elapsedSeconds':time.monotonic()-started,'maximumBytesPerStream':65536,'streams':[physical_file(p) for p in paths]}
 atomic_json(capture/(name+'.json'),record)
 need(not timed_out and record['elapsedSeconds']<seconds,'Controller metadata query deadline')
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


class Native:
 def __init__(self,work,host):
  need(host.get('operatorQualifiedNetworkProfileSHA256')==hashlib.sha256(host.get('qualifiedNetworkProfile','').encode()).hexdigest() and host.get('networkIPCProbeQualified') is True,'Qualified operator network/owned-cache IPC profile required');self.work=work;self.host=host;self.started=time.monotonic();self.spent=0;self.receipts=[]
  self.baseline_nobody={r['pid'] for r in ps_rows() if r['uid']==host['buildUid']}
 def run(self,name,args,env,cwd,seconds,as_build=True):
  need(re.fullmatch('[a-z][a-z0-9-]{0,95}',name) and seconds>0,'Fixed native phase name and positive deadline');need(not os.path.lexists(self.work/'capture'/(name+'.log')),'Fresh native phase log')
  need(time.monotonic()-self.started<LIMITS['wholeSeconds'] and shutil.disk_usage(self.work).free>=LIMITS['minimumFreeBytes'],'Native whole/capacity admission exhausted')
  if as_build:
   need(self.host['buildUser']=='nobody','Unexpected build account')
   args=['/usr/bin/sudo','-n','-u','nobody','/usr/bin/env','-i',*[k+'='+v for k,v in sorted(env.items())],'/usr/bin/sandbox-exec','-p',self.host['qualifiedNetworkProfile'],*args]
  log=self.work/'capture'/(name+'.log');start=time.monotonic();record={'phase':name,'argv':args,'cwd':str(cwd),'uid':self.host['buildUid'] if as_build else os.getuid(),'success':False,'sampledAggregateRssBytes':0,'sampledCapacityGuard':True}
  process=subprocess.Popen(args,cwd=cwd,env=env if not as_build else {'PATH':'/usr/bin:/bin'},stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True,preexec_fn=child_limits)
  record['pid']=process.pid;record['processGroup']=process.pid;self.receipts.append(record)
  selector=selectors.DefaultSelector();selector.register(process.stdout,selectors.EVENT_READ);code=None
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
  finally:
   selector.close()
   try:os.killpg(process.pid,signal.SIGTERM)
   except ProcessLookupError:pass
   try:process.wait(timeout=5)
   except subprocess.TimeoutExpired:
    os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=5)
   process.stdout.close()
   # A detached build-UID process is incomplete cleanup, not a permitted daemon.
   end=time.monotonic()+5
   while True:
    survivors=[r for r in ps_rows() if r['uid']==self.host['buildUid'] and r['pid'] not in self.baseline_nobody]
    if not survivors or time.monotonic()>=end:break
    time.sleep(0.1)
   record.update(elapsedSeconds=time.monotonic()-start,log=physical_file(log),unreapedBuildUidProcesses=survivors)
   if survivors:record['success']=False
   atomic_json(self.work/'capture'/'PHASES.json',self.receipts)
   need(not survivors,'Build-UID descendants remain; trusted packaging forbidden')
  return record
