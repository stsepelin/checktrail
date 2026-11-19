"""Offline bounded first-party Tree producer capture readback; no binary execution."""
import argparse,hashlib,importlib.util,json,os,re,stat
from pathlib import Path
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('tree_capture_controller',HERE/'native-controller.py');C=importlib.util.module_from_spec(spec);spec.loader.exec_module(C)
def need(c,m):
 if not c:raise ValueError(m)
def physical(root,relative):
 need(isinstance(relative,str) and relative and not relative.startswith('/') and all(p not in ('','.','..') for p in relative.split('/')),'Capture path unsafe');path=root/relative;s=path.lstat();need(path==path.resolve(strict=True) and stat.S_ISREG(s.st_mode) and s.st_nlink==1,'Physical regular capture required');return path
def validate(root,manifest,run,attempt,head):
 root=root.resolve(strict=True);need(re.fullmatch('[0-9]+',run) and re.fullmatch('[0-9]+',attempt) and re.fullmatch('[a-f0-9]{40}',head),'Concrete run identity required');index=json.loads(physical(root,'CAPTURE-INDEX.json').read_bytes());need(index['runId']==run and index['attempt']==attempt and index['controllerCommit']==head,'Capture index owner differs');expected=set();total=physical(root,'CAPTURE-INDEX.json').stat().st_size
 for row in index['files']:
  name=row['relativePath'];need(name not in expected,'Duplicate indexed capture path');expected.add(name);path=physical(root,name);total+=path.stat().st_size;need(total<=C.CAPTURE_BYTES and path.stat().st_size==row['bytes'] and C.M.digest(path)==row['sha256'],'Capture bytes/hash mismatch')
 actual={p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()};need(actual==expected|{'CAPTURE-INDEX.json'},'Unindexed/missing capture file');need(not any(p.is_symlink() for p in root.rglob('*')),'Capture link refused');result=json.loads(physical(root,'RESULT.json').read_bytes());need(result['run']==run and result['attempt']==attempt and result['controllerCommit']==head and result['sourceCommit']==manifest['sourceCommit'] and result['sourceTree']==manifest['sourceTree'],'Producer run/source binding differs')
 report={'captureBytes':total,'files':len(expected),'run':run,'attempt':attempt,'head':head,'actualComplete':result['complete'],'fullCompilerSDKSourceBuildLegalOrGateAClosureClaimed':False}
 if not result['complete']:return {**report,'acceptedOriginalProducerObservation':False,'failure':result['failure']}
 need(result['elapsedSeconds']<C.WHOLE_SECONDS and result['failure'] is None,'Late/failed result cannot complete');phases=result['phases'];names=[p['phase'] for p in phases]
 expected_names=['input-permissions','input-permissions-counterfactual','sdk-runtime-rustc','sdk-runtime-cargo','sdk-runtime-node','sdk-runtime-npm','sdk-npm-cache','original-emsdk-install','original-emsdk-activate','activated-sdk-permissions','activated-sdk-permissions-counterfactual','sdk-runtime-emsdk-node','sdk-runtime-emsdk-python']+[p['id'] for p in C.D.profiles(Path('/source'),Path('/emsdk'))][2:]
 need(names==expected_names and all(p['success'] is True and p['exitCode']==0 and not p['unreapedBuildUidProcesses'] for p in phases),'Original stage completion/order differs')
 for name in ['input-permissions','activated-sdk-permissions']:
  v=json.loads(physical(root,name+'.json').read_bytes());need(v['metadataEndpointMatched'] is True and v['observed']['allSelectedEntriesReadableExecutableAndProtected'] is True and v['observed']['failureCount']==0,'Input permission observation refused')
 ready=json.loads(physical(root,'host-readiness/admission.json').read_bytes());need(ready['allDeclaredHostChecksObserved'] is True and len(ready['checks'])==14 and all(v is True for v in ready['checks'].values()),'Original host readiness refused')
 original=json.loads(physical(root,'ORIGINAL-SOURCE-TREES.json').read_bytes());need({r['id']:r['observedTree'] for r in original}=={r['id']:r['materialization']['sourceGitTree'] for r in manifest['primary'] if r['materialization'].get('sourceGitTree')} and all(r['complete'] is True for r in original),'Source root proof differs')
 npm=json.loads(physical(root,'NPM-CACHE.json').read_bytes());need(npm['lockedPaths']==253 and npm['uniqueArchives']==npm['offlineReads']==npm['restoredReads']==245 and npm['corruptPayloadRejected'] is True,'Npm cache scope differs');curated=json.loads(physical(root,'CURATOR-RESULT.json').read_bytes());need(curated['complete'] is True and len(curated['records'])==543,'Custody partition differs')
 pins={r['id']:r for r in C.I.validate(manifest)};need({r['id'] for r in curated['records']}==set(pins) and all(r['sha256']==pins[r['id']]['sha256'] and r['bytes']==pins[r['id']]['bytes'] for r in curated['records']),'Observed input pins differ')
 installed=json.loads(physical(root,'EMSDK-INSTALLED-IDENTITIES.json').read_bytes());need(len(installed['keyFiles'])==len(manifest['installedSDKKeyFiles']),'Installed SDK identity partition differs')
 for expected,observed in zip(manifest['installedSDKKeyFiles'],installed['keyFiles']):need(all(observed[k]==v for k,v in expected.items()) and observed['observed']['sha256']==expected['sha256'] and observed['observed']['bytes']==expected['bytes'],'Installed SDK key identity differs')
 runtime=json.loads(physical(root,'SDK-RUNTIME-OBSERVED.json').read_bytes());need(all(runtime[k]==manifest['versions'][k] for k in ['rustc','cargo','node','npm']),'SDK runtime identity differs')
 outputs=json.loads(physical(root,'OUTPUTS.json').read_bytes());need({r['sourcePath'] for r in outputs['records']}==set(C.OUTPUTS),'Missing/extra selected build output')
 for row in outputs['records']:
  path=physical(root,'outputs/'+row['sourcePath']);need(path.stat().st_size==row['bytes'] and C.M.digest(path)==row['sha256'],'Selected build output differs')
 identity=C.N.macho_identity(physical(root,'outputs/'+C.OUTPUTS[0]),2);need(identity['buildVersion']['sdk']==(15<<16|5<<8),'Native CLI SDK differs');return {**report,'acceptedOriginalProducerObservation':True,'selectedBuildPhases':14,'upstreamTestsPassedClaimed':False,'historicalByteEqualityClaimed':False}
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('capture');p.add_argument('manifest');p.add_argument('--run',required=True);p.add_argument('--attempt',required=True);p.add_argument('--head',required=True);a=p.parse_args();print(json.dumps(validate(Path(a.capture),json.loads(Path(a.manifest).read_bytes()),a.run,a.attempt,a.head),sort_keys=True))
