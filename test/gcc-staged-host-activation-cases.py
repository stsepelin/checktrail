"""Real local N2 checkpoint/SDK DATA contracts; no SDK or project execution."""
import contextlib
import copy
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import time
import types
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parent.parent


def load(path):
    spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


s=load(ROOT/'scripts/producer-qualification/gcc-staged-host-state.py')
p=s.prepared
f=load(ROOT/'test/gcc-staged-cases.py')
sdk_fixture=load(ROOT/'test/gcc-main05-sdk-cases.py')


def production_modules(*roots):
    seen=set();pending=list(roots)
    while pending:
        module=pending.pop()
        if id(module) in seen:continue
        seen.add(id(module));yield module
        pending.extend(value for value in vars(module).values() if isinstance(value,types.ModuleType) and
                       str(getattr(value,'__file__','')).startswith(str(ROOT/'scripts/producer-qualification')))


class Activation(unittest.TestCase):
    def fixture(self,index=1,*,failed=False,unclosed=False,legacy_evidence_variant=None):
        temporary=tempfile.TemporaryDirectory(prefix='gcc-activation-synthetic-');self.addCleanup(temporary.cleanup)
        root=Path(temporary.name).resolve();root.chmod(0o700)
        self.assertIn(legacy_evidence_variant,[None,'missing-flag','missing-sdk-member'])
        self.assertTrue(legacy_evidence_variant is None or index==2)
        state=root/('legacy-native-evidence-frame/state' if index==2 else 'inert-original')
        state.mkdir(parents=True);(state/'source/stamps').mkdir(parents=True)
        configuration_directory=state/'__carrier_work/gcc-staged-configuration';configuration_directory.mkdir(parents=True)
        pins={}
        for relative in p.host.planner.RULES:
            body=('Synthetic inert rule '+relative+'\n').encode();path=state/'source'/relative
            path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(body);pins[relative]=p.codec.sha(body)
        stack=contextlib.ExitStack();self.addCleanup(stack.close)
        modules=list(production_modules(s,f.p))
        for module in modules:
            if hasattr(module,'RULES') and hasattr(module,'read_configuration'):
                stack.enter_context(mock.patch.object(module,'RULES',pins))
        configuration=f.configuration(hppa64=True)
        configuration['originalRulePins']=pins
        configuration['variables']['CONFARGS']='--enable-languages='+p.host.body.legacy.stage.LANGUAGES+' --enable-multilib --enable-offload-targets=nvptx-none,amdgcn-amdhsa'
        parameters=b'Synthetic generated parameters\n';(state/'source/debian/rules.parameters').write_bytes(parameters)
        configuration['generatedParametersSha256']=p.codec.sha(parameters)
        for name,value in configuration['variables'].items():(configuration_directory/name).write_text(value+'\n')
        for name,value in configuration['passedVariableValues'].items():(configuration_directory/('flag-'+name)).write_text(value+'\n')
        self.assertEqual(p.host.planner.read_configuration(configuration_directory,state/'source'),configuration)
        selected=p.host.planner.plan(configuration);ledger=p.host.planner.new_ledger(configuration)
        for i in range(index):ledger=p.host.planner.append_attempt(ledger,configuration,f.completed(ledger,configuration))
        for phase in selected['phases'][:index]:
            for stamp in phase['requiredStamps']:(state/'source'/stamp).write_bytes(b'Synthetic authentic earlier stamp')
        # Two actual object directories/data files exercise complete physical
        # preservation, not a one-object fake snapshot or returned success bool.
        for i in range(2):
            directory=state/f'source/build-{i}';directory.mkdir()
            path=directory/'object';path.write_bytes(bytes([i,255])*37);path.chmod(0o751+i)
            os.utime(path,ns=(1700000000123456789+i,1700000000123456789+i))
            os.link(path,directory/'hardlink');os.symlink('object',directory/'relative-link')
        (state/'__carrier_home').mkdir();(state/'__carrier_home/cache').write_bytes(b'Synthetic complete home state')
        for directory in ['__carrier_apt_lists','__carrier_apt_archives']:
            (state/directory).mkdir();(state/directory/'retained').write_bytes(b'Synthetic complete apt data')
        values=sdk_fixture.fixture(root)
        sdk_frame,sdk_controls=sdk_fixture.SdkHandoff().write_source(root,values)
        sdk_fixture.m.stage_metadata(sdk_frame,sdk_controls,values[2])
        (state/'__carrier_work/external-sdk-before.json').write_bytes(p.sdk.stage.canonical(values[0]))
        if index==2:
            self.legacy_native_evidence(state.parent,sdk_frame,values[2])
            if legacy_evidence_variant=='missing-sdk-member':
                (state/'__carrier_work/main05-carrier-evidence/sdk-native.log').unlink()
        sha=selected['configurationSha256'];last=ledger['attempts'][-1]
        binding=f.binding(configurationSha256=sha,packageInventorySha256='a'*64,phase=last['phase'],
                          sequence=last['sequence'],predecessorSha256=last['predecessorSha256'])
        transport=root/'downloaded-checkpoint';receipt=p.codec.capture(state,transport,binding,limits=p.LIMITS)
        ledger['attempts'][-1]['checkpointSha256']=receipt['archiveSha256']
        checkpoint_ledger=copy.deepcopy(ledger)
        predecessor={'binding':binding,'archiveBytes':receipt['archiveBytes'],'archiveSha256':receipt['archiveSha256'],
                     'manifestSha256':receipt['manifestSha256'],'externalSdkSha256':values[2]['externalSdkSha256']}
        if index==2 and legacy_evidence_variant!='missing-flag':
            predecessor['preparedSdkMetadataRetainedInsideCheckpoint']=True
        (transport/'CHECKPOINT-ROOT.json').write_bytes(p.codec.canonical(predecessor))
        (transport/'PHASE-LEDGER.json').write_bytes(p.codec.canonical(checkpoint_ledger))
        if failed or unclosed:
            row=f.completed(ledger,configuration)
            row.update(outcome='terminal-incomplete' if unclosed else 'failed',nativeSeconds=731,exitCode=0 if unclosed else 7,
                       checkpointSha256=None,stampIdentities=[],quiescenceObserved=not unclosed)
            if unclosed:row.update(incompleteStage='cleanup',incompleteReason='Synthetic genuine-zero family still unclosed')
            ledger=p.host.planner.append_attempt(ledger,configuration,row)
        policy={'schemaVersion':1,'profile':p.host.planner.PROFILE,'allowedOriginalPhase':selected['phases'][index]['phase'],
                'historySourceIsOperatorFrozenNotToolArguments':True,'operatorExecutionTrustGranted':False,'gateAComplete':False,
                'configuration':configuration,'configureLedger':{**ledger,'attempts':ledger['attempts'][:1]},
                'phaseLedger':ledger,'predecessorRoot':predecessor}
        policy_path=root/'synthetic-independent-operator-policy.json';policy_path.write_bytes(p.codec.canonical(policy))
        for module in modules:
            if hasattr(module,'POLICY_PATH') and hasattr(module,'read_policy'):
                for name,value in [('POLICY_PATH',policy_path),('POLICY_SHA256',p.codec.sha(policy_path.read_bytes())),
                                   ('HISTORY_SHA256',p.codec.sha(p.codec.canonical(ledger))),
                                   ('CONFIGURATION_SHA256',sha),('ALLOWED_ORIGINAL_PHASE',selected['phases'][index]['phase'])]:
                    stack.enter_context(mock.patch.object(module,name,value))
        return {'root':root,'original':state,'transport':transport,'sdk':sdk_controls,'frame':root/'prepared',
                'native':root/'native','configuration':configuration,'ledger':ledger,'rootIdentity':predecessor,
                'policy':policy,'policyPath':policy_path,'policyModules':[m for m in modules if hasattr(m,'POLICY_PATH')],
                'sdkValues':values,'sdkFrame':sdk_frame}

    def legacy_native_evidence(self,frame,sdk_frame,sdk_root):
        """Construct complete synthetic historical-v1 evidence before capture.

        Use the actual first-party metadata/evidence constructors. None of these
        logs/observations claims an original build; every body is synthetic.
        """
        controls=frame/'controls';controls.mkdir(mode=0o700)
        sdk_fixture.m.stage_metadata(sdk_frame,controls,sdk_root)
        observations=frame/'observations';observations.mkdir(mode=0o700)
        command=load(ROOT/'scripts/producer-qualification/gcc-main05-stage.py').COMMAND
        request={'state':'requested','command':command,'label':'original-main05','cwd':'/build/source'}
        terminal={**request,'state':'terminal','exitCode':0,'signal':None,'terminalObserved':True,'elapsedSeconds':50}
        (observations/'original-commands.jsonl').write_bytes(p.codec.canonical(request)+p.codec.canonical(terminal))
        for directory,label in [(frame,'main'),(sdk_frame,'sdk')]:
            (directory/'native.log').write_bytes(('Complete synthetic historical '+label+' stdout\n').encode())
            (directory/'resource-samples.json').write_bytes(p.codec.canonical({'syntheticHistoricalRole':label,'samples':[]}))
        (frame/'MAIN05-ATTEMPT.json').write_bytes(p.codec.canonical({'syntheticHistoricalMainAttempt':True}))
        (sdk_frame/'ATTEMPT.json').write_bytes(p.codec.canonical({'syntheticHistoricalSdkAttempt':True}))
        retainer=load(ROOT/'scripts/producer-qualification/gcc-main05-retain.py')
        return retainer.preserve_evidence(frame,sdk_frame,time.monotonic()+30)

    def prepare(self,values):return p.prepare(values['transport'],values['frame'],values['sdk'])

    def failure(self,values):
        stages=list(values['root'].glob('.gcc-staged-preparation-*'))
        self.assertEqual(len(stages),1)
        value=p.data(stages[0]/'PREPARATION-FAILURE.json')
        self.assertEqual(value['state'],'predecessor-preparation-incomplete')
        self.assertEqual(value['completeChargedPhaseHistory'],values['ledger'])
        self.assertFalse(value['originalPhaseAdvanced']);self.assertFalse(value['gateAComplete'])
        self.assertFalse(values['frame'].exists())
        return stages[0],value

    def test_codec_roundtrip_and_no_replace_activation_preserve_complete_n2_bytes_links_modes_owners_and_ns_times(self):
        v=self.fixture();before=p.codec.snapshot(v['original'],p.codec.Budget(p.LIMITS))
        input_bytes={name:(v['transport']/name).read_bytes() for name in p.MEMBERS}
        record=self.prepare(v);restored=v['frame']/'predecessor'
        self.assertEqual(p.codec.snapshot(restored,p.codec.Budget(p.LIMITS)),before)
        original_inode=restored.stat().st_ino
        result=s.activate(v['frame'],v['native']);state=v['native']/'state'
        self.assertEqual(p.codec.snapshot(state,p.codec.Budget(p.LIMITS)),before)
        self.assertEqual(state.stat().st_ino,original_inode)
        for i in range(2):
            self.assertEqual((state/f'source/build-{i}/object').stat().st_ino,(state/f'source/build-{i}/hardlink').stat().st_ino)
            self.assertEqual((state/f'source/build-{i}/object').stat().st_mtime_ns,1700000000123456789+i)
        for name,body in input_bytes.items():
            self.assertEqual((v['transport']/name).read_bytes(),body)
            self.assertEqual((v['frame']/'checkpoint'/name).read_bytes(),body)
        self.assertEqual(result['context'],record['context'])
        self.assertEqual(result['allAttemptNativeSecondsAlreadyCharged'],100)
        self.assertFalse((v['frame']/'predecessor').exists())
        for key in p.UNQUALIFIED:self.assertIs(result[key],False)
        with self.assertRaisesRegex(ValueError,'Prior activation intent'):s.activate(v['frame'],v['root']/'another-native')

    def test_each_remaining_original_phase_requires_its_independently_frozen_command_labels_and_repeated_stamps(self):
        for index in range(1,9):
            with self.subTest(index=index):
                v=self.fixture(index);record=self.prepare(v);result=s.activate(v['frame'],v['native'])
                expected=p.host.body.history.inspect()['contract']
                self.assertEqual(record['context']['contract'],expected)
                self.assertEqual(result['context']['contract']['command'],p.host.planner.plan(v['configuration'])['phases'][index]['command'])
                self.assertEqual(result['allAttemptNativeSecondsAlreadyCharged'],index*100)
                if index>=7:self.assertTrue(expected['requiredStampsAlsoRequiredEarlier'])

    def test_native_predecessor_has_complete_legacy_evidence_and_current_sdk_guard_really_runs(self):
        v=self.fixture(2);legacy=v['original']/'__carrier_work/main05-carrier-evidence'
        self.assertIs(v['rootIdentity'].get('preparedSdkMetadataRetainedInsideCheckpoint'),True)
        self.assertNotIn('native05EvidenceProfile',v['rootIdentity'])
        self.assertTrue(legacy.is_dir(),'Complete legacy evidence must exist before authenticated capture')
        inventory=p.data(legacy/'EVIDENCE-INVENTORY.json')
        self.assertEqual(set(inventory['files']),{'main-native.log','sdk-native.log','main-resource-samples.json',
            'sdk-resource-samples.json','MAIN05-ATTEMPT.json','SDK-ATTEMPT.json'})
        self.assertEqual(set(inventory['completeMetadataTrees']),{'main-observations','sdk-observations','prepared-sdk'})
        self.assertEqual((legacy/'sdk-native.log').read_bytes(),(v['sdkFrame']/'native.log').read_bytes())
        with mock.patch.object(p.sdk,'read_prepared',wraps=p.sdk.read_prepared) as guard:
            record=self.prepare(v)
        self.assertEqual(guard.call_count,3)
        for call in guard.call_args_list:
            self.assertEqual(call.args[0].name,'controls')
            self.assertEqual(call.args[1],v['sdkValues'][0]);self.assertEqual(call.args[2],v['rootIdentity'])
        self.assertEqual(guard.call_args_list[-1].args[0],v['frame']/'controls')
        self.assertEqual(record['allAttemptNativeSecondsAlreadyCharged'],200)
        # Keep the whole historical SDK evidence valid, but change a current
        # SDK engine and re-pin only its synthetic physical manifest. The real
        # current SDK reader must still refuse after the legacy guard passes.
        directory=v['frame']/'controls/prepared-sdk';name='PREPARED-SDK-GENERATION.json'
        value=p.data(directory/name);next(iter(value['effectiveMapping'].values()))['engine']='synthetic-wrong-engine'
        (directory/name).write_bytes(p.codec.canonical(value))
        manifest=p.data(directory/'PREPARED-SDK-MANIFEST.json');manifest['members'][name]=p.pin(directory/name)
        (directory/'PREPARED-SDK-MANIFEST.json').write_bytes(p.codec.canonical(manifest))
        with mock.patch.object(p.sdk,'read_prepared',wraps=p.sdk.read_prepared) as guard:
            with self.assertRaises((ValueError,KeyError)):p.verify_frame(v['frame'])
        guard.assert_called_once_with(v['frame']/'controls',v['sdkValues'][0],v['rootIdentity'])

    def test_native_predecessor_missing_legacy_flag_or_sdk_member_refuses_before_current_sdk_reader(self):
        for variant in ['missing-flag','missing-sdk-member']:
            with self.subTest(variant=variant):
                v=self.fixture(2,legacy_evidence_variant=variant)
                before={name:p.pin(v['transport']/name,p.LIMITS['archiveBytes'] if name=='tree.tar.gz' else 1024**2) for name in p.MEMBERS}
                with mock.patch.object(p.sdk,'read_prepared',side_effect=AssertionError('Current SDK guard reached before legacy admission')) as guard,\
                     mock.patch.object(p.codec,'restore',wraps=p.codec.restore) as restore:
                    with self.assertRaisesRegex(ValueError,'Historical main05|Legacy complete'):self.prepare(v)
                guard.assert_not_called();restore.assert_called_once()
                self.failure(v)
                self.assertEqual(before,{name:p.pin(v['transport']/name,p.LIMITS['archiveBytes'] if name=='tree.tar.gz' else 1024**2) for name in p.MEMBERS})

    def test_failed_attempt_charge_survives_cache_ledger_prefix_and_activation_without_reset(self):
        v=self.fixture(failed=True);record=self.prepare(v)
        self.assertEqual(record['context']['phaseLedger'],v['ledger'])
        self.assertEqual(record['context']['contract']['attempt'],2)
        self.assertEqual(p.data(v['frame']/'checkpoint/PHASE-LEDGER.json')['attempts'],v['ledger']['attempts'][:1])
        result=s.activate(v['frame'],v['native'])
        self.assertEqual(result['allAttemptNativeSecondsAlreadyCharged'],831)
        self.assertEqual(result['context']['phaseLedger']['attempts'][-1]['exitCode'],7)

    def test_genuine_zero_unclosed_family_refuses_before_any_output_or_sdk_contract_read(self):
        v=self.fixture(unclosed=True)
        with mock.patch.object(p.sdk,'read_prepared',side_effect=AssertionError('SDK was reached')):
            with self.assertRaisesRegex(ValueError,'Unresolved original process family'):self.prepare(v)
        self.assertEqual(v['ledger']['attempts'][-1]['exitCode'],0)
        self.assertFalse(v['ledger']['attempts'][-1]['quiescenceObserved'])
        self.assertFalse(v['frame'].exists());self.assertEqual(list(v['root'].glob('.gcc-staged-preparation-*')),[])

    def test_wrong_frozen_predecessor_or_changed_configuration_history_cannot_be_rehashed_by_caller(self):
        for kind in ['root','ledger','configuration']:
            with self.subTest(kind=kind):
                v=self.fixture(failed=True)
                if kind=='root':
                    root=p.data(v['transport']/'CHECKPOINT-ROOT.json');root['externalSdkSha256']='f'*64
                    (v['transport']/'CHECKPOINT-ROOT.json').write_bytes(p.codec.canonical(root))
                elif kind=='ledger':
                    ledger=p.data(v['transport']/'PHASE-LEDGER.json');ledger['attempts'][0]['nativeSeconds']=0
                    (v['transport']/'PHASE-LEDGER.json').write_bytes(p.codec.canonical(ledger))
                else:(v['policyPath']).write_bytes(p.codec.canonical({**v['policy'],'configuration':{}}))
                with self.assertRaises(ValueError):self.prepare(v)
                self.assertFalse(v['frame'].exists())

    def test_partial_extra_linked_hardlinked_or_corrupt_cache_members_refuse_without_success(self):
        for kind in ['missing','extra','symlink','hardlink','archive','receipt']:
            with self.subTest(kind=kind):
                v=self.fixture();path=v['transport']/'receipt.json'
                if kind=='missing':path.unlink()
                elif kind=='extra':(v['transport']/'extra').write_bytes(b'Synthetic unknown file')
                elif kind=='symlink':path.rename(v['root']/'real-receipt');path.symlink_to(v['root']/'real-receipt')
                elif kind=='hardlink':os.link(path,v['root']/'outside-alias')
                elif kind=='archive':(v['transport']/'tree.tar.gz').write_bytes(b'Synthetic corrupt archive')
                else:path.write_bytes(p.codec.canonical({**p.data(path),'manifestSha256':'f'*64}))
                with self.assertRaises(ValueError):self.prepare(v)
                self.assertFalse(v['frame'].exists())

    def test_real_sdk_contract_rejects_partial_engine_mapping_nonzero_final_hash_or_boolean_clearance(self):
        for kind in ['missing','engine','terminal','hash','boolean']:
            with self.subTest(kind=kind):
                v=self.fixture();directory=v['sdk']/'prepared-sdk'
                if kind=='missing':(directory/'PREPARED-SDK-VALIDATION.json').unlink()
                else:
                    name='PREPARED-SDK-GENERATION.json' if kind=='engine' else 'PREPARED-SDK-VALIDATION.json'
                    value=p.data(directory/name)
                    if kind=='engine':next(iter(value['effectiveMapping'].values()))['engine']='synthetic-wrong-engine'
                    elif kind=='terminal':value['validators'][0]['command']['exitCode']=2
                    elif kind=='hash':next(iter(value['finalGeneratedIdentities'].values()))['sha256']='f'*64
                    else:value={'qualified':True,'operatorExecutionTrustGranted':True}
                    (directory/name).write_bytes(p.codec.canonical(value))
                    manifest=p.data(directory/'PREPARED-SDK-MANIFEST.json');manifest['members'][name]=p.pin(directory/name)
                    (directory/'PREPARED-SDK-MANIFEST.json').write_bytes(p.codec.canonical(manifest))
                with self.assertRaises((ValueError,KeyError)):self.prepare(v)
                self.assertFalse(v['frame'].exists())
                if kind!='missing':self.failure(v)

    def test_prepare_preflights_existing_dangling_aliased_or_unowned_destinations(self):
        for kind in ['existing','dangling','overlap','parent-link','owner','writable']:
            with self.subTest(kind=kind):
                v=self.fixture();target=v['frame'];patch=contextlib.nullcontext()
                if kind=='existing':target.mkdir();(target/'sentinel').write_bytes(b'Synthetic keep')
                elif kind=='dangling':target.symlink_to(v['root']/'absent')
                elif kind=='overlap':target=v['transport']/'nested'
                elif kind=='parent-link':
                    link=v['root']/'alias';link.symlink_to(v['root']);target=link/'prepared'
                elif kind=='owner':patch=mock.patch.object(p.os,'geteuid',return_value=os.geteuid()+1)
                else:v['root'].chmod(0o777)
                with patch,self.assertRaises(ValueError):p.prepare(v['transport'],target,v['sdk'])
                self.assertEqual(list(v['root'].glob('.gcc-staged-preparation-*')),[])

    def test_interrupted_restore_or_copy_retains_input_and_only_an_incomplete_owned_stage(self):
        for kind in ['copy','restore','unconfirmed-restore']:
            with self.subTest(kind=kind):
                v=self.fixture();before={n:(v['transport']/n).read_bytes() for n in p.MEMBERS}
                target=p if kind=='copy' else p.codec;name='copy_file' if kind=='copy' else 'restore'
                actual=getattr(target,name)
                def fail(*args,**kwargs):
                    if kind=='unconfirmed-restore':return {**actual(*args,**kwargs),'physicalTreeVerified':False}
                    raise OSError('Synthetic interrupted '+kind)
                with mock.patch.object(target,name,side_effect=fail),self.assertRaises((OSError,ValueError)):self.prepare(v)
                stage,failure=self.failure(v)
                self.assertEqual(failure['completeChargedPhaseHistory'],v['ledger'])
                for n,b in before.items():self.assertEqual((v['transport']/n).read_bytes(),b)

    def test_late_preparation_collision_never_replaces_concurrent_output(self):
        v=self.fixture();actual=p.codec.rename_no_replace
        def rename(source,target):
            if target==v['frame']:
                target.mkdir();(target/'sentinel').write_bytes(b'Synthetic concurrent output')
            return actual(source,target)
        with mock.patch.object(p.codec,'rename_no_replace',side_effect=rename),self.assertRaises(OSError):self.prepare(v)
        self.assertEqual((v['frame']/'sentinel').read_bytes(),b'Synthetic concurrent output')
        self.assertFalse((v['frame']/'PREPARED.json').exists())
        stages=list(v['root'].glob('.gcc-staged-preparation-*'));self.assertEqual(len(stages),1)
        self.assertTrue((stages[0]/'predecessor').is_dir());self.assertTrue((stages[0]/'PREPARATION-FAILURE.json').is_file())

    def test_changed_physical_configuration_state_controls_sdk_or_recovery_checkpoint_refuses_activation(self):
        for kind in ['configuration','state','contract','sdk','checkpoint','history']:
            with self.subTest(kind=kind):
                v=self.fixture();self.prepare(v);frame=v['frame']
                if kind=='configuration':(frame/'predecessor/__carrier_work/gcc-staged-configuration/BOOT_CFLAGS').write_bytes(b'Synthetic wrong flags\n')
                elif kind=='state':(frame/'predecessor/source/build-1/object').write_bytes(b'Synthetic changed object')
                elif kind=='contract':
                    path=frame/'controls/SELECTED-PHASE-CONTRACT.json';value=p.data(path);value['terminalLabel']='same-phase-wrong-label';path.write_bytes(p.codec.canonical(value))
                elif kind=='sdk':(frame/'controls/prepared-sdk/PREPARED-SDK-GENERATION.json').write_bytes(b'{"qualified":true}')
                elif kind=='checkpoint':(frame/'checkpoint/tree.tar.gz').write_bytes(b'Synthetic corrupt recovery checkpoint')
                else:v['policyPath'].write_bytes(b'{"clearIncomplete":true}')
                with self.assertRaises((ValueError,KeyError)):s.activate(frame,v['native'])
                self.assertTrue((frame/'predecessor').is_dir());self.assertFalse(v['native'].exists())
                self.assertFalse((frame/'ACTIVATION-INTENT.json').exists())

    def test_cross_device_unsupported_owner_overlap_existing_and_dangling_native_destinations_preflight_before_intent(self):
        for kind in ['device','unsupported','owner','overlap','existing','dangling']:
            with self.subTest(kind=kind):
                v=self.fixture();self.prepare(v);target=v['native'];patch=contextlib.nullcontext()
                if kind=='device':
                    actual=Path.lstat
                    def info(path):
                        value=actual(path)
                        if path==target.parent:
                            fields=list(value);fields[2]+=1;return os.stat_result(fields)
                        return value
                    patch=mock.patch.object(Path,'lstat',info)
                elif kind=='unsupported':patch=mock.patch.object(s.sys,'platform','synthetic-unsupported')
                elif kind=='owner':patch=mock.patch.object(p.os,'geteuid',return_value=os.geteuid()+1)
                elif kind=='overlap':target=v['frame']/'nested'
                elif kind=='existing':target.mkdir()
                else:target.symlink_to(v['root']/'absent')
                with patch,self.assertRaises(ValueError):s.activate(v['frame'],target)
                self.assertTrue((v['frame']/'predecessor').is_dir());self.assertFalse((v['frame']/'ACTIVATION-INTENT.json').exists())

    def test_durable_intent_exists_before_move_and_fsync_failure_performs_no_relocation(self):
        v=self.fixture();self.prepare(v);actual=s.codec.rename_no_replace;observed=[];syncs=[];fsync=p.os.fsync
        def sync(descriptor):
            syncs.append('directory' if stat.S_ISDIR(os.fstat(descriptor).st_mode) else 'file')
            return fsync(descriptor)
        def rename(source,target):
            if source==v['frame']/'predecessor':
                self.assertEqual(syncs[:2],['file','directory'])
                observed.append(p.data(v['frame']/'ACTIVATION-INTENT.json')['completeChargedPhaseHistory'])
            return actual(source,target)
        with mock.patch.object(p.os,'fsync',side_effect=sync),mock.patch.object(s.codec,'rename_no_replace',side_effect=rename):
            s.activate(v['frame'],v['native'])
        self.assertEqual(observed,[v['ledger']])
        w=self.fixture();self.prepare(w)
        with mock.patch.object(p.os,'fsync',side_effect=OSError('Synthetic failed intent fsync')):
            with self.assertRaisesRegex(OSError,'intent fsync'):s.activate(w['frame'],w['native'])
        self.assertTrue((w['frame']/'predecessor').is_dir());self.assertFalse(w['native'].exists())

    def test_failure_before_and_after_move_keeps_exact_tree_at_one_recoverable_path_and_blocks_retry(self):
        for moved in [False,True]:
            with self.subTest(moved=moved):
                v=self.fixture(failed=True);self.prepare(v);before=p.codec.snapshot(v['frame']/'predecessor',p.codec.Budget(p.LIMITS))
                actual=s.codec.rename_no_replace
                def rename(source,target):
                    if source==v['frame']/'predecessor':
                        if moved:actual(source,target)
                        raise OSError('Synthetic ambiguous physical rename')
                    return actual(source,target)
                with mock.patch.object(s.codec,'rename_no_replace',side_effect=rename),self.assertRaisesRegex(OSError,'ambiguous'):s.activate(v['frame'],v['native'])
                failure=p.data(v['frame']/'ACTIVATION-FAILURE.json')
                self.assertEqual(failure['sourcePathPresent'],not moved);self.assertEqual(failure['destinationPathPresent'],moved)
                actual_path=v['native']/'state' if moved else v['frame']/'predecessor'
                self.assertEqual(p.codec.snapshot(actual_path,p.codec.Budget(p.LIMITS)),before)
                self.assertEqual(failure['completeChargedPhaseHistory'],v['ledger'])
                self.assertFalse((v['native']/'ACTIVATION.json').exists());self.assertTrue((v['frame']/'checkpoint/tree.tar.gz').is_file())
                with self.assertRaisesRegex(ValueError,'Prior activation intent'):s.activate(v['frame'],v['root']/'retry')

    def test_post_move_physical_failure_cannot_publish_success_or_erase_charges(self):
        v=self.fixture(failed=True);self.prepare(v);actual=s.codec.rename_no_replace
        def rename(source,target):
            result=actual(source,target)
            if source==v['frame']/'predecessor':(target/'source/build-1/object').chmod(0o600)
            return result
        with mock.patch.object(s.codec,'rename_no_replace',side_effect=rename),self.assertRaisesRegex(ValueError,'physical predecessor'):s.activate(v['frame'],v['native'])
        self.assertTrue((v['native']/'state').is_dir());self.assertFalse((v['native']/'ACTIVATION.json').exists())
        failure=p.data(v['frame']/'ACTIVATION-FAILURE.json');self.assertEqual(failure['selectedOriginalContract']['allAttemptNativeSecondsAlreadyCharged'],831)

    def reseal(self,values,policy):
        values['policyPath'].write_bytes(p.codec.canonical(policy))
        for module in values['policyModules']:
            module.POLICY_SHA256=p.codec.sha(values['policyPath'].read_bytes())
            module.HISTORY_SHA256=p.codec.sha(p.codec.canonical(policy['phaseLedger']))

    def test_aggregate_boundary_and_fresh_reviewed_history_cannot_reset_charges_or_reuse_old_preparation(self):
        for spent in [43199,43200]:
            with self.subTest(spent=spent):
                v=self.fixture();ledger=copy.deepcopy(v['ledger'])
                for duration in [14300,14300,14300,spent-43000]:
                    row=f.completed(ledger,v['configuration']);row.update(nativeSeconds=duration,outcome='failed',exitCode=7,checkpointSha256=None)
                    ledger=p.host.planner.append_attempt(ledger,v['configuration'],row)
                self.reseal(v,{**v['policy'],'phaseLedger':ledger})
                if spent==43200:
                    with self.assertRaisesRegex(ValueError,'Aggregate native allowance exhausted'):self.prepare(v)
                    self.assertFalse(v['frame'].exists())
                else:
                    result=self.prepare(v);self.assertEqual(result['allAttemptNativeSecondsAlreadyCharged'],43199)
                    activated=s.activate(v['frame'],v['native']);self.assertEqual(activated['allAttemptNativeSecondsAlreadyCharged'],43199)
                    self.assertFalse(activated['hostCapacityQualified'])
        v=self.fixture();self.prepare(v);ledger=copy.deepcopy(v['ledger'])
        row=f.completed(ledger,v['configuration']);row.update(nativeSeconds=54,outcome='failed',exitCode=3,checkpointSha256=None)
        ledger=p.host.planner.append_attempt(ledger,v['configuration'],row)
        self.reseal(v,{**v['policy'],'phaseLedger':ledger})
        with self.assertRaisesRegex(ValueError,'Read-only exact source-frozen phase contract'):s.activate(v['frame'],v['native'])
        self.assertFalse(v['native'].exists());self.assertTrue((v['frame']/'predecessor').is_dir())

    def test_an_equivalent_new_tree_cannot_replace_same_inode_relocation(self):
        v=self.fixture();self.prepare(v);actual=s.codec.rename_no_replace
        def rename(source,target):
            if source==v['frame']/'predecessor':
                actual(source,v['root']/'synthetic-owned-relocated-original')
                p.codec.restore(v['frame']/'checkpoint',target,v['rootIdentity']['binding'],v['rootIdentity']['archiveSha256'],limits=p.LIMITS)
                return
            return actual(source,target)
        with mock.patch.object(s.codec,'rename_no_replace',side_effect=rename),self.assertRaisesRegex(ValueError,'original physical inode'):
            s.activate(v['frame'],v['native'])
        self.assertFalse((v['native']/'ACTIVATION.json').exists());self.assertTrue((v['root']/'synthetic-owned-relocated-original').is_dir())

    def test_recovery_checkpoint_changed_after_move_cannot_receive_final_local_activation_receipt(self):
        v=self.fixture();self.prepare(v);actual=s.codec.rename_no_replace
        def rename(source,target):
            result=actual(source,target)
            if source==v['frame']/'predecessor':(v['frame']/'checkpoint/tree.tar.gz').write_bytes(b'Synthetic late corrupt recovery archive')
            return result
        with mock.patch.object(s.codec,'rename_no_replace',side_effect=rename),self.assertRaisesRegex(ValueError,'archive identity'):
            s.activate(v['frame'],v['native'])
        self.assertTrue((v['native']/'state').is_dir());self.assertFalse((v['native']/'ACTIVATION.json').exists())
        self.assertTrue((v['frame']/'ACTIVATION-FAILURE.json').is_file())

    def test_dangling_one_shot_marker_refuses_before_any_new_validation_or_effect(self):
        v=self.fixture();self.prepare(v);(v['frame']/'ACTIVATION-INTENT.json').symlink_to(v['root']/'absent-marker-target')
        with mock.patch.object(p,'verify_frame',side_effect=AssertionError('Validation was reached')):
            with self.assertRaisesRegex(ValueError,'Prior activation intent'):s.activate(v['frame'],v['native'])
        self.assertTrue((v['frame']/'predecessor').is_dir());self.assertFalse(v['native'].exists())

    def test_final_receipt_collision_is_not_overwritten_or_reported_as_local_success(self):
        v=self.fixture();self.prepare(v);actual=s.codec.rename_no_replace
        def rename(source,target):
            if target==v['native']/'ACTIVATION.json':target.write_bytes(b'Synthetic concurrent receipt')
            return actual(source,target)
        with mock.patch.object(s.codec,'rename_no_replace',side_effect=rename),self.assertRaises(OSError):s.activate(v['frame'],v['native'])
        self.assertEqual((v['native']/'ACTIVATION.json').read_bytes(),b'Synthetic concurrent receipt')
        self.assertEqual(p.data(v['frame']/'ACTIVATION-FAILURE.json')['state'],'source-activation-incomplete')
        self.assertTrue((v['native']/'state').is_dir());self.assertTrue((v['frame']/'checkpoint/tree.tar.gz').is_file())

    def test_bounded_copy_rejects_growth_and_sdk_contract_is_not_called_for_a_changed_archive(self):
        v=self.fixture();source=v['root']/'small';source.write_bytes(b'12');identity=p.pin(source)
        actual=p.pin;calls=[0]
        def change(path,maximum=1024**2):
            result=actual(path,maximum)
            if path==source:
                calls[0]+=1
                if calls[0]==1:source.write_bytes(b'1234')
            return result
        with mock.patch.object(p,'pin',side_effect=change),self.assertRaisesRegex(ValueError,'grew during bounded copy'):
            p.copy_file(source,v['root']/'target',identity,16)
        (v['transport']/'tree.tar.gz').write_bytes(b'Changed synthetic archive')
        with mock.patch.object(p.sdk,'read_prepared',side_effect=AssertionError('SDK was reached')):
            with self.assertRaisesRegex(ValueError,'archive identity'):self.prepare(v)

    def test_no_entry_phase_trust_clearance_sdk_execution_or_service_interface_is_exposed(self):
        import inspect
        self.assertEqual(list(inspect.signature(p.prepare).parameters),['transport','frame','sdk_controls'])
        self.assertEqual(list(inspect.signature(s.activate).parameters),['frame','native_frame'])
        for module in [p,s]:
            self.assertFalse(hasattr(module,'main'));self.assertFalse(hasattr(module,'subprocess'))
        with self.assertRaises(TypeError):p.prepare(None,None,None,operatorTrusted=True)
        with self.assertRaises(TypeError):s.activate(None,None,clearIncomplete=True)


if __name__=='__main__':unittest.main()
