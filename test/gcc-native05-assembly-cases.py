"""Fixed-controller composition with synthetic bodies; no SDK/Docker/API calls."""
import contextlib,copy,hashlib,importlib.util,json,os,stat,tempfile,time,unittest
from pathlib import Path
from unittest import mock
ROOT=Path(__file__).resolve().parent.parent
P=ROOT/'scripts/producer-qualification'
def load(path):
 spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
A=load(P/'gcc-native05-assembly.py');V=A.profile;S=V.scope
R=load(ROOT/'test/gcc-main05-retain-cases.py');D=load(ROOT/'test/gcc-main05-driver-cases.py')
E=load(P/'gcc-main05-export.py');RET=load(P/'gcc-main05-retain.py');HOST=load(P/'gcc-hosted-main05.py')
HEAD='a'*40

fixture=load(ROOT/'test/gcc-native05-synthetic-fixture.py')
sdk_receipt=fixture.sdk_receipt
make_scope=fixture.make_scope

def captured(root):
 args=R.Retention().fixture(root);scope=make_scope(args)
 with mock.patch.object(RET.planner,'read_configuration',return_value=args[4]),mock.patch.object(RET.shutil,'disk_usage',return_value=type('Disk',(),{'free':100*RET.policy.GIB})()):
  result=RET.capture_native05(*args,scope,deadline=time.monotonic()+120)
 root_record={'binding':result['binding'],'archiveSha256':result['checkpoint']['archiveSha256'],
  'preparedSdkMetadataRetainedInsideCheckpoint':False,'native05EvidenceProfile':V.PROFILE,
  'native05Evidence':result['native05Evidence'],'sourceServiceContext':{'GITHUB_SHA':HEAD}}
 return args,scope,result,root_record

def without_package_pin(root):
 # A v2/v3 writer refused any state whose predecessor package inventory digest
 # was also an SDK pin, so its descriptors never carry that pin.
 value=copy.deepcopy(root);row={'bytes':len(fixture.PACKAGES),'sha256':hashlib.sha256(fixture.PACKAGES).hexdigest()}
 value['native05Evidence']['excludedNewSdkBodyPins'].remove(row);return value

class FixedComposition(unittest.TestCase):
 def test_original_constructor_then_actual_reader_then_authenticated_baseline(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td).resolve();sdk=root/'sdk-frame';predecessor=root/'predecessor';(predecessor/'__carrier_work').mkdir(parents=True)
   (predecessor/S.BASELINE).write_bytes(b'Synthetic authenticated predecessor baseline');calls=[]
   facts=sdk_receipt();facts={k:facts[k] for k in ['counts','hashes','sdkContainerExitCode','sdkContainerQuiescent','ownedSdkCleanupObserved','sdkContainerSeconds']}
   def constructor(*_):calls.append('original-constructor');sdk.mkdir();return {'predecessor':predecessor,'originalMarker':True}
   def reader(*_):
    calls.append('physical-reader');self.assertTrue(sdk.is_dir());self.assertEqual(calls,['original-constructor','physical-reader'])
    (sdk/'native.log').write_bytes(b'Synthetic original SDK-only output')
    prepared=root/'sdk-private/independent-sdk-controls/prepared-sdk';prepared.mkdir(parents=True)
    for name in {*V.load('gcc-main05-sdk.py').FILES,'PREPARED-SDK-MANIFEST.json'}:(prepared/name).write_bytes(('Synthetic SDK '+name).encode())
    family={p.name:V.receipt.file_pin(p,32*1024**2) for p in sorted(prepared.iterdir())}
    facts['hashes']['sdkStdout']=hashlib.sha256((sdk/'native.log').read_bytes()).hexdigest()
    facts['hashes']['metadataFamily']=hashlib.sha256(V.receipt.canonical(family)).hexdigest()
    return {'sdkFactsForClosedReceipt':facts,'preparedSdkControls':str(root/'sdk-private/independent-sdk-controls')}
   baseline=A.profile.scope.historical_baseline
   def pin(state):calls.append('historical-baseline');self.assertEqual(state,predecessor);return baseline(state)
   with mock.patch.dict(os.environ,{'GITHUB_SHA':HEAD}),mock.patch.object(A.prepare,'reconstruct_for_main',side_effect=constructor),\
        mock.patch.object(A.local,'verify_prepared',side_effect=reader),mock.patch.object(A.profile.scope,'historical_baseline',side_effect=pin),mock.patch.object(A.profile,'reserve_before_native',wraps=A.profile.reserve_before_native) as reservation:
    result=A.reconstruct_verified(root,root,sdk,root)
   reservation.assert_called_once();self.assertEqual(reservation.call_args.args[0],sdk)
   self.assertEqual(calls,['original-constructor','physical-reader','historical-baseline'])
   self.assertTrue(result['originalMarker']);self.assertTrue(result['native05SdkScope']['historicalSdkReceipt']['sdkVerifiedOnHost'])
   self.assertFalse(result['native05SdkScope']['historicalSdkReceipt']['native05Invoked'])

 def test_constructor_or_actual_reader_failure_is_captured_privately_before_any_native_permission(self):
  for stage in ['constructor','reader']:
   with self.subTest(stage=stage),tempfile.TemporaryDirectory() as td:
    root=Path(td).resolve();calls=[]
    def ctor(*_):
     calls.append('constructor')
     if stage=='constructor':raise ValueError('Synthetic raw SDK failure details')
     return {'predecessor':root/'unused'}
    def reader(*_):calls.append('reader');raise ValueError('Synthetic raw SDK failure details')
    with mock.patch.dict(os.environ,{'GITHUB_SHA':HEAD}),mock.patch.object(A.prepare,'reconstruct_for_main',side_effect=ctor),\
         mock.patch.object(A.local,'verify_prepared',side_effect=reader),mock.patch.object(A.profile.scope,'historical_baseline') as baseline:
     with self.assertRaisesRegex(ValueError,'failed before GCC start'):A.reconstruct_verified(root,root,root/'sdk',root)
     baseline.assert_not_called()
    value=json.loads((root/'SDK-ONHOST-RECEIPT.json').read_bytes())
    self.assertFalse(value['sdkVerifiedOnHost']);self.assertNotIn('Synthetic raw SDK failure details',json.dumps(value))
    self.assertIn(b'Synthetic raw SDK failure details',(root/'sdk-private/opaque-wrapper-output.log').read_bytes())
    self.assertEqual(calls,['constructor'] if stage=='constructor' else ['constructor','reader'])

 def test_real_whole_state_capture_restore_three_evidence_and_independent_v2_reader(self):
  with tempfile.TemporaryDirectory() as td:
   args,scope,result,root=captured(Path(td).resolve());frame=args[0]
   self.assertTrue(result['restore']['physicalTreeVerified']);self.assertEqual(RET.planner.validate_ledger(result['phaseLedger'],args[4])[3],2)
   self.assertFalse((frame/'state'/V.LEGACY).exists());self.assertFalse((frame/'state'/'controls/prepared-sdk').exists())
   descriptor=root['native05Evidence'];self.assertLessEqual(len(V.scope.codec.canonical(descriptor)),16384)
   self.assertGreaterEqual(len(descriptor['excludedNewSdkBodyPins']),2)
   self.assertEqual({tuple(sorted(row)) for row in descriptor['excludedNewSdkBodyPins']},{('bytes','sha256')})
   self.assertTrue(descriptor['historicalSdkSubaction']['completedBeforeNative05Start']);self.assertFalse(descriptor['historicalSdkSubaction']['receipt']['native05Invoked'])
   restored=RET.codec.restore(frame/'checkpoint',frame/'test-independent-restore',result['binding'],result['checkpoint']['archiveSha256'],limits=RET.policy.CHECKPOINT_LIMITS)
   self.assertTrue(restored['physicalTreeVerified'])
   proof=V.validate_checkpoint(frame/'test-independent-restore',root,deadline=time.monotonic()+30)
   self.assertTrue(proof['threeGccEvidenceFilesPhysicallyVerified']);self.assertTrue(proof['historicalBaselinePhysicallyVerified'])
   self.assertEqual((frame/'state'/S.BASELINE).read_bytes(),(frame/'test-independent-restore'/S.BASELINE).read_bytes())
   self.assertEqual((frame/'test-independent-restore/source/object').stat().st_ino,(frame/'test-independent-restore/source/alias').stat().st_ino)

 def test_every_known_native_sdk_family_relabelled_as_gcc_evidence_refuses_before_archive(self):
  # N>1 includes distinct raw stage, package inventory, compressed projection,
  # full prepared manifest and the private wrapper-output family.
  for relative in ['observations/MAIN05-STAGE.json','observations/SDK-PROJECTION-after.json','observations/sdk-observed-before.json.gz',
                   'observations/installed-package-identities-after.txt','controls/prepared-sdk/synthetic.json','../NATIVE-PREPARED.json']:
   with self.subTest(relative=relative),tempfile.TemporaryDirectory() as td:
    args=R.Retention().fixture(Path(td).resolve());scope=make_scope(args);frame=args[0]
    (frame/'native.log').write_bytes((frame/relative).read_bytes())
    with mock.patch.object(RET.planner,'read_configuration',return_value=args[4]),mock.patch.object(RET.codec,'capture',side_effect=AssertionError('Synthetic checkpoint boundary reached before raw SDK refusal')) as checkpoint,\
         mock.patch.object(RET.profile.scope.h,'copy_pinned',wraps=RET.profile.scope.h.copy_pinned) as copy:
     with self.assertRaises(ValueError):RET.capture_native05(*args,scope,deadline=time.monotonic()+30)
     checkpoint.assert_not_called();copy.assert_not_called()
    self.assertFalse((frame/'PHASE-LEDGER.json').exists())

 def test_restored_reader_binds_reconstructed_package_inventory_to_its_predecessor_path_and_digest(self):
  with tempfile.TemporaryDirectory() as td:
   args,scope,result,root=captured(Path(td).resolve());frame=args[0]
   restored=frame/'test-independent-restore'
   RET.codec.restore(frame/'checkpoint',restored,result['binding'],result['checkpoint']['archiveSha256'],limits=RET.policy.CHECKPOINT_LIMITS)
   digest=hashlib.sha256(fixture.PACKAGES).hexdigest()
   self.assertEqual(root['binding']['packageInventorySha256'],digest)
   self.assertIn({'bytes':len(fixture.PACKAGES),'sha256':digest},root['native05Evidence']['excludedNewSdkBodyPins'])
   self.assertEqual((restored/S.PACKAGE_INVENTORY).read_bytes(),fixture.PACKAGES)
   self.assertEqual(V.validate_checkpoint(restored,root,deadline=time.monotonic()+30)['profile'],V.PROFILE)
   copied=restored/'source/installed-build-package-identities.txt';copied.write_bytes(fixture.PACKAGES)
   with self.assertRaisesRegex(ValueError,'Relabelled NEW SDK body'):V.validate_checkpoint(restored,root,deadline=time.monotonic()+30)
   copied.unlink();V.validate_checkpoint(restored,root,deadline=time.monotonic()+30)
   original=restored/S.PACKAGE_INVENTORY;original.write_bytes(fixture.PACKAGES.replace(b'2.40-2',b'2.40-3'))
   with self.assertRaisesRegex(ValueError,'package inventory bytes changed'):V.validate_checkpoint(restored,root,deadline=time.monotonic()+30)
   original.write_bytes(fixture.PACKAGES);V.validate_checkpoint(restored,root,deadline=time.monotonic()+30)
   other=copy.deepcopy(root);other['binding']['packageInventorySha256']=hashlib.sha256(b'another synthetic predecessor').hexdigest()
   with self.assertRaisesRegex(ValueError,'package inventory bytes changed'):V.validate_checkpoint(restored,other,deadline=time.monotonic()+30)
   unpinned=without_package_pin(root)
   with self.assertRaisesRegex(ValueError,'must pin the reconstructed predecessor package inventory'):
    V.validate_checkpoint(restored,unpinned,deadline=time.monotonic()+30)
   # Historical profiles keep their original rules: only the configure baseline
   # is exempt, so a pinned inventory digest refuses even at the predecessor path.
   for profile,policy in [(V.V3_PROFILE,V.V3_SDK_POLICY_SHA256),(V.V2_PROFILE,V.V2_SDK_POLICY_SHA256)]:
    with self.subTest(profile=profile):
     pinned=copy.deepcopy(root);pinned['native05EvidenceProfile']=profile;pinned['native05Evidence']['profile']=profile
     pinned['native05Evidence']['historicalSdkSubaction']['receipt']['sourcePolicySha256']=policy
     with self.assertRaisesRegex(ValueError,'Relabelled NEW SDK body'):V.validate_checkpoint(restored,pinned,deadline=time.monotonic()+30)
     historical=without_package_pin(pinned);historical['binding']['packageInventorySha256']=hashlib.sha256(b'unchecked by v2/v3').hexdigest()
     self.assertEqual(V.validate_checkpoint(restored,historical,deadline=time.monotonic()+30)['profile'],profile)

 def test_restored_reader_rejects_relabelled_sdk_body_even_with_updated_main_inventory(self):
  with tempfile.TemporaryDirectory() as td:
   args,scope,result,root=captured(Path(td).resolve());state=args[0]/'state';evidence=state/V.EVIDENCE
   body=(args[0]/'observations/SDK-PROJECTION-after.json').read_bytes();(evidence/'main-native.log').write_bytes(body)
   inventory=json.loads((evidence/'INVENTORY.json').read_bytes());inventory['mainFiles']['main-native.log']=S.physical_file(evidence/'main-native.log',512*1024**2)
   (evidence/'INVENTORY.json').write_bytes(RET.codec.canonical(inventory))
   with self.assertRaisesRegex(ValueError,'Relabelled NEW SDK body'):V.validate_checkpoint(state,root,deadline=time.monotonic()+30)

 def test_missing_wrong_version_body_flag_receipt_source_policy_pinset_and_inventory_fail(self):
  mutations=['missing-profile','unknown-profile','true-body','missing-descriptor','sdk-failure','sdk-source','sdk-policy','no-pins','duplicate-pins','raw-path','baseline']
  with tempfile.TemporaryDirectory() as td:
   args,scope,result,root=captured(Path(td).resolve())
   for kind in mutations:
    value=copy.deepcopy(root);d=value['native05Evidence']
    if kind=='missing-profile':value.pop('native05EvidenceProfile')
    if kind=='unknown-profile':value['native05EvidenceProfile']='legacy'
    if kind=='true-body':value['preparedSdkMetadataRetainedInsideCheckpoint']=True
    if kind=='missing-descriptor':value.pop('native05Evidence')
    if kind=='sdk-failure':d['historicalSdkSubaction']['receipt']['sdkVerifiedOnHost']=False
    if kind=='sdk-source':d['historicalSdkSubaction']['receipt']['sourceHead']='c'*40
    if kind=='sdk-policy':d['historicalSdkSubaction']['receipt']['sourcePolicySha256']='c'*64
    if kind=='no-pins':d['excludedNewSdkBodyPins']=[]
    if kind=='duplicate-pins':d['excludedNewSdkBodyPins']*=2
    if kind=='raw-path':d['excludedNewSdkBodyPins'][0]['path']='not-exportable'
    if kind=='baseline':d['historicalConfigureBaseline']['sha256']='d'*64
    with self.subTest(kind=kind),self.assertRaises((ValueError,KeyError,V.receipt.Refusal)):V.validate_checkpoint(args[0]/'state',value,deadline=time.monotonic()+30)
   (args[0]/'state'/V.EVIDENCE/'original-commands.jsonl').unlink()
   with self.assertRaisesRegex(ValueError,'Exactly three'):V.validate_checkpoint(args[0]/'state',root,deadline=time.monotonic()+30)

 def test_inventory_schema_requires_integer_one_with_boolean_and_float_refusals(self):
  with tempfile.TemporaryDirectory() as td:
   args,scope,result,root=captured(Path(td).resolve());path=args[0]/'state'/V.EVIDENCE/'INVENTORY.json'
   original=path.read_bytes();inventory=json.loads(original)
   self.assertIs(type(inventory['schemaVersion']),int)
   V.validate_checkpoint(args[0]/'state',root,deadline=time.monotonic()+30)
   for version in [True,1.0]:
    with self.subTest(versionType=type(version).__name__):
     inventory['schemaVersion']=version;path.write_bytes(RET.codec.canonical(inventory))
     with self.assertRaisesRegex(ValueError,'inventory/body flags differ'):V.validate_checkpoint(args[0]/'state',root,deadline=time.monotonic()+30)
   path.write_bytes(original)
   self.assertTrue(V.validate_checkpoint(args[0]/'state',root,deadline=time.monotonic()+30)['threeGccEvidenceFilesPhysicallyVerified'])

 def test_current_native_policy_does_not_follow_a_replaced_generic_sdk_policy(self):
  with tempfile.TemporaryDirectory() as td:
   args,scope,result,root=captured(Path(td).resolve());descriptor=copy.deepcopy(root['native05Evidence'])
   self.assertEqual(V.validate_descriptor(descriptor,HEAD)['historicalSdkSubaction']['receipt']['sourcePolicySha256'],V.SDK_POLICY_SHA256)
   future='e'*64;descriptor['historicalSdkSubaction']['receipt']['sourcePolicySha256']=future
   with mock.patch.object(V.receipt,'POLICY_SHA256',future):
    # The generic SDK decoder alone admits this internally coherent candidate;
    # the frozen current native decoder must still reject it.
    V.receipt.validate_receipt(descriptor['historicalSdkSubaction']['receipt'])
    with self.assertRaisesRegex(ValueError,'explicit profile/version decoder'):V.validate_descriptor(descriptor,HEAD)

 def test_historical_v2_keeps_v4_policy_and_cross_version_bindings_refuse(self):
  with tempfile.TemporaryDirectory() as td:
   args,scope,result,root=captured(Path(td).resolve())
   old=without_package_pin(root);old['native05EvidenceProfile']=V.V2_PROFILE
   old['native05Evidence']['profile']=V.V2_PROFILE
   old['native05Evidence']['historicalSdkSubaction']['receipt']['sourcePolicySha256']=V.V2_SDK_POLICY_SHA256
   self.assertEqual(V.validate_checkpoint(args[0]/'state',old,deadline=time.monotonic()+30)['profile'],V.V2_PROFILE)
   with self.assertRaises(V.receipt.Refusal):V.receipt.validate_receipt(old['native05Evidence']['historicalSdkSubaction']['receipt'])
   for outer,inner,policy in [(V.PROFILE,V.V2_PROFILE,V.V2_SDK_POLICY_SHA256),(V.V2_PROFILE,V.PROFILE,V.SDK_POLICY_SHA256),(V.V2_PROFILE,V.V2_PROFILE,V.SDK_POLICY_SHA256),(V.PROFILE,V.PROFILE,V.V2_SDK_POLICY_SHA256)]:
    value=copy.deepcopy(old);value['native05EvidenceProfile']=outer;value['native05Evidence']['profile']=inner
    value['native05Evidence']['historicalSdkSubaction']['receipt']['sourcePolicySha256']=policy
    with self.subTest(outer=outer,inner=inner,policy=policy),self.assertRaises((ValueError,V.receipt.Refusal)):
     V.validate_checkpoint(args[0]/'state',value,deadline=time.monotonic()+30)

 def test_v4_requires_the_revised_policy_and_v3_still_decodes_only_under_its_own_policy(self):
  with tempfile.TemporaryDirectory() as td:
   args,scope,result,root=captured(Path(td).resolve());state=args[0]/'state'
   self.assertEqual((V.PROFILE,V.SDK_POLICY_SHA256),('gcc-native05-gcc-only-checkpoint-v4','df094a9cc0e7bef188a0d2605befa076b03e1a217f36032191ac360f69a8706f'))
   self.assertEqual((V.V3_PROFILE,V.V3_SDK_POLICY_SHA256),('gcc-native05-gcc-only-checkpoint-v3','53e78d4937950c42fdddbcccacbb37b49b84d881ebd16e0f6397b69bad5232e9'))
   self.assertEqual(V.receipt.POLICY_SHA256,V.SDK_POLICY_SHA256)
   self.assertEqual(root['native05Evidence']['profile'],V.PROFILE)
   self.assertEqual(V.validate_checkpoint(state,root,deadline=time.monotonic()+30)['profile'],V.PROFILE)
   def relabel(outer,inner,policy):
    value=copy.deepcopy(root) if inner==V.PROFILE else without_package_pin(root)
    value['native05EvidenceProfile']=outer;value['native05Evidence']['profile']=inner
    value['native05Evidence']['historicalSdkSubaction']['receipt']['sourcePolicySha256']=policy;return value
   v3=relabel(V.V3_PROFILE,V.V3_PROFILE,V.V3_SDK_POLICY_SHA256)
   self.assertEqual(V.validate_checkpoint(state,v3,deadline=time.monotonic()+30)['profile'],V.V3_PROFILE)
   # The v3 receipt is not a current receipt, and the current decoder gate does not apply to it.
   with self.assertRaises(V.receipt.Refusal):V.receipt.validate_receipt(v3['native05Evidence']['historicalSdkSubaction']['receipt'])
   with mock.patch.object(V.receipt,'POLICY_SHA256','e'*64):
    self.assertEqual(V.validate_descriptor(v3['native05Evidence'],HEAD)['profile'],V.V3_PROFILE)
   policies={V.PROFILE:V.SDK_POLICY_SHA256,V.V3_PROFILE:V.V3_SDK_POLICY_SHA256,V.V2_PROFILE:V.V2_SDK_POLICY_SHA256}
   for outer in policies:
    for inner in policies:
     for policy in policies.values():
      value=relabel(outer,inner,policy)
      if outer==inner and policies[inner]==policy:
       self.assertEqual(V.validate_checkpoint(state,value,deadline=time.monotonic()+30)['profile'],inner);continue
      with self.subTest(outer=outer,inner=inner,policy=policy),self.assertRaises((ValueError,V.receipt.Refusal)):
       V.validate_checkpoint(state,value,deadline=time.monotonic()+30)

 def test_policy_mismatch_refuses_before_original_constructor_or_owned_directory_creation(self):
  for mismatch in ['decoder','local-source']:
   with self.subTest(mismatch=mismatch),tempfile.TemporaryDirectory() as td:
    root=Path(td).resolve()
    target=A.profile.receipt if mismatch=='decoder' else A.local
    with mock.patch.dict(os.environ,{'GITHUB_SHA':HEAD}),mock.patch.object(target,'POLICY_SHA256','e'*64),mock.patch.object(A.prepare,'reconstruct_for_main') as constructor,\
     mock.patch.object(A.local,'verify_prepared') as reader:
     with self.assertRaises(ValueError):A.reconstruct_verified(root,root,root/'sdk-frame',root)
     constructor.assert_not_called();reader.assert_not_called()
    self.assertEqual(list(root.iterdir()),[])

 def test_pinset_and_total16k_ceiling_refuse_instead_of_omitting_inputs(self):
  with tempfile.TemporaryDirectory() as td:
   args=R.Retention().fixture(Path(td).resolve());scope=make_scope(args);baseline=scope['historicalConfigureBaseline']
   pins={(i+1,hashlib.sha256(str(i).encode()).hexdigest()) for i in range(V.MAX_PINS+1)}
   with self.assertRaisesRegex(ValueError,'bounded raw SDK'):V.descriptor(sdk_receipt(),baseline,pins,HEAD)
   # Nonempty valid near miss; then a legitimate complete <=128-row set whose
   # combined typed receipt+pins exceeds16KiB must refuse, never trim.
   valid=V.descriptor(sdk_receipt(),baseline,set(list(sorted(pins))[:2]),HEAD);self.assertEqual(len(valid['excludedNewSdkBodyPins']),2)
   complete=V.descriptor(sdk_receipt(),baseline,set(list(sorted(pins))[:128]),HEAD)
   size=len(V.scope.codec.canonical(complete))
   with mock.patch.object(V,'MAX_DESCRIPTOR',size):self.assertEqual(V.validate_descriptor(complete,HEAD),complete)
   with mock.patch.object(V,'MAX_DESCRIPTOR',size-1),self.assertRaisesRegex(ValueError,'exceeds16KiB'):V.validate_descriptor(complete,HEAD)

 def test_pre_native_reservation_accounts_every_late_pin_and_refuses_before_build(self):
  with tempfile.TemporaryDirectory() as td:
   args=R.Retention().fixture(Path(td).resolve());scope=make_scope(args)
   reservation=V.reserve_before_native(args[1],scope,HEAD)
   expected_late=len([name for name in S.NATIVE_SDK_PATHS if name!='controls/prepared-sdk'])+len(V.load('gcc-main05-sdk.py').FILES)+1+1+2
   self.assertEqual(reservation['maximumAdditionalFixedBodyPins'],expected_late)
   self.assertGreater(reservation['maximumAdditionalFixedBodyPins'],2);self.assertFalse(reservation['sourceServiceOrNativeClockExtended'])
   size=reservation['completeSerializedDescriptorBytesUpperBound']
   with mock.patch.object(V,'MAX_DESCRIPTOR',size):self.assertEqual(V.reserve_before_native(args[1],scope,HEAD)['completeSerializedDescriptorBytesUpperBound'],size)
   with mock.patch.object(V,'MAX_DESCRIPTOR',size-1),self.assertRaisesRegex(ValueError,'before GCC start'):V.reserve_before_native(args[1],scope,HEAD)
   with mock.patch.object(V,'MAX_PINS',reservation['actualPreNativeUniqueBodyPins']+expected_late-1),self.assertRaisesRegex(ValueError,'before GCC start'):V.reserve_before_native(args[1],scope,HEAD)

 def test_changed_retained_sdk_logs_or_complete_prepared_family_refuse_before_checkpoint(self):
  for member in ['stdout','wrapper','prepared-body','prepared-missing']:
   with self.subTest(member=member),tempfile.TemporaryDirectory() as td:
    args=R.Retention().fixture(Path(td).resolve());scope=make_scope(args)
    if member=='stdout':(args[1]/'native.log').write_bytes(b'Synthetic SDK log replacement')
    if member=='wrapper':(scope['privateRoot']/'opaque-wrapper-output.log').write_bytes(b'Synthetic wrapper replacement')
    prepared=next((scope['preparedControls']/'prepared-sdk').iterdir())
    if member=='prepared-body':prepared.write_bytes(b'Synthetic different prepared SDK metadata')
    if member=='prepared-missing':prepared.unlink()
    with mock.patch.object(RET.planner,'read_configuration',return_value=args[4]),mock.patch.object(RET.codec,'capture') as archive:
     with self.assertRaisesRegex(ValueError,'retained|Retained'):RET.capture_native05(*args,scope,deadline=time.monotonic()+30)
     archive.assert_not_called()

 def test_historical_v1_complete_evidence_and_sdk_trees_still_required(self):
  with tempfile.TemporaryDirectory() as td:
   args=R.Retention().fixture(Path(td).resolve());R.Retention().capture(args)
   root={'binding':{'phase':'native','sequence':1},'preparedSdkMetadataRetainedInsideCheckpoint':True}
   proof=V.validate_checkpoint(args[0]/'state',root,deadline=time.monotonic()+30);self.assertTrue(proof['legacyCompleteEvidencePhysicallyPresent'])
   with self.assertRaisesRegex(ValueError,'deadline'):V.validate_checkpoint(args[0]/'state',root,deadline=time.monotonic()-1)
   (args[0]/'state'/V.LEGACY/'sdk-native.log').unlink()
   with self.assertRaisesRegex(ValueError,'Legacy complete'):V.validate_checkpoint(args[0]/'state',root,deadline=time.monotonic()+30)

 def test_full_driver_uses_v2_before_envelope_and_never_invokes_legacy_retainer(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td).resolve();stack,output,runtime,observed,*_=D.Driver().active(root)
   scope=runtime['sdkScope']
   # Driver fixture's NATIVE-PREPARED remains actual first-party controls shape.
   (output/'NATIVE-PREPARED.json').write_bytes(b'{"controls":[]}')
   with stack,mock.patch.object(HOST.start,'create_runtime',return_value=runtime),mock.patch.object(HOST.observer,'observe',return_value=observed),\
    mock.patch.object(HOST.start,'cleanup_native',return_value={'ownedNativeCleanupComplete':True,'quiescenceAfterOwnedRemovalObserved':True}),\
    mock.patch.object(HOST.start.image,'cleanup_owned',return_value={'ownedImageCleanupComplete':True}),\
    mock.patch.object(HOST.retain.planner,'read_configuration',return_value=runtime['configuration']),\
    mock.patch.object(HOST.retain.shutil,'disk_usage',return_value=type('Disk',(),{'free':100*HOST.service.GIB})()),\
    mock.patch.object(HOST.retain,'capture',side_effect=AssertionError('legacy retainer must not be selected')),\
    mock.patch.object(HOST.service,'capture_service',return_value={'synthetic':True}),mock.patch.object(HOST.service,'measure_envelope') as envelope,\
    mock.patch.object(HOST.service,'admit_measured_save',return_value={'syntheticAdmitted':True}),mock.patch.object(HOST.transport,'prepare',return_value={'syntheticPrepared':True}):
    def measured(files):
     r=json.loads(files['CHECKPOINT-ROOT.json']);self.assertEqual(r['native05EvidenceProfile'],V.PROFILE)
     self.assertFalse(r['preparedSdkMetadataRetainedInsideCheckpoint']);self.assertTrue(r['native05Evidence']['historicalSdkSubaction']['receipt']['sdkVerifiedOnHost'])
     self.assertTrue((runtime['nativeFrame']/'state'/V.EVIDENCE/'original-commands.jsonl').is_file())
     return {'envelopeLogicalBytesMeasured':sum(map(len,files.values()))}
    envelope.side_effect=measured
    result=HOST.capture(root,root,output)
   self.assertTrue(result['originalGccTargetInvoked']);self.assertTrue(result['localCheckpointCapturedAndPhysicallyRestored']);envelope.assert_called_once()

 def test_actual_start_adapter_refuses_before_native_create_on_constructor_or_reader_failure(self):
  for failure in ['constructor','reader']:
   with self.subTest(failure=failure),tempfile.TemporaryDirectory() as td:
    base=Path(td).resolve();output=base/'gcc-main05';start=HOST.start
    def constructor(*_):
     if failure=='constructor':raise ValueError('Synthetic private constructor detail')
     return {'predecessor':base/'not-used'}
    with mock.patch.dict(os.environ,{'RUNNER_TEMP':str(base),'GITHUB_RUN_ATTEMPT':'1','GITHUB_SHA':HEAD}),\
     mock.patch.object(start.os,'getuid',return_value=0),mock.patch.object(start,'operator_ledger',return_value={}),\
     mock.patch.object(start.assembly.prepare,'reconstruct_for_main',side_effect=constructor),\
     mock.patch.object(start.assembly.local,'verify_prepared',side_effect=ValueError('Synthetic private reader detail')),\
     mock.patch.object(start,'preparation_failure',return_value={'timingUnproven':True}),\
     mock.patch.object(start.image,'cleanup_owned',return_value={'ownedImageCleanupComplete':True}),\
     mock.patch.object(start.h,'docker') as docker,mock.patch.object(start.observer,'observe') as native:
     with self.assertRaisesRegex(ValueError,'failed before GCC start'):start.create_runtime(base,base,output)
     docker.assert_not_called();native.assert_not_called()
    self.assertFalse(json.loads((output/'NATIVE-PREPARED.json').read_bytes())['nativeStarted'])
    self.assertFalse(json.loads((output/'SDK-ONHOST-RECEIPT.json').read_bytes())['sdkVerifiedOnHost'])

 def test_generic_successor_reader_checks_actual_restored_v2_then_independent_sdk_controls(self):
  prepare=load(P/'gcc-staged-host-prepare.py')
  with tempfile.TemporaryDirectory() as td:
   root=Path(td).resolve();args,scope,result,checkpoint_root=captured(root/'producer');frame=root/'next-preparation';frame.mkdir()
   RET.codec.restore(args[0]/'checkpoint',frame/'predecessor',result['binding'],result['checkpoint']['archiveSha256'],limits=RET.policy.CHECKPOINT_LIMITS)
   controls=frame/'controls';controls.mkdir();(controls/'SELECTED-PHASE-CONTRACT.json').write_bytes(b'{}');(controls/'prepared-sdk').mkdir()
   # Only the existing genuine SDK physical reader is a synthetic seam here;
   # the new restored-state/profile/evidence admission remains real.
   calls=[]
   def before(*_):calls.append('original-phase-contract');return {'contract':{'allAttemptNativeSecondsAlreadyCharged':150}}
   def sdk(*_):calls.append('independent-current-sdk-reader');return {'syntheticVerified':True}
   with mock.patch.object(prepare,'inputs',return_value=(checkpoint_root,{})),mock.patch.object(prepare.host,'before',side_effect=before),\
    mock.patch.object(prepare,'sdk_members',return_value={}),mock.patch.object(prepare.sdk,'read_prepared',side_effect=sdk):
    # Baseline is an original JSON inventory in reality. Replace only parser of
    # that synthetic text fixture, not profile/evidence/file validation.
    actual_data=prepare.data
    def data(path,*a):
     if Path(path)==frame/'predecessor'/S.BASELINE:return {'syntheticOriginalBaseline':True}
     return actual_data(path,*a)
    with mock.patch.object(prepare,'data',side_effect=data):value=prepare.verify_local(frame,{},result['phaseLedger'])
    self.assertEqual(calls,['original-phase-contract','independent-current-sdk-reader']);self.assertTrue(value['sdkVerifiedContractSha256'])
    checkpoint_root['preparedSdkMetadataRetainedInsideCheckpoint']=True;calls.clear()
    with self.assertRaisesRegex(ValueError,'v2 profile/body flag'):prepare.verify_local(frame,{},result['phaseLedger'])
    self.assertEqual(calls,[])

 def test_actual_service_restore_admits_v2_and_rejects_conflicting_body_before_final_ledger(self):
  import shutil,types
  T=load(P/'gcc-main05-transport.py');capacity=load(P/'gcc-main05-service.py')
  for conflict in [False,True]:
   with self.subTest(conflict=conflict),tempfile.TemporaryDirectory() as td:
    base=Path(td).resolve();args,scope,result,root=captured(base/'producer');frame=args[0]
    selected={'GITHUB_SHA':HEAD,'GITHUB_RUN_ID':'12','GITHUB_RUN_ATTEMPT':'1','GITHUB_REF':'refs/heads/diagnostic/synthetic'}
    root['sourceServiceContext']=selected
    if conflict:root['preparedSdkMetadataRetainedInsideCheckpoint']=True
    (frame/'CHECKPOINT-ROOT.json').write_bytes(RET.codec.canonical(root))
    env={'RUNNER_TEMP':str(base),'SUDO_UID':str(os.getuid() or 1001),'SUDO_GID':str(os.getgid() or 1001)}
    original_stat=Path.stat;owned={frame/'TRANSPORT-EXPECTED.json',frame/'SERVICE-RESTORE-REQUEST.json'}
    def root_owned(path,*a,**kw):
     info=original_stat(path,*a,**kw)
     if path in owned:
      fields=list(info);fields[4]=0;return os.stat_result(fields)
     return info
    with mock.patch.object(T.os,'getuid',return_value=0),mock.patch.object(T.os,'chown'),mock.patch.object(Path,'stat',root_owned):
     expected=T.prepare(frame,capacity,selected,env,RET.codec)
     T.prepare_restore(frame,selected,capacity,RET.codec,env)
     path=T.transport_path(env);shutil.copytree(path.with_name(path.name+'-captured-original'),path)
     planner=types.SimpleNamespace(read_configuration=lambda *_:args[4],sha=RET.planner.sha,canonical=RET.planner.canonical,validate_ledger=RET.planner.validate_ledger)
     entry={'id':123,'key':expected['key'],'ref':expected['ref'],'size_in_bytes':expected['archive']['bytes']+2048}
     api=types.SimpleNamespace(get=lambda _:({'total_count':1,'actions_caches':[entry]},{}))
     with mock.patch.object(capacity,'capture_service',return_value={'clock':{'remainingSeconds':20000},'cache':{'observedOccupiedBytes':0}}):
      if conflict:
       with self.assertRaisesRegex(ValueError,'v2 profile/body flag'):T.verify(frame,selected,capacity,RET.codec,planner,api,env)
       self.assertFalse((frame/'FINAL-PHASE-LEDGER.json').exists())
      else:
       value=T.verify(frame,selected,capacity,RET.codec,planner,api,env)
       self.assertTrue(value['fullSourceReportsAndMountStatePhysicallyReplayed']);self.assertTrue(value['cacheSaveAndRestoreReplayed'])
       self.assertTrue((frame/'FINAL-PHASE-LEDGER.json').is_file())

 def test_fixed_exporter_failure_receipt_is_historical_only_without_raw_output_fallback(self):
  with tempfile.TemporaryDirectory() as td:
   base=Path(td).resolve();output=base/'gcc-main05';output.mkdir()
   (output/'SDK-ONHOST-RECEIPT.json').write_bytes(V.receipt.canonical(sdk_receipt()))
   (output/'CARRIER.json').write_bytes(b'{"rawSdkFailure":"synthetic raw detail"}')
   env={'RUNNER_TEMP':str(base),'SUDO_UID':str(os.getuid() or 1001),'SUDO_GID':str(os.getgid() or 1001),'GITHUB_SHA':HEAD}
   with mock.patch.dict(os.environ,env),mock.patch.object(E.os,'chown'):summary=E.export_native05(output)
   dest=base/'gcc-main05-diagnostics';self.assertEqual(set(x.name for x in dest.iterdir()),{'SDK-SUBACTION.json','SUMMARY.json'})
   self.assertFalse(summary['completeGccDiagnosticMembersPresent']);self.assertFalse(summary['checkpointArchiveIncluded']);sub=json.loads((dest/'SDK-SUBACTION.json').read_bytes())
   self.assertFalse(sub['currentNativeOutcomeAssessed']);self.assertFalse(sub['historicalSdkSubaction']['receipt']['native05Invoked'])
   self.assertNotIn(b'synthetic raw detail',(dest/'SDK-SUBACTION.json').read_bytes())

 def test_fixed_exporter_real_three_file_selection_and_raw_sdk_omission(self):
  with tempfile.TemporaryDirectory() as td:
   base=Path(td).resolve();output=base/'gcc-main05';output.mkdir();args,scope,result,root=captured(output);frame=args[0]
   (frame/'CHECKPOINT-ROOT.json').write_bytes(RET.codec.canonical(root));(output/'SDK-ONHOST-RECEIPT.json').write_bytes(V.receipt.canonical(sdk_receipt()))
   (output/'CARRIER.json').write_bytes(b'{"rawSdkLog":"must not export"}')
   env={'RUNNER_TEMP':str(base),'SUDO_UID':str(os.getuid() or 1001),'SUDO_GID':str(os.getgid() or 1001),'GITHUB_SHA':HEAD}
   with mock.patch.dict(os.environ,env),mock.patch.object(E.os,'chown'),mock.patch.object(E.load('gcc-staged-plan.py'),'read_configuration'):
    actual_load=E.load
    def modules(name):
     m=actual_load(name)
     if name=='gcc-staged-plan.py':m.read_configuration=lambda *_:args[4]
     return m
    with mock.patch.object(E,'load',side_effect=modules):summary=E.export_native05(output)
   self.assertTrue(summary['completeGccDiagnosticMembersPresent']);self.assertFalse(summary['checkpointArchiveIncluded']);dest=base/'gcc-main05-diagnostics'
   expected={'CHECKPOINT-ROOT.json','PHASE-LEDGER.json','receipt.json','historical-configure-baseline.json','main-native.log.gz',
             'gcc-evidence/main-resource-samples.json','gcc-evidence/original-commands.jsonl','gcc-evidence/INVENTORY.json','SUMMARY.json'}
   self.assertEqual({p.relative_to(dest).as_posix() for p in dest.rglob('*') if p.is_file()},expected)
   self.assertEqual((dest/'historical-configure-baseline.json').read_bytes(),(frame/'state'/S.BASELINE).read_bytes())
   self.assertFalse(summary['newRawSdkMetadataAndStdoutIncluded'])

 def test_actual_cli_export_mode_selects_fixed_v2_and_never_legacy(self):
  import sys
  with tempfile.TemporaryDirectory() as td:
   base=Path(td).resolve();output=base/'gcc-main05';output.mkdir()
   argv=['firstparty-controller','--repository',str(ROOT),'--inputs',str(base),'--output',str(output),'--mode','export-diagnostics']
   with mock.patch.dict(os.environ,{'RUNNER_TEMP':str(base)}),mock.patch.object(HOST.os,'getuid',return_value=0),\
    mock.patch.object(sys,'argv',argv),mock.patch.object(HOST.exporter,'export_native05',return_value={'fixedV2Selected':True}) as chosen,\
    mock.patch.object(HOST.exporter,'export',side_effect=AssertionError('Legacy raw SDK exporter must not be selected')) as legacy:
    value=HOST.main()
   self.assertEqual(value,{'fixedV2Selected':True});chosen.assert_called_once_with(output);legacy.assert_not_called()

 def test_exporter_malformed_v2_never_falls_back_to_legacy_or_emits_partial(self):
  with tempfile.TemporaryDirectory() as td:
   base=Path(td).resolve();output=base/'gcc-main05';(output/'native-frame').mkdir(parents=True)
   (output/'native-frame/CHECKPOINT-ROOT.json').write_bytes(b'{"native05EvidenceProfile":"legacy"}')
   (output/'SDK-ONHOST-RECEIPT.json').write_bytes(V.receipt.canonical(sdk_receipt()))
   env={'RUNNER_TEMP':str(base),'SUDO_UID':str(os.getuid() or 1001),'SUDO_GID':str(os.getgid() or 1001),'GITHUB_SHA':HEAD}
   with mock.patch.dict(os.environ,env),self.assertRaisesRegex(ValueError,'no legacy fallback'):E.export_native05(output)
   self.assertFalse((base/'gcc-main05-diagnostics').exists())

if __name__=='__main__':unittest.main(verbosity=2)
