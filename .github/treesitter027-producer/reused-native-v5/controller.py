#!/usr/bin/env python3
"""Manual operator Binaryen132 producer observation; root review before execution.

This is not a discovery/planning tool and does not claim project execution is
sandboxed. Native execution requires a reviewed workflow_dispatch action.
"""
import argparse,errno,hashlib,json,os,platform,pwd,re,resource,selectors,shutil,signal,stat,struct,subprocess,sys,tempfile,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from capsule import ROOTS,SELECTION,git_hash,load_capsule,materialize,need,pinned_object,read_physical,sha

GIB=1024**3
LIMITS={'wholeSeconds':15000,'configureSeconds':900,'buildSeconds':10800,'stripSeconds':300,'packSeconds':600,
        'logBytes':64*1024**2,'sampledRssBytes':6*GIB,'minimumFreeBytes':2*GIB,'admissionFreeBytes':12*GIB,
        'outputBytes':8*GIB,'outputFiles':50000,'sdkBytes':16*GIB,'sdkFiles':300000}
CONFIGURE=['-S','.','-B','out-arm64','-G','Ninja','-DCMAKE_BUILD_TYPE=Release','-DCMAKE_INSTALL_PREFIX=out-arm64/install','-DCMAKE_OSX_ARCHITECTURES=arm64']
BUILD=['--build','out-arm64','-v','--config','Release','--target','install']
PACK='''OSNAME=$(echo macos-14 | sed 's/-.*//')
VERSION=$GITHUB_REF_NAME
PKGNAME="binaryen-$VERSION-arm64-$OSNAME"
TARBALL=$PKGNAME.tar.gz
SHASUM=$PKGNAME.tar.gz.sha256
rm -rf binaryen-$VERSION
mv out-arm64/install binaryen-$VERSION
tar -czf $TARBALL binaryen-$VERSION
cmake -E sha256sum $TARBALL > $SHASUM
'''

def atomic_json(path,value,mode=0o600):
 body=(json.dumps(value,sort_keys=True,indent=2)+'\n').encode();temporary=path.with_suffix(path.suffix+'.next')
 descriptor=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(descriptor,'wb') as stream:os.fchmod(stream.fileno(),mode);stream.write(body);stream.flush();os.fsync(stream.fileno())
 os.replace(temporary,path)

def owned_directory(path,mode=0o755):
 path.mkdir(mode=mode);path.chmod(mode)

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

def deny_only_sudo_policy(code,stdout,stderr):
 denied=rb'User nobody is not allowed to run sudo on(?: |\n {8})[A-Za-z0-9_.-]+\.\n?'
 need(code in (0,1) and ((re.fullmatch(denied,stdout) is not None and stderr==b'') or (stdout==b'' and re.fullmatch(denied,stderr) is not None)),'Unknown or permissive nobody sudo policy; bounded raw query retained')
 return {'exitCode':code,'standaloneDenialVerified':True,'policyModified':False}

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

def input_catalog(root,maximum_bytes,maximum_files,deadline=None):
 root=Path(root).resolve(strict=True);root_stat=root.lstat();need(stat.S_ISDIR(root_stat.st_mode),'Physical input root directory required');rows=[];total=0;start=time.monotonic()
 for folder,dirs,files in os.walk(root,followlinks=False):
  for name in sorted(dirs+files):
   need(time.monotonic()-start<900 and (deadline is None or time.monotonic()<deadline),'Input catalog deadline')
   p=Path(folder)/name;s=p.lstat();item={'path':p.relative_to(root).as_posix(),'mode':stat.S_IMODE(s.st_mode),'uid':s.st_uid,'gid':s.st_gid}
   if stat.S_ISLNK(s.st_mode):item.update(type='symlink',target=os.readlink(p),resolvedPath=str(p.resolve()))
   elif stat.S_ISDIR(s.st_mode):item.update(type='directory')
   else:
    need(stat.S_ISREG(s.st_mode),'Unsupported physical input type');total+=s.st_size
    need(total<=maximum_bytes,'Input byte ceiling');item.update(type='file',**{k:v for k,v in physical_file(p,deadline).items() if k in ('bytes','sha256')})
   rows.append(item);need(len(rows)<=maximum_files,'Input entry ceiling')
 return {'root':str(root),'rootIdentity':{'mode':stat.S_IMODE(root_stat.st_mode),'uid':root_stat.st_uid,'gid':root_stat.st_gid,'device':root_stat.st_dev,'inode':root_stat.st_ino},'entries':rows,'regularBytes':total,'catalogSHA256':sha(json.dumps(rows,sort_keys=True,separators=(',',':')).encode()),'continuousImmutabilityClaimed':False}

def cmake_root_metadata(tool,record,query=capture_control_query):
 # Script mode evaluates only this fixed first-party message, without loading a
 # project, modules, compiler or SDK. Do not infer installation layout/version.
 with tempfile.TemporaryDirectory(prefix='checktrail-binaryen-cmake-root-',dir='/private/tmp') as folder:
  folder=Path(folder);folder.chmod(0o700);script=folder/'root.cmake';script.write_bytes(b'message(STATUS "CHECKTRAIL_CMAKE_ROOT=${CMAKE_ROOT}")\n');script.chmod(0o444)
  record.update({'argv':[tool['path'],'-P','<fixed-first-party-root-query>'],'scriptSHA256':sha(script.read_bytes()),'projectCompilerOrSdkExecuted':False})
  try:code,stdout,stderr=query(folder,'cmake-root',[tool['path'],'-P',str(script)],{'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'},cwd=folder)
  except BaseException as error:
   record['queryFailure']=type(error).__name__+': '+str(error)
   for stream in ['stdout','stderr']:
    raw=folder/('cmake-root.'+stream)
    if raw.is_file():
     with raw.open('rb') as f:record[stream]=f.read(65536).decode('utf8',errors='replace')
   raise
  record.update({'exitCode':code,'stdout':stdout.decode('utf8',errors='replace'),'stderr':stderr.decode('utf8',errors='replace')})
  match=re.fullmatch(rb'-- CHECKTRAIL_CMAKE_ROOT=(/[^\r\n\x00]+)\n',stdout)
  need(code==0 and stderr==b'' and match is not None,'Exact stock CMake root metadata query failed')
  selected=Path(match[1].decode('utf8'));record['reportedRoot']=str(selected);physical=selected.resolve(strict=True);record['physicalRoot']=str(physical)
  installation=Path(tool['path']).parent.parent;need(installation in physical.parents and physical.is_dir() and (physical/'Modules').is_dir(),'Reported CMake module root escaped admitted physical installation or is missing')
  need(physical in (physical/'Modules').resolve(strict=True).parents,'Physical CMake Modules directory escaped reported stock root')
  return physical

def host_admission(env,run=quick,admission=None):
 admission={} if admission is None else admission
 need(platform.system()=='Darwin' and platform.machine()=='arm64','Native Darwin ARM64 required')
 need(os.getuid()==0,'Controller must run as root; build uses the existing nobody UID')
 need(env.get('GITHUB_ACTIONS')=='true' and env.get('RUNNER_ENVIRONMENT')=='github-hosted' and env.get('RUNNER_ARCH')=='ARM64','Standard hosted ARM runner required')
 need(env.get('GITHUB_EVENT_NAME')=='workflow_dispatch' and env.get('GITHUB_REPOSITORY')=='stsepelin/checktrail','Reviewed manual repository workflow required')
 need(re.fullmatch('[0-9]+',env.get('GITHUB_RUN_ID','')) and re.fullmatch('[0-9a-f]{40}',env.get('GITHUB_SHA','')),'Exact hosted run/source identity required')
 need(re.fullmatch('20[0-9]{6}\\.[0-9]+\\.[0-9]+',env.get('ImageVersion','')),'Exact image version unavailable')
 admission.update(imageVersion=env['ImageVersion'],physicalArchitecture=platform.machine())
 developer=Path('/Applications/Xcode_16.4.app/Contents/Developer').resolve(strict=True)
 selected={**env,'DEVELOPER_DIR':str(developer)}
 admission['xcodeVersion']=run(['/usr/bin/xcodebuild','-version'],env=selected);need(admission['xcodeVersion']=='Xcode 16.4\nBuild version 16F6','Selected Xcode identity differs')
 admission['sdkVersion']=run(['/usr/bin/xcrun','--sdk','macosx','--show-sdk-version'],env=selected);need(admission['sdkVersion']=='15.5','Selected SDK version differs')
 admission['reportedSdkPath']=run(['/usr/bin/xcrun','--sdk','macosx','--show-sdk-path'],env=selected);sdk=Path(admission['reportedSdkPath']).resolve(strict=True);admission['physicalSdkPath']=str(sdk)
 need(developer in sdk.parents,'SDK escaped selected Xcode')
 need(run(['/usr/sbin/sysctl','-in','sysctl.proc_translated'],env=selected) in ('0',),'Translated execution refused')
 cpus=int(run(['/usr/sbin/sysctl','-n','hw.ncpu'],env=selected));memory=int(run(['/usr/sbin/sysctl','-n','hw.memsize'],env=selected))
 need(cpus>=3 and memory>=7*GIB,'Standard 3CPU/7GiB minimum unavailable')
 tools={};admission['physicalTools']=tools
 for name in ['cmake','ninja','git','python3']:
  found=shutil.which(name,path=env.get('PATH'));need(found,'Required stock tool missing: '+name);tools[name]=physical_file(found)
 for name in ['clang','clang++','ld','strip','ar','ranlib']:
  tools[name]=physical_file(run(['/usr/bin/xcrun','--find',name],env=selected))
 for name,path in {'bash':'/bin/bash','find':'/usr/bin/find','tar':'/usr/bin/tar','sed':'/usr/bin/sed','rm':'/bin/rm','mv':'/bin/mv','sudo':'/usr/bin/sudo','env':'/usr/bin/env','sandbox-exec':'/usr/bin/sandbox-exec'}.items():tools[name]=physical_file(path)
 tools['cc-shim']=physical_file('/usr/bin/cc');tools['cxx-shim']=physical_file('/usr/bin/c++')
 admission['cmakeVersion']=run([tools['cmake']['path'],'--version']);need(admission['cmakeVersion'].splitlines()[0]=='cmake version 4.4.5','Selected CMake identity differs')
 admission['ninjaVersion']=run([tools['ninja']['path'],'--version']);need(admission['ninjaVersion']=='1.13.2','Selected Ninja identity differs')
 admission['cmakeRootQuery']={};cmake_modules=cmake_root_metadata(tools['cmake'],admission['cmakeRootQuery'])
 admission['reportedGitExecPath']=run([tools['git']['path'],'--exec-path']);git_exec=Path(admission['reportedGitExecPath']).resolve(strict=True);admission['physicalGitExecPath']=str(git_exec);need(Path(tools['git']['path']).parent.parent in git_exec.parents,'Git helper tree escaped admitted installation')
 nobody=pwd.getpwnam('nobody');need(nobody.pw_uid not in (0,int(env.get('SUDO_UID','0'))),'Distinct existing build UID required')
 toolchain=next((p for p in Path(tools['clang']['path']).parents if p.name.endswith('.xctoolchain')),None);need(toolchain and developer in toolchain.parents,'Selected compiler toolchain escaped Xcode')
 protected=[env[k] for k in ['GITHUB_WORKSPACE','RUNNER_TEMP','GITHUB_ENV','GITHUB_OUTPUT','GITHUB_PATH','GITHUB_STATE','GITHUB_STEP_SUMMARY'] if env.get(k)]
 os_version=run(['/usr/bin/sw_vers','-productVersion']);need(os_version.split('.')[0]=='15','Selected macOS family differs')
 return {'runId':env['GITHUB_RUN_ID'],'sourceCommit':env['GITHUB_SHA'],'imageVersion':env['ImageVersion'],'imageOS':env.get('ImageOS'),'osVersion':os_version,'arch':'arm64','cpus':cpus,'memoryBytes':memory,'developerDir':str(developer),'sdk':str(sdk),'toolchain':str(toolchain),'auxiliaryToolTrees':{'cmakeModules':str(cmake_modules.resolve()),'gitExec':str(git_exec)},'sdkBuild':run(['/usr/bin/xcrun','--sdk','macosx','--show-sdk-build-version'],env=selected),'tools':tools,'buildUser':'nobody','buildUid':nobody.pw_uid,'buildGid':nobody.pw_gid,'buildHome':nobody.pw_dir,'protectedWorkflowPaths':protected,'selectedProducerBuildSDKClosureAssessed':False}

def ps_rows():
 rows=[]
 for line in quick(['/bin/ps','-axo','pid=,ppid=,pgid=,uid=,rss=,command=']).splitlines():
  parts=line.split(None,5)
  if len(parts)==6:
   row=dict(zip(['pid','ppid','pgid','uid','rssKiB'],map(int,parts[:5])),command=parts[5]);row['uid']&=0xffffffff;rows.append(row)
 return rows

def child_limits():
 os.umask(0o022)
 resource.setrlimit(resource.RLIMIT_NOFILE,(256,256))
 resource.setrlimit(resource.RLIMIT_NPROC,(256,256))
 resource.setrlimit(resource.RLIMIT_FSIZE,(GIB,GIB))
 resource.setrlimit(resource.RLIMIT_CPU,(12000,12000))

class Native:
 def __init__(self,work,host):
  self.work=work;self.host=host;self.started=time.monotonic();self.spent=0;self.receipts=[]
  self.baseline_nobody={r['pid'] for r in ps_rows() if r['uid']==host['buildUid']}
 def run(self,name,args,env,cwd,seconds,as_build=True):
  need(time.monotonic()-self.started<LIMITS['wholeSeconds'] and shutil.disk_usage(self.work).free>=LIMITS['minimumFreeBytes'],'Native whole/capacity admission exhausted')
  if as_build:
   need(self.host['buildUser']=='nobody','Unexpected build account')
   args=['/usr/bin/sudo','-n','-u','nobody','/usr/bin/env','-i',*[k+'='+v for k,v in sorted(env.items())],'/usr/bin/sandbox-exec','-p','(version 1)(allow default)(deny network*)',*args]
  log=self.work/'capture'/(name+'.log');start=time.monotonic();record={'phase':name,'argv':args,'cwd':str(cwd),'uid':self.host['buildUid'] if as_build else 0,'success':False,'sampledAggregateRssBytes':0,'sampledCapacityGuard':True,'secondsLimit':seconds,'wholeSecondsLimit':LIMITS['wholeSeconds']}
  process=subprocess.Popen(args,cwd=cwd,env=env if not as_build else {'PATH':'/usr/bin:/bin'},stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True,preexec_fn=child_limits)
  record['pid']=process.pid;record['processGroup']=process.pid;self.receipts.append(record)
  selector=selectors.DefaultSelector();selector.register(process.stdout,selectors.EVENT_READ);code=None;primary=None
  try:
   with log.open('xb') as stream:
    while selector.get_map():
     need(time.monotonic()-start<seconds and time.monotonic()-self.started<LIMITS['wholeSeconds'],'Native phase/whole deadline')
     need(shutil.disk_usage(self.work).free>=LIMITS['minimumFreeBytes'],'Native free-space reserve exhausted')
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
   # Preserve Tree's original distinct-build-UID final observation as well as
   # independently observing/reaping the exact Popen process group.
   end=time.monotonic()+5;survivors=None
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
   atomic_json(self.work/'capture'/'PHASES.json',self.receipts)
  if primary is not None:raise primary
  need(record['ownedProcessCleanup']['complete'],'Owned native process cleanup incomplete; trusted packaging forbidden')
  need(survivors is not None and not survivors,'Build-UID descendants remain or observation unavailable; trusted packaging forbidden')
  need(record['elapsedSeconds']<seconds and time.monotonic()-self.started<LIMITS['wholeSeconds'],'Native phase/whole deadline')
  return record

def build_environment(work,source,host):
 tools=host['tools'];paths=list(dict.fromkeys([str(Path(tools[k]['path']).parent) for k in ['cmake','ninja','git','python3','clang']]+['/usr/bin','/bin','/usr/sbin','/sbin']))
 result={'PATH':':'.join(paths),'HOME':host['buildHome'],'TMPDIR':str(work/'tmp'),'XDG_CACHE_HOME':str(work/'cache'),'LANG':'en_US.UTF-8','LC_ALL':'en_US.UTF-8','DEVELOPER_DIR':host['developerDir'],'SDKROOT':host['sdk'],'GITHUB_REF_NAME':'version_132','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':str(work/'control'/'git-safe.config'),'GIT_TERMINAL_PROMPT':'0','GIT_OPTIONAL_LOCKS':'0'}
 return result

def verify_pack_tools(host,env):
 bindings={}
 for name in ['rm','mv','tar','sed','cmake']:
  need(name in host['tools'],'Original PACK external tool is not admitted: '+name)
  found=shutil.which(name,path=env['PATH']);need(found is not None,'Original PACK external is unavailable on fixed build PATH: '+name)
  actual=physical_file(found);need(actual==host['tools'][name],'Original PACK external resolved to a changed or foreign physical tool: '+name)
  bindings[name]={'resolvedFromFixedBuildPATH':found,'physicalTool':actual}
 return bindings

def source_frame(source,manifest):
 result=[]
 for root in manifest['roots']:
  base=source if root['mountPath']=='.' else source/root['mountPath']
  for row in root['files']:
   p=base/row['path'];s=p.lstat()
   if row['mode']=='120000':need(stat.S_ISLNK(s.st_mode),'Source symlink type changed');body=os.readlink(p).encode()
   else:
    need(stat.S_ISREG(s.st_mode) and s.st_nlink==1,'Source file type/link changed');body=read_physical(p)
    need(stat.S_IMODE(s.st_mode)==(0o755 if row['mode']=='100755' else 0o644),'Source mode changed')
   need(git_hash('blob',body)==row['gitBlob'],'Source input changed')
   result.append({'root':root['id'],'path':row['path'],'sha256':sha(body),'bytes':len(body),'uid':s.st_uid,'gid':s.st_gid})
 return result

def permission_admission(work,source,manifest,host,env,native,input_catalogs):
 paths=set();read_paths=set();canaries=[]
 for folder,dirs,files in os.walk(source,followlinks=False):
  paths.add(folder);read_paths.add(folder)
  for name in dirs+files:
   p=Path(folder)/name
   if not p.is_symlink():paths.add(str(p));read_paths.add(str(p))
 for root in manifest['roots']:
  base=source if root['mountPath']=='.' else source/root['mountPath'];p=base/'.checktrail-write-guard';p.write_bytes(b'original permission control\n');p.chmod(0o644);canaries.append(str(p))
 for tool in host['tools'].values():
  p=Path(tool['path']);paths.add(str(p));paths.update(str(x) for x in p.parents)
 for catalog in input_catalogs:
  paths.add(catalog['root']);paths.update(str(x) for x in Path(catalog['root']).parents)
  for row in catalog['entries']:
   p=Path(catalog['root'])/row['path'];paths.add(str(p))
   if row['type']=='symlink' and p.exists():
    resolved=p.resolve();paths.add(str(resolved));paths.update(str(x) for x in resolved.parents)
 paths.add(str(work/'control'));paths.add(host['sdk']);paths.add(host['developerDir'])
 paths.update(host['protectedWorkflowPaths'])
 for p in (work/'control').iterdir():paths.add(str(p))
 # The build directory is the sole writable source-tree exception.
 paths={p for p in paths if p!=str(source/'out-arm64') and not p.startswith(str(source/'out-arm64')+'/')}
 request=work/'control'/'permission-inputs.json';paths.add(str(request));read_paths.add(str(request));read_paths.add(str(work/'control'/'git-safe.config'))
 payload={'paths':sorted(paths),'readPaths':sorted(read_paths),'canaries':canaries,'expectedUid':host['buildUid']}
 atomic_json(request,payload,mode=0o444)
 probe='''import errno,json,os,sys
with open(sys.argv[1]) as stream:v=json.load(stream)
assert os.getuid()==v['expectedUid']
assert not [p for p in v['readPaths'] if not os.access(p,os.R_OK)],'required source/request is unreadable'
assert not [p for p in v['paths'] if os.access(p,os.W_OK)],'protected file or parent writable'
count=0
for p in v['canaries']:
 for action in [lambda:open(p,'ab'),lambda:os.unlink(p),lambda:os.rename(p,p+'.renamed'),lambda:open(p+'.new','xb')]:
  try:r=action()
  except OSError as e:assert e.errno in (errno.EACCES,errno.EPERM);count+=1
  else:
   if hasattr(r,'close'):r.close()
   raise AssertionError('source parent replacement/write unexpectedly permitted')
print(json.dumps({'uid':os.getuid(),'protectedPaths':len(v['paths']),'directDenials':count}))
'''
 try:native.run('permission-counterfactuals',[host['tools']['python3']['path'],'-I','-c',probe,str(work/'control'/'permission-inputs.json')],env,source,120)
 finally:
  for p in canaries:Path(p).unlink(missing_ok=True)

def freeze_output(root,build_uid):
 need(root==root.resolve() and root.is_dir(),'Physical installed output required')
 entries=[]
 for folder,dirs,files in os.walk(root,followlinks=False):
  for name in dirs+files:
   p=Path(folder)/name;s=p.lstat();need(s.st_uid==build_uid and (stat.S_ISDIR(s.st_mode) or s.st_nlink==1),'Foreign or hardlinked output')
   need(not s.st_mode&0o002,'World-writable output refused')
   if p.is_symlink():need(root in p.resolve(strict=True).parents,'Installed symlink escaped output')
   else:need(stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode),'Unsupported output type')
   entries.append(p)
 for p in entries:os.lchown(p,0,0)
 os.chown(root,0,0)

def macho_identity(path,kind):
 path=Path(path);pin=physical_file(path)
 with path.open('rb') as stream:
  header=stream.read(32);need(len(header)==32,'Short native Mach-O header')
  magic,cpu,subtype,filetype,count,size,flags,reserved=struct.unpack('<IiiIIIII',header)
  need(magic==0xfeedfacf and cpu==0x0100000c and subtype==0 and filetype==kind,'Expected thin native ARM64 output')
  need(0<count<=1000 and 0<size<=16*1024**2 and 32+size<=pin['bytes'],'Malformed native load commands')
  commands=stream.read(size);offset=0;versions=[]
  for _ in range(count):
   need(offset+8<=len(commands),'Missing Mach-O command');command,length=struct.unpack_from('<II',commands,offset)
   need(length>=8 and length%4==0 and offset+length<=len(commands),'Invalid Mach-O command length')
   if command==0x32:
    need(length>=24,'Short build-version command');platform_id,minimum,sdk,_=struct.unpack_from('<IIII',commands,offset+8)
    need(platform_id==1,'Expected macOS build platform');versions.append({'minimumOS':minimum,'sdk':sdk})
   offset+=length
  need(offset==len(commands) and len(versions)==1,'Ambiguous/missing actual build version')
 return {**pin,'cpuType':cpu,'cpuSubtype':subtype,'fileType':filetype,'buildVersion':versions[0],'binaryExecuted':False}

def validate_cache(text,source,host):
 values={}
 for line in text.splitlines():
  match=re.fullmatch('([A-Z_]+):[A-Z_]+=(.*)',line)
  if match:
   need(match[1] not in values,'Duplicate CMake cache key');values[match[1]]=match[2]
 for key in ['BUILD_TESTS','BUILD_FUZZTEST','CMAKE_BUILD_TYPE','CMAKE_C_COMPILER','CMAKE_CXX_COMPILER','CMAKE_OSX_SYSROOT','CMAKE_OSX_ARCHITECTURES','CMAKE_INSTALL_PREFIX']:need(key in values,'Generated compiler/sysroot metadata missing: '+key)
 need(values['BUILD_TESTS']=='ON' and values['BUILD_FUZZTEST']=='OFF' and values['CMAKE_BUILD_TYPE']=='Release','Original build defaults differ')
 need(values['CMAKE_OSX_ARCHITECTURES']=='arm64','Selected architecture differs')
 need(Path(values['CMAKE_OSX_SYSROOT']).resolve()==Path(host['sdk']),'Selected compiler sysroot differs')
 need(Path(values['CMAKE_INSTALL_PREFIX']).resolve()==source/'out-arm64'/'install','Selected install prefix differs')
 for key,allowed in [('CMAKE_C_COMPILER',['clang','cc-shim']),('CMAKE_CXX_COMPILER',['clang++','cxx-shim'])]:
  candidate=Path(values[key]).resolve();need(str(candidate) in {host['tools'][n]['path'] for n in allowed},'Compiler driver escaped admitted stock tools')
 return values

def observe(args):
 env=dict(os.environ)
 need(os.getuid()==0 and env.get('GITHUB_ACTIONS')=='true' and env.get('GITHUB_EVENT_NAME')=='workflow_dispatch' and env.get('GITHUB_REPOSITORY')=='stsepelin/checktrail' and re.fullmatch('[0-9]+',env.get('GITHUB_RUN_ID','')) and re.fullmatch('[0-9a-f]{40}',env.get('GITHUB_SHA','')),'Exact hosted operator context before admission evidence write')
 runner_temp=Path(env.get('RUNNER_TEMP',''));need(runner_temp.is_absolute() and runner_temp==runner_temp.resolve(strict=True) and runner_temp.is_dir() and runner_temp.stat().st_uid in (0,int(env.get('SUDO_UID','0'))),'Physical exact runner-owned temporary root required')
 admission_file=runner_temp/'binaryen-host-admission.json';need(not os.path.lexists(admission_file),'Fresh early host admission evidence required')
 admission={'schemaVersion':1,'runId':env['GITHUB_RUN_ID'],'sourceCommit':env['GITHUB_SHA'],'complete':False,'originalProducerExecuted':False}
 try:
  host=host_admission(env,admission=admission);admission['complete']=True
 except BaseException as error:
  admission['failure']=type(error).__name__+': '+str(error);raise
 finally:atomic_json(admission_file,admission,mode=0o644)
 work=Path(args.work)
 need(work.parent==Path('/private/tmp') and re.fullmatch('checktrail-binaryen-'+host['runId']+'-[a-z0-9]{8,32}',work.name),'Owned work namespace required')
 need(not work.exists() and shutil.disk_usage(work.parent).free>=LIMITS['admissionFreeBytes'],'Fresh namespace/capacity required')
 manifest,objects,facts=load_capsule(Path(args.capsule),args.sha256,args.bytes)
 owned_directory(work)
 for name in ['control','capture']:
  owned_directory(work/name,0o700 if name=='capture' else 0o755)
 for name in ['tmp','cache']:
  p=work/name;owned_directory(p,0o700);os.chown(p,host['buildUid'],host['buildGid'])
 for name in ['empty-home','empty-hooks']:owned_directory(work/'control'/name)
 for file in [Path(__file__),Path(__file__).with_name('capsule.py')]:
  target=work/'control'/file.name;target.write_bytes(read_physical(file.resolve()));target.chmod(0o444)
 native=Native(work,host);deadline=native.started+LIMITS['wholeSeconds']
 result={'schemaVersion':1,'selection':SELECTION,'host':host,'limits':LIMITS,'complete':False,'producerExecuted':False,'gateAComplete':False,'fullOriginalNoticeClosure':False,'historicalArtifactEquality':False,'upstreamTestsExecuted':False,'sourcePublicationAuthorized':False}
 atomic_json(work/'control'/'OWNERSHIP.json',{'selection':SELECTION,'work':str(work),'runId':host['runId'],'sourceCommit':host['sourceCommit'],'buildUid':host['buildUid'],'baselineBuildUidPids':sorted(native.baseline_nobody)})
 try:
  atomic_json(work/'capture'/'HOST.json',host)
  policy=capture_control_query(work/'capture','sudo-policy',['/usr/bin/sudo','-n','-l','-U','nobody'],{'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'})
  atomic_json(work/'capture'/'SUDO-POLICY.json',deny_only_sudo_policy(*policy))
  sdk_before=input_catalog(Path(host['sdk']),LIMITS['sdkBytes'],LIMITS['sdkFiles'],deadline);atomic_json(work/'capture'/'SDK-BEFORE.json',sdk_before)
  toolchain_before=input_catalog(Path(host['toolchain']),LIMITS['sdkBytes'],LIMITS['sdkFiles'],deadline);atomic_json(work/'capture'/'TOOLCHAIN-BEFORE.json',toolchain_before)
  auxiliary_before={key:input_catalog(Path(path),2*GIB,50000,deadline) for key,path in host['auxiliaryToolTrees'].items()};atomic_json(work/'capture'/'AUXILIARY-TOOLS-BEFORE.json',auxiliary_before)
  source=work/'source'
  materialize(manifest,objects,facts,source,host['tools']['git']['path'],lambda a,**k:quick(a,**k),work/'control')
  # Within the source tree, root owns every input/parent; only out-arm64 is writable.
  out=source/'out-arm64';need(not out.exists(),'Build output already present');owned_directory(out);os.chown(out,host['buildUid'],host['buildGid'])
  safe='[safe]\n'+''.join(' directory = '+str(source if r['mountPath']=='.' else source/r['mountPath'])+'\n' for r in manifest['roots'])+'[core]\n hooksPath = '+str(work/'control'/'empty-hooks')+'\n fsmonitor = false\n[protocol]\n allow = never\n'
  (work/'control'/'git-safe.config').write_text(safe);(work/'control'/'git-safe.config').chmod(0o444)
  env=build_environment(work,source,host)
  before=source_frame(source,manifest);atomic_json(work/'capture'/'SOURCE-BEFORE.json',before)
  permission_admission(work,source,manifest,host,env,native,[sdk_before,toolchain_before,*auxiliary_before.values()])
  network_probe="import errno,json,socket; s=socket.socket(); code=s.connect_ex(('127.0.0.1',9)); s.close(); assert code in (errno.EPERM,errno.EACCES),code; print(json.dumps({'networkDenialErrno':code}))"
  native.run('network-denial',[host['tools']['python3']['path'],'-I','-c',network_probe],env,source,30)
  native.run('git-metadata',[host['tools']['git']['path'],'describe','--tags','--exact-match','HEAD'],env,source,30)
  need((work/'capture'/'git-metadata.log').read_bytes()==b'version_132\n','Original root Git tag result differs')
  native.run('git-submodule-metadata',[host['tools']['git']['path'],'submodule','status','--recursive'],env,source,60)
  lines=(work/'capture'/'git-submodule-metadata.log').read_text().splitlines();observed={}
  for line in lines:
   match=re.fullmatch(' ([a-f0-9]{40}) ([A-Za-z0-9_./-]+)(?: \\(.*\\))?',line);need(match is not None,'Submodule checkout is incomplete or changed')
   need(match[2] not in observed,'Duplicate observed submodule');observed[match[2]]=match[1]
  need(observed=={r['mountPath']:r['commit'] for r in manifest['roots'][1:]},'Recursive submodule metadata differs')
  result['producerExecuted']=True
  native.run('configure',[host['tools']['cmake']['path'],*CONFIGURE],env,source,LIMITS['configureSeconds'])
  cache=(out/'CMakeCache.txt').read_text();generated=validate_cache(cache,source,host);atomic_json(work/'capture'/'SELECTED-CMAKE-INPUTS.json',generated)
  for name in ['CMakeCache.txt']:
   shutil.copyfile(out/name,work/'capture'/name)
  for p in out.glob('CMakeFiles/*/CMake*Compiler.cmake'):
   need(p.is_file() and p.stat().st_size<=4*1024**2,'Compiler metadata limit');shutil.copyfile(p,work/'capture'/p.name)
  native.run('build-install',[host['tools']['cmake']['path'],*BUILD],env,source,LIMITS['buildSeconds'])
  install=out/'install';need(install==install.resolve() and install.is_dir(),'Install path escaped build output')
  # Strip stays at the unprivileged build UID; the root pack phase follows quiescence.
  need(list(source.glob('out*/install'))==[install],'Original strip glob admitted another tree')
  native.run('strip',[host['tools']['find']['path'],'out-arm64/install/','-type','f','-perm','-u=x','-exec',host['tools']['strip']['path'],'-x','{}','+'],env,source,LIMITS['stripSeconds'])
  need(not [r for r in ps_rows() if r['uid']==host['buildUid'] and r['pid'] not in native.baseline_nobody],'Build UID not quiescent before pack')
  freeze_output(out,host['buildUid'])
  frozen_paths=[str(out)]
  for folder,dirs,files in os.walk(out,followlinks=False):frozen_paths.extend(str(Path(folder)/x) for x in dirs+files)
  atomic_json(work/'control'/'frozen-output-paths.json',frozen_paths,mode=0o444)
  frozen_probe="import json,os,sys; from pathlib import Path; paths=json.loads(Path(sys.argv[1]).read_text()); assert not [p for p in paths if os.access(p,os.W_OK)],'frozen output writable'; print(len(paths))"
  native.run('frozen-output-denial',[host['tools']['python3']['path'],'-I','-c',frozen_probe,str(work/'control'/'frozen-output-paths.json')],env,source,120)
  for name in ['binaryen-version_132','binaryen-version_132-arm64-macos.tar.gz','binaryen-version_132-arm64-macos.tar.gz.sha256']:need(not (source/name).exists(),'Original pack target collision')
  pack_before=verify_pack_tools(host,env);atomic_json(work/'capture'/'PACK-TOOLS-BEFORE.json',pack_before)
  native.run('pack',[host['tools']['bash']['path'],'-euo','pipefail','-c',PACK],env,source,LIMITS['packSeconds'],as_build=False)
  pack_after=verify_pack_tools(host,env);need(pack_before==pack_after,'Original PACK external tool bindings changed');atomic_json(work/'capture'/'PACK-TOOLS-AFTER.json',pack_after)
  archive=source/'binaryen-version_132-arm64-macos.tar.gz';artifact=physical_file(archive)
  checksum=(source/'binaryen-version_132-arm64-macos.tar.gz.sha256').read_text().split()
  need(checksum==[artifact['sha256'],archive.name],'Original checksum output differs')
  after=source_frame(source,manifest);need(before==after,'Native build changed original source inputs');atomic_json(work/'capture'/'SOURCE-AFTER.json',after)
  sdk_after=input_catalog(Path(host['sdk']),LIMITS['sdkBytes'],LIMITS['sdkFiles'],deadline);need(sdk_before==sdk_after,'Selected SDK bytes/metadata changed');atomic_json(work/'capture'/'SDK-AFTER.json',sdk_after)
  toolchain_after=input_catalog(Path(host['toolchain']),LIMITS['sdkBytes'],LIMITS['sdkFiles'],deadline);need(toolchain_before==toolchain_after,'Selected toolchain bytes/metadata changed');atomic_json(work/'capture'/'TOOLCHAIN-AFTER.json',toolchain_after)
  auxiliary_after={key:input_catalog(Path(path),2*GIB,50000,deadline) for key,path in host['auxiliaryToolTrees'].items()};need(auxiliary_before==auxiliary_after,'Selected tool module/helper tree changed');atomic_json(work/'capture'/'AUXILIARY-TOOLS-AFTER.json',auxiliary_after)
  for tool in host['tools'].values():need(physical_file(tool['path'])==tool,'Selected tool changed')
  output=input_catalog(source/'binaryen-version_132',LIMITS['outputBytes'],LIMITS['outputFiles'],deadline);atomic_json(work/'capture'/'OUTPUT.json',output)
  (work/'capture'/'source-notices').mkdir()
  notice_index=[]
  for root in manifest['roots']:
   for notice in root['notices']:
    body=pinned_object(objects,notice['body']);target=work/'capture'/'source-notices'/notice['body']['sha256']
    if not target.exists():target.write_bytes(body)
    notice_index.append({'repository':root['repository'],'commit':root['commit'],'path':notice['path'],'body':notice['body'],'outputComponentRelationship':'unassessed'})
  atomic_json(work/'capture'/'SOURCE-NOTICE-INDEX.json',notice_index)
  shutil.copyfile(archive,work/'capture'/archive.name)
  binaries={'wasm-opt':macho_identity(source/'binaryen-version_132'/'bin'/'wasm-opt',2),'libbinaryen':macho_identity(source/'binaryen-version_132'/'lib'/'libbinaryen.dylib',6)}
  need(time.monotonic()<deadline,'Native observation capture deadline')
  result.update(complete=True,artifact=artifact,nativeOutputs=binaries,sourceUnchanged=True,selectedSdkUnchanged=True,selectedToolchainUnchanged=True,toolsUnchanged=True,sourceNoticeBodiesRetained=True,buildTestsCompiledDefaultPreserved=True,packOrchestration='Original static packaging commands executed as controller root after all build-UID processes reaped and output ownership frozen. Archive ownership differs from historical publisher; no equality claimed.')
 except BaseException as error:
  result['failure']=type(error).__name__+': '+str(error)
  raise
 finally:
  result['phases']=native.receipts;result['elapsedSeconds']=time.monotonic()-native.started
  result['remainingBuildUidProcesses']=[r for r in ps_rows() if r['uid']==host['buildUid'] and r['pid'] not in native.baseline_nobody]
  if result['remainingBuildUidProcesses']:result['complete']=False
  atomic_json(work/'capture'/'TERMINAL.json',result)
 return result

def owned_marker(work,env):
 need(os.getuid()==0 and env.get('GITHUB_ACTIONS')=='true' and env.get('GITHUB_EVENT_NAME')=='workflow_dispatch','Reviewed hosted operator cleanup required')
 work=Path(work);run=env.get('GITHUB_RUN_ID','');need(re.fullmatch('[0-9]+',run),'Missing cleanup run identity')
 need(work.parent==Path('/private/tmp') and re.fullmatch('checktrail-binaryen-'+run+'-[a-z0-9]{8,32}',work.name),'Foreign cleanup namespace')
 if not work.exists():return None
 need(work==work.resolve() and work.stat().st_uid==0,'Cleanup root is not physical/owned')
 marker=work/'control'/'OWNERSHIP.json';need(marker.stat().st_uid==0,'Cleanup marker owner differs')
 value=json.loads(read_physical(marker))
 need(value['selection']==SELECTION and value['work']==str(work) and value['runId']==run and value['sourceCommit']==env.get('GITHUB_SHA'),'Cleanup owner binding differs')
 survivors=[r for r in ps_rows() if r['uid']==value['buildUid'] and r['pid'] not in value['baselineBuildUidPids']]
 need(not survivors,'Unreaped build-UID process; retain workspace until runner disposal')
 return value

def stage_capture(work,env):
 work=Path(work);marker=owned_marker(work,env)
 if marker is None:return {'staged':False,'reason':'owned namespace was never created'}
 capture=work/'capture';need(capture==capture.resolve() and capture.is_dir() and capture.stat().st_uid==0,'Physical controller-owned capture required')
 paths=[capture];total=0
 for folder,dirs,files in os.walk(capture,followlinks=False):
  for name in dirs+files:
   p=Path(folder)/name;s=p.lstat();need(s.st_uid==0 and not p.is_symlink(),'Foreign or symbolic capture path')
   need(stat.S_ISDIR(s.st_mode) or (stat.S_ISREG(s.st_mode) and s.st_nlink==1),'Unsupported capture path')
   total+=s.st_size if stat.S_ISREG(s.st_mode) else 0;paths.append(p)
   need(total<=LIMITS['outputBytes']+512*1024**2 and len(paths)<=LIMITS['outputFiles']+2000,'Upload staging bounds')
 # Validate the entire set before changing any modes. Never follow source links.
 for p in reversed(paths):p.chmod(0o755 if p.is_dir() else 0o444)
 return {'staged':True,'filesAndDirectories':len(paths),'bytes':total,'buildUidQuiescent':True,'sdkOrToolPermissionsModified':False}

def cleanup(work,env):
 work=Path(work);marker=owned_marker(work,env)
 if marker is None:return {'deleted':False,'reason':'owned namespace was never created'}
 previous=signal.getsignal(signal.SIGALRM)
 need(signal.getitimer(signal.ITIMER_REAL)==(0.0,0.0),'Existing cleanup alarm refused')
 def elapsed(_number,_frame):raise TimeoutError('Owned workspace cleanup deadline')
 signal.signal(signal.SIGALRM,elapsed);signal.setitimer(signal.ITIMER_REAL,120)
 try:shutil.rmtree(work)
 finally:signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,previous)
 need(not work.exists(),'Owned workspace cleanup incomplete');return {'deleted':True,'namespace':str(work),'sdkOrToolInputsDeleted':False}

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('mode',choices=['validate','observe','stage-capture','cleanup']);p.add_argument('--capsule');p.add_argument('--sha256');p.add_argument('--bytes',type=int);p.add_argument('--work')
 a=p.parse_args()
 if a.mode=='cleanup':need(a.work,'Owned cleanup path required');print(json.dumps(cleanup(a.work,dict(os.environ))));return
 if a.mode=='stage-capture':need(a.work,'Owned staging path required');print(json.dumps(stage_capture(a.work,dict(os.environ))));return
 need(a.capsule and a.sha256 and a.bytes,'Pinned capsule identity required')
 if a.mode=='validate':
  _,_,facts=load_capsule(Path(a.capsule),a.sha256,a.bytes);print(json.dumps({'selectedRoots':facts['roots'],'ordinaryFiles':facts['files'],'sourceExtracted':False,'producerExecuted':False}));return
 need(a.work,'Native observation requires a fresh owned work namespace')
 previous={number:signal.getsignal(number) for number in [signal.SIGTERM,signal.SIGINT]}
 def stopped(number,_frame):raise InterruptedError('Operator/runner signal '+str(number))
 for number in previous:signal.signal(number,stopped)
 try:
  result=observe(a);print(json.dumps({k:v for k,v in result.items() if k!='phases'}));need(result['complete'],'Producer observation incomplete')
 finally:
  for number,handler in previous.items():signal.signal(number,handler)

if __name__=='__main__':main()
