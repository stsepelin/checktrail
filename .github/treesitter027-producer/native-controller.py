"""Manual original Tree-sitter6070 producer; frozen operator review required.

Imports/planning execute no SDK or source code. Execution uses the unchanged
reviewed macOS Native supervisor under the distinct existing nobody account.
"""
import argparse,gzip,hashlib,importlib.util,json,os,pwd,re,shutil,signal,stat,sys,time
from pathlib import Path
HERE=Path(__file__).resolve().parent

def load(name,file):
 spec=importlib.util.spec_from_file_location(name,HERE/file);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
D=load('tree_original_driver','original-stage-driver.py');N=D.N
M=load('tree_materializer','materialize-native-inputs.py');I=load('tree_curator','curate-native-inputs.py')
A=load('tree_admission','admit.py');P=load('tree_budget','custody-budget.py');G=load('tree_git_proof','git_source_root_proof.py')
SELECTION='tree-sitter-native-0.27.0-6070dbf'
LIMITS={**N.LIMITS,'wholeSeconds':2400,'logBytes':128*1024**2,'minimumFreeBytes':8*1024**3,'sampledRssBytes':6*1024**3,'outputBytes':384*1024**2,'outputFiles':20000}
N.LIMITS=LIMITS
CAPTURE_BYTES=512*1024**2
WHOLE_SECONDS=3600
OUTPUTS=['target/aarch64-apple-darwin/release/tree-sitter','libtree-sitter.a','libtree-sitter.dylib','tree-sitter.pc','build/static/libtree-sitter.a','build/shared/libtree-sitter.dylib']+['lib/binding_web/'+p for p in ['web-tree-sitter.js','web-tree-sitter.cjs','web-tree-sitter.wasm','debug/web-tree-sitter.js','debug/web-tree-sitter.cjs','debug/web-tree-sitter.wasm']]

def need(value,message):
 if not value:raise ValueError(message)

def atomic(path,value):N.atomic_json(path,value,mode=0o444)

def own_tree(path,uid,gid,writable=False):
 need(path==path.resolve(strict=True),'Physical new owned tree required')
 for folder,dirs,files in os.walk(path,followlinks=False):
  for name in dirs+files:
   item=Path(folder)/name
   if item.is_symlink():os.lchown(item,uid,gid);continue
   mode=item.stat().st_mode;os.chown(item,uid,gid)
   item.chmod((0o755 if writable else 0o555) if item.is_dir() or mode&0o111 else (0o644 if writable else 0o444))
 os.chown(path,uid,gid);path.chmod(0o700 if writable else 0o555)

def run_context(env):
 need(os.getuid()==0 and env.get('GITHUB_ACTIONS')=='true' and env.get('GITHUB_EVENT_NAME')=='workflow_dispatch' and env.get('RUNNER_ENVIRONMENT')=='github-hosted','Reviewed public hosted operator dispatch required')
 need(env.get('GITHUB_REPOSITORY')=='stsepelin/checktrail' and re.fullmatch('[0-9a-f]{40}',env.get('GITHUB_SHA','')),'Concrete repository/head binding required')
 for key in ['GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT']:need(re.fullmatch('[0-9]+',env.get(key,'')),'Numeric run/attempt required')
 return env['GITHUB_RUN_ID'],env['GITHUB_RUN_ATTEMPT']

def namespace(env):
 run,attempt=run_context(env);return Path('/private/tmp')/('checktrail-tree027-'+run+'-'+attempt)

def owned_marker(work,env):
 expected=namespace(env);need(work==expected,'Foreign cleanup/capture namespace')
 if not os.path.lexists(work):return None
 need(work==work.resolve(strict=True) and work.lstat().st_uid==0 and stat.S_ISDIR(work.lstat().st_mode),'Physical root-owned workspace required')
 marker=work/'control/OWNERSHIP.json';need(marker.lstat().st_uid==0 and not marker.is_symlink(),'Root-owned marker required');value=json.loads(N.read_physical(marker))
 need(value['selection']==SELECTION and value['work']==str(work) and value['runId']==env['GITHUB_RUN_ID'] and value['attempt']==env['GITHUB_RUN_ATTEMPT'] and value['sourceCommit']==env['GITHUB_SHA'] and value['upstreamSourceCommit']=='6070dbfefd326bd735e5683eb128cc1b57dad0c0','Concrete ownership binding differs')
 need(not [r for r in N.ps_rows() if r['uid']==value['buildUid'] and r['pid'] not in value['baselineBuildUidPids']],'Unreaped build UID; retain workspace until disposal');return value
# Reuse the reviewed validate-all-before-mode-change and alarm-bounded cleanup.
N.owned_marker=owned_marker

def stage_capture(work,env):
 if owned_marker(work,env) is None:return {'staged':False,'reason':'owned namespace never created'}
 total=0;count=0
 for folder,dirs,files in os.walk(work/'capture',followlinks=False):
  for name in dirs+files:
   path=Path(folder)/name;s=path.lstat();need(not path.is_symlink() and s.st_uid==0 and (stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode) and s.st_nlink==1),'Foreign/symbolic capture path');total+=s.st_size if stat.S_ISREG(s.st_mode) else 0;count+=1
   need(total<=CAPTURE_BYTES and count<=22000,'Tree capture ceiling')
 index=[]
 for folder,dirs,files in os.walk(work/'capture',followlinks=False):
  for name in files:
   path=Path(folder)/name
   if path.name!='CAPTURE-INDEX.json':index.append({'relativePath':path.relative_to(work/'capture').as_posix(),**N.physical_file(path)})
 if not (work/'capture/CAPTURE-INDEX.json').exists():
  value={'runId':env['GITHUB_RUN_ID'],'attempt':env['GITHUB_RUN_ATTEMPT'],'controllerCommit':env['GITHUB_SHA'],'files':index,'sourceOrSDKInputTreesExported':False};need(total+len(json.dumps(value,sort_keys=True,indent=2).encode())+1<=CAPTURE_BYTES,'Capture index exceeds total ceiling');atomic(work/'capture/CAPTURE-INDEX.json',value)
 result=N.stage_capture(work,env);result.pop('sdkOrToolPermissionsModified',None);result['stockSDKOrToolPermissionsModified']=False;return result

def runtime_host(work,readiness):
 need(readiness['allDeclaredHostChecksObserved'] is True,'Fresh host metadata admission required');account=pwd.getpwnam('nobody');tools={}
 for name in ['cmake','git','python3','jq','gzip','zip','make','gcc','ar']:
  path=shutil.which(name,path='/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin');need(path is not None,'Original host tool unavailable: '+name);tools[name]=N.physical_file(path)
 home=work/'home';home.mkdir();os.chown(home,account.pw_uid,account.pw_gid);home.chmod(0o700)
 return {'buildUid':account.pw_uid,'buildGid':account.pw_gid,'buildUser':'nobody','buildHome':str(home),'tools':tools,'developerDir':str(A.DEVELOPER),'sdk':str(A.SDK),'identity':readiness['identity']}

def source_tree_proof(source,expected):
 entries={};rows=[]
 for folder,dirs,files in os.walk(source,followlinks=False):
  for name in dirs+files:
   path=Path(folder)/name;s=path.lstat();relative=path.relative_to(source).as_posix()
   if path.is_symlink():body=os.readlink(path).encode('utf8','surrogateescape');mode='120000';h=G.git_blob(body)
   elif stat.S_ISDIR(s.st_mode):continue
   else:
    need(stat.S_ISREG(s.st_mode) and s.st_nlink==1,'Unsupported source tree leaf');mode='100755' if s.st_mode&0o111 else '100644';h=hashlib.sha1(b'blob '+str(s.st_size).encode()+b'\0')
    with path.open('rb') as stream:
     while True:
      body=stream.read(65536)
      if not body:break
      h.update(body)
    h=h.hexdigest()
   entries[relative]=(mode,h);rows.append({'path':relative,'mode':mode,'blobSHA1':h})
 observed=G.git_tree(entries);need(observed==expected,'Every original source blob/mode must reproduce selected Git tree');return {'complete':True,'expectedTree':expected,'observedTree':observed,'blobs':len(entries),'allBlobModes':rows,'GitHistoryFabricated':False}

def prepare_payload(work,manifest,curated):
 archives={row['id']:Path(row['file']) for row in curated['records']};rows=manifest['primary'].copy()
 for crate in manifest['cargo']:rows.append({**crate,'id':'cargo:'+crate['name']+'@'+crate['version'],'materialization':{'destination':'vendor/'+crate['archivePrefix'],'strip':1},'cargoPackageChecksum':crate['sha256']})
 report=M.prepare(archives,rows,work/'inputs');atomic(work/'capture/MATERIALIZATION.json',report)
 proofs=[]
 for row in manifest['primary']:
  if row['materialization'].get('sourceGitTree'):proofs.append({'id':row['id'],**source_tree_proof(work/'inputs'/row['materialization']['destination'],row['materialization']['sourceGitTree'])})
 atomic(work/'capture/ORIGINAL-SOURCE-TREES.json',proofs)
 for name,source in [('source',work/'inputs/source'),('emsdk',work/'inputs/emsdk-source')]:shutil.copytree(source,work/name,symlinks=True)
 for relative in OUTPUTS:need(not os.path.lexists(work/'source'/relative),'Pre-existing output cannot receive fresh-build credit: '+relative)
 need(not (work/'source/target').exists() and not (work/'source/build').exists(),'Original source already has build directories')
 downloads=work/'emsdk/downloads';downloads.mkdir(exist_ok=True)
 for row in manifest['primary']:
  if row['materialization'].get('originalInstallerOnly'):shutil.copyfile(archives[row['id']],downloads/row['materialization']['filename'])
 cargo=work/'cargo-home';cargo.mkdir();(cargo/'config.toml').write_text('[source.crates-io]\nreplace-with = "original-locked-vendor"\n[source.original-locked-vendor]\ndirectory = '+json.dumps(str(work/'inputs/vendor'))+'\n')
 (work/'control/git-empty.config').write_bytes(b'');shutil.copytree(work/'inputs/node24/lib/node_modules/npm',work/'npm-tool',symlinks=True)
 cache_downloads=work/'downloads/npm';cache_downloads.mkdir(parents=True)
 for row in manifest['npm']:shutil.copyfile(archives[row['id']],cache_downloads/(row['sha256']+'.tgz'))
 return archives

def phase_environment(work,manifest,host):
 env=D.clean_environment(work,work/'inputs',host,work/'emsdk',work/'emsdk/node/UNACTIVATED/bin/node',work/'em-cache');env.pop('EMSDK_NODE');env['CHECKTRAIL_WASMTIME_VERSION_RECEIPT']=str(work/'state/wasmtime-version.txt');return env

def permission_admission(native,work,host,environment,extra_roots=(),phase='input-permissions'):
 # The existing v4 metadata/physical-target checks are reused, not broadened.
 guard=work/'control/.write-guard'
 if not guard.exists():guard.write_bytes(b'owned guard\n');guard.chmod(0o444)
 request=work/'control'/('permission-'+phase+'.json');request.write_bytes(b'{}');request.chmod(0o444)
 roots=[work/'inputs',work/'control',HERE,work/'npm-tool',work/'downloads',*map(Path,extra_roots),*[Path(x['path']) for x in host['tools'].values()]]
 roots=sorted(set(p.resolve(strict=True) for p in roots),key=lambda p:len(p.parts));selected=[]
 for root in roots:
  if not any(root==x or x in root.parents for x in selected):selected.append(root)
 bounds=A.Bounds();frame=A.snapshot(selected,bounds);frame=[r for r in frame if r['path']!=str(request)]
 controller=work/'control/admit.py';payload={'frame':frame,'controller':{'file':str(controller),'sha256':M.digest(controller),'uid':int(os.environ['CHECKTRAIL_CONTROLLER_UID'])},'identity':host['identity']};request.write_bytes(A.encoded(payload));need(request.stat().st_size<=A.MAX_DECODED_METADATA,'Permission frame bound')
 result=native.run(phase,[host['tools']['python3']['path'],'-I','-S','-B',str(controller),'--inner',str(request)],environment,work,300);observed=json.loads(Path(result['log']['path']).read_bytes());endpoint=A.current_endpoint(frame)
 need(observed['allSelectedEntriesReadableExecutableAndProtected'] is True and observed['selectedEntriesChecked']==len(frame) and observed['metadataEndpointSha256']==A.digest(A.encoded(endpoint)),'Materialized input or controller permissions refused')
 probe="""import errno,json,os,sys
v=json.load(open(sys.argv[1]));assert os.getuid()==v['uid']
count=0
for p in v['protected']:
 for action in [lambda:open(p,'ab'),lambda:os.unlink(p),lambda:os.rename(p,p+'.renamed'),lambda:open(p+'.new','xb')]:
  try:r=action()
  except OSError as e:assert e.errno in (errno.EACCES,errno.EPERM);count+=1
  else:
   if hasattr(r,'close'):r.close()
   raise AssertionError('protected write/replacement unexpectedly allowed')
for parent in v['writable']:
 p=parent+'/.effective-write-positive';f=open(p,'xb');f.write(b'positive');f.close();os.unlink(p)
print(json.dumps({'uid':os.getuid(),'directDenials':count,'positiveWritableRoots':len(v['writable'])}))
"""
 counter=work/'control'/('counter-'+phase+'.json');atomic(counter,{'uid':host['buildUid'],'protected':[str(guard),str(work/'inputs/node24/bin/node'),str(work/'inputs/rust/bin/rustc')],'writable':[str(work/'source'),str(work/'state'),str(work/'tmp')]});native.run(phase+'-counterfactual',[host['tools']['python3']['path'],'-I','-S','-c',probe,str(counter)],environment,work,120)
 # Counter metadata is created after the endpoint comparison; no continuous claim.
 atomic(work/'capture'/(phase+'.json'),{'observed':observed,'frameEntries':len(frame),'hashReadBytes':bounds.bytes,'metadataEndpointMatched':True,'continuousImmutabilityClaimed':False,'stockPermissionsChanged':False})


def check_runtime(native,work,host,environment):
 for name,args,expected in [('rustc',['rustc','--version','--verbose'],'release: 1.98.0'),('cargo',['cargo','--version','--verbose'],'release: 1.98.0'),('node',['node','--version'],'v24.18.0'),('npm',['npm','--version'],'11.16.0')]:
  record=native.run('sdk-runtime-'+name,args,environment,work/'source',60);body=Path(record['log']['path']).read_text();need(expected in body.splitlines(),'Exact original SDK runtime identity differs: '+name)
  if name=='rustc':need('host: aarch64-apple-darwin' in body.splitlines(),'Rust SDK host identity differs')
 atomic(work/'capture/SDK-RUNTIME-OBSERVED.json',{'rustc':'1.98.0','cargo':'1.98.0','node':'24.18.0','npm':'11.16.0','sourceBuildOfSDKsClaimed':False})

def installed_sdk_identity(work,manifest):
 records=[]
 for row in manifest['installedSDKKeyFiles']:
  path=work/'emsdk'/row['installedPath'];physical=path.resolve(strict=True);need(work/'emsdk' in physical.parents,'Installed SDK identity escaped');actual=N.physical_file(physical);need(actual['bytes']==row['bytes'] and actual['sha256']==row['sha256'],'Original installed SDK executable identity differs');records.append({**row,'observed':actual})
 return records

def freeze_emsdk(native,work,manifest,host,environment):
 node=work/'emsdk/node/22.16.0_64bit/bin/node';python=work/'emsdk/python/3.13.3_64bit/bin/python3';need(node.is_file() and python.is_file(),'Original installed Emsdk selections missing');records=installed_sdk_identity(work,manifest)
 cache=work/'emsdk/upstream/emscripten/cache';need(cache.is_dir() and not os.path.lexists(work/'em-cache'),'Fresh Emscripten cache copy required');shutil.copytree(cache,work/'em-cache',symlinks=True);own_tree(work/'em-cache',host['buildUid'],host['buildGid'],True);D.immutable_sdk_tree(work/'emsdk')
 environment={**environment,'EMSDK_NODE':str(node)};permission_admission(native,work,host,environment,[work/'emsdk'],'activated-sdk-permissions')
 for name,args,expected in [('emsdk-node',[str(node),'--version'],'v22.16.0'),('emsdk-python',[str(python),'--version'],'Python 3.13.3')]:
  record=native.run('sdk-runtime-'+name,args,environment,work/'source',60);need(Path(record['log']['path']).read_text().strip()==expected,'Exact installed Emsdk runtime identity differs')
 atomic(work/'capture/EMSDK-INSTALLED-IDENTITIES.json',{'keyFiles':records,'catalog':N.input_catalog(work/'emsdk',4*1024**3,200000),'onlyNewSDKCopyFrozen':True,'sourceBuildOfSDKsClaimed':False});return {'EMSDK_NODE':str(node)}

def capture_outputs(work,manifest,host):
 source=work/'source';pending=[];total=0
 # Resolve and validate every required result before exporting any result.
 for relative in OUTPUTS:
  path=source/relative;physical=path.resolve(strict=True);need(source in physical.parents and physical.is_file(),'Required original output missing/escaping: '+relative);s=physical.stat();need(s.st_uid==host['buildUid'] and s.st_nlink==1,'Foreign/hardlinked original output');total+=s.st_size;need(total<=LIMITS['outputBytes'],'Native output bound');pending.append((relative,physical,os.readlink(path) if path.is_symlink() else None))
 output=work/'capture/outputs';output.mkdir();records=[]
 for relative,physical,link in pending:
  target=output/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(physical,target);target.chmod(0o444);records.append({'sourcePath':relative,'originalSourceLink':link,'resolvedSourcePath':str(physical.relative_to(source)),**N.physical_file(target)})
 cli=output/OUTPUTS[0];identity=N.macho_identity(cli,2);need(identity['buildVersion']['sdk']==(15<<16|5<<8),'Fresh native CLI selected SDK must be15.5')
 atomic(work/'capture/OUTPUTS.json',{'records':records,'nativeCLI':identity,'symlinkResultsExportedAsBoundPhysicalBytes':True,'originalLinuxReleasePackagingReproduced':False,'historicalPublisherByteEqualityClaimed':False,'SDKOrSourceTreesExported':False});return records

def fresh_host(work,env):
 shutil.copyfile(HERE/'admit.py',work/'control/admit.py');(work/'control/admit.py').chmod(0o444);spec=importlib.util.spec_from_file_location('fresh_tree_host',work/'control/admit.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 return module.observe(work/'control',work/'capture/host-readiness',{k:env[k] for k in ['GITHUB_ACTIONS','RUNNER_ENVIRONMENT','RUNNER_OS','RUNNER_ARCH','CHECKTRAIL_CONTROLLER_UID',*A.CONTEXT]})

def observe(manifest):
 env=dict(os.environ);work=namespace(env);need(not os.path.lexists(work),'Fresh run namespace required');I.validate(manifest);started=time.monotonic();account=pwd.getpwnam('nobody');baseline=[r['pid'] for r in N.ps_rows() if r['uid']==account.pw_uid];work.mkdir(mode=0o755);work.chmod(0o755);N.owned_directory(work/'control');N.owned_directory(work/'capture');complete=False;error=None;native=None
 atomic(work/'control/OWNERSHIP.json',{'selection':SELECTION,'runId':env['GITHUB_RUN_ID'],'attempt':env['GITHUB_RUN_ATTEMPT'],'sourceCommit':env['GITHUB_SHA'],'upstreamSourceCommit':manifest['sourceCommit'],'buildUid':account.pw_uid,'baselineBuildUidPids':baseline,'work':str(work)})
 previous=signal.getsignal(signal.SIGALRM);need(signal.getitimer(signal.ITIMER_REAL)==(0.0,0.0),'Existing whole alarm refused')
 def expired(_number,_frame):raise TimeoutError('Tree original producer whole3600s deadline')
 signal.signal(signal.SIGALRM,expired);signal.setitimer(signal.ITIMER_REAL,WHOLE_SECONDS)
 try:
  ready=fresh_host(work,env);need(ready['allDeclaredHostChecksObserved'] is True,'Fresh original host checks refused');(work/'control/build-home').rmdir();host=runtime_host(work,ready)
  need(shutil.disk_usage(work).free>=16*1024**3,'Original input/build scratch admission needs16GiB free');curated=I.acquire(manifest,work/'archives',P.Budget);atomic(work/'capture/CURATOR-RESULT.json',curated)
  for file in (work/'archives').iterdir():file.chmod(0o444)
  (work/'archives').chmod(0o555);prepare_payload(work,manifest,curated)
  for name in ['tmp','cache','npm-cache','state']:(work/name).mkdir()
  for name in ['source','emsdk','cargo-home','tmp','cache','npm-cache','state']:own_tree(work/name,host['buildUid'],host['buildGid'],True)
  environment=phase_environment(work,manifest,host);native=N.Native(work,host);need(native.baseline_nobody==set(baseline),'Build UID process set changed before execution');permission_admission(native,work,host,environment);check_runtime(native,work,host,environment)
  catalog=work/'control/native-inputs.json';atomic(catalog,manifest);native.run('sdk-npm-cache',[str(work/'inputs/node24/bin/node'),'--permission','--allow-fs-read='+str(work),'--allow-fs-read='+str(HERE/'original-npm-cache.mjs'),'--allow-fs-write='+str(work/'npm-cache'),str(HERE/'original-npm-cache.mjs'),str(work),str(catalog)],environment,work,300)
  proof=work/'npm-cache/proof.json';need(proof.is_file() and not proof.is_symlink() and proof.stat().st_size<=4096,'Npm offline cache proof missing');value=json.loads(proof.read_bytes());need(value['lockedPaths']==253 and value['uniqueArchives']==245 and value['offlineReads']==245 and value['corruptPayloadRejected'] is True and value['restoredReads']==245,'Original npm cache counterfactual proof differs');atomic(work/'capture/NPM-CACHE.json',value)
  D.run(native,work/'source',work/'emsdk',environment,lambda:freeze_emsdk(native,work,manifest,host,environment),lambda value:atomic(work/'capture/EMBEDDED-INPUTS.json',value));capture_outputs(work,manifest,host);need(sum(p.stat().st_size for p in (work/'capture').rglob('*') if p.is_file())<=CAPTURE_BYTES-1024**2,'Capture reserve exhausted');need(time.monotonic()-started<WHOLE_SECONDS,'Late success refused');owned_marker(work,env);complete=True
 except Exception as failure:error={'type':type(failure).__name__,'reason':str(failure)[:1024]}
 finally:
  signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,previous)
  if time.monotonic()-started>=WHOLE_SECONDS:complete=False;error={'type':'TimeoutError','reason':'Whole deadline exhausted; apparent completion not accepted'}
  result={'complete':complete,'sourceCommit':manifest['sourceCommit'],'sourceTree':manifest['sourceTree'],'controllerCommit':env['GITHUB_SHA'],'run':env['GITHUB_RUN_ID'],'attempt':env['GITHUB_RUN_ATTEMPT'],'elapsedSeconds':time.monotonic()-started,'failure':error,'phases':native.receipts if native else [],'upstreamTestsPassedClaimed':False,'fullCompilerSDKSourceBuildLegalOrGateAClosureClaimed':False,'sourceOrSDKInputTreesExported':False};atomic(work/'capture/RESULT.json',result)
 return work,result

def main():
 parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='mode',required=True);produce=sub.add_parser('observe');produce.add_argument('manifest');produce.add_argument('--sha256',required=True)
 for mode in ['stage-capture','cleanup']:sub.add_parser(mode).add_argument('work')
 args=parser.parse_args()
 if args.mode=='observe':
  file=Path(args.manifest);need(file==file.resolve(strict=True) and file.stat().st_uid==0 and M.digest(file)==args.sha256,'Frozen root input manifest required');work,result=observe(json.loads(file.read_bytes()));print(json.dumps({'work':str(work),'complete':result['complete'],'failure':result['failure']}));return 0 if result['complete'] else 1
 result=stage_capture(Path(args.work),dict(os.environ)) if args.mode=='stage-capture' else N.cleanup(Path(args.work),dict(os.environ))
 if args.mode=='cleanup':result.pop('sdkOrToolInputsDeleted',None);result.update(onlyOwnedInputCopiesDeleted=result.get('deleted',False),stockSDKOrToolInputsDeleted=False)
 print(json.dumps(result));return 0
if __name__=='__main__':raise SystemExit(main())
