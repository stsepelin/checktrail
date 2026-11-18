"""Finite Xcode26.2 name/type metadata only; never opens original regular bodies.
A model/CLI argument cannot authorize SDK/native execution. This helper provides
no such execution path. Future hosted startup/publication needs operator review.
"""
from pathlib import Path
from contextlib import ExitStack
from dataclasses import dataclass,replace
import argparse,hashlib,json,os,platform,re,signal,stat,sys,time
SELECTED_APP=Path('/Applications/Xcode_26.2.app')
PROFILE_SHA256='37e662b3341adf7b34f4a7fcb795efc77ddbf3b605a58da060e3b8b39ddffbbd'
SOURCE_COHORT_SHA256='25b7d801f3c41bc0d3c413a015500f09e9777ecf3181c63ad11f50dbcd58037e'
ORIGINAL_SELECTOR='Contents/Resources/English.lproj/License.rtf'
STDOUT_RESERVE=4096
FAILURE_RESERVE=4096
@dataclass(frozen=True)
class Policy:
 directories:int=66
 localizations:int=64
 entries:int=4096
 output_bytes:int=2*1024**2
 name_bytes:int=1024
 readlink_bytes:int=4096
 seconds:int=60
class Refusal(ValueError):
 def __init__(self,reason,observation=None):super().__init__(reason);self.reason=reason;self.observation=observation

def require(value,reason,observation=None):
 if not value:raise Refusal(reason,observation)
def endpoint(s):return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
def identity(s):return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid)
def kind(s):
 if stat.S_ISDIR(s.st_mode):return 'directory'
 if stat.S_ISREG(s.st_mode):return 'regular'
 if stat.S_ISLNK(s.st_mode):return 'symlink'
 return 'other'
def fields(s):return {'kind':kind(s),'device':s.st_dev,'inode':s.st_ino,'mode':stat.S_IMODE(s.st_mode),'uid':s.st_uid,'gid':s.st_gid,'links':s.st_nlink,'bytes':s.st_size,'mtimeNs':s.st_mtime_ns,'ctimeNs':s.st_ctime_ns}
def error_status(error):
 if isinstance(error,FileNotFoundError):return 'missing'
 if isinstance(error,PermissionError):return 'inaccessible'
 if isinstance(error,NotADirectoryError):return 'wrong-type-ancestor'
 return 'unknown-os-error'
class Budget:
 def __init__(self,policy,clock,started=None):self.policy=policy;self.clock=clock;self.started=clock() if started is None else started;self.deadline=self.started+policy.seconds;self.entries=0;self.directories=0;self.localizations=0
 def tick(self):require(self.clock()<self.deadline,'metadata-deadline')
 def name(self,name):
  self.tick();require(name not in ('','.','..') and '/' not in name and '\0' not in name,'noncanonical-entry-name');require(len(os.fsencode(name))<=self.policy.name_bytes,'entry-name-byte-bound')
 def entry(self):self.tick();self.entries+=1;require(self.entries<=self.policy.entries,'metadata-entry-bound')
 def directory(self):self.tick();self.directories+=1;require(self.directories<=self.policy.directories,'metadata-directory-bound')
 def localization(self):self.tick();self.localizations+=1;require(self.localizations<=self.policy.localizations,'localization-directory-bound')

def lstat_at(parent,name,relative,budget):
 budget.name(name)
 try:
  s=os.stat(name,dir_fd=parent,follow_symlinks=False);row={'relativePath':relative,'status':'observed',**fields(s)}
  if row['kind']=='symlink':
   budget.tick();link=os.readlink(name,dir_fd=parent);require(len(os.fsencode(link))<=budget.policy.readlink_bytes,'readlink-byte-bound');row['linkText']=link
  return row,s
 except OSError as error:return {'relativePath':relative,'status':error_status(error),'errno':error.errno},None

def inventory(policy=None,clock=time.monotonic,started=None):
 policy=policy or Policy();budget=Budget(policy,clock,started);records={};bindings=[];scopes=[];ancestors=[];fully_observed=True
 flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
 with ExitStack() as stack:
  def keep(fd):stack.callback(os.close,fd);return fd
  root_before=os.lstat('/');root=keep(os.open('/',flags));require(endpoint(root_before)==endpoint(os.fstat(root)),'root-endpoint-changed');ancestors.append({'path':'/',**fields(root_before)})
  def open_bound(parent,name,relative,s):
   budget.tick();require(s is not None and stat.S_ISDIR(s.st_mode),'required-physical-directory',{'relativePath':relative,'kind':kind(s) if s is not None else 'unavailable'})
   try:fd=keep(os.open(name,flags,dir_fd=parent))
   except OSError as error:raise Refusal('directory-open-refused',{'relativePath':relative,'status':error_status(error),'errno':error.errno}) from None
   require(endpoint(s)==endpoint(os.fstat(fd)),'opened-directory-endpoint-differs',{'relativePath':relative});bindings.append((parent,name,fd,identity(s),relative));return fd
  parent=root
  for part in SELECTED_APP.parts[1:]:
   relative=str(Path(ancestors[-1]['path'])/part);row,s=lstat_at(parent,part,relative,budget);ancestors.append({'path':relative,**{k:v for k,v in row.items() if k!='relativePath'}})
   require(row['status']=='observed' and row['kind']=='directory','selected-app-ancestor-not-physical-directory',row);parent=open_bound(parent,part,relative,s)
  app=parent
  def record(parent,name,relative):
   if relative in records:return records[relative]
   budget.entry();row,s=lstat_at(parent,name,relative,budget);records[relative]=(row,s);return row,s
  def scan(fd,relative):
   nonlocal fully_observed
   budget.directory();before=os.fstat(fd);names=[]
   try:
    with os.scandir(fd) as iterator:
     for entry in iterator:
      budget.name(entry.name);require(len(names)<policy.entries,'metadata-entry-bound');names.append(entry.name)
   except OSError as error:
    scopes.append({'relativePath':relative,'status':error_status(error),'errno':error.errno});fully_observed=False;return
   require(len(names)==len(set(names)),'duplicate-directory-name')
   for name in sorted(names,key=os.fsencode):
    row,_=record(fd,name,relative+'/'+name)
    if row['status'] not in ('observed','missing'):fully_observed=False
   require(endpoint(before)==endpoint(os.fstat(fd)),'scanned-directory-changed',{'relativePath':relative});scopes.append({'relativePath':relative,'status':'scanned','entries':len(names)})
  contents_row,contents_s=record(app,'Contents','Contents')
  if contents_row['status']=='observed' and contents_row['kind']=='directory':
   contents=open_bound(app,'Contents','Contents',contents_s);scan(contents,'Contents');resources_row,resources_s=record(contents,'Resources','Contents/Resources')
   if resources_row['status']=='observed' and resources_row['kind']=='directory':
    resources=open_bound(contents,'Resources','Contents/Resources',resources_s);scan(resources,'Contents/Resources')
    localizations=[(r,s) for path,(r,s) in records.items() if Path(path).parent.as_posix()=='Contents/Resources' and Path(path).name.endswith('.lproj') and r['status']=='observed' and r['kind']=='directory']
    for row,s in sorted(localizations,key=lambda pair:os.fsencode(pair[0]['relativePath'])):
     budget.localization();name=Path(row['relativePath']).name;fd=open_bound(resources,name,row['relativePath'],s);scan(fd,row['relativePath'])
   else:fully_observed=False
  else:fully_observed=False
  # Recheck both held descriptors and original names before credit. Holding the
  # inode prevents identity reuse; O_NOFOLLOW prevents redirected enumeration.
  for parent,name,fd,before,relative in bindings:
   budget.tick()
   try:current=os.stat(name,dir_fd=parent,follow_symlinks=False)
   except OSError as error:raise Refusal('selected-directory-binding-unavailable',{'relativePath':relative,'status':error_status(error),'errno':error.errno}) from None
   require(identity(current)==identity(os.fstat(fd))==before,'selected-directory-binding-changed',{'relativePath':relative})
  budget.tick();original=records.get(ORIGINAL_SELECTOR)
  if original is not None:selector={'status':original[0]['status'],'kind':original[0].get('kind'),'relativePath':ORIGINAL_SELECTOR}
  else:
   selector={'status':'not-observed','relativePath':ORIGINAL_SELECTOR}
   for path in ['Contents','Contents/Resources','Contents/Resources/English.lproj']:
    value=records.get(path)
    if value is not None and (value[0]['status']!='observed' or value[0].get('kind')!='directory'):
     selector.update(status='blocked-by-ancestor',ancestorStatus=value[0]['status'],ancestorKind=value[0].get('kind'),ancestorRelativePath=path);break
   else:
    scope_by_path={r['relativePath']:r for r in scopes};english_path='Contents/Resources/English.lproj';english=records.get(english_path);scope=scope_by_path.get(english_path)
    if english is not None and english[0]['status']=='observed' and english[0].get('kind')=='directory':
     if scope is not None and scope['status']=='scanned':selector['status']='missing-file'
     else:
      selector.update(status=scope['status'] if scope is not None else 'existing-directory-not-scanned',observationScope='directory-enumeration',scopeRelativePath=english_path,directoryPresenceObserved=True,fileAbsenceEstablished=False)
      if scope is not None and 'errno' in scope:selector['errno']=scope['errno']
    elif scope_by_path.get('Contents/Resources',{}).get('status')=='scanned':selector['status']='missing-localization-directory'
  result={'kind':'finite-xcode262-sla-path-metadata-only','selectedApp':str(SELECTED_APP),'selectedProfileSHA256':PROFILE_SHA256,'sourceCohortSHA256':SOURCE_COHORT_SHA256,'actualXcodeVersionNotReadOrVerifiedByThisResolver':True,'requestedScopeFullyObserved':fully_observed,'originalSelector':selector,'ancestors':ancestors,'directoryScopes':scopes,'entries':[records[k][0] for k in sorted(records,key=os.fsencode)],'counts':{'entries':budget.entries,'directoriesScanned':budget.directories,'localizationsScanned':budget.localizations},'licenseLocatedQualifiedOrRetained':False,'SDKSourceToolNativeOrModelExecuted':False,'originalRegularFileBodiesOpened':False,'existingPermissionsChanged':False,'endpointEqualityIsNotContinuousImmutability':True,'nativeAdmissionGranted':False,'elapsedSeconds':clock()-budget.started}
  budget.tick();body=encode(result,policy);budget.tick();return result,body

def encode(value,policy):
 body=(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True)+'\n').encode();require(len(body)<=policy.output_bytes,'metadata-output-byte-bound');return body

def context(environment):
 values={key:environment.get(key,'') for key in ['GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_SHA','GITHUB_REPOSITORY','GITHUB_EVENT_NAME','RUNNER_ARCH']};require(re.fullmatch('[1-9][0-9]{0,19}',values['GITHUB_RUN_ID']) and re.fullmatch('[1-9][0-9]{0,9}',values['GITHUB_RUN_ATTEMPT']) and re.fullmatch('[0-9a-f]{40}',values['GITHUB_SHA']),'exact-hosted-context');require(values['GITHUB_REPOSITORY']=='stsepelin/checktrail' and values['GITHUB_EVENT_NAME']=='workflow_dispatch' and values['RUNNER_ARCH']=='ARM64','exact-repository-event-architecture-context');return values

def write_result(output,value,run,source_sha256,policy,clock,started):
 def timely():require(clock()-started<policy.seconds,'metadata-deadline')
 timely();value={**value,'runContext':run,'firstPartyResolverSHA256':source_sha256};encoded=encode(value,replace(policy,output_bytes=policy.output_bytes-STDOUT_RESERVE-FAILURE_RESERVE));timely();file=output/'RESULT.json';created=False
 try:
  fd=os.open(file,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o400);created=True
  with os.fdopen(fd,'wb') as stream:os.fchmod(stream.fileno(),0o400);stream.write(encoded);stream.flush();os.fsync(stream.fileno())
  timely()
 except (Refusal,OSError):
  # Preserve only this newly created incomplete/late metadata, never a prior file.
  if created:
   rejected=output/'UNACCEPTED-METADATA.json';require(not os.path.lexists(rejected),'fresh-unaccepted-metadata-name');file.rename(rejected)
  raise
 return {'metadataOnlyObserved':True,'requestedScopeFullyObserved':value['requestedScopeFullyObserved'],'counts':value['counts'],'originalSelectorStatus':value['originalSelector']['status'],'privateMetadataBytes':len(encoded),'privateMetadataSHA256':hashlib.sha256(encoded).hexdigest(),'regularOriginalBodiesRead':False,'nativeAdmissionGranted':False}

def emit(value):
 body=(json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode();require(len(body)<=STDOUT_RESERVE,'closed-stdout-byte-bound');sys.stdout.write(body.decode())
def write_refusal(output,error):
 value={'metadataOnlyObserved':False,'reasonIdentifier':error.reason,'observation':error.observation,'nativeAdmissionGranted':False};limit=FAILURE_RESERVE if (output/'UNACCEPTED-METADATA.json').exists() else Policy().output_bytes-STDOUT_RESERVE-FAILURE_RESERVE
 body=encode(value,replace(Policy(),output_bytes=limit));fd=os.open(output/'REFUSAL.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o400)
 with os.fdopen(fd,'wb') as stream:os.fchmod(stream.fileno(),0o400);stream.write(body);stream.flush();os.fsync(stream.fileno())
 emit({'metadataOnlyObserved':False,'reasonIdentifier':error.reason,'privateFailureMetadataBytes':len(body),'privateFailureMetadataSHA256':hashlib.sha256(body).hexdigest(),'nativeAdmissionGranted':False})

def main():
 started=time.monotonic();parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--expected-source-sha256',required=True);args=parser.parse_args();require(os.getuid()==0 and platform.system()=='Darwin' and platform.machine()=='arm64' and os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('RUNNER_ENVIRONMENT')=='github-hosted','reviewed-root-standard-macos-arm-metadata-startup');run=context(os.environ);source=Path(__file__);s=source.lstat();require(source==source.resolve(strict=True) and stat.S_ISREG(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o444 and s.st_nlink==1 and 0<s.st_size<=65536,'reviewed-physical-firstparty-source');body=source.read_bytes();require(endpoint(s)==endpoint(source.lstat()) and hashlib.sha256(body).hexdigest()==args.expected_source_sha256,'exact-reviewed-firstparty-source-hash')
 parent=Path('/opt');p=parent.lstat();require(parent==parent.resolve(strict=True) and stat.S_ISDIR(p.st_mode) and p.st_uid==0,'physical-root-owned-output-parent');out=parent/('checktrail-rust198-sla-'+run['GITHUB_RUN_ID']+'-'+run['GITHUB_RUN_ATTEMPT']+'-'+run['GITHUB_SHA'][:12]);require(not os.path.lexists(out),'fresh-owned-metadata-output');out.mkdir(mode=0o700);out.chmod(0o700)
 try:
  value,_=inventory(started=started);summary=write_result(out,value,run,hashlib.sha256(body).hexdigest(),Policy(),time.monotonic,started);emit(summary);return 0 if value['requestedScopeFullyObserved'] else 1
 except Refusal as error:
  # Closed first-party identifiers/metadata only, never raw exception or body.
  write_refusal(out,error);return 1
def run(policy=None):
 policy=policy or Policy()
 def expired(_signum,_frame):raise Refusal('metadata-deadline')
 prior=signal.signal(signal.SIGALRM,expired);timer=signal.setitimer(signal.ITIMER_REAL,policy.seconds)
 try:
  try:return main()
  except Refusal as error:emit({'metadataOnlyObserved':False,'reasonIdentifier':error.reason,'nativeAdmissionGranted':False});return 1
  except OSError as error:emit({'metadataOnlyObserved':False,'reasonIdentifier':'metadata-os-error','errno':error.errno,'nativeAdmissionGranted':False});return 1
 finally:signal.setitimer(signal.ITIMER_REAL,*timer);signal.signal(signal.SIGALRM,prior)
if __name__=='__main__':raise SystemExit(run())
