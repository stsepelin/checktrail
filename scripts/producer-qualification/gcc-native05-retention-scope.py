"""Finite main05 evidence scope. Historical baseline is not NEW SDK metadata.

This guards the fixed controller's file copies, not universal information flow
through arbitrary producer output. No checkpoint/cache action is performed.
"""
import hashlib,importlib.util,json,os,re,stat,tempfile,time
from pathlib import Path

def load(name):
 p=Path(__file__).with_name(name);s=importlib.util.spec_from_file_location(p.stem.replace('-','_'),p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

h=load('gcc-hosted-carrier.py')
codec=load('gcc-staged-checkpoint.py')
require=h.require
BASELINE='__carrier_work/external-sdk-before.json'
# Written by configure and bound by the predecessor root. A successful SDK
# reconstruction must reproduce it byte for byte, so its digest is also a NEW
# SDK pin; only this path with exactly the bound digest is the historical file.
PACKAGE_INVENTORY='__carrier_work/installed-build-package-identities.txt'
MAIN_SOURCES={'main-native.log':'native.log','main-resource-samples.json':'resource-samples.json','original-commands.jsonl':'observations/original-commands.jsonl'}
FORBIDDEN_STATE_PATHS=('__carrier_work/main05-carrier-evidence','sdk-frame','prepared-sdk','controls/prepared-sdk')
SDK_SENSITIVE_PATHS=('native.log','resource-samples.json','ATTEMPT.json','SDK-FOR-MAIN.json','SDK-CARRIER.json',
                     'SDK-SNAPSHOT-MATERIAL-PROOF.json','SDK-LOCAL-IMAGE-OBSERVATION.json','SDK-LOCAL-IMAGE.json',
                     'SDK-LOCAL-SNAPSHOT-REQUEST.json','SDK-LOCAL-SNAPSHOT-COMMAND.json','SDK-STOPPED-FOR-SNAPSHOT.json',
                     'SDK-IMAGE-CLEANUP-OBSERVED.json','SDK-IMAGE-CLEANUP.json','observations')
# Fixed known native-side SDK-bearing outputs. These remain on-host for genuine
# before/after/ledger admission; none are checkpoint/export evidence.
NATIVE_SDK_PATHS=('MAIN05-ATTEMPT.json','LOCAL-SDK-IMAGE-BEFORE-NATIVE.json','controls/prepared-sdk',
 'observations/MAIN05-STAGE.json','observations/MAIN05-ATTEMPT.json',
 'observations/installed-package-identities-before.txt','observations/installed-package-identities-after.txt',
 'observations/SDK-PROJECTION-before.json','observations/SDK-PROJECTION-after.json',
 'observations/sdk-observed-before.json.gz','observations/sdk-comparison-before.json.gz',
 'observations/sdk-observed-after.json.gz','observations/sdk-comparison-after.json.gz')

def physical_file(path,maximum,*,unique=True):
 path=Path(path);h.physical(path);s=path.lstat()
 require(stat.S_ISREG(s.st_mode) and (not unique or s.st_nlink==1) and 0<=s.st_size<=maximum,'Physical bounded evidence file/link scope required')
 return {'bytes':s.st_size,'sha256':h.digest_file(path,maximum=maximum)['sha256'],'mode':stat.S_IMODE(s.st_mode)}

def historical_baseline(state):
 """Called only after the accepted constructor physically verifies predecessor."""
 return physical_file(Path(state)/BASELINE,256*1024**2)

def historical_package_inventory(state,package_inventory_sha256):
 require(type(package_inventory_sha256) is str and re.fullmatch('[a-f0-9]{64}',package_inventory_sha256),
         'Predecessor package inventory binding required')
 path=Path(state)/PACKAGE_INVENTORY
 require(os.path.lexists(path),'Historical predecessor package inventory missing')
 pin=physical_file(path,1024**2)
 require(pin['sha256']==package_inventory_sha256,'Historical predecessor package inventory bytes changed')
 return pin

def raw_sdk_pins(sdk_frame,prepared_controls,*,native_frame=None):
 sdk_frame=h.physical(Path(sdk_frame));prepared_controls=h.physical(Path(prepared_controls))
 require(sdk_frame.is_dir() and prepared_controls.is_dir(),'Physical NEW SDK family roots required')
 files=[]
 for name in SDK_SENSITIVE_PATHS:
  p=sdk_frame/name
  if not os.path.lexists(p):continue
  if p.is_dir():
   require(not p.is_symlink(),'SDK family directory alias refused')
   for x in p.rglob('*'):
    require(not x.is_symlink(),'SDK family child alias refused')
    if not x.is_dir():files.append(x)
  else:files.append(p)
 for x in prepared_controls.rglob('*'):
  require(not x.is_symlink(),'Prepared SDK child alias refused')
  if not x.is_dir():files.append(x)
 if native_frame is not None:
  native_frame=h.physical(Path(native_frame));require(native_frame.is_dir(),'Physical fixed native frame required')
  for name in NATIVE_SDK_PATHS:
   path=native_frame/name
   if not os.path.lexists(path):continue
   require(not path.is_symlink(),'Native SDK metadata alias refused')
   if path.is_dir():
    for child in path.rglob('*'):
     require(not child.is_symlink(),'Native SDK metadata child alias refused')
     if not child.is_dir():files.append(child)
   else:files.append(path)
  prepared=native_frame.parent/'NATIVE-PREPARED.json'
  if os.path.lexists(prepared):files.append(prepared)
 require(0<len(files)<=1000,'Bounded nonempty NEW SDK family required for scope guard')
 return {(v['bytes'],v['sha256']) for p in files if (v:=physical_file(p,512*1024**2))['bytes']>0}

def inspect_state(state,sdk_frame,prepared_controls,baseline_pin,*,deadline,package_inventory_sha256,native_frame=None):
 state=h.physical(Path(state));sdk_frame=h.physical(Path(sdk_frame));prepared_controls=h.physical(Path(prepared_controls))
 for foreign in [sdk_frame,prepared_controls]:
  require(state!=foreign and state not in foreign.parents and foreign not in state.parents,'Original state and NEW SDK family overlap')
 require(historical_baseline(state)==baseline_pin,'Historical configure SDK baseline bytes/mode changed')
 historical_package_inventory(state,package_inventory_sha256)
 for name in FORBIDDEN_STATE_PATHS:require(not os.path.lexists(state/name),'NEW/old SDK exporter directory cannot enter successor state')
 pins=raw_sdk_pins(sdk_frame,prepared_controls,native_frame=native_frame);sizes={n for n,digest in pins};checked=0
 for p in state.rglob('*'):
  require(time.monotonic()<deadline,'SDK scope inspection deadline reached')
  s=p.lstat()
  if stat.S_ISDIR(s.st_mode):continue
  # The checkpoint codec later validates all link semantics. An alias into the
  # NEW SDK family is refused here rather than followed into foreign bytes.
  if stat.S_ISLNK(s.st_mode):
   resolved=p.resolve()
   require(all(resolved!=r and r not in resolved.parents for r in [sdk_frame,prepared_controls]),'State link targets NEW SDK family')
   continue
  require(stat.S_ISREG(s.st_mode),'Unsupported successor source-state member')
  # Both historical paths were bound to their predecessor bytes above.
  if p.relative_to(state).as_posix() in (BASELINE,PACKAGE_INVENTORY):continue
  if s.st_size in sizes:
   v=physical_file(p,512*1024**2,unique=False);checked+=1
   require((v['bytes'],v['sha256']) not in pins,'Exact NEW SDK family body copied into original source state')
 return {'historicalBaselineRetainedByteIdentically':True,'newSdkRawFamilyExplicitlyExcluded':True,
         'candidateHashComparisons':checked,'universalProducerOutputNoninterferenceClaimed':False,
         'cacheOrNativeExecutionAuthorized':False}

def evidence_plan(native_frame,state,sdk_frame,prepared_controls,baseline_pin,*,deadline,package_inventory_sha256):
 native_frame=h.physical(Path(native_frame));state=h.physical(Path(state))
 require(state==native_frame/'state','Fixed complete native05 state required')
 scoped=inspect_state(state,sdk_frame,prepared_controls,baseline_pin,deadline=deadline,
                      package_inventory_sha256=package_inventory_sha256,native_frame=native_frame)
 sdk_pins=raw_sdk_pins(sdk_frame,prepared_controls,native_frame=native_frame);files={}
 for target,relative in MAIN_SOURCES.items():
  source=native_frame/relative;pin=physical_file(source,512*1024**2)
  require((pin['bytes'],pin['sha256']) not in sdk_pins,'NEW SDK raw body supplied as main evidence')
  require(all(source.resolve()!=r and r not in source.resolve().parents for r in [Path(sdk_frame),Path(prepared_controls)]),
          'Main evidence source belongs to NEW SDK family')
  files[target]={'source':str(source),'identity':pin}
 # No entire observations directory or MAIN05/SELECTED-PHASE-STAGE dump is
 # copied: those contain NEW sdkBefore/sdkAfter inventories and witnesses.
 return {'mainSources':files,'scope':scoped,'excludedNewSdkFamiliesStayOnHost':True,
         'rawSdkObservedStageDumpsMayEnterCheckpoint':False,'checkpointOrCacheExportAuthorized':False}

def retain_main_only(native_frame,state,sdk_frame,prepared_controls,baseline_pin,*,deadline,package_inventory_sha256):
 """Copy only the three fixed main evidence files; preserve all source state.

 No SDK observation or raw stage dump is copied. The SDK checks still execute
 and remain privately available to the existing phase/ledger validators.
 """
 native_frame=Path(native_frame);state=Path(state)
 plan=evidence_plan(native_frame,state,sdk_frame,prepared_controls,baseline_pin,deadline=deadline,
                    package_inventory_sha256=package_inventory_sha256)
 work=state/'__carrier_work';h.physical(work);require(work.is_dir(),'Physical original work directory required')
 destination=work/'native05-gcc-only-evidence'
 require(not os.path.lexists(destination),'Fresh main-only evidence destination required')
 before=raw_sdk_pins(sdk_frame,prepared_controls,native_frame=native_frame)
 staging=Path(tempfile.mkdtemp(prefix='.native05-evidence-',dir=work));published=False
 try:
  for name,row in plan['mainSources'].items():
   require(time.monotonic()<deadline,'Main-only evidence deadline reached')
   h.copy_pinned(Path(row['source']),staging/name,row['identity']);(staging/name).chmod(row['identity']['mode'])
   require(physical_file(staging/name,512*1024**2)==row['identity'],'Copied original main evidence differs')
  require(raw_sdk_pins(sdk_frame,prepared_controls,native_frame=native_frame)==before,'NEW SDK metadata changed during scope validation')
  record={'schemaVersion':1,'mainFiles':{name:row['identity'] for name,row in plan['mainSources'].items()},
          'historicalConfigureBaseline':baseline_pin,'historicalBaselineRetentionIsDistinctFromNewSdkExport':True,
          'newRawSdkFamilyCopied':False,'wholeOriginalStateRetained':True,'universalProducerOutputNoninterferenceClaimed':False,
          'nativeExecutionOrCacheExportAuthorized':False}
  with (staging/'INVENTORY.json').open('xb') as stream:stream.write(codec.canonical(record));stream.flush();os.fsync(stream.fileno())
  require(time.monotonic()<deadline,'Late main-only evidence publication refused')
  codec.rename_no_replace(staging,destination);published=True
  fd=os.open(work,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  try:os.fsync(fd)
  finally:os.close(fd)
  inspect_state(state,sdk_frame,prepared_controls,baseline_pin,deadline=deadline,
                package_inventory_sha256=package_inventory_sha256,native_frame=native_frame)
  require(set(p.name for p in destination.iterdir())=={*MAIN_SOURCES,'INVENTORY.json'},'Unexpected main-only evidence member')
  return record
 except BaseException:
  # A partial owned directory is retained for recovery. No checkpoint or phase
  # success follows; the outer fixed operator must record charged failure.
  raise
