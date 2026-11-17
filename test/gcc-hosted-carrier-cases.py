"""Synthetic lifecycle/SDK/selection controls; Docker and upstream never run."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import types
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parent.parent
MODULE=ROOT/'scripts/producer-qualification'
def load(path):
    spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
h=load(MODULE/'gcc-hosted-carrier.py');s=load(MODULE/'gcc-hosted-stage.py')
existing=load(ROOT/'test/gcc-staged-cases.py')


def configuration(**options):
    value=existing.configuration(**{'hppa64':True,**options})
    value['variables']['CONFARGS']='--enable-languages='+s.LANGUAGES+' --enable-multilib --enable-offload-targets=nvptx-none=/build/source/debian/tmp-nvptx/usr,amdgcn-amdhsa=/build/source/debian/tmp-gcn/usr'
    return value


class Body(unittest.TestCase):
    def test_full_retained_language_multilib_and_all_default_branches_are_required(self):
        value=s.selected_configuration(configuration(),existing.p)
        self.assertEqual(value['mainLanguages'],s.LANGUAGES)
        self.assertIn('check',value['selectedDefaultBranches']);self.assertFalse(value['nativeLaterBranchesCompleted'])
        for mutate in [lambda v:v['variables'].update(CONFARGS=v['variables']['CONFARGS'].replace('--enable-languages='+s.LANGUAGES,'--enable-languages=c,c++')),
            lambda v:v['variables'].update(CONFARGS=v['variables']['CONFARGS'].replace('--enable-multilib','--disable-multilib')),
            lambda v:v['variables'].update(CONFARGS=v['variables']['CONFARGS'].replace(',amdgcn-amdhsa=/build/source/debian/tmp-gcn/usr',''))]:
            value=configuration();mutate(value)
            with self.assertRaises(ValueError):s.selected_configuration(value,existing.p)
        for value in [configuration(hppa64=False),configuration(jit=False)]:
            # Each is a valid conditional graph; only the retained full-default
            # selection guard should reject it for this closed phase-0 carrier.
            existing.p.plan(value)
            with self.assertRaisesRegex(ValueError,'full default producer branch'):
                s.selected_configuration(value,existing.p)

    def test_external_sdk_bytes_modes_links_and_times_are_witnessed_without_following_links(self):
        with tempfile.TemporaryDirectory(prefix='gcc-sdk-synthetic-') as name:
            root=Path(name).resolve();(root/'usr').mkdir();(root/'usr/tool').write_bytes(b'Synthetic SDK bytes')
            (root/'build').mkdir();(root/'build/private').write_bytes(b'Excluded mutable mount')
            os.symlink('/absent/synthetic-sdk',root/'usr/alias')
            before=s.external_inventory(root)
            self.assertFalse(any(row['path'].startswith('/build') for row in before['entries']))
            self.assertEqual(next(row for row in before['entries'] if row['path']=='/usr/alias')['target'],'/absent/synthetic-sdk')
            (root/'usr/tool').write_bytes(b'Changed SDK bytes')
            self.assertNotEqual(before,s.external_inventory(root))
            os.mkfifo(root/'usr/socket-like-special')
            with self.assertRaisesRegex(ValueError,'special state'):s.external_inventory(root)

    def test_original_nonzero_and_signal_terminals_are_not_rewritten_as_exit137(self):
        for code,exit_code,signal_number in [(7,7,None),(-9,None,9)]:
            with tempfile.TemporaryDirectory(prefix='gcc-command-synthetic-') as name:
                records=Path(name)/'commands.jsonl'
                with mock.patch.object(s.subprocess,'run',return_value=types.SimpleNamespace(returncode=code)),self.assertRaises(ValueError):
                    s.command_record(['synthetic-command'],Path(name),records,'synthetic')
                rows=[json.loads(raw) for raw in records.read_text().splitlines()]
                self.assertEqual([row['state'] for row in rows],['requested','terminal'])
                self.assertEqual(rows[-1]['exitCode'],exit_code);self.assertEqual(rows[-1]['signal'],signal_number)
                self.assertNotEqual(rows[-1]['exitCode'],137)


class Host(unittest.TestCase):
    def test_actual_container_assembly_rejects_wrong_limits_mounts_and_early_execution(self):
        output=Path('/synthetic/output');catalog={'image':'synthetic-pinned-image','environment':s.FIXED_ENVIRONMENT}
        config={'Labels':{'io.checktrail.gcc-staged-owner':'synthetic-owner'},'User':'0:0','WorkingDir':'/work',
            'Entrypoint':['/usr/bin/env'],'Image':catalog['image'],
            'Cmd':['-i',*[key+'='+value for key,value in s.FIXED_ENVIRONMENT.items()],
                   '/usr/bin/python3','-I','-B','/controller/gcc-hosted-stage.py','configure']}
        expected={'/build':(output/'state',True),'/inputs':(output/'inputs/source',False),
            '/controller':(output/'controls',False),'/usr/share/keyrings/debian-keyring.gpg':(output/'inputs/keyrings/debian-keyring.gpg',False)}
        expected.update({target:(output/'state'/relative,True) for relative,target in h.MUTABLE_MOUNTS.items()})
        owner={'Id':'synthetic-id','Config':config,'HostConfig':{'NetworkMode':'none','Privileged':False,'Init':True,
            'NanoCpus':4000000000,'Memory':6*h.GIB,'PidsLimit':1024},
            'State':{'Status':'created','Running':False,'Pid':0},
            'Mounts':[{'Type':'bind','Source':str(source),'Destination':target,'RW':rw} for target,(source,rw) in expected.items()]}
        self.assertTrue(h.validate_container(owner,'synthetic-id','synthetic-owner',catalog,output)['actualLimitsObserved'])
        for mutate in [lambda v:v['HostConfig'].update(Memory=1),lambda v:v['HostConfig'].update(NanoCpus=0),
            lambda v:v['HostConfig'].update(PidsLimit=-1),lambda v:v['HostConfig'].update(Privileged=True),
            lambda v:v['State'].update(Running=True,Pid=10),lambda v:v['Config']['Cmd'].__setitem__(-1,'narrowed-target'),
            lambda v:v['Mounts'][2].update(RW=True),lambda v:v['Mounts'].pop()]:
            changed=copy.deepcopy(owner);mutate(changed)
            with self.assertRaises(ValueError):h.validate_container(changed,'synthetic-id','synthetic-owner',catalog,output)

    def test_fixed_container_retains_original_environment_limits_and_mount_paths(self):
        root=Path('/synthetic/owned-output')
        args=h.create_arguments({'image':'synthetic-pinned-image','environment':s.FIXED_ENVIRONMENT},root,'synthetic-owner')
        self.assertIn('--network',args);self.assertIn('none',args);self.assertIn('6g',args)
        self.assertEqual(args[-1],'configure');self.assertNotIn('bootstrap-lean',args)
        self.assertTrue(any('target=/build' in arg for arg in args))
        for target in h.MUTABLE_MOUNTS.values():self.assertTrue(any(('target='+target) in arg for arg in args))
        for key,value in s.FIXED_ENVIRONMENT.items():self.assertIn(key+'='+value,args)
        self.assertFalse(any('TOKEN' in arg for arg in args))

    def test_capacity_sampling_counts_sparse_logical_and_unique_physical_hardlink_bytes(self):
        with tempfile.TemporaryDirectory(prefix='gcc-state-synthetic-') as name:
            root=Path(name).resolve();path=root/'one';path.write_bytes(b'a'*8192);os.link(path,root/'two')
            value=h.allocated_state(root)
            self.assertEqual(value['logicalBytes'],16384)
            self.assertLess(value['allocatedBytes'],sum(p.lstat().st_blocks*512 for p in [root,path,root/'two']))
            self.assertFalse(value['quotaEnforced']);self.assertFalse(value['samplingIsPhysicalHighWater'])
            with self.assertRaisesRegex(ValueError,'sample deadline'):h.allocated_state(root,maximum_seconds=0)

    def test_sparse_logical_overrun_cannot_be_admitted_from_small_physical_allocation(self):
        with self.assertRaisesRegex(ValueError,'logical/physical'):
            h.admit_state({}, {}, {'logicalBytes':h.STATE_CEILING+1,'allocatedBytes':4096})

    def observation(self,output,*,running=False,oom=False,clock=None,maximum=60,late_terminal=False):
        late_now=[0]
        if late_terminal:clock=lambda:late_now[0]
        read_fd,write_fd=os.pipe();os.write(write_fd,b'Synthetic original stdout\n');os.close(write_fd)
        class Process:
            def __init__(self):self.stdout=os.fdopen(read_fd,'rb');self.pid=999999
            def wait(self,timeout=None):
                if late_terminal:late_now[0]=maximum+10
                return 0
            def poll(self):return 0
        process=Process();calls=[]
        state={'Running':running,'Pid':10 if running else 0,'Status':'running' if running else 'exited','ExitCode':0,'OOMKilled':oom,'Error':''}
        def docker(arguments,**kwargs):
            calls.append(arguments)
            return json.dumps([{'State':state}]).encode() if arguments[0]=='inspect' else b''
        service={'remainingSeconds':20000,'capturedMonotonic':0 if clock else h.time.monotonic()}
        with mock.patch.object(h.subprocess,'Popen',return_value=process),mock.patch.object(h,'docker',side_effect=docker),mock.patch.object(h.time,'sleep'):
            if clock:
                with mock.patch.object(h.time,'monotonic',side_effect=clock):return h.native_observation(output,'synthetic-owner',maximum,service),calls
            return h.native_observation(output,'synthetic-owner',maximum,service),calls

    def test_attach_zero_is_insufficient_without_clean_container_and_absent_native_family(self):
        for values in [{'running':True},{'oom':True}]:
            with tempfile.TemporaryDirectory(prefix='gcc-observe-synthetic-') as name:
                output=Path(name).resolve();(output/'state').mkdir()
                with self.subTest(values=values),self.assertRaises(ValueError):self.observation(output,**values)
                self.assertTrue((output/'ATTEMPT.json').is_file())

    def test_original_stdout_and_true_quiescent_terminal_are_retained(self):
        with tempfile.TemporaryDirectory(prefix='gcc-observe-synthetic-') as name:
            output=Path(name).resolve();(output/'state').mkdir()
            value,calls=self.observation(output)
            self.assertTrue(value['quiescenceObserved']);self.assertEqual(value['containerState']['ExitCode'],0)
            self.assertEqual((output/'native.log').read_bytes(),b'Synthetic original stdout\n')
            self.assertFalse(json.loads((output/'ATTEMPT.json').read_bytes())['originalCommandTerminalAssessed'])

    def test_timeout_never_promotes_a_zero_attach_return_or_invents_native_exit(self):
        with tempfile.TemporaryDirectory(prefix='gcc-timeout-synthetic-') as name:
            output=Path(name).resolve();(output/'state').mkdir();ticks=iter([0,100,100,100,100])
            with self.assertRaisesRegex(ValueError,'cutoff'):self.observation(output,clock=lambda:next(ticks))
            attempt=json.loads((output/'ATTEMPT.json').read_bytes())
            self.assertIsNone(attempt['nativeOriginalCommandExitCode']);self.assertTrue(attempt['allElapsedTimeMustBeChargedOnRetry'])
            self.assertFalse(attempt['checkpointCompleted'])

    def test_late_zero_terminal_after_last_pipe_read_still_refuses(self):
        with tempfile.TemporaryDirectory(prefix='gcc-late-terminal-synthetic-') as name:
            output=Path(name).resolve();(output/'state').mkdir()
            with self.assertRaisesRegex(ValueError,'Late native wrapper terminal'):
                self.observation(output,late_terminal=True)
            self.assertFalse(json.loads((output/'ATTEMPT.json').read_bytes())['checkpointCompleted'])


if __name__=='__main__':
    suite=unittest.TestSuite([unittest.defaultTestLoader.loadTestsFromTestCase(Body),unittest.defaultTestLoader.loadTestsFromTestCase(Host)])
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    print(json.dumps({'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'skips':len(result.skipped),'dockerOrUpstreamExecuted':False}))
    raise SystemExit(not result.wasSuccessful())
