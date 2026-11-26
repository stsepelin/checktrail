"""Synthetic SDK DATA and real FD/child-output barriers; no SDK/native effects."""
import contextlib
import copy
import ast
import hashlib
import importlib.util
import json
import marshal
import os
import re
from pathlib import Path
import shutil
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


@contextlib.contextmanager
def private_staging(root):
    """Stage verified runtime files under this test's own directory and remove them after."""
    with mock.patch.object(m,'STAGING_PARENT',str(root)),mock.patch.dict(m.VERIFIED),mock.patch.object(sys,'pycache_prefix',sys.pycache_prefix):
        try:yield
        finally:m.remove_staged()
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
                     mock.patch.object(m,'fixed_work',side_effect=work) as called,mock.patch.dict(m.ADMISSION),\
                     mock.patch.object(sys,'pycache_prefix',sys.pycache_prefix):
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

    def test_staging_cleanup_failure_is_a_closed_failure_receipt_with_the_observed_terminal(self):
        with mock.patch.object(m,'remove_staged',side_effect=OSError(16,'Synthetic busy staged copy 137')):
            root,code,calls,value,_=self.run_entry(lambda _:self.facts())
        self.assertEqual((code,calls),(1,1));self.assertFalse(value['sdkVerifiedOnHost'])
        self.assertEqual(value['errorId'],'cleanup-unconfirmed')
        self.assertEqual((value['sdkContainerExitCode'],value['sdkContainerSeconds']),(0,71.5))
        root,code,_,value,_=self.run_entry(lambda _:self.facts())
        self.assertEqual((code,value['errorId'],value['sdkVerifiedOnHost']),(0,'none',True))

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

    def test_each_receipt_decoder_admits_only_its_own_exact_policy_revision(self):
        root,_,_,good,_=self.run_entry(self.noisy)
        current='1e8fe16ba8192347186097b7bc331bb3ae1d5dbf480ae138723a2610642604a8'
        v5='53e78d4937950c42fdddbcccacbb37b49b84d881ebd16e0f6397b69bad5232e9'
        v4='d3d3df6c5ab0a92b99cd847444750e80f50c5959a42ed4462cce73d9f58d1c58'
        self.assertEqual(m.POLICY_SHA256,current);self.assertEqual(good['sourcePolicySha256'],current)
        decoders={current:m.validate_receipt,v5:m.validate_historical_v5_receipt,v4:m.validate_historical_v4_receipt}
        # Earlier v6 amendments never authorized a run, so no receipt or
        # checkpoint carries their digests and no decoder keeps them.
        retired=['ad97aef6fd05beca69e27b2ff035c36e04a92c6695c93e83d86d7f9c451cce77','d60c7df439f79aa27cf1629a12a24d6f5044cf48b65a488ddbd1e10de6e94089','3a044fbbd5438560506c2649628bbd855bafc539d1c0a05bb23635e82eedc923','30640bb6878c88f8c145ffe7e4b51eea990661a04a05e28a31d5d91e365eb261','1bef0675ee6055195f264ac5d7997b05429b01402b580826f4ed7dd897500bd6','df094a9cc0e7bef188a0d2605befa076b03e1a217f36032191ac360f69a8706f','dc7a556360a766ed2e4ec899b035a6f81f679ac39ff4526b2084f4bee8ad4b1b']
        self.assertNotIn(current,retired)
        for digest in retired:
            for decode in decoders.values():
                with self.subTest(retired=digest),self.assertRaises(m.Refusal):decode({**good,'sourcePolicySha256':digest})
        for policy in decoders:
            for admitted,decode in decoders.items():
                value={**good,'sourcePolicySha256':policy}
                with self.subTest(policy=policy,decoder=admitted):
                    if policy==admitted:self.assertEqual(decode(value)['sourcePolicySha256'],policy)
                    else:
                        with self.assertRaises(m.Refusal):decode(value)

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
                     mock.patch.object(m,'verify_checkout'),mock.patch.dict(m.ADMISSION),\
                     mock.patch.object(m.subprocess,'run',side_effect=run),mock.patch.object(m,'verify_on_host',side_effect=verify),\
                     private_staging(root):
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
        mock.patch.object(m,'verify_checkout'),mock.patch.dict(m.ADMISSION),mock.patch.object(legacy.h,'verify_repository',return_value={}),\
        mock.patch.object(legacy.h,'admit_host_node',return_value={'path':'/fixed/synthetic-node'}),\
        mock.patch.object(legacy.h.capacity.base.platform,'system',return_value='SyntheticHost'),\
        mock.patch.object(legacy.h,'docker',side_effect=AssertionError('Docker reached')) as docker,\
        mock.patch.object(m.subprocess,'run',return_value=types.SimpleNamespace(returncode=0)) as commands,private_staging(root):
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



MARKER_CODE="\nimport pathlib as _synthetic_pathlib\n_synthetic_pathlib.Path({marker!r}).write_text('sibling-module-code-ran-137')\n"
DRIVER='''import importlib.util,os,sys
spec=importlib.util.spec_from_file_location('copied_receipt',sys.argv[1]);m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
os.getuid=lambda:0
sys.argv=['helper','qualify-on-host','--operator-trust-execution'];raise SystemExit(m.entry())
'''


class SiblingAdmission(unittest.TestCase):
 """The operator entry runs no sibling module code before its pin is checked."""
 def checkout(self,sibling,*,pinned):
  """pinned: True re-pins the changed bytes; 'stale-hash' pins only their new size;
  'stale-cache' keeps the pinned source and plants matching-header bytecode beside it."""
  temporary=tempfile.TemporaryDirectory(prefix='gcc-receipt-admission-');self.addCleanup(temporary.cleanup)
  base=Path(temporary.name).resolve();copy=base/'checkout';marker=base/'sibling-imported.marker'
  policy_rel='scripts/producer-qualification/gcc-sdk-receipt-policy.v1.json';receipt_rel='scripts/producer-qualification/gcc-sdk-onhost-receipt.py'
  policy=json.loads((ROOT/policy_rel).read_bytes())
  for name in [policy_rel,receipt_rel,*[row['path'] for row in policy['runtimeFiles']]]:
   target=copy/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(ROOT/name,target)
  changed=copy/'scripts/producer-qualification'/sibling;before=changed.read_bytes()
  if pinned=='stale-cache':
   # An untracked cache whose header matches the source's mtime and size is
   # what the default loader would execute instead of the verified source.
   info=changed.stat();code=compile(before+MARKER_CODE.format(marker=str(marker)).encode(),str(changed),'exec')
   cache=Path(importlib.util.cache_from_source(str(changed)));cache.parent.mkdir(exist_ok=True)
   cache.write_bytes(importlib.util.MAGIC_NUMBER+(0).to_bytes(4,'little')+(int(info.st_mtime)&0xFFFFFFFF).to_bytes(4,'little')+
                     (info.st_size&0xFFFFFFFF).to_bytes(4,'little')+marshal.dumps(code))
   self.assertEqual(changed.read_bytes(),before)
  else:
   changed.write_bytes(before+MARKER_CODE.format(marker=str(marker)).encode());self.assertNotEqual(changed.read_bytes(),before)
  if pinned in (True,'stale-hash'):
   # The valid near miss: the operator re-pins exactly these bytes and freezes that policy.
   row=next(row for row in policy['runtimeFiles'] if row['path'].endswith('/'+sibling))
   body=changed.read_bytes();row.update(bytes=len(body))
   if pinned is True:row.update(sha256=hashlib.sha256(body).hexdigest())
   raw=json.dumps(policy,indent=2,sort_keys=True).encode()+b'\n';(copy/policy_rel).write_bytes(raw)
   source=(copy/receipt_rel).read_text();updated=source.replace(m.POLICY_SHA256,hashlib.sha256(raw).hexdigest())
   self.assertNotEqual(updated,source);(copy/receipt_rel).write_text(updated)
  env={'HOME':str(base),'GIT_CONFIG_NOSYSTEM':'1','PATH':'/usr/bin:/bin'}
  git=['/usr/bin/git','-c','user.name=synthetic','-c','user.email=synthetic@invalid','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false']
  for command in [['init','-q'],['add','-A'],['commit','-q','-m','synthetic checkout']]:
   subprocess.run([*git,*command],cwd=copy,env=env,check=True,capture_output=True,timeout=60)
  head=subprocess.run([*git,'rev-parse','HEAD'],cwd=copy,env=env,check=True,capture_output=True,timeout=10).stdout.decode().strip()
  return base,copy,marker,head
 def entry(self,base,copy,head):
  temp=base/'runner-temp';temp.mkdir()
  env={'RUNNER_TEMP':str(temp),'GITHUB_WORKSPACE':str(copy),'GITHUB_SHA':head,'CHECKTRAIL_HOST_NODE':'{}','PATH':'/usr/bin:/bin'}
  completed=subprocess.run([sys.executable,'-I','-B','-c',DRIVER,str(copy/'scripts/producer-qualification/gcc-sdk-onhost-receipt.py')],
                           env=env,capture_output=True,timeout=120)
  self.assertEqual(completed.stderr,b'');self.assertTrue(completed.stdout.startswith(m.PREFIX),completed.stdout[:200])
  return completed.returncode,json.loads(completed.stdout[len(m.PREFIX):])
 def test_changed_sibling_is_refused_before_any_of_its_module_code_runs(self):
  # Direct (diagnostics) and transitive (carrier, loaded by the SDK helper) imports.
  for sibling,pinned in [('gcc-sdk-structured-diagnostics.py',False),('gcc-hosted-carrier.py',False),
                         ('gcc-sdk-structured-diagnostics.py','stale-hash'),('gcc-hosted-carrier.py','stale-hash')]:
   with self.subTest(sibling=sibling,pinned=pinned):
    base,copy,marker,head=self.checkout(sibling,pinned=pinned)
    code,value=self.entry(base,copy,head)
    self.assertEqual((code,value['errorId']),(1,'source-refused'));self.assertEqual(value['diagnostics']['stage'],'runtime-source-validation')
    self.assertFalse(marker.exists(),'Sibling module code ran before its pin was checked')
 def test_exactly_pinned_sibling_bytes_are_admitted_and_then_imported(self):
  for sibling in ['gcc-sdk-structured-diagnostics.py','gcc-hosted-carrier.py']:
   with self.subTest(sibling=sibling):
    base,copy,marker,head=self.checkout(sibling,pinned=True)
    code,value=self.entry(base,copy,head)
    self.assertEqual(code,1);self.assertNotEqual(value['errorId'],'source-refused')
    self.assertEqual(marker.read_text(),'sibling-module-code-ran-137')
 def test_pinned_source_is_executed_instead_of_an_adjacent_stale_bytecode_cache(self):
  for sibling in ['gcc-hosted-carrier.py','gcc-sdk-structured-diagnostics.py']:
   with self.subTest(sibling=sibling):
    base,copy,marker,head=self.checkout(sibling,pinned='stale-cache')
    cache=Path(importlib.util.cache_from_source(str(copy/'scripts/producer-qualification'/sibling)));self.assertTrue(cache.is_file())
    code,value=self.entry(base,copy,head)
    self.assertEqual(code,1);self.assertNotEqual(value['errorId'],'source-refused')
    self.assertFalse(marker.exists(),'A bytecode cache ran instead of the pinned source')
 def test_planted_cache_is_what_the_default_loader_would_execute(self):
  # Harness check: without the receipt's cache prefix the planted bytes do run.
  base,copy,marker,head=self.checkout('gcc-hosted-carrier.py',pinned='stale-cache')
  path=copy/'scripts/producer-qualification/gcc-hosted-carrier.py'
  completed=subprocess.run([sys.executable,'-I','-B','-c','import importlib.util,sys;s=importlib.util.spec_from_file_location("c",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)',str(path)],
                           capture_output=True,timeout=60)
  self.assertEqual(completed.returncode,0,completed.stderr[-2000:]);self.assertEqual(marker.read_text(),'sibling-module-code-ran-137')
 def test_dirty_or_different_checkout_is_refused_before_any_sibling_loads(self):
  for kind in ['dirty','other-head']:
   with self.subTest(kind=kind):
    base,copy,marker,head=self.checkout('gcc-hosted-carrier.py',pinned=True)
    if kind=='dirty':
     path=copy/'scripts/producer-qualification/gcc-staged-plan.py';path.write_bytes(path.read_bytes()+b'# synthetic-dirty-137\n')
    code,value=self.entry(base,copy,head if kind=='dirty' else 'c'*40)
    self.assertEqual(value['errorId'],'source-refused');self.assertFalse(marker.exists())
 def test_every_loaded_or_executed_sibling_is_a_runtime_file_row(self):
  def python_references(path):
   found=set()
   for node in ast.walk(ast.parse(path.read_bytes())):
    if isinstance(node,ast.Constant) and type(node.value) is str and node.value.endswith(('.py','.mjs')) and not node.value.startswith('/'):
     for candidate in [path.parent/node.value,ROOT/node.value]:
      if candidate.is_file():found.add(candidate.resolve().relative_to(ROOT).as_posix())
   return found
  def module_references(path):
   found=set()
   for specifier in re.findall(r"""(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}/[^"']+)["']""",path.read_text()):
    found.add((path.parent/specifier).resolve().relative_to(ROOT).as_posix())
   return found
  # Python sibling loads, files run by node, and their relative ES imports.
  start='scripts/producer-qualification/gcc-sdk-onhost-receipt.py';closure=set();pending=[start]
  while pending:
   current=pending.pop();path=ROOT/current
   found=python_references(path) if current.endswith('.py') else module_references(path)
   for reference in found-closure-{start}:closure.add(reference);pending.append(reference)
  pinned={row['path'] for row in json.loads((ROOT/'scripts/producer-qualification/gcc-sdk-receipt-policy.v1.json').read_bytes())['runtimeFiles']}
  self.assertEqual(sorted(closure-pinned),[],'A loaded or executed first-party file has no runtimeFiles pin')
  self.assertEqual(len(set(m.RUNTIME_SIBLINGS)),len(m.RUNTIME_SIBLINGS))
  self.assertLessEqual(set(m.RUNTIME_SIBLINGS),closure);self.assertLessEqual(set(m.RUNTIME_SIBLINGS),pinned)
  for expected in ['scripts/producer-qualification/gcc-sdk-structured-diagnostics.py','scripts/producer-qualification/binutils-image-identity.mjs',
                   'scripts/qualify-binutils-producer.mjs','scripts/producer-qualification/c-producer-profile.mjs']:
   self.assertIn(expected,closure)
 def test_every_file_the_staged_node_code_names_beside_itself_is_pinned(self):
  # The acquisition runs from the private verified copy, so any sibling file it
  # reads, copies or executes by a relative name must have been verified too.
  policy=json.loads((ROOT/'scripts/producer-qualification/gcc-sdk-receipt-policy.v1.json').read_bytes())
  pinned={row['path'] for row in policy['runtimeFiles']};named=set()
  for relative in sorted(path for path in pinned if path.endswith('.mjs')):
   path=ROOT/relative
   for literal in re.findall(r"""["'`]([A-Za-z0-9_./-]+\.(?:json|py|sh|mjs|mk|txt|js))["'`]""",path.read_text()):
    if literal.startswith('/'):continue
    for folder in [path.parent,path.parent/'producer-qualification']:
     candidate=(folder/literal).resolve()
     if candidate.is_file() and ROOT in candidate.parents:named.add(candidate.relative_to(ROOT).as_posix())
  self.assertIn('scripts/producer-qualification/binutils-prepare-inputs.py',named)
  self.assertEqual(sorted(named-pinned),[],'Staged Node code names an unpinned sibling file')
 def test_closure_scan_follows_relative_es_imports_and_ignores_bare_packages(self):
  pattern=r"""(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}/[^"']+)["']"""
  source='import a from "./synthetic-a-137.mjs";\nimport { b } from \'../synthetic-b.mjs\';\nawait import("./synthetic-c.mjs");\nimport fs from "node:fs";\nimport "./synthetic-side-effect.mjs";\n'
  self.assertEqual(re.findall(pattern,source),['./synthetic-a-137.mjs','../synthetic-b.mjs','./synthetic-c.mjs','./synthetic-side-effect.mjs'])
 def test_unobserved_structured_twin_is_the_decoder_empty_value_and_not_a_type_confusable_shortcut(self):
  decoder=m.structured_diagnostics()
  self.assertEqual(m.canonical(m.UNOBSERVED_STRUCTURED_SDK),m.canonical(decoder.empty()))
  self.assertEqual(decoder.validate(m.unobserved_structured()),m.UNOBSERVED_STRUCTURED_SDK)
  self.assertEqual(m.validate_structured(m.unobserved_structured()),m.UNOBSERVED_STRUCTURED_SDK)
  # 0 == False in Python; a value equal under == must still meet the full decoder.
  confused=m.unobserved_structured();confused['sdkQualifiedByProjection']=0
  self.assertEqual(confused,m.UNOBSERVED_STRUCTURED_SDK)
  with self.assertRaises(decoder.Bad):m.validate_structured(confused)
  observed=m.unobserved_structured();observed['state']='invalid';observed['errorId']='record-unavailable'
  self.assertEqual(m.validate_structured(observed)['state'],'invalid')

SWAP_DRIVER='''import importlib.util,json,os,pathlib,subprocess,sys,types
spec=importlib.util.spec_from_file_location('copied_receipt',sys.argv[1]);m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
os.getuid=lambda:0
config=json.loads(os.environ['SYNTHETIC_SWAP_CONFIG']);m.STAGING_PARENT=config['stagingParent']
report={'opened':[],'node':[],'policyOpens':0};armed=[False]
policy_path=os.path.normpath(os.path.join(os.path.dirname(sys.argv[1]),'gcc-sdk-receipt-policy.v1.json'))
def audit(event,args):
 if event=='open' and isinstance(args[0],(str,bytes,os.PathLike)):
  path=os.path.normpath(os.fsdecode(args[0]))
  if path==policy_path and not armed[0]:report['policyOpens']+=1
  if armed[0]:report['opened'].append(path)
sys.addaudithook(audit)
real_verify=m.verify_runtime_files
def verify(repository,policy):
 value=real_verify(repository,policy)
 for relative,body in config['swap'].items():(repository/relative).write_bytes(body.encode())
 armed[0]=True;return value
m.verify_runtime_files=verify
real_stage=m.stage_verified
def stage(files):
 root=real_stage(files)
 if config.get('plantCache'):
  # Plant matching bytecode where a cache prefix under the runner-owned
  # private directory would look for the staged carrier.
  source=root/'scripts/producer-qualification/gcc-hosted-carrier.py';info=source.stat();staged_prefix=sys.pycache_prefix
  sys.pycache_prefix=config['plantCache']['prefix']
  try:cache=pathlib.Path(importlib.util.cache_from_source(str(source)))
  finally:sys.pycache_prefix=staged_prefix
  import marshal
  code=compile(source.read_bytes()+config['plantCache']['code'].encode(),str(source),'exec');cache.parent.mkdir(parents=True,exist_ok=True)
  cache.write_bytes(importlib.util.MAGIC_NUMBER+(0).to_bytes(4,'little')+(int(info.st_mtime)&0xFFFFFFFF).to_bytes(4,'little')+
                    (info.st_size&0xFFFFFFFF).to_bytes(4,'little')+marshal.dumps(code))
 return root
m.stage_verified=stage
real_run=subprocess.run
def run(command,**kwargs):
 if command[0]=='/usr/bin/docker':return types.SimpleNamespace(returncode=0)
 if str(command[1]).endswith('.mjs'):
  # Load the entry point and its whole import graph without its arguments:
  # the entry refuses its usage after every import has been evaluated.
  done=real_run([command[0],command[1]],cwd=kwargs.get('cwd'),capture_output=True,timeout=120)
  report['node'].append({'script':command[1],'cwd':str(kwargs.get('cwd')),'code':done.returncode,'stderr':done.stderr.decode()[-400:]})
  return types.SimpleNamespace(returncode=0 if len(report['node'])<=config.get('nodeSuccesses',0) else 1)
 return real_run(command,**kwargs)
subprocess.run=run
sys.argv=['helper','qualify-on-host','--operator-trust-execution'];code=m.entry()
armed[0]=False;pathlib.Path(config['report']).write_text(json.dumps(report));raise SystemExit(code)
'''
NODE_MARKER_CODE='\nimport {{ writeFileSync as synthetic137Write }} from "node:fs";\nsynthetic137Write({marker!r}, "node-import-ran-137");\n'


class VerifiedExecution(unittest.TestCase):
 """After admission the entry runs only the bytes it verified, never the checkout again."""
 PYTHON='scripts/producer-qualification/gcc-hosted-carrier.py'
 NODE='scripts/producer-qualification/binutils-image-identity.mjs'
 POLICY='scripts/producer-qualification/gcc-sdk-receipt-policy.v1.json'
 RECEIPT='scripts/producer-qualification/gcc-sdk-onhost-receipt.py'
 def checkout(self,pinned_markers=False):
  temporary=tempfile.TemporaryDirectory(prefix='gcc-receipt-verified-');self.addCleanup(temporary.cleanup)
  base=Path(temporary.name).resolve();copy=base/'checkout';markers={'python':base/'python-helper-ran.marker','node':base/'node-import-ran.marker'}
  policy=json.loads((ROOT/self.POLICY).read_bytes())
  for name in [self.POLICY,self.RECEIPT,*[row['path'] for row in policy['runtimeFiles']]]:
   target=copy/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(ROOT/name,target)
  if pinned_markers:
   # The valid near miss: marker code that the operator pinned does run, from
   # the verified copy, which proves this harness observes both runtimes.
   for relative,code in [(self.PYTHON,MARKER_CODE.format(marker=str(markers['python']))),(self.NODE,NODE_MARKER_CODE.format(marker=str(markers['node'])))]:
    path=copy/relative;path.write_bytes(path.read_bytes()+code.encode())
    row=next(row for row in policy['runtimeFiles'] if row['path']==relative);body=path.read_bytes()
    row.update(bytes=len(body),sha256=hashlib.sha256(body).hexdigest())
   raw=json.dumps(policy,indent=2,sort_keys=True).encode()+b'\n';(copy/self.POLICY).write_bytes(raw)
   source=(copy/self.RECEIPT).read_text();(copy/self.RECEIPT).write_text(source.replace(m.POLICY_SHA256,hashlib.sha256(raw).hexdigest()))
  env={'HOME':str(base),'GIT_CONFIG_NOSYSTEM':'1','PATH':'/usr/bin:/bin'}
  git=['/usr/bin/git','-c','user.name=synthetic','-c','user.email=synthetic@invalid','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false']
  for command in [['init','-q'],['add','-A'],['commit','-q','-m','synthetic checkout']]:
   subprocess.run([*git,*command],cwd=copy,env=env,check=True,capture_output=True,timeout=60)
  head=subprocess.run([*git,'rev-parse','HEAD'],cwd=copy,env=env,check=True,capture_output=True,timeout=10).stdout.decode().strip()
  return base,copy,markers,head
 def entry(self,base,copy,head,swap,**extra):
  temp=base/'runner-temp';temp.mkdir();staging=base/'staging';staging.mkdir(mode=0o700);report=base/'report.json'
  record=CheckoutGitConfig.carrier_cases.node_record()
  env={'RUNNER_TEMP':str(temp),'GITHUB_WORKSPACE':str(copy),'GITHUB_SHA':head,'CHECKTRAIL_HOST_NODE':json.dumps(record),'PATH':'/usr/bin:/bin',
       'SYNTHETIC_SWAP_CONFIG':json.dumps({'swap':swap,'stagingParent':str(staging),'report':str(report),**extra})}
  completed=subprocess.run([sys.executable,'-I','-B','-c',SWAP_DRIVER,str(copy/self.RECEIPT)],env=env,capture_output=True,timeout=300)
  self.assertEqual(completed.stderr,b'');self.assertTrue(completed.stdout.startswith(m.PREFIX),completed.stdout[:200])
  value=json.loads(completed.stdout[len(m.PREFIX):]);observed=json.loads(report.read_text())
  # The run reached the first Node acquisition step after any synthetic
  # successes and stopped there.
  successes=extra.get('nodeSuccesses',0);stage=['common-input-acquisition','gcc-input-acquisition'][successes]
  self.assertEqual((value['errorId'],value['diagnostics']['stage']),('input-refused',stage))
  self.assertEqual(len(observed['node']),successes+1);self.assertEqual(list(staging.iterdir()),[],'The private verified copy was not removed')
  return value,observed
 def swaps(self,base,markers):
  helper=(ROOT/self.PYTHON).read_text()+MARKER_CODE.format(marker=str(markers['python']))
  imported=(ROOT/self.NODE).read_text()+NODE_MARKER_CODE.format(marker=str(markers['node']))
  return {self.PYTHON:helper,self.NODE:imported,self.POLICY:'{"synthetic":"policy swapped after verification 137"}\n'}
 def swapped_run(self,kind):
  base,copy,markers,head=self.checkout();swap=self.swaps(base,markers)[kind]
  value,observed=self.entry(base,copy,head,{kind:swap})
  # Every pinned file and the policy; the running entry's own source may still
  # be read for a local traceback, which executes nothing.
  pinned={str(copy/row['path']) for row in json.loads((ROOT/self.POLICY).read_bytes())['runtimeFiles']}|{str(copy/self.POLICY)}
  self.assertIn(str(copy/kind),pinned)
  run=observed['node'][0];self.assertEqual(run['code'],2,run);self.assertIn('AssertionError',run['stderr'])
  def not_reopened():
   self.assertFalse(run['script'].startswith(str(copy)+'/'),run)
   self.assertEqual([path for path in observed['opened'] if os.path.normpath(path) in pinned],[],'A verified file was reopened from the checkout')
  return markers,not_reopened
 def test_python_helper_swapped_after_verification_never_runs(self):
  markers,not_reopened=self.swapped_run(self.PYTHON)
  self.assertFalse(markers['python'].exists(),'A Python helper swapped after verification ran');not_reopened()
 def test_node_import_swapped_after_verification_never_runs(self):
  markers,not_reopened=self.swapped_run(self.NODE)
  self.assertFalse(markers['node'].exists(),'A Node import swapped after verification ran');not_reopened()
 def test_policy_swapped_after_verification_is_never_reopened(self):
  _,not_reopened=self.swapped_run(self.POLICY);not_reopened()
 def test_second_acquisition_entry_and_its_import_run_from_the_verified_copy(self):
  base,copy,markers,head=self.checkout();relative='scripts/producer-qualification/c-producer-profile.mjs'
  swapped=(ROOT/relative).read_text()+NODE_MARKER_CODE.format(marker=str(markers['node']))
  _,observed=self.entry(base,copy,head,{relative:swapped},nodeSuccesses=1)
  second=observed['node'][1];self.assertTrue(second['script'].endswith('/scripts/acquire-c-producer-inputs.mjs'),second)
  self.assertEqual(second['code'],2,second)
  self.assertFalse(markers['node'].exists(),'A Node import of the second entry swapped after verification ran')
  self.assertFalse(second['script'].startswith(str(copy)+'/'),second)
 def test_bytecode_beside_a_runner_owned_cache_prefix_is_never_read(self):
  base,copy,markers,head=self.checkout()
  prefix=str(base/'runner-temp/gcc-sdk-receipt-private/no-bytecode-cache')
  self.entry(base,copy,head,{},plantCache={'prefix':prefix,'code':MARKER_CODE.format(marker=str(markers['python']))})
  self.assertTrue(any(Path(prefix).rglob('*.pyc')),'The synthetic cache was not planted')
  self.assertFalse(markers['python'].exists(),'Planted bytecode ran instead of the verified source')
 def test_policy_is_opened_once_and_the_checked_bytes_are_parsed(self):
  base,copy,markers,head=self.checkout();_,observed=self.entry(base,copy,head,{})
  self.assertEqual(observed['policyOpens'],1)
 def test_pinned_marker_code_runs_from_the_verified_copy(self):
  base,copy,markers,head=self.checkout(pinned_markers=True)
  value,observed=self.entry(base,copy,head,{})
  self.assertEqual(markers['python'].read_text(),'sibling-module-code-ran-137')
  self.assertEqual(markers['node'].read_text(),'node-import-ran-137')
  self.assertEqual(observed['node'][0]['code'],2)


class CheckoutGitConfig(unittest.TestCase):
 """The stdlib-only checkout check refuses a repository whose own config
 names a program git could run, and agrees with git about which keys exist."""
 carrier_cases=load(ROOT/'test/gcc-hosted-carrier-cases.py')
 CORPUS=['[core]\n\trepositoryformatversion = 0\n\tbare = false\n[remote "origin"]\n\turl = https://example.invalid/x.git\n\tpartialclonefilter = blob:none\n',
         '[filter "synthetic"]\n\tclean = /bin/false\n','[Filter.Synthetic]\n\tSMUDGE = /bin/false\n','[filter.outer "inner"] process = /bin/false\n',
         '[diff "synthetic"]\n\txfuncname = "^x ; [filter]"\n\ttextconv = /bin/false\n','[diff]\n\texternal = /bin/false\n',
         '[core]\n\tcomment = continued \\\n  [filter "fake"] clean = /bin/false\n\thooksPath = /tmp/hooks\n',
         '[includeIf "gitdir:/"]\n\tpath = /tmp/synthetic.config\n[include]\n\tpath = /tmp/other.config\n',
         '[core] fsmonitor\n; [filter "commented"] clean = /bin/false\n# [diff "c"] textconv = x\n',
         '[http "https://example.invalid/"]\n\textraheader = synthetic 137\n']
 def test_both_readers_list_exactly_the_keys_git_itself_reads(self):
  h=self.carrier_cases.h
  for config in self.CORPUS:
   with self.subTest(config=config),tempfile.TemporaryDirectory() as name:
    path=Path(name)/'config';path.write_text(config)
    listed=subprocess.run(['/usr/bin/git','config','--file',str(path),'--list','--name-only'],env={'PATH':'/usr/bin:/bin','GIT_CONFIG_NOSYSTEM':'1'},
                          check=True,capture_output=True,timeout=10).stdout.decode().splitlines()
    expected=sorted((key.split('.',1)[0].lower(),key.rsplit('.',1)[1].lower()) for key in listed)
    self.assertTrue(expected)
    self.assertEqual(sorted(m.git_config_keys(config.encode())),expected)
    self.assertEqual(sorted(h.git_config_keys(config.encode())),expected)
 def test_malformed_config_is_refused_by_both_readers(self):
  h=self.carrier_cases.h
  for config in ['[core\n','[core]\n\tbroken = "unterminated\n','[core]\n\tbad = escape \\q\n','orphan = before any section\n',b'[core]\n\tx = \xff\n']:
   raw=config if isinstance(config,bytes) else config.encode()
   with self.subTest(config=config):
    with self.assertRaises(m.Refusal):m.git_config_keys(raw)
    with self.assertRaises(ValueError):h.git_config_keys(raw)
 def test_clean_filter_in_repository_config_is_refused_before_git_runs_it(self):
  with tempfile.TemporaryDirectory(prefix='gcc-receipt-git-filter-') as name:
   base=Path(name).resolve();marker=base/'filter-ran.marker'
   repository,head=self.carrier_cases.filtered_repository(base,'[filter "synthetic"]\n\tclean = %s\n'%self.carrier_cases.marking_filter(base,marker))
   try:m.verify_checkout(repository,head);refusal=None
   except m.Refusal as error:refusal=error
   self.assertFalse(marker.exists(),'A configured clean filter ran during checkout verification')
   self.assertEqual(getattr(refusal,'identifier',None),'source-refused')
 def test_clean_checkout_with_benign_filter_mentions_is_verified(self):
  with tempfile.TemporaryDirectory(prefix='gcc-receipt-git-benign-') as name:
   repository,head=self.carrier_cases.filtered_repository(Path(name).resolve(),self.CORPUS[0])
   self.assertIsNone(m.verify_checkout(repository,head))
   with self.assertRaises(m.Refusal):m.verify_checkout(repository,'c'*40)


class CheckoutGitLayout(unittest.TestCase):
 """Both checkout readers inspect the configuration git itself opens."""
 carrier_cases=CheckoutGitConfig.carrier_cases
 def git(self,cwd,*args,base):
  env={'HOME':str(base),'GIT_CONFIG_NOSYSTEM':'1','PATH':'/usr/bin:/bin'}
  return subprocess.run(['/usr/bin/git','-c','user.name=synthetic','-c','user.email=synthetic@invalid','-c','core.hooksPath=/dev/null',
                         '-c','commit.gpgsign=false',*args],cwd=cwd,env=env,check=True,capture_output=True,timeout=60)
 def both_refuse(self,repository,head,marker=None):
  h=self.carrier_cases.h
  with self.assertRaisesRegex(ValueError,'Repository git'):h.verify_repository(repository,{'GITHUB_SHA':head})
  with self.assertRaises(m.Refusal):m.verify_checkout(repository,head)
  if marker is not None:self.assertFalse(marker.exists(),'A configured clean filter ran during checkout verification')
 def test_gitdir_path_ending_in_a_space_is_read_exactly(self):
  with tempfile.TemporaryDirectory(prefix='gcc-git-space-') as name:
   base=Path(name).resolve();marker=base/'filter-ran.marker'
   repository,head=self.carrier_cases.filtered_repository(base,'[filter "synthetic"]\n\tclean = %s\n'%self.carrier_cases.marking_filter(base,marker))
   # Git reads the gitdir whose name ends in a space; a decoy without the
   # space holds a harmless configuration.
   real=base/'metadata-137 ';(repository/'.git').rename(real);(repository/'.git').write_text('gitdir: %s\n'%real)
   decoy=base/'metadata-137';decoy.mkdir();(decoy/'config').write_text('[core]\n\trepositoryformatversion = 0\n')
   self.assertEqual(self.git(repository,'rev-parse','--git-dir',base=base).stdout.decode().rstrip('\n'),str(real))
   self.both_refuse(repository,head,marker)
 def test_linked_worktree_ignores_the_main_worktree_configuration_but_not_its_own(self):
  with tempfile.TemporaryDirectory(prefix='gcc-git-worktree-') as name:
   base=Path(name).resolve();main,head=self.carrier_cases.filtered_repository(base,'[extensions]\n\tworktreeConfig = true\n')
   (main/'.git/config').write_text((main/'.git/config').read_text().replace('repositoryformatversion = 0','repositoryformatversion = 1'))
   # Written after the add, which copies the main worktree's file into the new one.
   self.git(main,'worktree','add','-q','--detach',str(base/'linked'),'HEAD',base=base);linked=base/'linked'
   (main/'.git/config.worktree').write_text('[core]\n\thooksPath = /tmp/synthetic-main-hooks-137\n')
   self.assertIn('synthetic-main-hooks-137',self.git(main,'config','--show-origin','--list',base=base).stdout.decode())
   self.assertNotIn('synthetic-main-hooks-137',self.git(linked,'config','--show-origin','--list',base=base).stdout.decode())
   self.assertEqual(self.carrier_cases.h.verify_repository(linked,{'GITHUB_SHA':head})['headSha'],head)
   self.assertIsNone(m.verify_checkout(linked,head))
   gitdir=Path(self.git(linked,'rev-parse','--absolute-git-dir',base=base).stdout.decode().rstrip('\n'))
   (gitdir/'config.worktree').write_text('[core]\n\thooksPath = /tmp/synthetic-linked-hooks-137\n')
   self.both_refuse(linked,head)
 def test_fifo_metadata_is_refused_without_waiting_for_a_writer(self):
  with tempfile.TemporaryDirectory(prefix='gcc-git-fifo-') as name:
   base=Path(name).resolve();repository,_=self.carrier_cases.filtered_repository(base,'')
   os.mkfifo(repository/'.git/config.worktree')
   for module,call in [(ROOT/'scripts/producer-qualification/gcc-hosted-carrier.py','refuse_executable_git_config'),
                       (ROOT/'scripts/producer-qualification/gcc-sdk-onhost-receipt.py','refuse_executable_git_config')]:
    with self.subTest(module=module.name):
     code=('import importlib.util,pathlib,sys;s=importlib.util.spec_from_file_location("r",sys.argv[1]);r=importlib.util.module_from_spec(s);'
           's.loader.exec_module(r)\ntry:r.%s(pathlib.Path(sys.argv[2]))\nexcept Exception as e:print("refused",type(e).__name__)'%call)
     completed=subprocess.run([sys.executable,'-I','-B','-c',code,str(module),str(repository)],capture_output=True,timeout=60)
     self.assertEqual(completed.stdout.decode().split()[0],'refused',completed.stderr[-500:])
 def test_both_git_environments_carry_every_shared_metadata_control(self):
  # src/git-metadata-policy.ts is the engine's git policy; any control added
  # there must also reach both root-run checkout readers.
  source=(ROOT/'src/git-metadata-policy.ts').read_text()
  body=re.search(r'gitMetadataEnvironment = Object\.freeze\(\{(.*?)\}\)',source,re.S).group(1)
  shared=dict(re.findall(r'(GIT_[A-Z_]+):\s*"([^"]*)"',body))
  self.assertIn('GIT_NO_LAZY_FETCH',shared);self.assertEqual(shared['GIT_ALLOW_PROTOCOL'],'')
  for name,environment in [('carrier',self.carrier_cases.h.GIT_ENV),('receipt',m.CHECKOUT_ENV)]:
   with self.subTest(reader=name):
    self.assertEqual({key:environment.get(key) for key in shared},shared)
    self.assertEqual(set(environment)-set(shared),{'PATH'})


if __name__=='__main__':unittest.main()
