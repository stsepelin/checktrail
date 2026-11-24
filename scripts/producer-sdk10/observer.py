"""First-party compiler/header and source-endpoint observations, never a review."""
import argparse,gzip,hashlib,json,os,pathlib,posixpath,re,stat,struct,subprocess,sys,tarfile,time,zlib,xml.etree.ElementTree as ET,xml.parsers.expat as expat
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
from common import Refusal,need,freeze,encoded,read_json,hash_file,git_blob,syncdir,safe_relative,bundle_json
def file_identity(path,maximum=256*1024**2,deadline=None):
 p=pathlib.Path(path);fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  before=os.fstat(fd);need(stat.S_ISREG(before.st_mode) and before.st_size<=maximum,'bounded observed physical regular file');h=hashlib.sha256();n=0
  while True:
   if deadline is not None:need(time.monotonic()<deadline,'observed identity hash deadline')
   block=os.read(fd,1048576)
   if not block:break
   n+=len(block);need(n<=maximum,'observed identity grew past byte bound');h.update(block)
  after=os.fstat(fd);endpoint=p.lstat();keys=lambda st:(st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns,st.st_mode)
  need(n==before.st_size and keys(before)==keys(after)==keys(endpoint),'observed physical file changed during hash')
  return {'bytes':n,'sha256':h.hexdigest(),'dev':after.st_dev,'inode':after.st_ino,'mtimeNS':after.st_mtime_ns,'ctimeNS':after.st_ctime_ns,'mode':stat.S_IMODE(after.st_mode),'physicalPath':str(p),'resolvedPath':os.path.realpath(p)}
 finally:os.close(fd)
def regular_body(path,deadline=None,keep=0):
 """Hash one regular file through a single descriptor and keep its body up to keep bytes.

 O_NONBLOCK makes opening a FIFO return at once instead of waiting for a
 writer, and O_NOFOLLOW refuses a final symlink; fstat then refuses anything
 that is not a regular file before a single read can block.
 """
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  before=os.fstat(fd);need(stat.S_ISREG(before.st_mode),'observed physical regular file');h=hashlib.sha256();n=0;chunks=[]
  while True:
   if deadline is not None:need(time.monotonic()<deadline,'observed file hash deadline')
   block=os.read(fd,1048576)
   if not block:break
   n+=len(block);h.update(block)
   if n<=keep:chunks.append(block)
  # The path is checked again too: a rename over it during the read leaves
  # this descriptor on the old file, which only the endpoint lstat reveals.
  after=os.fstat(fd);endpoint=os.lstat(path);keys=lambda st:(st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns,st.st_mode)
  need(n==before.st_size and keys(before)==keys(after)==keys(endpoint),'observed file changed during hash')
  return n,h.hexdigest(),b''.join(chunks) if n<=keep else None,after
 finally:os.close(fd)
def inventoried_regular(stream,identity):
 """The open stream, once it is the same regular file the inventory hashed.

 A path replaced by a FIFO after the inventory opens without blocking, but a
 nonblocking read of it returns None, which the gzip reader cannot handle.
 """
 opened=os.fstat(stream.fileno());need(stat.S_ISREG(opened.st_mode) and (opened.st_dev,opened.st_ino)==(identity['dev'],identity['inode']),'opened output is the inventoried regular file');return stream
def read_observed(path,identity,maximum):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  st=os.fstat(fd);need(stat.S_ISREG(st.st_mode) and st.st_size<=maximum and (st.st_dev,st.st_ino)==(identity['dev'],identity['inode']),'observed report physical identity changed');chunks=[];n=0
  while True:
   block=os.read(fd,min(1048576,maximum+1-n))
   if not block:break
   chunks.append(block);n+=len(block);need(n<=maximum,'observed report grew past parser bound')
  body=b''.join(chunks);need(len(body)==identity['bytes'] and hashlib.sha256(body).hexdigest()==identity['sha256'],'parsed report differs from observed identity');return body
 finally:os.close(fd)
def image_probe(profile,out):
 rows=[]
 for item in profile['image']['physicalCompilerHeaders']:
  got=file_identity(item['path']);need(got['bytes']==item['bytes'] and got['sha256']==item['sha256'],'fresh original compiler/header physical pin');rows.append({'imagePath':item['path'],**got})
 probes=[]
 for argv in [['/usr/local/bin/clang-20','--version'],['/usr/local/bin/clang-20','-print-resource-dir'],['/usr/local/bin/lld','--version'],['/usr/local/bin/llvm-ar','--version'],['/usr/bin/gcc','--version'],['/usr/bin/c++','--version']]:
  r=subprocess.run(argv,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=15,env={**os.environ,'HOME':'/work/home','LANG':'C','TZ':'UTC'},cwd='/');need(len(r.stdout)<=65536 and len(r.stderr)<=65536,'version probe output bound');probes.append({'argv':argv,'exitCode':r.returncode,'stdout':r.stdout.decode('utf8','replace'),'stderrBytes':len(r.stderr),'stderrSHA256':hashlib.sha256(r.stderr).hexdigest(),'candidateToolExecutedForVersionOnly':True,'selectedByOriginalSourceBuild':False})
 result={'physicalCompilerHeaderPinsFreshlyMatched':True,'staticImageHandoffSHA256':profile['image']['staticNoticePackageHandoffSHA256'],'files':rows,'versionProbes':probes,'actualSourceCompilerSelectionObservedByTheseProbes':False};freeze(pathlib.Path(out)/'IMAGE-COMPILER-HEADER-PROBES.json',encoded(result));return result
def tracked_after(source,before,deadline):
 rows=[];changes=[];tracked={x['path']:x for x in before['entries']}
 for path,old in sorted(tracked.items()):
  need(time.monotonic()<deadline,'tracked source endpoint hash deadline');p=pathlib.Path(source)/path
  try:s=p.lstat()
  except FileNotFoundError:changes.append({'path':path,'change':'deleted','before':old});continue
  if stat.S_ISREG(s.st_mode):
   n,h,_,opened=regular_body(p,deadline);row={'path':path,'kind':'regular','mode':stat.S_IMODE(opened.st_mode),'bytes':n,'sha256':h}
  elif stat.S_ISLNK(s.st_mode):row={'path':path,'kind':'symlink','mode':stat.S_IMODE(s.st_mode),'bytes':s.st_size,'target':os.readlink(p)}
  else:row={'path':path,'kind':'other','mode':stat.S_IMODE(s.st_mode),'bytes':s.st_size}
  rows.append(row);keys=['kind','mode','sha256','target'];changed=any(old.get(k)!=row.get(k) for k in keys if k in old or k in row)
  if changed:changes.append({'path':path,'change':'modified-by-original-build-or-test','before':old,'after':row})
 return {'trackedBefore':len(tracked),'trackedAfterPresent':len(rows),'trackedEndpointChanges':changes,'endpointImmutabilityAssumed':False,'fullBeforeAndAfterTrackedIdentities':rows,'changedAndGeneratedBodiesRequireStoppedWorkCapture':True}
def refuse_declarations(body):
 """Refuse a report with any DOCTYPE or ENTITY declaration, in whatever encoding expat detects.

 Checking the parser's own events covers UTF-16 and every other encoding the
 parser accepts, and text that merely mentions a declaration is not one.
 """
 def refuse(*_):raise Refusal('report XML external declarations')
 parser=expat.ParserCreate();parser.StartDoctypeDeclHandler=refuse;parser.EntityDeclHandler=refuse
 try:parser.Parse(body,True)
 except expat.ExpatError as error:raise ET.ParseError(str(error)) from error
def natural_report(body):
 """Read native result rows and reconcile every supported declared summary.

 Absence of a failure element is meaningful only inside a recognized native
 document whose counters cover the rows. Unknown, empty and incomplete reports
 retain observations but cannot earn passing credit.
 """
 refuse_declarations(body)
 doc=ET.fromstring(body);local=lambda x:x.tag.rsplit('}',1)[-1]
 def number(value):
  need(type(value) is str and re.fullmatch(r'[0-9]+',value) is not None,'native report nonnegative integer counter');return int(value)
 def reconciles(node,actual,required=()):
  return all(k in node.attrib for k in required) and all(number(node.attrib[k])==v for k,v in actual.items() if k in node.attrib)
 def result(fmt,outcomes,consistent,covered,**extra):
  return {'format':fmt,'tests':len(outcomes),'outcomes':outcomes,'summaryAgreesWithActualRows':bool(consistent),'summaryCoversEveryActualRow':bool(covered),'allReportedTestsPassed':bool(outcomes) and consistent and covered and all(x=='passed' for x in outcomes),**extra}
 root=local(doc)
 if root=='TestRun':
  results=[x for x in doc if local(x)=='Results'];summaries=[x for x in doc if local(x)=='ResultSummary'];rows=[x for r in results for x in r if local(x)=='UnitTestResult'];native=[x.attrib.get('outcome') for x in rows]
  mapping={'Passed':'passed','Failed':'failed','Error':'error','Timeout':'timeout','Aborted':'aborted','Inconclusive':'inconclusive','NotExecuted':'skipped','NotRunnable':'not-runnable','Disconnected':'disconnected','Warning':'warning','PassedButRunAborted':'aborted-pass','Completed':'completed','InProgress':'in-progress','Pending':'pending'}
  outcomes=[mapping.get(x,'unavailable') for x in native];counters=[x for summary in summaries for x in summary if local(x)=='Counters'];covered=len(results)==1 and len(summaries)==1 and len(counters)==1 and len(rows)==sum(local(x)=='UnitTestResult' for x in doc.iter())
  actual={'total':len(rows),'executed':len(rows)-native.count('NotExecuted'),'passed':native.count('Passed'),**{k:native.count(v) for k,v in [('failed','Failed'),('error','Error'),('timeout','Timeout'),('aborted','Aborted'),('inconclusive','Inconclusive'),('notExecuted','NotExecuted'),('notRunnable','NotRunnable'),('disconnected','Disconnected'),('warning','Warning'),('passedButRunAborted','PassedButRunAborted'),('completed','Completed'),('inProgress','InProgress'),('pending','Pending')]}}
  infrastructure_error=any(local(x)=='ErrorInfo' or (local(x)=='RunInfo' and x.attrib.get('outcome') in ['Failed','Error','Timeout','Aborted']) for x in doc.iter())
  consistent=covered and reconciles(counters[0],actual,('total','executed','passed')) and summaries[0].attrib.get('outcome') in ['Passed','Completed'] and 'unavailable' not in outcomes and not infrastructure_error
  return result('TRX',outcomes,consistent,covered,counters=[x.attrib for x in counters])
 if root in ['assemblies','assembly']:
  assemblies=[doc] if root=='assembly' else [x for x in doc if local(x)=='assembly'];rows=[x for a in assemblies for x in a.iter() if local(x)=='test'];mapping={'Pass':'passed','Fail':'failed','Skip':'skipped'};outcomes=[mapping.get(x.attrib.get('result'),'unavailable') for x in rows]
  covered=bool(assemblies) and len(rows)==sum(local(x)=='test' for x in doc.iter());consistent=covered and 'unavailable' not in outcomes and not any(local(x)=='error' for x in doc.iter())
  for assembly in assemblies:
   tests=[x for x in assembly.iter() if local(x)=='test'];native=[x.attrib.get('result') for x in tests];errors=sum(local(x)=='error' for x in assembly.iter());actual={'total':len(tests),'passed':native.count('Pass'),'failed':native.count('Fail'),'skipped':native.count('Skip'),'errors':errors};consistent=consistent and reconciles(assembly,actual,('total','passed','failed','skipped')) and errors==0
   for scope in [x for x in assembly.iter() if local(x) in ['collection','class']]:
    cases=[x for x in scope.iter() if local(x)=='test'];states=[x.attrib.get('result') for x in cases];consistent=consistent and reconciles(scope,{'total':len(cases),'passed':states.count('Pass'),'failed':states.count('Fail'),'skipped':states.count('Skip')})
   consistent=consistent and all(not any(local(c) in ['failure','reason','error'] for c in x.iter() if c is not x) or x.attrib.get('result')!='Pass' for x in tests)
  return result('xUnit',outcomes,consistent,covered)
 if root in ['testsuite','testsuites']:
  cases=[x for x in doc.iter() if local(x)=='testcase'];scopes=[x for x in doc.iter() if local(x) in ['testsuite','testsuites']];states={};parents={id(child):parent for parent in doc.iter() for child in parent};structural=all(local(parents[id(x)])=='testsuite' for x in cases)
  structural=structural and all(id(x) in parents and local(parents[id(x)])=='testcase' for x in doc.iter() if local(x) in ['failure','error','skipped'])
  for case in cases:
   markers=[local(x) for x in case if local(x) in ['failure','error','skipped']];status=case.attrib.get('status');outcome=case.attrib.get('result')
   known_status=status in [None,'run','passed','Passed','notrun','not-run','disabled','skipped'];known_result=outcome in [None,'completed','passed','Passed','skipped','suppressed','disabled','failed','error']
   state='unavailable' if not known_status or not known_result or len(markers)>1 else ('error' if 'error' in markers or outcome=='error' else 'failed' if 'failure' in markers or outcome=='failed' else 'skipped' if 'skipped' in markers or status in ['notrun','not-run','disabled','skipped'] or outcome in ['skipped','suppressed','disabled'] else 'passed');states[id(case)]=state
  counted=set();consistent=True
  for scope in scopes:
   tests=[x for x in scope.iter() if local(x)=='testcase'];native=[states[id(x)] for x in tests];actual={'tests':len(tests),'failures':native.count('failed'),'errors':native.count('error'),'skipped':native.count('skipped'),'disabled':sum(x.attrib.get('status')=='disabled' or x.attrib.get('result')=='disabled' for x in tests),'passed':native.count('passed')};consistent=consistent and reconciles(scope,actual)
   if 'tests' in scope.attrib:counted.update(id(x) for x in tests)
  # Every case must be inside a testsuite, rather than a lookalike wrapper.
  inside={id(x) for scope in scopes if local(scope)=='testsuite' for x in scope.iter() if local(x)=='testcase'};outcomes=[states[id(x)] for x in cases];covered=bool(cases) and structural and counted=={id(x) for x in cases} and inside==counted
  return result('JUnit',outcomes,consistent and 'unavailable' not in outcomes,covered)
 return {'format':'unrecognized-or-empty','tests':0,'outcomes':[],'summaryAgreesWithActualRows':False,'summaryCoversEveryActualRow':False,'allReportedTestsPassed':False,'outcome':'INCOMPLETE; no recognized native report root and result rows observed'}
def cmake_records(source,deadline):
 records=[]
 for parent,dirs,files in os.walk(source,followlinks=False):
  need(time.monotonic()<deadline,'compiler metadata walk deadline');dirs[:]=[x for x in dirs if not pathlib.Path(parent,x).is_symlink() and x not in ['.git','.dotnet']]
  for name in files:
   if name not in ['CMakeCache.txt','CMakeCCompiler.cmake','CMakeCXXCompiler.cmake','compile_commands.json']:continue
   p=pathlib.Path(parent,name);need(not p.is_symlink(),'compiler metadata file symlink');size,sha,body,_=regular_body(p,deadline,32*1024**2);row={'path':str(p),'bytes':size,'sha256':sha,'kind':name}
   if body is not None:
    if name=='compile_commands.json':
     try:
      data=json.loads(body);need(type(data) is list and len(data)<=200000,'compiler command count');row['compileCommands']=[{k:x.get(k) for k in ['directory','file','command','arguments']} for x in data if type(x) is dict]
     except (ValueError,Refusal):row['parseState']='INCOMPLETE compiler-command metadata'
    else:row['selectedCompilerAndImplicitHeaderDeclarations']=[x for x in body.decode('utf8','replace').splitlines() if re.search(r'CMAKE_(?:C|CXX)_(?:COMPILER|IMPLICIT_INCLUDE_DIRECTORIES|COMPILER_VERSION|COMPILER_ID)',x)]
   else:row['parseState']='INCOMPLETE parser byte bound; original body still captured'
   records.append(row)
 return records
def output_inventory(roots,deadline,kind):
 """Identify matching outputs; a directory that cannot be listed leaves the inventory incomplete.

 An unlisted directory is not an empty one: it may hold a report or archive
 that a later, successful listing would otherwise count as new.
 """
 need(kind in ['test-reports','sdk-archives'],'known output identity inventory kind');entries={};errors=[];roots=sorted({str(pathlib.Path(x).absolute()) for x in roots})
 def unlisted(error):errors.append({'path':str(error.filename),'errno':error.errno,'errorType':type(error).__name__})
 for root in roots:
  rp=pathlib.Path(root);need(not rp.is_symlink(),'output inventory root must not be a symlink')
  if not rp.exists():continue
  need(rp.is_dir(),'output inventory root directory')
  for parent,dirs,files in os.walk(root,onerror=unlisted,followlinks=False):
   need(time.monotonic()<deadline,'pre-command output identity deadline');dirs[:]=[x for x in dirs if not pathlib.Path(parent,x).is_symlink() and x not in ['.git','.dotnet']]
   for name in files:
    p=pathlib.Path(parent,name);parts=p.parts;report=name.endswith(('.trx','.xml')) and any(parts[i]=='artifacts' and i+1<len(parts) and parts[i+1]=='TestResults' for i in range(len(parts)));sdk=name.startswith('dotnet-sdk-') and name.endswith('.tar.gz')
    if not (report if kind=='test-reports' else sdk):continue
    need(len(entries)<100000 and not p.is_symlink(),'bounded observed output is not a symlink');identity=file_identity(p,2*1024**3 if kind=='sdk-archives' else 32*1024**2,deadline);need(pathlib.Path(root).resolve() in pathlib.Path(identity['resolvedPath']).parents,'observed output resolves inside inventory root');entries[str(p)]=identity
 return {'schemaVersion':2,'kind':kind,'roots':roots,'snapshotComplete':not errors,'unlistedDirectories':errors[:64],'unlistedDirectoryCount':len(errors),'createdBeforeOriginalCommand':True,'identityPolicy':'regular-no-symlinks-content-sha256-before-command','entries':entries}
def prior_identities(before,kind,roots,deadline=None):
 """Content identities of a valid protected pre-command snapshot, or None.

 None means nothing can be attributed to the command: the snapshot is
 missing, incomplete, for other roots, or holds a malformed entry.
 """
 if not(type(before) is dict and before.get('schemaVersion')==2 and before.get('kind')==kind and before.get('roots')==sorted({str(pathlib.Path(x).absolute()) for x in roots}) and before.get('snapshotComplete') is True and before.get('createdBeforeOriginalCommand') is True and before.get('identityPolicy')=='regular-no-symlinks-content-sha256-before-command' and type(before.get('entries')) is dict):return None
 known=set()
 for old in before['entries'].values():
  if deadline is not None:need(time.monotonic()<deadline,'pre-command snapshot validation deadline')
  if not(type(old) is dict and type(old.get('bytes')) is int and re.fullmatch(r'[0-9a-f]{64}',str(old.get('sha256','')))):return None
  known.add((old['bytes'],old['sha256']))
 return frozenset(known)
def newly_attributed(identity,known):
 # An inode swap, copy, rename or future timestamp alone is not new content.
 return known is not None and (identity['bytes'],identity['sha256']) not in known

# Materialization snapshots record exactly these two tracked endpoint kinds.
TRACKED_KINDS=('regular','symlink')
def tracked_content_identities(baseline):
 """Content identities of tracked regular files, or None without a usable baseline."""
 if not(type(baseline) is dict and type(baseline.get('entries')) is list):return None
 rows=set()
 for row in baseline['entries']:
  if not(type(row) is dict and type(row.get('path')) is str and row.get('kind') in TRACKED_KINDS):return None
  if row['kind']!='regular':continue
  if not(type(row.get('bytes')) is int and re.fullmatch(r'[0-9a-f]{64}',str(row.get('sha256','')))):return None
  rows.add((row['bytes'],row['sha256']))
 return frozenset(rows)
def bound_tracked_baseline(evidence):
 """The tracked baseline, or None when materialization recorded none.

 Materialization freezes source-before.json and, in MATERIALIZATION.json, the
 SHA256 of exactly those bytes and their entry count. A baseline those do not
 bind is incomplete, however well formed, and is refused rather than read as
 a smaller tracked tree.
 """
 path=pathlib.Path(evidence)/'source-before.json'
 if not path.exists():return None
 need(not path.is_symlink() and path.stat().st_size<=64*1024**2,'bounded regular tracked baseline');raw=path.read_bytes();before=json.loads(raw)
 receipt=optional_json(pathlib.Path(evidence)/'MATERIALIZATION.json')
 need(type(receipt) is dict and receipt.get('state')=='COMPLETE','complete materialization receipt binds the tracked baseline')
 need(type(receipt.get('baselineSHA256')) is str and hashlib.sha256(raw).hexdigest()==receipt['baselineSHA256'],'tracked baseline bytes match the materialization receipt')
 need(tracked_content_identities(before) is not None,'malformed tracked baseline')
 need(type(receipt.get('trackedPhysicalLeaves')) is int and len(before['entries'])==receipt['trackedPhysicalLeaves'],'tracked baseline entry count matches the materialization receipt')
 return before
def reports(source,deadline,tracked_paths=(),test_started_wall=None,before=None,original_test=None,tracked_contents=None):
 # The pre-test snapshot holds only reports already under artifacts/TestResults,
 # so a tracked passing report copied there from elsewhere in the source tree
 # would look new to it; its content still matches the tracked baseline.
 # tracked_contents=None means that baseline is unavailable: no comparison is
 # made, matchesTrackedSourceContent stays None and nothing is credited.
 source=str(pathlib.Path(source).absolute());rows=[];command_passed=type(original_test) is dict and original_test.get('originalCodeExecuted') is True and type(original_test.get('exitCode')) is int and original_test.get('exitCode')==0 and original_test.get('stopReason') is None
 inventory=output_inventory([source],deadline,'test-reports');seen=set();known=prior_identities(before,'test-reports',[source],deadline)
 for path,identity in inventory['entries'].items():
  p=pathlib.Path(path);relative=p.relative_to(source).as_posix();row={'path':path,'identity':identity,'bytes':identity['bytes'],'sha256':identity['sha256'],'duplicateBody':False,'preexistingTrackedFixture':relative in tracked_paths,'matchesTrackedSourceContent':None if tracked_contents is None else (identity['bytes'],identity['sha256']) in tracked_contents,'changedSinceProtectedPreTestSnapshot':newly_attributed(identity,known),'originalTestCommandPositivelyPassed':command_passed}
  try:row.update(natural=natural_report(read_observed(p,identity,32*1024**2)),naturalReportParsed=True)
  # LookupError: a report declaring an XML encoding this interpreter lacks.
  except (ValueError,LookupError,ET.ParseError,Refusal,OSError):row['naturalReportParsed']=False
  row['eligibleForPassingCredit']=not row['preexistingTrackedFixture'] and row['matchesTrackedSourceContent'] is False and row['changedSinceProtectedPreTestSnapshot'] and command_passed
  if row['eligibleForPassingCredit']:row['duplicateBody']=identity['sha256'] in seen;seen.add(identity['sha256'])
  rows.append(row)
 eligible=[row for row in rows if row['eligibleForPassingCredit']];credited=[row['natural'] for row in eligible if row.get('naturalReportParsed') and not row['duplicateBody'] and row['natural']['tests']>0];observed=[x for row in credited for x in row.get('outcomes',[])];counts={x:observed.count(x) for x in sorted(set(observed))};unavailable=not inventory['snapshotComplete'] or any(not row.get('naturalReportParsed') or row['natural']['tests']==0 for row in eligible)
 return {'reports':rows,'reportInventoryComplete':inventory['snapshotComplete'],'trackedSourceBaselineAvailable':tracked_contents is not None,'unlistedDirectories':inventory['unlistedDirectories'],'naturalOutcomeCounts':counts,'allCreditedFreshTestsPassed':bool(observed) and all(row['allReportedTestsPassed'] for row in credited) and not unavailable,'protectedPreCommandIdentitySnapshotRequired':True,'staleFutureMtimeOrTrackedFixtureReportsGivenPassingCredit':False,'skippedUnavailableOrEmptyCountAsPassing':False,'allPossibleUpstreamTestSuiteCoverageClaimed':False}

def arm64_musl_elf(f,size):
 head=f.read(64)
 if len(head)!=64 or head[:6]!=b'\x7fELF\x02\x01':return False
 fields=struct.unpack('<16sHHIQQQIHHHHHH',head);_,typ,machine,version,entry,phoff,shoff,flags,ehsize,phsize,phnum,*_=fields
 if not(typ in [2,3] and machine==183 and version==1 and ehsize==64 and phsize==56 and 0<phnum<=128 and 64<=phoff and phoff+phsize*phnum<=min(size,1024**2)):return False
 f.read(phoff-64);table=f.read(phsize*phnum);loads=False;interpreter=None
 for i in range(phnum):
  ptype,pflags,offset,vaddr,paddr,filesz,memsz,align=struct.unpack('<IIQQQQQQ',table[i*56:(i+1)*56]);loads=loads or ptype==1
  if ptype==3:interpreter=(offset,filesz)
 if not(loads and interpreter and 1<interpreter[1]<=256 and phoff+len(table)<=interpreter[0] and sum(interpreter)<=size):return False
 f.read(interpreter[0]-(phoff+len(table)));return f.read(interpreter[1]).rstrip(b'\0')==b'/lib/ld-musl-aarch64.so.1'

def fresh_sdks(roots,profile,deadline,before=None,original_build=None):
 rows=[];inventory=output_inventory(roots,deadline,'sdk-archives');known=prior_identities(before,'sdk-archives',roots,deadline);command_passed=type(original_build) is dict and original_build.get('originalCodeExecuted') is True and original_build.get('exitCode')==0 and original_build.get('stopReason') is None
 for path,identity in inventory['entries'].items():
  p=pathlib.Path(path);row={'path':path,'archive':identity,'versionFiles':[],'targetDotnetARM64MuslELFMetadataMatched':False,'changedSinceProtectedPreBuildSnapshot':newly_attributed(identity,known),'originalBuildCommandPositivelyPassed':command_passed};decoded=0;entries=0;layout=set();names=set()
  try:
   class Reader:
    def __init__(self,stream):self.stream=stream;self.bytes=0
    def read(self,n=-1):
     need(time.monotonic()<deadline,'fresh SDK gzip validation deadline');body=self.stream.read(n);self.bytes+=len(body);need(self.bytes<=8*1024**3,'fresh SDK complete decoded stream bound');return body
   fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
   with os.fdopen(fd,'rb') as raw,gzip.GzipFile(fileobj=inventoried_regular(raw,identity),mode='rb') as compressed:
    reader=Reader(compressed)
    with tarfile.open(fileobj=reader,mode='r|') as t:
     for item in t:
      need(time.monotonic()<deadline and entries<100000,'fresh SDK archive bounds');entries+=1;decoded+=item.size;name=item.name.removeprefix('./')
      if name in ['', '.'] and item.isdir():continue
      safe_relative(name);need(decoded<=8*1024**3 and name not in names,'fresh SDK decoded/unique-member bound');names.add(name)
      need(item.isfile() or item.isdir() or item.issym() or item.islnk(),'fresh SDK ordinary member type')
      if item.issym() or item.islnk():
       target=item.linkname;need(target and not target.startswith('/') and '\\' not in target and '\0' not in target,'fresh SDK relative link target');resolved=posixpath.normpath(posixpath.join(posixpath.dirname(name) if item.issym() else '',target));need(resolved!='..' and not resolved.startswith('../'),'fresh SDK link remains inside archive')
      if not item.isfile():continue
      if name.endswith('/.version'):
       need(item.size<=4096,'embedded SDK version metadata size');body=t.extractfile(item).read(4097);row['versionFiles'].append({'path':name,'sha256':hashlib.sha256(body).hexdigest(),'lines':body.decode().splitlines()})
      # The host runs dotnet directly, so a non-executable one is not the selected SDK entry point.
      if name=='dotnet':row['dotnetMode']=oct(item.mode&0o7777);row['targetDotnetARM64MuslELFMetadataMatched']=item.mode&0o111==0o111 and arm64_musl_elf(t.extractfile(item),item.size)
      if item.size>0:
       if re.fullmatch(r'host/fxr/[^/]+/libhostfxr\.so',name):layout.add('hostfxr')
       if re.fullmatch(r'shared/Microsoft\.NETCore\.App/[^/]+/libcoreclr\.so',name):layout.add('coreclr')
       if re.fullmatch(r'shared/Microsoft\.NETCore\.App/[^/]+/System\.Private\.CoreLib\.dll',name):layout.add('corelib')
       if name=='sdk/10.0.401/dotnet.dll':layout.add('sdk-entry-assembly')
    while reader.read(65536):pass
   need(file_identity(p,2*1024**3,deadline)==identity,'selected SDK archive changed during metadata validation');row['fullGzipStreamIntegrityVerified']=True
   versions=[x for x in row['versionFiles'] if x['path']=='sdk/10.0.401/.version'];row['requiredProductLayoutMetadataObserved']=layout=={'hostfxr','coreclr','corelib','sdk-entry-assembly'};row['selectedSDKArchiveMetadataAndAttributionMatched']=len(versions)==1 and all(x in versions[0]['lines'] for x in [profile['source']['commit'],'10.0.401',profile['targetRID']]) and row['targetDotnetARM64MuslELFMetadataMatched'] and row['requiredProductLayoutMetadataObserved'] and row['changedSinceProtectedPreBuildSnapshot'] and command_passed
  except (ValueError,tarfile.TarError,Refusal,struct.error,OSError,EOFError,zlib.error):row['selectedSDKArchiveMetadataAndAttributionMatched']=False
  rows.append(row)
 return {'candidates':rows,'outputInventoryComplete':inventory['snapshotComplete'],'selectedSDKArchiveMetadataAndAttributionObserved':any(x.get('selectedSDKArchiveMetadataAndAttributionMatched') for x in rows),'productOrBuildQualificationClaimed':False,'metadataLayoutAndAttributionAreNotProductExecutionOrReproducibility':True,'bootstrapDotnetAndInputArchivesSearched':False,'historicalPublisherBinaryEqualityClaimed':False}
SOURCE_ROOT='/work/source'
SDK_OUTPUT_ROOTS=['/work/staging','/work/source/artifacts']
def optional_json(path):return read_json(path) if pathlib.Path(path).exists() else None
UNOBSERVABLE=(Refusal,OSError,ValueError)
def unobserved_sdks(error,state):
 return {'candidates':[],'outputInventoryComplete':False,'selectedSDKArchiveMetadataAndAttributionObserved':False,'productOrBuildQualificationClaimed':False,'observedAfterBuildStoppedBeforeTestPhase':True,'state':state,'errorType':type(error).__name__}
def post_build_sdks(roots,profile,deadline,evidence):
 """Validate SDK archives after the build stops and before the test phase.

 The test command reruns ./build.sh against the same staging and artifacts
 directories, so the final tree cannot tell which archive the build produced.
 The evidence directory is never mounted into either original command.
 """
 evidence=pathlib.Path(evidence)
 # An unobservable output tree is recorded as an incomplete observation
 # without build credit; it must not keep the original tests from starting.
 try:value={**fresh_sdks(roots,profile,deadline,optional_json(evidence/'PRE-BUILD-OUTPUT-IDENTITIES.json'),optional_json(evidence/'original-build-TERMINAL.json')),'observedAfterBuildStoppedBeforeTestPhase':True}
 except UNOBSERVABLE as error:value=unobserved_sdks(error,'INCOMPLETE post-build SDK output observation')
 freeze(evidence/'POST-BUILD-SDK-OUTPUTS.json',encoded(value));return value
def build_sdk_outputs(roots,profile,deadline,evidence):
 """Report build SDK output from the post-build record, never the final tree.

 The test container is created only after the before-test observer has frozen
 that record, so without it the final tree stands in only when no test phase
 was admitted. A recorded archive later removed or replaced keeps its
 post-build validation; its final state is reported beside it, and archives
 first seen afterwards are listed without build credit.
 """
 evidence=pathlib.Path(evidence);recorded=optional_json(evidence/'POST-BUILD-SDK-OUTPUTS.json')
 if recorded is not None:value=recorded;source='post-build-before-test-record'
 elif any((evidence/x).exists() for x in ['PRE-TEST-OUTPUT-IDENTITIES.json','original-tests-TERMINAL.json']):value={'candidates':[],'outputInventoryComplete':False,'selectedSDKArchiveMetadataAndAttributionObserved':False,'productOrBuildQualificationClaimed':False};source='INCOMPLETE test phase admitted without a post-build SDK output record'
 else:
  source='final-tree-no-test-phase-admitted'
  try:value={**fresh_sdks(roots,profile,deadline,optional_json(evidence/'PRE-BUILD-OUTPUT-IDENTITIES.json'),optional_json(evidence/'original-build-TERMINAL.json')),'observedAfterBuildStoppedBeforeTestPhase':True}
  except UNOBSERVABLE as error:value=unobserved_sdks(error,'INCOMPLETE final SDK output observation')
 # With no test phase the tree fresh_sdks just inventoried is the final one.
 # An unobservable final tree is an incomplete final inventory: recorded
 # archives are then neither reported lost nor retained for custody, and the
 # observer still finishes so stopped capture can run.
 final_error=None
 if source=='post-build-before-test-record':
  try:final=output_inventory(roots,deadline,'sdk-archives')
  except UNOBSERVABLE as error:final={'snapshotComplete':False,'entries':{}};final_error=type(error).__name__
 else:final={'snapshotComplete':value['outputInventoryComplete'],'entries':{row['path']:row['archive'] for row in value['candidates']}}
 built=set();changed=[]
 for row in value['candidates']:
  now=final['entries'].get(row['path']);identity=(row['archive']['bytes'],row['archive']['sha256']);built.add((row['path'],*identity))
  row['finalObservation']=('absent' if final['snapshotComplete'] else 'not-found-in-incomplete-final-inventory') if now is None else 'unchanged' if (now['bytes'],now['sha256'])==identity else 'replaced'
  # Only an archive the build produced, positively seen gone or different, is a build output the final tree lost.
  if row['changedSinceProtectedPreBuildSnapshot'] is True and row['finalObservation'] in ['absent','replaced']:changed.append(row['path'])
 later=[{'path':path,'archive':x,'creditedAsBuildOutput':False} for path,x in sorted(final['entries'].items()) if (path,x['bytes'],x['sha256']) not in built]
 # Stopped capture packs this same final /work tree, so custody holds a validated
 # build archive only if its exact bytes are still there, unchanged.
 retained=final['snapshotComplete'] is True and any(row.get('selectedSDKArchiveMetadataAndAttributionMatched') is True and row['finalObservation']=='unchanged' for row in value['candidates'])
 return {**value,'buildOutputObservation':source,'finalOutputInventoryComplete':final['snapshotComplete'],'finalOutputInventoryErrorType':final_error,'buildOutputsAbsentOrReplacedAtFinalObservation':changed,'outputsFirstObservedAfterBuildNotCredited':later,'validatedBuildArchiveBytesUnchangedForStoppedCapture':retained}
def after(profile,evidence,deadline,test_started_wall=None):
 """Freeze every after-test observation; stopped capture runs only once this returns.

 A record that cannot be observed is frozen as incomplete without credit, so
 it neither suppresses the remaining records nor the capture of logs and
 failure evidence.
 """
 evidence=pathlib.Path(evidence);baseline_error=None
 # An unreadable, malformed or unbound baseline is an unavailable one, never an empty one.
 try:before=bound_tracked_baseline(evidence)
 except UNOBSERVABLE as error:before=None;baseline_error=str(error) if isinstance(error,Refusal) else type(error).__name__
 def observe(name,build):
  try:value=build()
  except UNOBSERVABLE+(ET.ParseError,LookupError) as error:value={'state':'INCOMPLETE after-test observation','errorType':type(error).__name__,'passingCredit':False}
  freeze(evidence/name,encoded(value))
 observe('SOURCE-ENDPOINT-CHANGES.json',lambda:tracked_after(SOURCE_ROOT,before,deadline) if before is not None else {'state':'INCOMPLETE original materialization; no valid tracked baseline','baselineError':baseline_error,'passingCredit':False})
 observe('ACTUAL-CMAKE-COMPILER-SELECTION.json',lambda:{'records':cmake_records(SOURCE_ROOT,deadline),'packageLabelsAloneAreExecutionEvidence':False})
 observe('ORIGINAL-NATURAL-TEST-REPORTS.json',lambda:reports(SOURCE_ROOT,deadline,{x['path'] for x in before['entries']} if before else (),test_started_wall,optional_json(evidence/'PRE-TEST-OUTPUT-IDENTITIES.json'),optional_json(evidence/'original-tests-TERMINAL.json'),tracked_content_identities(before)))
 observe('FRESH-SELECTED-SDK-OUTPUTS.json',lambda:build_sdk_outputs(SDK_OUTPUT_ROOTS,profile,deadline,evidence))
def pre_command_inventory(roots,deadline,kind):
 """A pre-command output snapshot, recorded incomplete when an output cannot be observed.

 A symlinked or oversized output already present must not keep the original
 command from starting. prior_identities() attributes nothing to an
 incomplete snapshot, so nothing found afterwards earns credit.
 """
 try:return output_inventory(roots,deadline,kind)
 except UNOBSERVABLE as error:return {'schemaVersion':2,'kind':kind,'roots':sorted({str(pathlib.Path(x).absolute()) for x in roots}),'snapshotComplete':False,'unlistedDirectories':[],'unlistedDirectoryCount':0,'createdBeforeOriginalCommand':True,'identityPolicy':'regular-no-symlinks-content-sha256-before-command','entries':{},'state':'INCOMPLETE pre-command '+kind+' inventory; no credit','errorType':type(error).__name__}
def phase(mode,profile,evidence,deadline,test_started_wall=None):
 evidence=pathlib.Path(evidence)
 if mode=='probe':image_probe(profile,evidence)
 elif mode=='before-build':freeze(evidence/'PRE-BUILD-OUTPUT-IDENTITIES.json',encoded(pre_command_inventory(SDK_OUTPUT_ROOTS,deadline,'sdk-archives')))
 elif mode=='before-test':post_build_sdks(SDK_OUTPUT_ROOTS,profile,deadline,evidence);freeze(evidence/'PRE-TEST-OUTPUT-IDENTITIES.json',encoded(pre_command_inventory([SOURCE_ROOT],deadline,'test-reports')))
 else:need(mode=='after','known observer phase');after(profile,evidence,deadline,test_started_wall)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('mode',choices=['probe','before-build','before-test','after']);p.add_argument('--profile',required=True);p.add_argument('--evidence',required=True);p.add_argument('--deadline',type=float,required=True);p.add_argument('--uid',type=int,required=True);p.add_argument('--gid',type=int,required=True);p.add_argument('--test-start-wall',type=float);a=p.parse_args();profile=bundle_json(a.profile)
 os.chown(a.evidence,0,0)
 try:
  phase(a.mode,profile,a.evidence,a.deadline,a.test_start_wall)
 finally:
  for f in pathlib.Path(a.evidence).iterdir():
   if f.is_file() and not f.is_symlink():os.chown(f,a.uid,a.gid)
  os.chown(a.evidence,a.uid,a.gid)
