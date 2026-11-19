"""Synthetic SDK scope fixtures, never original upstream data or execution."""
import hashlib,importlib.util,json
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
P=ROOT/'scripts/producer-qualification'
def load(path):
 spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
V=load(P/'gcc-native05-checkpoint-profile.py');S=V.scope
HEAD='a'*40

def sdk_receipt():
 r=V.receipt.empty_receipt(HEAD)
 r.update(errorId='none',sdkVerifiedOnHost=True,sdkContainerExitCode=0,sdkContainerQuiescent=True,ownedSdkCleanupObserved=True,sdkContainerSeconds=1,
          counts={k:1 for k in r['counts']},hashes={k:'b'*64 for k in r['hashes']},diagnostics={**V.receipt.empty_diagnostics(),'stage':'complete'})
 r['counts'].update(generatedOutputs=51,formats=13)
 return V.receipt.validate_receipt(r)

def make_scope(args):
 frame,sdk=args[:2];state=frame/'state';private=frame.parent/'sdk-private';private.mkdir()
 (private/'opaque-wrapper-output.log').write_bytes(b'Synthetic private SDK wrapper traceback/opaque output')
 (private/'independent-sdk-controls/prepared-sdk').mkdir(parents=True)
 for name in {*V.load('gcc-main05-sdk.py').FILES,'PREPARED-SDK-MANIFEST.json'}:
  (private/'independent-sdk-controls/prepared-sdk'/name).write_bytes(('Synthetic verified SDK controls '+name).encode())
 (state/S.BASELINE).write_bytes(b'{"syntheticOriginalBaseline":true,"historical":true}\n')
 (frame/'native.log').write_bytes(b'Synthetic GCC-only stdout distinct from SDK stdout\xff')
 (frame/'resource-samples.json').write_bytes(b'{"syntheticGccSamples":[]}')
 command=V.load('gcc-main05-stage.py').COMMAND
 requested={'command':command,'label':'original-main05','cwd':'/build/source','state':'requested'}
 terminal={**requested,'state':'terminal','exitCode':0,'signal':None,'terminalObserved':True,'elapsedSeconds':80}
 (frame/'observations/original-commands.jsonl').write_bytes(V.receipt.canonical(requested)+V.receipt.canonical(terminal))
 for name in S.NATIVE_SDK_PATHS:
  p=frame/name
  if p.exists() or name=='controls/prepared-sdk':continue
  p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(('Synthetic raw SDK metadata '+name).encode())
 if not (frame.parent/'NATIVE-PREPARED.json').exists():(frame.parent/'NATIVE-PREPARED.json').write_bytes(b'{"syntheticRawPreparedSdkManifest":true}')
 value=sdk_receipt();value['hashes']['sdkStdout']=hashlib.sha256((sdk/'native.log').read_bytes()).hexdigest()
 value['hashes']['wrapperOutput']=hashlib.sha256((private/'opaque-wrapper-output.log').read_bytes()).hexdigest()
 family={path.name:{k:pin[k] for k in ['bytes','sha256']} for path in sorted((private/'independent-sdk-controls/prepared-sdk').iterdir()) if (pin:=S.physical_file(path,32*1024**2))}
 value['hashes']['metadataFamily']=hashlib.sha256(V.receipt.canonical(family)).hexdigest()
 return {'privateRoot':private,'preparedControls':private/'independent-sdk-controls',
         'historicalConfigureBaseline':S.historical_baseline(state),'historicalSdkReceipt':value}
