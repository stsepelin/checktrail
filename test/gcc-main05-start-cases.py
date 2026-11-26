"""Physical native-mount construction and fixed outer failure lifecycle; SDK/Docker mocked."""
import copy
import importlib.util
import json
import os
import shutil
import time
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parent.parent

def load(path):
 spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path);v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v);return v

m=load(ROOT/'scripts/producer-qualification/gcc-main05-start.py')
f=load(ROOT/'test/gcc-staged-cases.py')
NAME='checktrail-gcc-native05-'+'a'*32
IDENTIFIER='b'*64
LOCAL_IMAGE='sha256:'+'c'*64


class RuntimePreparation(unittest.TestCase):
 def frame(self,root):
  frame=root/'native';(frame/'controls').mkdir(parents=True);(frame/'inputs/source').mkdir(parents=True);(frame/'observations').mkdir();return frame

 def test_actual_constructor_physically_prepares_nested_native_observation_before_readonly_parent(self):
  with tempfile.TemporaryDirectory() as name:
   frame=self.frame(Path(name).resolve());original=frame/'controls/synthetic-control';original.write_bytes(b'Synthetic immutable controller')
   args=m.arguments({'image':LOCAL_IMAGE,'environment':m.sdk.stage.FIXED_ENVIRONMENT},frame,NAME)
   child=frame/'controls/observations';self.assertTrue(child.is_dir());self.assertFalse(child.is_symlink())
   self.assertEqual(child.stat().st_mode & 0o777,0o700);self.assertEqual(list(child.iterdir()),[])
   self.assertEqual(original.read_bytes(),b'Synthetic immutable controller');self.assertEqual(args[-5:],m.observer.BODY)
   self.assertIn('type=bind,source='+str(frame/'observations')+',target=/controller/observations',args)
   self.assertNotIn('--rules-target=configure',args)

 def test_stale_or_linked_child_cannot_be_overwritten_or_reach_original_constructor(self):
  for kind in ['directory','file','dangling','parent-link']:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as name:
    frame=self.frame(Path(name).resolve());child=frame/'controls/observations'
    if kind=='directory':child.mkdir()
    if kind=='file':child.write_bytes(b'Synthetic preserved file')
    if kind=='dangling':child.symlink_to('/inert/missing')
    if kind=='parent-link':
     (frame/'controls').rename(frame/'real-controls');(frame/'controls').symlink_to(frame/'real-controls')
    with mock.patch.object(m.h,'create_arguments') as constructor:
     with self.assertRaises(ValueError):m.arguments({'image':LOCAL_IMAGE,'environment':m.sdk.stage.FIXED_ENVIRONMENT},frame,NAME)
     constructor.assert_not_called()
    if kind=='file':self.assertEqual(child.read_bytes(),b'Synthetic preserved file')

 def owner(self,frame):
  mounts={'/build':(frame/'state',True),'/inputs':(frame/'inputs/source',False),'/controller':(frame/'controls',False),
          '/controller/observations':(frame/'observations',True),'/usr/share/keyrings/debian-keyring.gpg':(frame/'inputs/keyrings/debian-keyring.gpg',False)}
  mounts.update({target:(frame/'state'/relative,True) for relative,target in m.h.MUTABLE_MOUNTS.items()})
  return {'Id':IDENTIFIER,'Config':{'Labels':{'io.checktrail.gcc-staged-owner':NAME},'User':'0:0','WorkingDir':'/work','Image':LOCAL_IMAGE,
          'Entrypoint':['/usr/bin/env'],'Cmd':['-i',*[key+'='+value for key,value in m.sdk.stage.FIXED_ENVIRONMENT.items()],*m.observer.BODY]},
          'State':{'Status':'created','Running':False,'Pid':0},'HostConfig':{'NetworkMode':'none','Privileged':False,'Init':True,
          'NanoCpus':4000000000,'Memory':6*m.h.GIB,'PidsLimit':1024},
          'Mounts':[{'Type':'bind','Destination':target,'Source':str(path),'RW':rw} for target,(path,rw) in mounts.items()]}

 def test_complete_mount_map_and_exact_prepared_image_controls_before_any_native_start(self):
  with tempfile.TemporaryDirectory() as name:
   frame=self.frame(Path(name).resolve());owner=self.owner(frame)
   result=m.validate_container(owner,IDENTIFIER,NAME,{'image':LOCAL_IMAGE},frame);self.assertFalse(result['nativeStarted'])
   for change in ['input-rw','missing-run','duplicate','image','started','unknown-type']:
    value=copy.deepcopy(owner)
    if change=='input-rw':next(row for row in value['Mounts'] if row['Destination']=='/inputs')['RW']=True
    if change=='missing-run':value['Mounts']=[row for row in value['Mounts'] if row['Destination']!='/run']
    if change=='duplicate':value['Mounts'].append(copy.deepcopy(value['Mounts'][0]))
    if change=='image':value['Config']['Image']='sha256:'+'d'*64
    if change=='started':value['State'].update(Status='running',Running=True,Pid=1)
    if change=='unknown-type':value['Mounts'][0]['Type']='volume'
    with self.subTest(change=change),self.assertRaises(ValueError):m.validate_container(value,IDENTIFIER,NAME,{'image':LOCAL_IMAGE},frame)

 def test_outer_recovers_owned_image_even_when_sdk_materializer_created_it_but_returned_nothing(self):
  with tempfile.TemporaryDirectory() as name:
   root=Path(name).resolve();output=root/'gcc-main05'
   def incomplete(repository,inputs,frame,**_):
    frame.mkdir();(frame/'SDK-LOCAL-SNAPSHOT-COMMAND.json').write_bytes(b'Synthetic retained actual created-image receipt')
    raise ValueError('Synthetic original SDK post-commit validation failure')
   with mock.patch.dict(os.environ,{'RUNNER_TEMP':str(root),'GITHUB_RUN_ATTEMPT':'1','GITHUB_SHA':'a'*40}),mock.patch.object(m.os,'getuid',return_value=0),\
        mock.patch.object(m.assembly.local,'stage_source',side_effect=lambda repository:Path(repository)/'synthetic-verified-copy-137'),mock.patch.object(m.prepare,'reconstruct_for_main',side_effect=incomplete),\
        mock.patch.object(m,'preparation_failure',return_value={'state':'synthetic separately tested timing journal'}) as journal,\
        mock.patch.object(m.image,'cleanup_owned',return_value={'ownedImageCleanupComplete':True}) as cleanup,mock.patch.object(m.h,'docker') as docker:
    with self.assertRaisesRegex(ValueError,'failed before GCC start'):m.create_runtime(root,root,output)
    cleanup.assert_called_once_with(output/'sdk-frame');journal.assert_called_once();docker.assert_not_called()
   result=json.loads((output/'NATIVE-PREPARED.json').read_bytes());self.assertFalse(result['originalGccTargetInvoked'])
   self.assertTrue(result['ownedLocalSdkImageCleanup']['ownedImageCleanupComplete']);self.assertIn('failed before GCC start',result['error']);self.assertIn(b'post-commit validation failure',(output/'sdk-private/opaque-wrapper-output.log').read_bytes())

 def test_cleanup_failure_does_not_erase_original_failure_or_claim_a_ready_native_runtime(self):
  with tempfile.TemporaryDirectory() as name:
   root=Path(name).resolve();output=root/'gcc-main05'
   with mock.patch.dict(os.environ,{'RUNNER_TEMP':str(root),'GITHUB_RUN_ATTEMPT':'1','GITHUB_SHA':'a'*40}),mock.patch.object(m.os,'getuid',return_value=0),\
        mock.patch.object(m.assembly.local,'stage_source',side_effect=lambda repository:Path(repository)/'synthetic-verified-copy-137'),mock.patch.object(m.prepare,'reconstruct_for_main',side_effect=ValueError('Synthetic original failure')),\
        mock.patch.object(m,'preparation_failure',return_value={'state':'synthetic separately tested timing journal'}),\
        mock.patch.object(m.image,'cleanup_owned',side_effect=ValueError('Synthetic image cleanup unavailable')):
    with self.assertRaisesRegex(ValueError,'failed before GCC start'):m.create_runtime(root,root,output)
   result=json.loads((output/'NATIVE-PREPARED.json').read_bytes());self.assertEqual(result['state'],'native05-runtime-preparation-incomplete')
   self.assertIn('failed before GCC start',result['error']);self.assertIn(b'Synthetic original failure',(output/'sdk-private/opaque-wrapper-output.log').read_bytes());self.assertIn('cleanup unavailable',result['imageCleanupError']);self.assertFalse(result['nativeStarted'])

 def test_exact_native_recovery_removes_own_invalid_runtime_but_never_a_rebound_or_unproven_name(self):
  # 'rebound-id': the returned container is gone and another holds the name;
  # cleanup is complete for what we own and the holder is reported, not removed.
  foreign='f'*64
  for mode in ['known-invalid-command','ambiguous-valid-command','rebound-id','ambiguous-wrong-command','rebound-after-inspect']:
   with self.subTest(mode=mode),tempfile.TemporaryDirectory() as name:
    frame=self.frame(Path(name).resolve());owner=self.owner(frame);calls=[]
    (frame/'NATIVE-CREATION-REQUEST.json').write_text(json.dumps({'name':NAME,'localImageId':LOCAL_IMAGE,'sameNameWasAbsentObserved':True}))
    if mode in ['known-invalid-command','rebound-id','rebound-after-inspect']:
     (frame/'NATIVE-CREATION-RESPONSE.json').write_text(json.dumps({'name':NAME,'returnedContainerId':IDENTIFIER}))
    if mode in ['known-invalid-command','ambiguous-wrong-command']:owner['Config']['Cmd']=['Synthetic invalid native command']
    if mode=='rebound-id':owner['Id']='e'*64
    # Synthetic daemon table: container ID -> current name. The race mode renames
    # the owned container away and binds a foreign one to the name before rm runs.
    containers={owner['Id']:NAME}
    def docker(args,**kw):
     calls.append(args)
     if args[:5]==['ps','--all','--no-trunc','--quiet','--filter']:
      selector=args[5]
      if selector=='name=^/'+NAME+'$':matched=[key for key,value in containers.items() if value==NAME]
      else:self.assertTrue(selector.startswith('id='));matched=[key for key in containers if key==selector[3:]]
      return ''.join(key+'\n' for key in matched).encode()
     if args[0]=='inspect':self.assertEqual(args,['inspect',owner['Id']]);self.assertIn(args[1],containers);return json.dumps([owner]).encode()
     self.assertEqual(args[:2],['rm','--force'])
     if mode=='rebound-after-inspect' and containers.get(IDENTIFIER)==NAME:containers[IDENTIFIER]='synthetic-renamed-137';containers[foreign]=NAME
     target=args[2] if args[2] in containers else next(key for key,value in containers.items() if value==args[2])
     del containers[target];return b'Synthetic exact removal'
    with mock.patch.object(m.h,'docker',side_effect=docker):
     if mode in ['known-invalid-command','ambiguous-valid-command','rebound-after-inspect']:
      result=m.cleanup_native(frame);self.assertTrue(result['ownedNativeCleanupComplete'])
      self.assertEqual([call for call in calls if call[0]=='rm'],[['rm','--force',IDENTIFIER]])
      self.assertEqual(result['removedContainerId'],IDENTIFIER);self.assertNotIn(IDENTIFIER,containers)
      self.assertEqual(json.loads((frame/'NATIVE-CLEANUP.json').read_bytes()),result)
      if mode=='rebound-after-inspect':
       self.assertEqual(containers,{foreign:NAME});self.assertEqual(result['ownedNameReboundTo'],[foreign])
       self.assertFalse(result['quiescenceAfterOwnedRemovalObserved'])
      else:
       self.assertEqual(containers,{});self.assertEqual(result['ownedNameReboundTo'],[]);self.assertTrue(result['quiescenceAfterOwnedRemovalObserved'])
     elif mode=='rebound-id':
      result=m.cleanup_native(frame);self.assertTrue(result['ownedNativeCleanupComplete'])
      self.assertEqual(result['state'],'exact-owned-native-container-absent');self.assertEqual(result['ownedNameReboundTo'],['e'*64])
      self.assertNotIn('quiescenceAfterOwnedRemovalObserved',result)
      self.assertEqual(containers,{'e'*64:NAME});self.assertFalse(any(call[0] in ['rm','inspect'] for call in calls))
     else:
      with self.assertRaises(ValueError):m.cleanup_native(frame)
      self.assertEqual(containers,{owner['Id']:NAME});self.assertFalse(any(call[0]=='rm' for call in calls))
    self.assertEqual((frame/'NATIVE-CLEANUP-OBSERVED.json').exists(),mode!='rebound-id')

 def journal_fixture(self,root):
  output=root/'gcc-main05';sdk=output/'sdk-frame';native=output/'native-frame';(sdk/'controls').mkdir(parents=True);(sdk/'predecessor').mkdir()
  (sdk/'controls/EXPECTED-PREDECESSOR-ROOT.json').write_text(json.dumps({'syntheticOriginalRoot':True}))
  (sdk/'ATTEMPT.json').write_text(json.dumps({'nativePhase':'sdk-reconstruction','elapsedSeconds':20,'allElapsedTimeMustBeChargedOnRetry':True}))
  config=f.configuration(hppa64=True);ledger=m.attempt_ledger.planner.new_ledger(config)
  ledger=m.attempt_ledger.planner.append_attempt(ledger,config,f.completed(ledger,config))
  return output,sdk,native,config,ledger

 def test_actual_sdk_time_is_charged_after_later_failure_without_inventing_gcc_exit_or_advancement(self):
  with tempfile.TemporaryDirectory() as name:
   output,sdk,native,config,ledger=self.journal_fixture(Path(name).resolve())
   with mock.patch.object(m,'operator_ledger',return_value=ledger),mock.patch.object(m.state.body,'predecessor',return_value=(config,{},1)):
    result=m.preparation_failure(output,sdk,native,21,'Synthetic later snapshot failure')
   charged=json.loads((output/'PREPARATION-FAILED-PHASE-LEDGER.json').read_bytes());row=charged['attempts'][-1]
   self.assertEqual(row['nativeSeconds'],21);self.assertIsNone(row['exitCode']);self.assertIsNone(row['signal']);self.assertFalse(row['terminalObserved'])
   self.assertEqual(row['outcome'],'timeout-incomplete');self.assertIsNone(row['checkpointSha256'])
   self.assertEqual(m.attempt_ledger.planner.validate_ledger(charged,config)[3],1)
   self.assertEqual(result['actualSdkBodyObservedSeconds'],20);self.assertEqual(result['conservativeFullSdkPreparationSecondsCharged'],21)
   self.assertFalse(result['originalGccTargetInvoked']);self.assertFalse(result['retryAuthorized'])

 def test_missing_stale_or_undercharged_sdk_observation_stays_unqualified_without_zero_time_claim(self):
  for kind in ['missing','wrong-phase','undercharged']:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as name:
    output,sdk,native,config,ledger=self.journal_fixture(Path(name).resolve())
    if kind=='missing':(sdk/'ATTEMPT.json').unlink()
    if kind=='wrong-phase':(sdk/'ATTEMPT.json').write_text(json.dumps({'nativePhase':'configure','elapsedSeconds':20,'allElapsedTimeMustBeChargedOnRetry':True}))
    with mock.patch.object(m,'operator_ledger',return_value=ledger),mock.patch.object(m.state.body,'predecessor',return_value=(config,{},1)):
     result=m.preparation_failure(output,sdk,native,19 if kind=='undercharged' else 21,'Synthetic invalid observation')
    self.assertFalse(result['failureLedgerWritten']);self.assertFalse(result['retryAuthorized'])
    self.assertNotIn('conservativeFullSdkPreparationSecondsCharged',result);self.assertNotIn('actualSdkBodyObservedSeconds',result)
    self.assertFalse((output/'PREPARATION-FAILED-PHASE-LEDGER.json').exists())

 def test_physical_runtime_control_cohort_imports_without_any_repository_fallback(self):
  with tempfile.TemporaryDirectory() as name:
   controls=Path(name)/'controller';controls.mkdir()
   for filename in m.CONTROLS:shutil.copy2(ROOT/'scripts/producer-qualification'/filename,controls/filename)
   entry=load(controls/'gcc-main05-stage.py');self.assertEqual(entry.COMMAND,m.observer.body.COMMAND)
   self.assertEqual(entry.prepared_sdk.d.POLICY,m.handoff.d.POLICY)
   (controls/'gcc-main05-sdk.py').unlink()
   with self.assertRaises(FileNotFoundError):load(controls/'gcc-main05-stage.py')

 def test_complete_outer_prepares_real_controls_mounts_and_admission_without_starting_native(self):
  with tempfile.TemporaryDirectory() as name:
   root=Path(name).resolve();output=root/'gcc-main05';inputs=root/'inputs';inputs.mkdir()
   rows=[]
   for rel in ['source/synthetic-original.tar.xz','keyrings/debian-keyring.gpg']:
    path=inputs/rel;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'Synthetic original pinned input')
    rows.append({'file':rel,**m.h.digest_file(path)})
   configuration=f.configuration(hppa64=True)
   configuration['variables']['CONFARGS']='--enable-languages='+m.sdk.stage.LANGUAGES+' --enable-multilib --enable-offload-targets=nvptx-none,amdgcn-amdhsa'
   ledger=m.attempt_ledger.planner.new_ledger(configuration);ledger=m.attempt_ledger.planner.append_attempt(ledger,configuration,f.completed(ledger,configuration))
   selected={'GITHUB_SHA':'a'*40,'GITHUB_RUN_ID':'12','GITHUB_RUN_ATTEMPT':'1','GITHUB_REF':'refs/heads/diagnostic/synthetic'}
   resources={'context':selected,'architecture':'x86_64','cpus':4,'memoryBytes':16*m.h.GIB,'availableMemoryBytes':10*m.h.GIB,
     'freeDiskBytes':100*m.h.GIB,'dockerRootFilesystemFreeBytes':100*m.h.GIB}
   expected={'archiveSha256':'0'*64,'binding':{'configurationSha256':m.attempt_ledger.planner.plan(configuration)['configurationSha256']}}
   local={'localImageId':LOCAL_IMAGE,'observedOriginalImageId':'sha256:'+'d'*64,'localOwnedTag':'synthetic-owned-sdk','originalRootfsLayers':['sha256:'+'e'*64]}
   def sdk_prepare(repository,sources,frame,operator_output):
    self.assertEqual(sources,inputs);frame.mkdir();(frame/'predecessor').mkdir()
    return {'frame':frame,'predecessor':frame/'predecessor','expectedRoot':expected,'originalCatalog':{'profiles':{'gcc-12':{'files':rows}},'image':m.codec.IMAGE,'environment':m.sdk.stage.FIXED_ENVIRONMENT},
     'sdkProof':{'packageInventoryMatches':True,'generatedStatePhysicallyValidated':True},'localImage':local,'sdkObservedSeconds':1,'sourceContext':selected,'native05SdkScope':{'syntheticSeparatelyTestedAdapter':True}}
   def activate(prepared,native,old):
    self.assertEqual(old,ledger);(native/'state/source').mkdir(parents=True);(native/'state/source/synthetic').write_bytes(b'Synthetic full source state')
    return {'configuration':configuration}
   events=[]
   def docker(args,**kwargs):
    events.append(args)
    if args[:2]==['image','inspect']:return b'[{}]'
    if args[0]=='ps':return b''
    if args[0]=='create':return IDENTIFIER.encode()
    if args[0]=='inspect':return json.dumps([self.owner(output/'native-frame')]).encode()
    if args[0]=='info':return b'{}'
    self.fail('Unplanned Docker operation '+repr(args))
   now=time.monotonic();fresh={'clock':{'capturedMonotonic':now,'remainingSeconds':20000,'jobId':123},'cache':{'capturedMonotonic':now,'observedOccupiedBytes':6044189091,'completeUniqueListingObserved':True}}
   with mock.patch.dict(os.environ,{'RUNNER_TEMP':str(root),'GITHUB_RUN_ATTEMPT':'1','CHECKTRAIL_GITHUB_JOB_TOKEN':'synthetic'}),mock.patch.object(m.os,'getuid',return_value=0),mock.patch.object(m.uuid,'uuid4',return_value=type('Uuid',(),{'hex':'a'*32})()),mock.patch.object(m.assembly,'reconstruct_verified',side_effect=sdk_prepare),mock.patch.object(m.sdk,'prepare_readonly_keyring',return_value={}),mock.patch.object(m.handoff,'stage_metadata',return_value={'synthetic':True}),mock.patch.object(m.state,'activate',side_effect=activate),mock.patch.object(m.operator_history,'verify_selected_history',return_value={'phase':'native'}) as verify_history,mock.patch.object(m,'operator_ledger',return_value=ledger),mock.patch.object(m.h,'docker',side_effect=docker),mock.patch.object(m.image,'validate_local_image',return_value={'synthetic':True}),mock.patch.object(m.service.h.capacity,'stock_resources',return_value=resources),mock.patch.object(m.h,'validate_daemon',return_value=resources),mock.patch.object(m.service,'GitHub'),mock.patch.object(m.service,'capture_service',return_value=fresh),mock.patch.object(m,'cleanup_native') as cleanup,mock.patch.object(m.image,'cleanup_owned') as image_cleanup:
    runtime=m.create_runtime(ROOT,inputs,output)
   cleanup.assert_not_called();image_cleanup.assert_not_called();verify_history.assert_called_once_with(configuration,ledger)
   self.assertEqual(runtime['name'],NAME);self.assertEqual(runtime['containerId'],IDENTIFIER)
   self.assertEqual(runtime['configuration'],configuration);self.assertEqual(runtime['admitted']['phase'],'native')
   self.assertFalse(any(args[0] in ['start','run','commit','rm','kill'] for args in events))
   receipt=json.loads((output/'NATIVE-PREPARED.json').read_bytes());self.assertEqual(receipt['state'],'original-native05-runtime-prepared-not-started')
   self.assertFalse(receipt['nativeStarted']);self.assertFalse(receipt['originalGccTargetInvoked']);self.assertFalse(receipt['gateAComplete'])
   self.assertEqual({row['file'] for row in receipt['controls']},set(m.CONTROLS))


if __name__=='__main__':unittest.main(verbosity=2)
