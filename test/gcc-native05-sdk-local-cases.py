"""Synthetic R3 family plus real readers; ALL Docker/host-runtime seams mocked."""
import copy,importlib.util,inspect,json,os,shutil,tempfile,unittest
from pathlib import Path
from unittest import mock

ROOT=Path(__file__).resolve().parent.parent
def load(path,name):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
m=load(ROOT/'scripts/producer-qualification/gcc-native05-sdk-local.py','next_sdk_local')
data_fixture=load(ROOT/'test/gcc-sdk-onhost-receipt-cases.py','sdk_data_fixture')
image_fixture=load(ROOT/'test/gcc-main05-sdk-image-cases.py','sdk_image_fixture')
HEAD='a'*40
POLICY='scripts/producer-qualification/gcc-sdk-receipt-policy.v1.json'
CARRIER='scripts/producer-qualification/gcc-hosted-carrier.py'
SDK='scripts/producer-qualification/gcc-hosted-sdk.py'
STRUCTURED='scripts/producer-qualification/gcc-sdk-structured-diagnostics.py'
IMAGE_IDENTITY='scripts/producer-qualification/binutils-image-identity.mjs'
PHASE0_CAPACITY='scripts/producer-qualification/gcc-hosted-phase0-capacity.py'
DERIVED_RUN='scripts/producer-qualification/gcc-sdk-derived-run.py'
# The carrier pin approved by the previous policy revision, before live sampling tolerated vanished entries.
PREVIOUS_CARRIER=(43970,'ea6521cec4a88bfacf73999c4f9e4ee42fc3253c25a3224bd76702d93a7555ea')

class LocalSdk(unittest.TestCase):
 def family(self):
  helper=data_fixture.Receipt();self.addCleanup(helper.doCleanups)
  root,output,private,policy,values=helper.sdk_data()
  old=json.loads((output/'SDK-CARRIER.json').read_bytes());(output/'SDK-CARRIER.json').unlink()
  owner,unused,base,image=image_fixture.fixture();proof=json.loads((output/'observations/SDK-RECONSTRUCTION.json').read_bytes())
  # The metadata-only reader fixture omits stopped-image success fields.
  # The real R3 writer emits these at gcc-sdk-reconstruct.py:124-126; retain
  # that complete synthetic producer shape rather than weakening its guard.
  for key,value in unused.items():proof.setdefault(key,value)
  (output/'observations/SDK-RECONSTRUCTION.json').write_bytes(m.image.codec.canonical(proof))
  calls=[]
  def constructor(args,**kwargs):
   if args==['inspect','--size',image_fixture.CONTAINER]:return json.dumps([owner]).encode()
   if args==['image','ls','--no-trunc','--quiet',image_fixture.TAG]:return b''
   if args==['commit','--pause=true',image_fixture.CONTAINER,image_fixture.TAG]:return image_fixture.IMAGE.encode()
   if args==['image','inspect',image_fixture.IMAGE]:return json.dumps([image]).encode()
   raise AssertionError(args)
  local=image_fixture.m.commit_prepared(image_fixture.NAME,image_fixture.CONTAINER,base,proof,output,constructor)
  source={'head':HEAD,'syntheticFirstpartySource':True};admission={'image':m.image.codec.IMAGE,'syntheticAdmission':True}
  result={'state':'original-sdk-for-main-prepared-and-locally-snapshotted','originalGccTargetInvoked':False,
          'originalPhaseAdvanced':False,'ownedContainerCleanup':'removed','ownedSeedCleanup':'removed','source':source,
          'observed':old['observed'],'localImage':local,'proof':proof,'image':admission}
  (output/'SDK-FOR-MAIN.json').write_bytes(m.image.codec.canonical(result))
  state={'containerPresent':False,'base':base,'image':image}
  def docker(args,**kwargs):
   calls.append(args)
   if args==['ps','--all','--no-trunc','--quiet','--filter','id='+image_fixture.CONTAINER]:return image_fixture.CONTAINER.encode() if state['containerPresent'] else b''
   if args==['image','inspect',image_fixture.IMAGE]:return json.dumps([state['image']]).encode()
   if args==['image','inspect',m.image.codec.IMAGE]:return json.dumps([state['base']]).encode()
   raise AssertionError('Unreviewed synthetic Docker operation: '+repr(args))
  return root,output,private,source,admission,state,calls,docker
 def verify(self,family):
  root,output,private,source,admission,state,calls,docker=family
  with mock.patch.dict(os.environ,{'GITHUB_SHA':HEAD,'CHECKTRAIL_HOST_NODE':'{"path":"/synthetic/firstparty-node"}'}),\
       mock.patch.object(m.h,'verify_repository',return_value=source) as source_check,\
       mock.patch.object(m.h,'admit_host_node',return_value={'path':'/synthetic/firstparty-node'}),\
       mock.patch.object(m.h,'validate_image',return_value=admission) as registry_check:
   result=m.verify_prepared(ROOT,output,private,docker)
  source_check.assert_called_once_with(ROOT,{'GITHUB_SHA':HEAD});registry_check.assert_called_once()
  self.assertTrue(all(args[0] in ['ps','image'] for args in calls));return result
 def mutate_result(self,family,change):
  p=family[1]/'SDK-FOR-MAIN.json';value=json.loads(p.read_bytes());change(value);p.write_bytes(m.image.codec.canonical(value))
 def test_complete_synthetic_sdk_family_is_read_again_and_image_identity_is_current(self):
  family=self.family();result=self.verify(family);facts=result['sdkFactsForClosedReceipt']
  self.assertEqual(facts['counts']['packages'],2);self.assertEqual(facts['counts']['generatedOutputs'],51);self.assertEqual(facts['counts']['formats'],13)
  self.assertEqual(facts['sdkContainerExitCode'],0);self.assertEqual(facts['sdkContainerSeconds'],71.5)
  self.assertEqual(result['sameApprovedSdkPolicySha256'],m.POLICY_SHA256);self.assertTrue(result['closedReceiptNotYetEmitted'])
  for key in ['operatorExecutionTrustGranted','nativeStartAuthorized','nativeFitOrServiceClockQualified','checkpointOrCacheExportAuthorized']:self.assertIs(result[key],False)
  self.assertTrue((Path(result['preparedSdkControls'])/'prepared-sdk/PREPARED-SDK-MANIFEST.json').is_file())
 def test_sdk_terminal_boolean_unknown_nonzero_or_unclosed_cannot_be_qualified(self):
  for key,value in [('ExitCode',True),('ExitCode',3),('Pid',False),('Running',0),('Status','created')]:
   with self.subTest(key=key,value=value):
    family=self.family();self.mutate_result(family,lambda r:r['observed']['containerState'].__setitem__(key,value))
    with self.assertRaisesRegex(ValueError,'Genuine clean SDK terminal'):self.verify(family)
 def test_source_or_cleanup_from_other_attempt_is_not_accepted_from_a_summary(self):
  for kind in ['source','cleanup']:
   family=self.family()
   self.mutate_result(family,lambda r:r.__setitem__('source',{'head':'b'*40}) if kind=='source' else r.__setitem__('ownedContainerCleanup','reported-removed'))
   with self.assertRaises(ValueError):self.verify(family)
 def test_existing_owned_sdk_materializer_must_be_independently_absent(self):
  family=self.family();family[5]['containerPresent']=True
  with self.assertRaisesRegex(ValueError,'independently absent'):self.verify(family)
 def test_current_base_and_local_image_cannot_borrow_retained_json_identity(self):
  for kind in ['base-id','base-layer','local-layer','local-tag']:
   family=self.family();state=family[5]
   if kind=='base-id':state['base']['Id']='sha256:'+'9'*64
   if kind=='base-layer':state['base']['RootFS']['Layers'][0]='sha256:'+'9'*64
   if kind=='local-layer':state['image']['RootFS']['Layers'][0]='sha256:'+'9'*64
   if kind=='local-tag':state['image']['RepoTags']=['unowned']
   with self.subTest(kind=kind),self.assertRaises(ValueError):self.verify(family)
 def test_missing_post_commit_record_retains_actual_original_sdk_terminal_without_native_credit(self):
  family=self.family();p=family[1]/'SDK-LOCAL-SNAPSHOT-COMMAND.json';p.unlink()
  with self.assertRaises(Exception):self.verify(family)
  row=json.loads((family[1]/'SDK-FOR-MAIN.json').read_bytes())
  self.assertEqual(row['observed']['containerState']['ExitCode'],0);self.assertEqual(row['observed']['nativeSeconds'],71.5)
  self.assertFalse((family[1]/'SDK-CARRIER.json').exists())
 def test_new_local_projection_never_overwrites_an_existing_sdk_capture(self):
  family=self.family();p=family[1]/'SDK-CARRIER.json';p.write_bytes(b'KEEP-OWNED-LOCAL-DATA')
  with self.assertRaisesRegex(ValueError,'Fresh local R3 reader projection'):self.verify(family)
  self.assertEqual(p.read_bytes(),b'KEEP-OWNED-LOCAL-DATA')
 def test_real_r3_reader_refuses_missing_generated_witness_after_zero_and_snapshot(self):
  family=self.family();p=family[1]/'observations/SDK-DERIVED-GENERATION.json';p.unlink()
  with self.assertRaises(Exception):self.verify(family)
  row=json.loads((family[1]/'SDK-FOR-MAIN.json').read_bytes());self.assertEqual(row['observed']['containerState']['ExitCode'],0)
 def test_current_policy_links_exact_prior_revision_and_preserves_original_limits(self):
  policy=m.source_policy(ROOT)
  self.assertEqual(policy['revision'],'live-sample-tolerance-and-container-id-v6')
  self.assertEqual(policy['previousPolicySha256'],'53e78d4937950c42fdddbcccacbb37b49b84d881ebd16e0f6397b69bad5232e9')
  self.assertEqual(policy['sdkBodySeconds'],1200);self.assertEqual(policy['sourceJobSeconds'],21600)
  self.assertEqual(policy['artifactUploads'],0);self.assertEqual(policy['cacheWrites'],0)
  self.assertTrue(policy['freshApprovalReviewRequired']);self.assertFalse(policy['native05Authorized']);self.assertFalse(policy['gateAComplete'])
  approval=policy['revisionApproval']
  self.assertEqual((approval['approvedOn'],approval['approvedBy']),('2026-11-24','operator'))
  # The approval names exactly the runtime rows whose bytes differ from the
  # previous revision, and the rows that revision did not pin at all.
  self.assertEqual(approval['changedRuntimeFiles'],[CARRIER,SDK,PHASE0_CAPACITY,DERIVED_RUN])
  self.assertEqual(approval['addedRuntimeFiles'],[STRUCTURED,IMAGE_IDENTITY,*['scripts/producer-qualification/'+name for name in
                   ['binutils-acquisition-plan.mjs','binutils-retention-observer.mjs','c-producer-profile.mjs']],'scripts/qualify-binutils-producer.mjs',
                   *['scripts/producer-qualification/'+name for name in ['binutils.v1.json','binutils-apt-index-preparation.v1.json',
                     'binutils-prepare-inputs.py','binutils-expectations.v1.json','gcc-local-12h-policy.v1.json','gcc-local-wall-policy.v1.json']]])
  paths=[row['path'] for row in policy['runtimeFiles']]
  self.assertEqual(len(paths),len(set(paths)));self.assertLessEqual({*approval['changedRuntimeFiles'],*approval['addedRuntimeFiles']},set(paths))
  self.assertTrue(any('LIVE_VANISHED_CEILING' in line for line in approval['scope']))
  self.assertTrue(any('container ID' in line for line in approval['scope']))
  self.assertTrue(any('standard library before loading any sibling' in line for line in approval['scope']))
  # The later 2026-11-24 fixes name each runtime file they changed.
  further=[line for line in approval['scope'] if line.startswith('Further changes approved by the operator on 2026-11-24')]
  self.assertEqual(len(further),1)
  for path in [CARRIER,PHASE0_CAPACITY,DERIVED_RUN]:self.assertIn(Path(path).name,further[0])
  self.assertIn('gcc-hosted-sdk.py',further[0])
  for topic in ['Restore capacity','Bounded native waits','Descriptor walk','Not-started generator','Git configuration','Verified execution']:
   self.assertEqual(sum(line.startswith(topic+':') for line in approval['scope']),1,topic)

 def counterfactual(self,directory):
  copy=Path(directory).resolve()/'copy';copy.mkdir()
  policy=json.loads((ROOT/POLICY).read_bytes())
  for name in [POLICY,*[row['path'] for row in policy['runtimeFiles']]]:
   target=copy/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(ROOT/name,target)
  return copy,policy

 def test_revised_policy_admits_the_live_sampling_carrier_and_refuses_its_previous_pin(self):
  with tempfile.TemporaryDirectory(prefix='sdk-policy-carrier-') as directory:
   copy,policy=self.counterfactual(directory)
   carrier=next(row for row in m.source_policy(copy)['runtimeFiles'] if row['path']==CARRIER)
   self.assertEqual(carrier['sha256'],m.receipt.file_pin(copy/CARRIER,carrier['bytes'])['sha256'])
   self.assertNotEqual((carrier['bytes'],carrier['sha256']),PREVIOUS_CARRIER)
   self.assertIn(b'LIVE_VANISHED_CEILING',(copy/CARRIER).read_bytes())
   for row in policy['runtimeFiles']:
    if row['path']==CARRIER:row['bytes'],row['sha256']=PREVIOUS_CARRIER
   claimed=json.dumps(policy,indent=2,sort_keys=True).encode()+b'\n';(copy/POLICY).write_bytes(claimed)
   self.assertIn(PREVIOUS_CARRIER[1].encode(),(copy/POLICY).read_bytes())
   with self.assertRaisesRegex(ValueError,'Unchanged approved SDK policy required'):m.source_policy(copy)
   # Even a frozen constant moved to that claim cannot pair it with the new,
   # larger carrier body: the old byte bound refuses the read itself.
   with mock.patch.object(m,'POLICY_SHA256',m.receipt.hashlib.sha256(claimed).hexdigest()),\
        self.assertRaises(m.receipt.Refusal) as refused:m.source_policy(copy)
   self.assertEqual(refused.exception.identifier,'sdk-proof-refused')

 def test_every_pinned_runtime_file_change_without_a_policy_revision_is_refused(self):
  with tempfile.TemporaryDirectory(prefix='sdk-policy-every-runtime-') as directory:
   copy,policy=self.counterfactual(directory);m.source_policy(copy)
   self.assertGreaterEqual(len(policy['runtimeFiles']),19)
   for row in policy['runtimeFiles']:
    with self.subTest(path=row['path']):
     p=copy/row['path'];body=p.read_bytes();changed=body[:-1]+(b' ' if body[-1:]!=b' ' else b'\n')
     self.assertNotEqual(changed,body);p.write_bytes(changed)
     try:
      with self.assertRaisesRegex(ValueError,'R3 SDK runtime source changed'):m.source_policy(copy)
     finally:p.write_bytes(body)
     m.source_policy(copy)

 def test_unchanged_approved_sdk_source_policy_is_a_real_byte_guard(self):
  with tempfile.TemporaryDirectory(prefix='sdk-policy-counterfactual-') as directory:
   copy=Path(directory).resolve()/'copy';copy.mkdir()
   policy_path='scripts/producer-qualification/gcc-sdk-receipt-policy.v1.json'
   policy=json.loads((ROOT/policy_path).read_bytes())
   for name in [policy_path,*[row['path'] for row in policy['runtimeFiles']]]:
    target=copy/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(ROOT/name,target)
   m.source_policy(copy)
   p=copy/'scripts/producer-qualification/gcc-staged-plan.py';body=p.read_bytes();p.write_bytes(body[:-1]+(b' ' if body[-1:]!=b' ' else b'\n'))
   with self.assertRaisesRegex(ValueError,'R3 SDK runtime source changed'):m.source_policy(copy)
 def test_no_phase_command_or_execution_boolean_parameter_can_supply_authority(self):
  self.assertEqual(list(inspect.signature(m.verify_prepared).parameters),['repository','sdk_frame','private','docker'])

if __name__=='__main__':unittest.main(verbosity=2)
