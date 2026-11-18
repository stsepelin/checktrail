"""Synthetic SDK DATA and real FD/child-output barriers; no SDK/native effects."""
import copy
import ast
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parent.parent


def load(path):
    spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


m=load(ROOT/'scripts/producer-qualification/gcc-sdk-onhost-receipt.py')
fixture=load(ROOT/'test/gcc-main05-sdk-cases.py')
HEAD='b'*40
RAW='RAW_SYNTHETIC_SDK_BODY_DO_NOT_EXPORT_17'
RAW2='RAW_SYNTHETIC_SDK_BODY_DO_NOT_EXPORT_29'


class Receipt(unittest.TestCase):
    def folder(self):
        temporary=tempfile.TemporaryDirectory(prefix='gcc-receipt-synthetic-');self.addCleanup(temporary.cleanup)
        return Path(temporary.name).resolve()

    def facts(self):
        return {'counts':{'packages':2,'originalEntries':400,'currentEntries':400,'generatedOutputs':51,'formats':13,
                          'generators':17,'validators':37},'hashes':{key:'c'*64 for key in m.HASHES},
                'sdkContainerExitCode':0,'sdkContainerQuiescent':True,'ownedSdkCleanupObserved':True,'sdkContainerSeconds':71.5}

    def run_entry(self,work,*,arguments=None):
        root=self.folder();public=root/'synthetic-public-job-log';public_err=root/'synthetic-public-stderr'
        saved=[os.dup(1),os.dup(2)]
        with public.open('wb') as stdout,public_err.open('wb') as stderr:
            try:
                sys.stdout.flush();sys.stderr.flush();os.dup2(stdout.fileno(),1);os.dup2(stderr.fileno(),2)
                with mock.patch.dict(os.environ,{'RUNNER_TEMP':str(root),'GITHUB_SHA':HEAD}),\
                     mock.patch.object(sys,'argv',arguments or ['fixed-helper','qualify-on-host','--operator-trust-execution']),\
                     mock.patch.object(m,'fixed_work',side_effect=work) as called:
                    code=m.main();calls=called.call_count
                sys.stdout.flush();sys.stderr.flush()
            finally:
                os.dup2(saved[0],1);os.dup2(saved[1],2)
                for fd in saved:os.close(fd)
        body=public.read_bytes();error=public_err.read_bytes()
        self.assertEqual(error,b'');self.assertEqual(body.count(m.PREFIX),1);self.assertTrue(body.startswith(m.PREFIX))
        self.assertLessEqual(len(body),m.MAX_RECEIPT)
        self.assertNotIn(RAW.encode(),body);self.assertNotIn(RAW2.encode(),body)
        value=json.loads(body[len(m.PREFIX):]);m.validate_receipt(value)
        return root,code,calls,value,body

    def noisy(self,private):
        print(RAW);print(RAW2,file=sys.stderr);os.write(1,(RAW+'-os-write\n').encode());os.write(2,(RAW2+'-os-write\n').encode())
        subprocess.run([sys.executable,'-c','import os;os.write(1,'+repr((RAW+'-child\n').encode())+');os.write(2,'+repr((RAW2+'-child\n').encode())+')'],check=True)
        return self.facts()

    def test_success_captures_n2_python_os_and_inherited_child_fds_and_emits_only_closed_counts_hashes_status(self):
        root,code,calls,value,body=self.run_entry(self.noisy)
        self.assertEqual((code,calls),(0,1));self.assertTrue(value['sdkVerifiedOnHost']);self.assertEqual(value['errorId'],'none')
        local=(root/'gcc-sdk-receipt-private/opaque-wrapper-output.log').read_bytes()
        for suffix in ['', '-os-write','-child']:
            for secret in [RAW,RAW2]:self.assertIn((secret+suffix).encode(),local)
        self.assertEqual(value['hashes']['wrapperOutput'],m.file_pin(root/'gcc-sdk-receipt-private/opaque-wrapper-output.log',m.MAX_OPAQUE)['sha256'])
        self.assertFalse(value['offHostRawCustody']);self.assertEqual(value['artifactUploads'],0)
        self.assertFalse(value['native05Invoked']);self.assertFalse(value['gateAComplete'])

    def test_sdk_failure_keyboard_interrupt_systemexit_and_tracebacks_never_open_a_public_body_channel(self):
        for error in [RuntimeError(RAW+' /original/sdk/private-path'),KeyboardInterrupt(RAW2),SystemExit(RAW),BaseException(RAW2)]:
            with self.subTest(kind=type(error).__name__):
                def fail(private):self.noisy(private);raise error
                root,code,calls,value,body=self.run_entry(fail)
                self.assertEqual((code,calls),(1,1));self.assertFalse(value['sdkVerifiedOnHost']);self.assertEqual(value['errorId'],'unexpected-failure')
                self.assertIsNone(value['sdkContainerSeconds']);self.assertIsNone(value['sdkContainerExitCode'])
                local=(root/'gcc-sdk-receipt-private/opaque-wrapper-output.log').read_text()
                self.assertIn('Traceback',local);self.assertIn(RAW,local);self.assertIn(RAW2,local)
                self.assertNotIn(b'/original/sdk/private-path',body)

    def test_invalid_operator_entry_cannot_reach_sdk_or_echo_raw_arguments(self):
        for args in [['helper'],['helper',RAW,'--operator-trust-execution'],['helper','qualify-on-host',RAW2]]:
            with self.subTest(args=args):
                root,code,calls,value,body=self.run_entry(lambda _:self.fail('SDK reached'),arguments=args)
                self.assertEqual((code,calls),(1,0));self.assertEqual(value['errorId'],'operator-required')
                self.assertFalse((root/'gcc-sdk-receipt-private').exists())

    def test_every_literal_refusal_identifier_is_enumerated_and_entry_withholds_broken_emission_without_traceback(self):
        tree=ast.parse(Path(m.__file__).read_bytes());identifiers=set()
        for node in ast.walk(tree):
            if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id in ['require','Refusal'] and node.args:
                value=node.args[-1]
                if isinstance(value,ast.Constant) and type(value.value) is str:identifiers.add(value.value)
        self.assertTrue(identifiers);self.assertLessEqual(identifiers,m.ERRORS)
        with mock.patch.object(m,'main',side_effect=RuntimeError(RAW+' /original/private-path')):
            self.assertEqual(m.entry(),1)

    def test_real_process_entry_failures_emit_one_bounded_receipt_with_no_raw_stdout_stderr_or_traceback(self):
        for kind in ['bad-argv','missing-temp','linked-temp','namespace-exists','timeout']:
            with self.subTest(kind=kind):
                root=self.folder();env=dict(os.environ);env['GITHUB_SHA']=HEAD
                env['RUNNER_TEMP']=str(root);command=[sys.executable,'-I','-B',str(Path(m.__file__)),'qualify-on-host','--operator-trust-execution']
                if kind=='bad-argv':command[-1]=RAW
                elif kind=='missing-temp':env.pop('RUNNER_TEMP',None)
                elif kind=='linked-temp':
                    alias=root/'RAW_SYNTHETIC_PRIVATE_PATH';alias.symlink_to(root);env['RUNNER_TEMP']=str(alias)
                elif kind=='namespace-exists':(root/'gcc-sdk-receipt-private').write_text(RAW)
                else:
                    program='HELPER='+repr(str(Path(m.__file__)))+'\nBODY_ONE='+repr(RAW)+'\nBODY_TWO='+repr(RAW2)+'\n'+'''import importlib.util,os,subprocess,sys
spec=importlib.util.spec_from_file_location('closed_helper',HELPER);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def work(private):
 os.write(1,BODY_ONE.encode());os.write(2,BODY_TWO.encode())
 subprocess.run([sys.executable,'-c','import time;time.sleep(1)'],timeout=0.02,check=True)
m.fixed_work=work;sys.argv=['helper','qualify-on-host','--operator-trust-execution'];raise SystemExit(m.entry())
'''
                    command=[sys.executable,'-I','-B','-c',program]
                completed=subprocess.run(command,env=env,capture_output=True,timeout=10)
                self.assertEqual(completed.returncode,1);self.assertEqual(completed.stderr,b'')
                self.assertTrue(completed.stdout.startswith(m.PREFIX));self.assertEqual(completed.stdout.count(m.PREFIX),1)
                self.assertLessEqual(len(completed.stdout),m.MAX_RECEIPT)
                for secret in [RAW.encode(),RAW2.encode(),b'Traceback',b'RAW_SYNTHETIC_PRIVATE_PATH']:self.assertNotIn(secret,completed.stdout)
                value=json.loads(completed.stdout[len(m.PREFIX):]);m.validate_receipt(value)
                expected='operator-required' if kind=='bad-argv' else 'input-refused' if kind=='timeout' else 'runtime-refused'
                self.assertEqual(value['errorId'],expected);self.assertFalse(value['sdkVerifiedOnHost'])

    def test_sdk_postcondition_failure_preserves_genuine_container_zero_and_elapsed_without_verification_credit(self):
        def fail(private):
            output=private/'synthetic-owned-sdk';output.mkdir()
            (output/'SDK-CARRIER.json').write_bytes(m.canonical({'ownedContainerCleanup':'removed','ownedSeedCleanup':'removed',
              'observed':{'nativeSeconds':91.25,'containerState':{'Running':False,'Pid':0,'Status':'exited','ExitCode':0}}}))
            m.retain_attempt(output,private)
            raise m.Refusal('sdk-proof-refused')
        root,code,_,value,_=self.run_entry(fail)
        self.assertEqual(code,1);self.assertFalse(value['sdkVerifiedOnHost']);self.assertEqual(value['sdkContainerExitCode'],0)
        self.assertEqual(value['sdkContainerSeconds'],91.25);self.assertTrue(value['sdkContainerQuiescent'])
        self.assertTrue(value['ownedSdkCleanupObserved']);self.assertGreaterEqual(value['helperSeconds'],0)

    def test_extra_raw_fields_and_invalid_counts_hashes_status_types_cannot_be_returned_as_success(self):
        for kind in ['raw-field','path-hash','huge-hash','extra-count','boolean-count','boolean-terminal','missing-hash','unknown-hash']:
            with self.subTest(kind=kind):
                def bad(private):
                    facts=self.noisy(private)
                    if kind=='raw-field':facts['stdout']=RAW
                    elif kind=='path-hash':facts['hashes']['sdkStdout']='/original/sdk/'+RAW
                    elif kind=='huge-hash':facts['hashes']['sdkStdout']=RAW*5000
                    elif kind=='extra-count':facts['counts']['path']=RAW
                    elif kind=='boolean-count':facts['counts']['packages']=True
                    elif kind=='boolean-terminal':facts['sdkContainerExitCode']=False
                    elif kind=='missing-hash':facts['hashes']['sdkStdout']=None
                    else:facts['hashes']['unknown']=RAW
                    return facts
                root,code,calls,value,body=self.run_entry(bad)
                self.assertEqual((code,calls),(1,1));self.assertFalse(value['sdkVerifiedOnHost']);self.assertEqual(value['errorId'],'sdk-proof-refused')

    def test_closed_receipt_type_bounds_required_formats_quiescence_and_limitations_have_no_success_near_match(self):
        root,_,_,good,_=self.run_entry(self.noisy)
        for name,value in [('schemaVersion',True),('sdkContainerQuiescent',False),('ownedSdkCleanupObserved',False),
                           ('errorId',RAW),('sourceHead',RAW2),('sourcePolicySha256','e'*64),('helperSeconds',float('nan')),
                           ('artifactUploads',False),('artifactUploads',1),('gateAComplete',True),('offHostRawCustody',True)]:
            with self.subTest(name=name,value=value):
                with self.assertRaises((m.Refusal,TypeError)):m.validate_receipt({**good,name:value})
        for name,count in [('generatedOutputs',50),('formats',12),('packages',0)]:
            value=copy.deepcopy(good);value['counts'][name]=count
            with self.assertRaises(m.Refusal):m.validate_receipt(value)

    def test_output_ceiling_and_late_control_time_refuse_without_exporting_capture_or_exception(self):
        with mock.patch.object(m,'MAX_OPAQUE',64):
            root,code,_,value,_=self.run_entry(self.noisy)
            self.assertEqual(code,1);self.assertEqual(value['errorId'],'local-output-limit')
            self.assertEqual(value['sdkContainerExitCode'],0);self.assertEqual(value['sdkContainerSeconds'],71.5)
            self.assertFalse(value['sdkVerifiedOnHost'])
            self.assertGreater((root/'gcc-sdk-receipt-private/opaque-wrapper-output.log').stat().st_size,64)
        ticks=[0]
        def monotonic():
            ticks[0]+=1;return 0 if ticks[0]==1 else 6601
        with mock.patch.object(m,'time',types.SimpleNamespace(monotonic=monotonic)):
            root,code,_,value,_=self.run_entry(lambda _:self.facts())
            self.assertEqual(code,1);self.assertEqual(value['errorId'],'runtime-refused')

    def test_closed_failure_stage_follows_actual_fixed_work_calls_without_running_any_sdk_command(self):
        for stop,expected in [('image-acquisition','image-acquisition'),('common-input-acquisition','common-input-acquisition'),
                              ('gcc-input-acquisition','gcc-input-acquisition'),('legacy-sdk-capture','legacy-sdk-capture'),
                              ('none','complete')]:
            with self.subTest(stop=stop):
                root=self.folder();private=root/'private';private.mkdir()
                calls=[]
                def current():return m.read_json(private/'CLOSED-STAGE.json')['stage']
                def run(command,**kwargs):
                    stage=current();calls.append(stage)
                    return types.SimpleNamespace(returncode=1 if stop==stage else 0)
                def legacy_main():
                    calls.append(current())
                    if stop=='legacy-sdk-capture':raise ValueError('SDK reconstruction host/scratch capacity unavailable')
                legacy=types.SimpleNamespace(__file__='fixed-sdk.py',main=legacy_main,codec=types.SimpleNamespace(IMAGE='fixed-image'),
                  h=types.SimpleNamespace(verify_repository=lambda *args:None,admit_host_node=lambda *args:{'path':'/fixed/node'}))
                def verify(*args):calls.append(current());return self.facts()
                env={'RUNNER_TEMP':str(root),'GITHUB_WORKSPACE':str(ROOT),'GITHUB_SHA':HEAD,'CHECKTRAIL_HOST_NODE':'{}'}
                with mock.patch.dict(os.environ,env),mock.patch.object(m.os,'getuid',return_value=0),\
                     mock.patch.object(m,'load',side_effect=lambda name:legacy if name=='gcc-hosted-sdk.py' else object()),\
                     mock.patch.object(m.subprocess,'run',side_effect=run),mock.patch.object(m,'verify_on_host',side_effect=verify):
                    value=m.guarded(lambda:m.fixed_work(private),private,HEAD)
                self.assertEqual(value['diagnostics']['stage'],expected)
                ordered=['image-acquisition','common-input-acquisition','gcc-input-acquisition','legacy-sdk-capture','independent-verification']
                self.assertEqual(calls,ordered if stop=='none' else ordered[:ordered.index(stop)+1])
                self.assertEqual(value['sdkVerifiedOnHost'],stop=='none')
                if stop=='legacy-sdk-capture':
                    self.assertEqual(value['diagnostics']['refusalId'],'sdk-host-capacity')
                    self.assertEqual(value['diagnostics']['exceptionType'],'value-error')
                    self.assertIsNone(value['sdkContainerExitCode'])

    def test_exact_known_refusals_are_whole_literals_and_cannot_be_borrowed_by_suffix_prefix_or_subclass(self):
        class SyntheticValueError(ValueError):pass
        message='SDK reconstruction host/scratch capacity unavailable'
        for error,expected,kind in [(ValueError(message),'sdk-host-capacity','value-error'),
                                    (ValueError(message+' '+RAW),'unclassified','value-error'),
                                    (ValueError(RAW+' '+message),'unclassified','value-error'),
                                    (ValueError(message.lower()),'unclassified','value-error'),
                                    (SyntheticValueError(message),'unclassified','other')]:
            with self.subTest(expected=expected,kind=kind):
                def fail(private):
                    m.record_stage(private,'legacy-sdk-capture')
                    try:raise error
                    except BaseException as cause:raise m.Refusal('sdk-incomplete') from cause
                _,code,_,value,body=self.run_entry(fail)
                self.assertEqual(code,1);self.assertFalse(value['sdkVerifiedOnHost'])
                self.assertEqual(value['diagnostics']['refusalId'],expected)
                self.assertEqual(value['diagnostics']['exceptionType'],kind)
                self.assertEqual(value['diagnostics']['errorSha256'],m.hashlib.sha256(str(error).encode()).hexdigest())
                self.assertNotIn(message.encode(),body);self.assertNotIn(type(error).__name__.encode(),body)
                self.assertIsNone(value['sdkContainerExitCode']);self.assertIsNone(value['sdkContainerSeconds'])

    def test_all_exported_refusal_identifiers_are_grounded_in_exact_current_firstparty_guard_literals(self):
        literals=set()
        for filename in ['gcc-hosted-sdk.py','gcc-hosted-carrier.py','gcc-hosted-capacity.py']:
            tree=ast.parse((ROOT/'scripts/producer-qualification'/filename).read_bytes())
            for node in ast.walk(tree):
                if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id=='require' and len(node.args)>1:
                    argument=node.args[1]
                    if isinstance(argument,ast.Constant) and type(argument.value) is str:literals.add(argument.value)
        self.assertTrue(m.REFUSALS);self.assertLessEqual(set(m.REFUSALS),literals)
        self.assertEqual(len(m.REFUSALS),len(set(m.REFUSALS.values())))

    def test_last_legacy_milestone_is_only_a_recorded_fact_and_never_original_terminal_or_execution_credit(self):
        fields=[({},'not-observed'),({'source':{}},'source-recorded'),({'source':{},'predecessorCache':{}},'predecessor-cache-recorded'),
                ({'source':{},'readOnlyKeyring':{}},'keyring-recorded'),({'image':{}},'image-recorded'),
                ({'image':{},'ownedSeedCleanup':'removed'},'seed-cleanup-recorded'),
                ({'state':'sdk-material-reconstruction-observed-no-gcc-target-run'},'material-reconstruction-recorded')]
        for carrier,expected in fields:
            with self.subTest(expected=expected):
                def fail(private):
                    m.record_stage(private,'legacy-sdk-capture')
                    output=private.parent/'gcc-sdk-reconstruction';output.mkdir()
                    (output/'SDK-CARRIER.json').write_bytes(m.canonical({**carrier,'error':RAW,'cleanupError':RAW2}))
                    raise m.Refusal('sdk-incomplete')
                _,code,_,value,body=self.run_entry(fail)
                self.assertEqual(code,1);self.assertEqual(value['diagnostics']['lastLegacyMilestone'],expected)
                self.assertFalse(value['sdkVerifiedOnHost']);self.assertFalse(value['sdkContainerQuiescent'])
                self.assertIsNone(value['sdkContainerExitCode']);self.assertIsNone(value['sdkContainerSeconds'])
                self.assertNotIn(b'cleanupError',body)

    def test_unknown_broken_and_oversized_exception_messages_remain_closed_and_never_echo_class_or_raw_body(self):
        class RawNamedError(Exception):
            def __str__(self):raise RuntimeError(RAW)
        for error in [RawNamedError(),RuntimeError(RAW+' /original/private/path'),RuntimeError(RAW*70000)]:
            with self.subTest(kind=type(error).__name__):
                def fail(private):raise error
                _,code,_,value,body=self.run_entry(fail)
                self.assertEqual(code,1);self.assertFalse(value['sdkVerifiedOnHost'])
                self.assertEqual(value['diagnostics']['refusalId'],'unclassified')
                if type(error) is RawNamedError:self.assertEqual(value['diagnostics']['exceptionType'],'other')
                if type(error) is RawNamedError or len(str(error))>65536:self.assertIsNone(value['diagnostics']['errorSha256'])
                self.assertNotIn(b'RawNamedError',body);self.assertNotIn(b'/original/private/path',body)

    def test_unknown_raw_or_corrupt_stage_and_legacy_witness_cannot_escape_or_grant_completion(self):
        for kind in ['unknown-stage','extra-stage-field','raw-carrier','non-dict-carrier','symlink-carrier']:
            with self.subTest(kind=kind):
                def fail(private):
                    if kind in ['unknown-stage','extra-stage-field']:
                        (private/'CLOSED-STAGE.json').write_bytes(m.canonical({'stage':RAW} if kind=='unknown-stage' else {'stage':'legacy-sdk-capture','raw':RAW2}))
                    else:
                        m.record_stage(private,'legacy-sdk-capture');output=private.parent/'gcc-sdk-reconstruction';output.mkdir()
                        path=output/'SDK-CARRIER.json'
                        if kind=='raw-carrier':path.write_text(RAW)
                        elif kind=='non-dict-carrier':path.write_bytes(m.canonical([RAW]))
                        else:
                            target=private/'synthetic-carrier';target.write_bytes(m.canonical({'source':{}}));path.symlink_to(target)
                    raise m.Refusal('sdk-incomplete')
                _,code,_,value,_=self.run_entry(fail)
                self.assertEqual(code,1);self.assertFalse(value['sdkVerifiedOnHost'])
                name='stage' if kind in ['unknown-stage','extra-stage-field'] else 'lastLegacyMilestone'
                self.assertEqual(value['diagnostics'][name],'unavailable')
                self.assertIsNone(value['sdkContainerExitCode'])

    def test_closed_diagnostic_schema_rejects_unknown_extra_boolean_and_raw_fields_without_success_near_match(self):
        _,_,_,good,_=self.run_entry(self.noisy)
        for key,bad in [('stage',RAW),('stage',True),('lastLegacyMilestone',RAW),('exceptionType',RAW),
                        ('refusalId',RAW),('errorSha256','/original/'+RAW)]:
            with self.subTest(key=key):
                value=copy.deepcopy(good);value['diagnostics'][key]=bad
                with self.assertRaises((m.Refusal,TypeError)):m.validate_receipt(value)
        def fail(private):raise RuntimeError(RAW)
        _,_,_,failed,_=self.run_entry(fail)
        for original in [good,failed]:
            value=copy.deepcopy(original);value['diagnostics']['raw']=RAW
            with self.assertRaises(m.Refusal):m.validate_receipt(value)
        value=copy.deepcopy(good);value['diagnostics']['stage']='legacy-sdk-capture'
        with self.assertRaises(m.Refusal):m.validate_receipt(value)

    def sdk_data(self):
        root=self.folder();values=list(fixture.fixture(root));packages=b'synthetic-a\t1\tamd64\nsynthetic-b\t1\tall\n'
        digest=m.hashlib.sha256(packages).hexdigest();values[2]['binding']['packageInventorySha256']=digest
        values[4]['originalPackageManifestSha256']=digest
        policy=json.loads((ROOT/'scripts/producer-qualification/gcc-sdk-receipt-policy.v1.json').read_bytes())
        values[3]['preparation']={'command':policy['originalOfflineAptCommand'],'state':'terminal','exitCode':0,'signal':None,'terminalObserved':True}
        output,unused=fixture.SdkHandoff().write_source(root,values)
        (output/'checkpoint').mkdir();(output/'checkpoint/CHECKPOINT-ROOT.json').write_bytes(m.canonical(values[2]))
        (output/'observations/installed-package-identities.txt').write_bytes(packages)
        (output/'native.log').write_text(RAW+'\n'+RAW2+'\n')
        carrier={'state':'sdk-material-reconstruction-observed-no-gcc-target-run','ownedContainerCleanup':'removed','ownedSeedCleanup':'removed',
                 'originalGccTargetInvoked':False,'originalPhaseAdvanced':False,'observed':{'quiescenceObserved':True,'nativeSeconds':71.5,
                 'containerState':{'Running':False,'Pid':0,'Status':'exited','ExitCode':0,'OOMKilled':False,'Error':''}}}
        (output/'SDK-CARRIER.json').write_bytes(m.canonical(carrier));private=root/'private';private.mkdir()
        return root,output,private,policy,values

    def test_independent_on_host_reader_validates_real_synthetic_sdk_family_without_exposing_rows_names_or_logs(self):
        root,output,private,policy,values=self.sdk_data()
        facts=m.verify_on_host(output,private,policy,fixture.m)
        self.assertEqual(facts['counts']['packages'],2);self.assertEqual(facts['counts']['generatedOutputs'],51);self.assertEqual(facts['counts']['formats'],13)
        self.assertEqual(facts['sdkContainerSeconds'],71.5)
        self.assertTrue((private/'independent-sdk-controls/prepared-sdk/PREPARED-SDK-INVENTORY.json.gz').is_file())
        serialized=m.canonical(facts)
        for raw in [RAW.encode(),RAW2.encode(),b'/var/cache/',b'synthetic-a',b'generatorCommands']:self.assertNotIn(raw,serialized)
        self.assertEqual(set(facts['hashes']),m.HASHES)

    def test_real_sdk_software_generator_engine_package_terminal_and_cleanup_near_misses_refuse_locally(self):
        for kind in ['engine','software','package','apt-terminal','container-terminal','cleanup']:
            with self.subTest(kind=kind):
                root,output,private,policy,values=self.sdk_data()
                if kind=='engine':
                    name=output/'observations/SDK-DERIVED-GENERATION.json';value=json.loads(name.read_bytes())
                    next(iter(value['effectiveMapping'].values()))['engine']='wrong-original-engine';name.write_bytes(m.canonical(value))
                elif kind=='software':
                    name=output/'predecessor/__carrier_work/external-sdk-before.json';value=json.loads(name.read_bytes());value['entries'][0]['mode']^=1;name.write_bytes(m.canonical(value))
                elif kind=='package':(output/'observations/installed-package-identities.txt').write_text('wrong-package\n')
                elif kind=='apt-terminal':
                    name=output/'observations/SDK-RECONSTRUCTION.json';value=json.loads(name.read_bytes());value['preparation']['exitCode']=2;name.write_bytes(m.canonical(value))
                else:
                    name=output/'SDK-CARRIER.json';value=json.loads(name.read_bytes())
                    if kind=='container-terminal':value['observed']['containerState']['ExitCode']=2
                    else:value['ownedContainerCleanup']='unavailable'
                    name.write_bytes(m.canonical(value))
                with self.assertRaises((ValueError,m.Refusal)):m.verify_on_host(output,private,policy,fixture.m)

    def test_workflow_has_no_denied_export_body_channel_or_target_and_preserves_sdk_operator_and_source_limits(self):
        candidate=ROOT/'ci-sdk-onhost-receipt.yml'
        workflow=(candidate if candidate.exists() else ROOT/'.github/workflows/ci.yml').read_text()
        for token in ['export-diagnostics','upload-artifact','GITHUB_OUTPUT','GITHUB_STEP_SUMMARY','actions/cache/save','base64','native05','tee ']:
            self.assertNotIn(token,workflow)
        self.assertIn('actions/cache/restore@55cc8345',workflow);self.assertIn('runs-on: ubuntu-26.04',workflow)
        self.assertIn('timeout-minutes: 360',workflow);self.assertIn('qualify-on-host --operator-trust-execution',workflow)
        policy=json.loads((ROOT/'scripts/producer-qualification/gcc-sdk-receipt-policy.v1.json').read_bytes())
        self.assertEqual(policy['sdkBodySeconds'],1200);self.assertEqual(policy['receiptBytes'],16384)
        self.assertEqual(policy['originalOfflineAptCommand'],values_command())
        self.assertTrue(policy['freshApprovalReviewRequired']);self.assertFalse(policy['native05Authorized'])


def values_command():
    return ['apt-get','-o','APT::Get::AllowUnauthenticated=false','-o','Acquire::AllowInsecureRepositories=false','-o',
            'Acquire::AllowDowngradeToInsecureRepositories=false','-o','Acquire::Check-Valid-Until=true','-o',
            'Dir::Cache::archives=/var/cache/apt/archives/gcc-12','--yes','--no-download','--no-install-recommends','build-dep',
            '/inputs/gcc-12/gcc-12_12.2.0-14+deb12u1.dsc']


class Composition(unittest.TestCase):
 def test_previous_receipt_job_refuses_actual_legacy_context_after_real_argparse_accepts_rebound_argv(self):
  self.check_entry('gcc-sdk-onhost','Wrong fixed carrier job')
 def test_exact_original_job_is_valid_near_miss_that_reaches_next_real_host_guard_not_an_sdk_success(self):
  self.check_entry('gcc-staged-first','Native Linux AMD64 host required')
 def check_entry(self,job,expected):
  legacy=load(ROOT/'scripts/producer-qualification/gcc-hosted-sdk.py')
  with tempfile.TemporaryDirectory(prefix='gcc-real-entry-synthetic-') as name:
   root=Path(name).resolve();private=root/'private';private.mkdir();(private/'opaque-wrapper-output.log').write_bytes(b'')
   env={'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','RUNNER_OS':'Linux','RUNNER_ARCH':'X64',
    'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REPOSITORY':'stsepelin/checktrail',
    'GITHUB_REF':'refs/heads/diagnostic/gcc-phase0-original-1117','GITHUB_SHA':'a'*40,'GITHUB_RUN_ID':'1',
    'GITHUB_RUN_ATTEMPT':'1','GITHUB_JOB':job,'RUNNER_TEMP':str(root),'GITHUB_WORKSPACE':str(ROOT),'CHECKTRAIL_HOST_NODE':'{}'}
   outer=['outer-receipt','qualify-on-host','--operator-trust-execution']
   with mock.patch.dict(os.environ,env),mock.patch.object(sys,'argv',outer.copy()),mock.patch.object(m.os,'getuid',return_value=0),\
        mock.patch.object(m,'load',side_effect=lambda name:legacy if name=='gcc-hosted-sdk.py' else object()),\
        mock.patch.object(legacy.h,'verify_repository',return_value={}),\
        mock.patch.object(legacy.h,'admit_host_node',return_value={'path':'/fixed/synthetic-node'}),\
        mock.patch.object(legacy.h.capacity.base.platform,'system',return_value='SyntheticHost'),\
        mock.patch.object(legacy.h,'docker',side_effect=AssertionError('Docker reached')) as docker,\
        mock.patch.object(m.subprocess,'run',return_value=types.SimpleNamespace(returncode=0)) as commands:
    with self.assertRaises(m.Refusal) as caught:m.fixed_work(private)
    self.assertEqual(caught.exception.identifier,'sdk-incomplete')
    self.assertIs(type(caught.exception.__cause__),ValueError);self.assertEqual(str(caught.exception.__cause__),expected)
    self.assertEqual(sys.argv,outer);self.assertEqual(commands.call_count,3);docker.assert_not_called()
   carrier=json.loads((root/'gcc-sdk-reconstruction/SDK-CARRIER.json').read_bytes())
   self.assertEqual(carrier['error'],expected);self.assertNotIn('source',carrier);self.assertNotIn('observed',carrier)
   actual=json.loads((private/'OWNED-SDK-ATTEMPT.json').read_bytes())
   self.assertIsNone(actual['sdkContainerExitCode']);self.assertIsNone(actual['sdkContainerSeconds'])
   self.assertFalse(actual['sdkContainerQuiescent'])
 def service_data(self):
  capacity=load(ROOT/'scripts/producer-qualification/gcc-hosted-capacity.py')
  env={'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','RUNNER_OS':'Linux','RUNNER_ARCH':'X64',
   'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REPOSITORY':'stsepelin/checktrail',
   'GITHUB_REF':'refs/heads/diagnostic/gcc-phase0-original-1117','GITHUB_SHA':'a'*40,'GITHUB_RUN_ID':'1',
   'GITHUB_RUN_ATTEMPT':'1','GITHUB_JOB':'gcc-staged-first'}
  selected=capacity.context(env);repository={'full_name':'stsepelin/checktrail','private':False}
  run={'id':1,'run_attempt':1,'head_sha':'a'*40,'event':'workflow_dispatch','workflow_id':363121286,
       'head_branch':'diagnostic/gcc-phase0-original-1117'}
  jobs={'total_count':1,'jobs':[{'id':2,'name':'gcc-staged-first','status':'in_progress','conclusion':None,
    'run_id':1,'labels':['ubuntu-26.04'],'started_at':'2026-11-18T10:00:00Z'}]}
  capture={'serviceDate':'2026-11-18T10:00:10+00:00','requestSeconds':0.25}
  return capacity,env,selected,repository,run,jobs,capture
 def test_current_workflow_key_and_implicit_display_name_pass_entire_original_context_and_service_clock_contract(self):
  path=ROOT/'ci-sdk-onhost-receipt.yml';workflow=(path if path.exists() else ROOT/'.github/workflows/ci.yml').read_text()
  jobs_body=workflow.split('jobs:\n',1)[1]
  self.assertEqual([line for line in jobs_body.splitlines() if m.re.fullmatch(r'  [A-Za-z0-9_-]+:',line)],['  gcc-staged-first:'])
  self.assertFalse(any(line.startswith('    name:') for line in jobs_body.splitlines()))
  capacity,env,selected,repository,run,jobs,capture=self.service_data()
  self.assertEqual(env['GITHUB_JOB'],capacity.JOB);self.assertEqual(jobs['jobs'][0]['name'],capacity.JOB)
  result=capacity.service_clock(selected,repository,run,jobs,capture)
  self.assertEqual(result['jobId'],2);self.assertEqual(result['remainingSeconds'],21600-12.25)
  self.assertTrue(result['includesCheckoutPreparationCaptureUploadFinalization'])
 def test_every_original_context_and_service_clock_guard_refuses_causal_wrong_job_source_runner_and_clock_near_misses(self):
  capacity,env,selected,repository,run,jobs,capture=self.service_data()
  for kind,expected in [('job','Wrong fixed carrier job'),('fixed-context','Wrong fixed public hosted context'),
      ('ref','Native continuation requires an explicit diagnostic branch'),('head','Invalid reviewed checkout SHA'),
      ('attempt','Invalid source run/attempt')]:
   bad=dict(env)
   if kind=='job':bad['GITHUB_JOB']='gcc-sdk-onhost'
   elif kind=='fixed-context':bad['GITHUB_REPOSITORY']='other/checktrail'
   elif kind=='ref':bad['GITHUB_REF']='refs/heads/main'
   elif kind=='head':bad['GITHUB_SHA']='a'*39
   else:bad['GITHUB_RUN_ATTEMPT']='0'
   with self.subTest(context=kind),self.assertRaisesRegex(ValueError,'^'+m.re.escape(expected)+'$'):capacity.context(bad)
  for kind,expected in [('configuration','Invalid configured source-job timeout'),
      ('repository','Paid/private source repository not admitted'),('run','Service run differs from reviewed manual diagnostic checkout'),
      ('inventory','Incomplete service job inventory'),('job-name','Ambiguous carrier job identity'),
      ('job-suffix','Ambiguous carrier job identity'),('duplicate','Ambiguous carrier job identity'),
      ('runner','Unknown stock Ubuntu 26.04 service job'),('job-run','Unknown stock Ubuntu 26.04 service job'),
      ('clock','Source hosted job deadline exhausted or in future')]:
   r,j,c=copy.deepcopy(repository),copy.deepcopy(jobs),copy.deepcopy(capture);source=copy.deepcopy(run);seconds=21600
   if kind=='configuration':seconds=21601
   elif kind=='repository':r['private']=True
   elif kind=='run':source['workflow_id']=363121287
   elif kind=='inventory':j['total_count']=0
   elif kind=='job-name':j['jobs'][0]['name']='gcc-sdk-onhost'
   elif kind=='job-suffix':j['jobs'][0]['name']='gcc-staged-first-suffix'
   elif kind=='duplicate':j['jobs'].append(copy.deepcopy(j['jobs'][0]));j['total_count']=2
   elif kind=='runner':j['jobs'][0]['labels']=['ubuntu-24.04']
   elif kind=='job-run':j['jobs'][0]['run_id']=2
   else:c['serviceDate']='2026-11-18T09:59:00+00:00'
   with self.subTest(service=kind),self.assertRaisesRegex(ValueError,'^'+m.re.escape(expected)+'$'):
    capacity.service_clock(selected,r,source,j,c,configured_job_seconds=seconds)


if __name__=='__main__':unittest.main()
