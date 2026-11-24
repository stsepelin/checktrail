"""Fixed native05 v4 admission; historical v3, v2 and v1 keep their original bindings.

No producer/SDK/cache code runs. The closed SDK record describes a historical
subaction completed before GCC. It is not a statement that GCC never ran.
"""
import hashlib,importlib.util,json,os,re,stat,time
from pathlib import Path

def load(name):
 path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

scope=load('gcc-native05-retention-scope.py')
receipt=load('gcc-sdk-onhost-receipt.py')
h=scope.h
require=h.require
PROFILE='gcc-native05-gcc-only-checkpoint-v4'
SDK_POLICY_SHA256='3a044fbbd5438560506c2649628bbd855bafc539d1c0a05bb23635e82eedc923'
# Historical profiles never follow the current SDK policy: each decodes only a
# receipt bound to the exact policy it was produced under.
V3_PROFILE='gcc-native05-gcc-only-checkpoint-v3'
V3_SDK_POLICY_SHA256='53e78d4937950c42fdddbcccacbb37b49b84d881ebd16e0f6397b69bad5232e9'
V2_PROFILE='gcc-native05-gcc-only-checkpoint-v2'
V2_SDK_POLICY_SHA256='d3d3df6c5ab0a92b99cd847444750e80f50c5959a42ed4462cce73d9f58d1c58'
HISTORICAL_DECODERS={V3_PROFILE:(receipt.validate_historical_v5_receipt,V3_SDK_POLICY_SHA256),
                     V2_PROFILE:(receipt.validate_historical_v4_receipt,V2_SDK_POLICY_SHA256)}
PROFILES={PROFILE,*HISTORICAL_DECODERS}
MAX_DESCRIPTOR=16384
MAX_PINS=128
EVIDENCE='__carrier_work/native05-gcc-only-evidence'
LEGACY='__carrier_work/main05-carrier-evidence'
SDK_STAGE='original-sdk-reconstruction-and-independent-physical-validation-before-native05'


def require_selected_policy():
 require(receipt.POLICY_SHA256==SDK_POLICY_SHA256,
         'Frozen native05-v4 SDK policy differs; new policy requires explicit profile/version decoder')
 return True


def raw_pin_rows(pins):
 rows=[{'bytes':n,'sha256':digest} for n,digest in sorted(pins)]
 require(0<len(rows)<=MAX_PINS,'Nonempty bounded raw SDK pin family required')
 require(all(type(r['bytes']) is int and 0<r['bytes']<=512*1024**2 and
             type(r['sha256']) is str and re.fullmatch('[a-f0-9]{64}',r['sha256']) for r in rows),'SDK body pin shape differs')
 return rows


def validate_descriptor(value,expected_head):
 require(type(value) is dict and set(value)=={'profile','preparedSdkMetadataRetainedInsideCheckpoint','historicalSdkSubaction',
  'historicalConfigureBaseline','excludedNewSdkBodyPins','sdkPinComparisonIsFiniteKnownFileCopiesOnly','universalProducerOutputNoninterferenceClaimed'},'Closed v2 descriptor required')
 require(value['profile'] in PROFILES and value['preparedSdkMetadataRetainedInsideCheckpoint'] is False and
         value['sdkPinComparisonIsFiniteKnownFileCopiesOnly'] is True and value['universalProducerOutputNoninterferenceClaimed'] is False,
         'V2 body/scope flags differ')
 sub=value['historicalSdkSubaction']
 require(type(sub) is dict and set(sub)=={'stage','completedBeforeNative05Start','receipt'} and sub['stage']==SDK_STAGE and
         sub['completedBeforeNative05Start'] is True,'SDK receipt must identify the historical pre-GCC subaction')
 if value['profile']==PROFILE:
  require_selected_policy();sdk=receipt.validate_receipt(sub['receipt']);expected_policy=SDK_POLICY_SHA256
 else:
  decode,expected_policy=HISTORICAL_DECODERS[value['profile']];sdk=decode(sub['receipt'])
 require(sdk['sdkVerifiedOnHost'] is True and sdk['sourceHead']==expected_head and sdk['sourcePolicySha256']==expected_policy,
         'Successful source-bound SDK subaction receipt required')
 baseline=value['historicalConfigureBaseline']
 require(type(baseline) is dict and set(baseline)=={'bytes','sha256','mode'} and type(baseline['bytes']) is int and
         0<baseline['bytes']<=256*1024**2 and type(baseline['mode']) is int and 0<=baseline['mode']<=0o7777 and
         type(baseline['sha256']) is str and re.fullmatch('[a-f0-9]{64}',baseline['sha256']),'Historical baseline pin differs')
 rows=value['excludedNewSdkBodyPins']
 require(type(rows) is list and all(type(row) is dict and set(row)=={'bytes','sha256'} for row in rows),'Size/SHA-only SDK pin list required')
 require(rows==raw_pin_rows({(r['bytes'],r['sha256']) for r in rows}),'SDK body pins must be sorted unique and nonempty')
 require(len(scope.codec.canonical(value))<=MAX_DESCRIPTOR,'Complete SDK-derived descriptor exceeds16KiB; no pins may be dropped')
 return value


def descriptor(sdk_receipt,baseline,pins,head):
 return validate_descriptor({'profile':PROFILE,'preparedSdkMetadataRetainedInsideCheckpoint':False,
  'historicalSdkSubaction':{'stage':SDK_STAGE,'completedBeforeNative05Start':True,'receipt':sdk_receipt},
  'historicalConfigureBaseline':baseline,'excludedNewSdkBodyPins':raw_pin_rows(pins),
  'sdkPinComparisonIsFiniteKnownFileCopiesOnly':True,'universalProducerOutputNoninterferenceClaimed':False},head)


def reserve_before_native(sdk_frame,sdk_scope,head):
 """Conservative complete serialization reservation before original GCC start.

 Include every fixed later native leaf, the complete five-file prepared SDK
 copy, the parent prepared manifest and both later SDK image-cleanup outputs.
 Repeated actual bodies may deduplicate later; this upper bound assumes none do.
 No service/native clock, SDK fit or execution permission is inferred.
 """
 verify_historical_sdk_sources(sdk_frame,sdk_scope)
 pins=scope.raw_sdk_pins(sdk_frame,sdk_scope['privateRoot'])
 value=descriptor(sdk_scope['historicalSdkReceipt'],sdk_scope['historicalConfigureBaseline'],pins,head)
 prepared_count=len(receipt.load('gcc-main05-sdk.py').FILES)+1
 later=len([name for name in scope.NATIVE_SDK_PATHS if name!='controls/prepared-sdk'])+prepared_count+1+2
 require(len(pins)+later<=MAX_PINS,'Complete pre-native SDK pin-count reservation cannot fit; refuse before GCC start')
 # 512MiB is the largest admitted raw body, hence the widest decimal size.
 # The 64-byte hash has fixed width; order/deduplication cannot increase bytes.
 worst={**value,'excludedNewSdkBodyPins':value['excludedNewSdkBodyPins']+[{'bytes':512*1024**2,'sha256':'f'*64} for _ in range(later)]}
 reserved=len(scope.codec.canonical(worst))
 require(reserved<=MAX_DESCRIPTOR,'Complete16KiB SDK descriptor reservation cannot fit; refuse before GCC start')
 return {'schemaVersion':1,'descriptorByteLimit':MAX_DESCRIPTOR,'rawPinCountLimit':MAX_PINS,
         'actualPreNativeUniqueBodyPins':len(pins),'maximumAdditionalFixedBodyPins':later,
         'completeSerializedDescriptorBytesUpperBound':reserved,'allActualPinsMustStillBeRetained':True,
         'sourceServiceOrNativeClockExtended':False,'nativeExecutionAuthorized':False,'fitQualified':False}


def verify_historical_sdk_sources(sdk_frame,sdk_scope):
 """Recheck retained pre-native logs/prepared family against the strict receipt.

 The stage still performs original full current SDK checks separately. No raw
 body enters this record or the export descriptor.
 """
 value=receipt.validate_receipt(sdk_scope['historicalSdkReceipt'])
 require(value['sdkVerifiedOnHost'] is True,'Successful SDK-only subaction required')
 require(scope.physical_file(Path(sdk_frame)/'native.log',512*1024**2)['sha256']==value['hashes']['sdkStdout'] and
         scope.physical_file(Path(sdk_scope['privateRoot'])/'opaque-wrapper-output.log',16*1024**2)['sha256']==value['hashes']['wrapperOutput'],
         'Original retained SDK stdout/wrapper output differs from historical receipt')
 prepared=h.physical(Path(sdk_scope['preparedControls'])/'prepared-sdk')
 require(prepared.is_dir() and set(path.name for path in prepared.iterdir())=={*load('gcc-main05-sdk.py').FILES,'PREPARED-SDK-MANIFEST.json'},
         'Complete retained independent SDK family required')
 family={path.name:{k:pin[k] for k in ['bytes','sha256']} for path in sorted(prepared.iterdir())
         if (pin:=scope.physical_file(path,32*1024**2))}
 require(hashlib.sha256(receipt.canonical(family)).hexdigest()==value['hashes']['metadataFamily'],
         'Retained independent SDK metadata changed after validation')
 return True


def data(path,maximum=MAX_DESCRIPTOR):
 scope.physical_file(path,maximum)
 return json.loads(Path(path).read_bytes())


def inspect_v2(state,value,head,*,deadline,package_inventory_sha256):
 value=validate_descriptor(value,head);state=h.physical(Path(state))
 require(scope.historical_baseline(state)==value['historicalConfigureBaseline'],'Restored historical baseline differs')
 exempt={scope.BASELINE}
 if value['profile']==PROFILE:
  # Historical profiles keep their original single exception. A v4 writer
  # always pins the reconstructed inventory, so its path exception is only
  # sound while the same digest stays a refused pin everywhere else.
  packages=scope.historical_package_inventory(state,package_inventory_sha256)
  require({'bytes':packages['bytes'],'sha256':packages['sha256']} in value['excludedNewSdkBodyPins'],
          'V4 descriptor must pin the reconstructed predecessor package inventory')
  exempt.add(scope.PACKAGE_INVENTORY)
 for relative in scope.FORBIDDEN_STATE_PATHS:
  require(not os.path.lexists(state/relative),'V2 checkpoint contains old/new SDK exporter directories')
 evidence=h.physical(state/EVIDENCE)
 require(evidence.is_dir() and set(x.name for x in evidence.iterdir())=={*scope.MAIN_SOURCES,'INVENTORY.json'},
         'Exactly three GCC evidence files and inventory required')
 inventory=data(evidence/'INVENTORY.json')
 require(type(inventory) is dict and set(inventory)=={'schemaVersion','mainFiles','historicalConfigureBaseline',
  'historicalBaselineRetentionIsDistinctFromNewSdkExport','newRawSdkFamilyCopied','wholeOriginalStateRetained',
  'universalProducerOutputNoninterferenceClaimed','nativeExecutionOrCacheExportAuthorized'} and
  type(inventory['schemaVersion']) is int and inventory['schemaVersion']==1 and inventory['historicalConfigureBaseline']==value['historicalConfigureBaseline'] and
  inventory['historicalBaselineRetentionIsDistinctFromNewSdkExport'] is True and inventory['newRawSdkFamilyCopied'] is False and
  inventory['wholeOriginalStateRetained'] is True and inventory['universalProducerOutputNoninterferenceClaimed'] is False and
  inventory['nativeExecutionOrCacheExportAuthorized'] is False and set(inventory['mainFiles'])==set(scope.MAIN_SOURCES),
  'Actual v2 inventory/body flags differ')
 for name,pin in inventory['mainFiles'].items():
  require(scope.physical_file(evidence/name,512*1024**2)==pin,'Restored GCC evidence bytes/mode differ')
 pins={(r['bytes'],r['sha256']) for r in value['excludedNewSdkBodyPins']};sizes={n for n,_ in pins};compared=0
 for path in state.rglob('*'):
  require(time.monotonic()<deadline,'V2 restored scope deadline reached')
  info=path.lstat()
  if not stat.S_ISREG(info.st_mode):continue # Full codec still validates tree/link semantics.
  # Explicit historical exceptions only, each bound to its predecessor bytes above.
  if path.relative_to(state).as_posix() in exempt:continue
  if info.st_size in sizes:
   row=scope.physical_file(path,512*1024**2,unique=False);compared+=1
   require((row['bytes'],row['sha256']) not in pins,'Relabelled NEW SDK body in v2 checkpoint')
 require(time.monotonic()<deadline,'Late v2 scope validation refused')
 return {'profile':value['profile'],'threeGccEvidenceFilesPhysicallyVerified':True,'historicalBaselinePhysicallyVerified':True,
         'finiteSdkBodyComparisons':compared,'preparedSdkBodiesRetained':False,'wholePhysicalCheckpointValidationStillRequired':True}


def inspect_legacy(state,*,deadline):
 state=h.physical(Path(state));evidence=h.physical(state/LEGACY)
 require(evidence.is_dir() and not os.path.lexists(state/EVIDENCE),'Legacy full evidence profile cannot contain v2 evidence')
 inventory=data(evidence/'EVIDENCE-INVENTORY.json',1024**2)
 files={'main-native.log','sdk-native.log','main-resource-samples.json','sdk-resource-samples.json','MAIN05-ATTEMPT.json','SDK-ATTEMPT.json'}
 trees={'main-observations','sdk-observations','prepared-sdk'}
 require(set(evidence.iterdir())=={evidence/name for name in {*files,*trees,'EVIDENCE-INVENTORY.json'}} and
         set(inventory['files'])==files and set(inventory['completeMetadataTrees'])==trees and
         inventory['originalSdkAndMainStdoutRetainedCompletely'] is True,'Legacy complete SDK/main family required')
 for name,pin in inventory['files'].items():
  observed=scope.physical_file(evidence/name,512*1024**2)
  require({k:observed[k] for k in ['bytes','sha256']}==pin,'Legacy evidence byte pin differs')
 for name,proof in inventory['completeMetadataTrees'].items():
  tree=h.physical(evidence/name)
  require(tree.is_dir() and proof['physicalScratchCloneVerified'] is True and proof['sourceModified'] is False,'Legacy SDK metadata physical clone missing')
  remaining=deadline-time.monotonic();require(remaining>0,'Legacy complete-evidence deadline reached')
  snapshot=scope.codec.snapshot(tree,scope.codec.Budget({'treeBytes':128*1024**2,'memberBytes':32*1024**2,'entries':1000,'seconds':min(120,remaining)}))
  # Historical proof records counts/logical bytes, not a per-tree digest. The
  # authenticated archive/full independent replay supplies whole-body binding.
  require(len(snapshot['entries'])==proof['entries'] and snapshot['logicalBytes']==proof['logicalBytes'],'Legacy complete metadata tree differs')
 require(time.monotonic()<deadline,'Late legacy complete-evidence validation refused')
 return {'profile':'historical-full-sdk-evidence-v1','legacyCompleteEvidencePhysicallyPresent':True,'wholePhysicalCheckpointValidationStillRequired':True}


def validate_checkpoint(state,root,*,deadline):
 binding=root['binding'];is_main=binding.get('phase')=='native' and binding.get('sequence')==1
 if not is_main:
  require('native05EvidenceProfile' not in root and 'native05Evidence' not in root,'V2 evidence cannot label another phase')
  return None
 if 'native05EvidenceProfile' not in root:
  require('native05Evidence' not in root and root.get('preparedSdkMetadataRetainedInsideCheckpoint') is True,
          'Historical main05 requires its original complete SDK evidence flag')
  return inspect_legacy(state,deadline=deadline)
 require(root['native05EvidenceProfile'] in PROFILES and root.get('preparedSdkMetadataRetainedInsideCheckpoint') is False and
         type(root.get('native05Evidence')) is dict and root['native05Evidence'].get('profile')==root['native05EvidenceProfile'],'Missing/conflicting explicit v2 profile/body flag')
 return inspect_v2(state,root['native05Evidence'],root['sourceServiceContext']['GITHUB_SHA'],deadline=deadline,
                  package_inventory_sha256=root['binding']['packageInventorySha256'])
