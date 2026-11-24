"""Synthetic lifecycle/SDK/selection controls; Docker and upstream never run."""
import base64
import copy
import hashlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
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


def node_record():
    path = Path(shutil.which('node')).resolve(strict=True)
    return {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'version': subprocess.check_output([str(path), '--version'], text=True).strip()}


def image_fixture():
    def row(raw, url):
        return {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
                'base64': base64.b64encode(raw).decode(), 'sourceUrl': url}
    config = {'os': 'linux', 'architecture': 'amd64', 'rootfs': {'type': 'layers',
              'diff_ids': ['sha256:' + 'a' * 64, 'sha256:' + 'b' * 64]}}
    raw_config = h.canonical(config); config_digest = 'sha256:' + hashlib.sha256(raw_config).hexdigest()
    manifest = {'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                'config': {'digest': config_digest, 'size': len(raw_config)},
                'layers': [{'digest': 'sha256:' + letter * 64} for letter in ['c', 'd']]}
    raw_manifest = h.canonical(manifest); manifest_digest = 'sha256:' + hashlib.sha256(raw_manifest).hexdigest()
    selected = 'docker.io/coqorg/coq@' + manifest_digest
    registry = {'schemaVersion': 1, 'selectedImage': selected,
                'manifest': row(raw_manifest, 'https://registry-1.docker.io/v2/coqorg/coq/manifests/' + manifest_digest),
                'config': row(raw_config, 'https://registry-1.docker.io/v2/coqorg/coq/blobs/' + config_digest),
                'rawManifestConfigVerified': True, 'compilerBuildExecuted': False, 'gateAComplete': False}
    image = {'Id': config_digest, 'Architecture': 'amd64', 'Os': 'linux', 'RepoDigests': [selected],
             'RootFS': {'Type': 'layers', 'Layers': config['rootfs']['diff_ids']}}
    return image, selected, registry, manifest_digest


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
    def test_host_node_uses_the_explicit_physical_executable_without_inherited_path_or_options(self):
        record = node_record()
        with mock.patch.dict(os.environ, {'PATH': '/absent/synthetic', 'NODE_OPTIONS': '--not-a-real-option'}):
            runtime = h.admit_host_node(record)
            image, selected, registry, _ = image_fixture()
            self.assertTrue(h.validate_image(image, selected, registry, runtime)['nativeAmd64'])
        self.assertTrue(runtime['physicalExecutableVerified'])
        for field, value in [('sha256', '0'*64), ('version', 'v0.0.0'), ('path', '/absent/synthetic-node')]:
            changed = {**record, field: value}
            with self.subTest(field=field), self.assertRaises((ValueError, FileNotFoundError)):
                h.admit_host_node(changed)

    def test_both_original_docker_id_forms_bind_the_same_pinned_layers_and_repository(self):
        image, selected, registry, manifest_digest = image_fixture()
        runtime = h.admit_host_node(node_record())
        for identifier in [image['Id'], manifest_digest]:
            image['Id'] = identifier
            witness = h.validate_image(image, selected, registry, runtime)
            self.assertEqual(witness['observedIdentity']['id'], identifier)
            self.assertEqual(witness['observedIdentity']['rootfsDiffIds'], image['RootFS']['Layers'])
            self.assertEqual(witness['configSha256'], registry['config']['sha256'])
            self.assertTrue(witness['nativeAmd64'])
        image['RepoDigests'] = [selected.removeprefix('docker.io/')]
        self.assertEqual(h.validate_image(image, selected, registry, runtime)['observedIdentity']['id'], manifest_digest)
        image['Config'] = {'Env': ['EXCLUDED_SYNTHETIC=not-an-identity-field']}
        self.assertNotIn('Config', h.observed_image_fields(image))

    def test_host_toolcache_write_modes_are_observations_and_byte_identity_stays_required(self):
        record = node_record(); path = Path(record['path']); actual_lstat = Path.lstat
        for permissions in [0o755, 0o775, 0o777]:
            # Synthetic lstat mode changes only the condition under test; the
            # actual selected Node executable still performs both bridge calls.
            def mode_observation(candidate, **options):
                result = actual_lstat(candidate, **options)
                if candidate == path:
                    values = list(result); values[0] = stat.S_IFREG | permissions
                    return os.stat_result(values)
                return result
            with tempfile.TemporaryDirectory(prefix='gcc-node-mode-synthetic-') as name:
                output = Path(name)
                with mock.patch.object(Path, 'lstat', mode_observation):
                    try:
                        runtime = h.admit_host_node(record, output)
                    except ValueError as error:
                        self.fail('Valid hosted tool-cache mode refused: ' + str(error))
                    image, selected, registry, _ = image_fixture()
                    self.assertTrue(h.validate_image(image, selected, registry, runtime)['nativeAmd64'])
                    changed = {**record, 'sha256': '0'*64}
                    with self.assertRaisesRegex(ValueError, 'bytes differ'):
                        h.admit_host_node(changed, output)
                observation = json.loads((output/'HOST-NODE-OBSERVATION.json').read_bytes())
                self.assertEqual(observation['mode'], permissions)
                self.assertEqual(observation['requestedRuntime'], changed)
                self.assertTrue(observation['regularFile']);self.assertTrue(observation['executable'])
        with tempfile.TemporaryDirectory(prefix='gcc-node-refusal-synthetic-') as name:
            output = Path(name); changed = {**record, 'sha256': '0'*64}
            with self.assertRaisesRegex(ValueError, 'bytes differ'):h.admit_host_node(changed, output)
            self.assertTrue((output/'HOST-NODE-OBSERVATION.json').is_file())
            self.assertFalse((output/'HOST-NODE.json').exists())

    def test_host_runtime_non_executable_and_special_file_modes_refuse_before_execution(self):
        record = node_record(); path = Path(record['path']); actual_lstat = Path.lstat
        for rejected_mode in [stat.S_IFREG | 0o644, stat.S_IFIFO | 0o777, stat.S_IFLNK | 0o777]:
            def mode_observation(candidate, **options):
                result = actual_lstat(candidate, **options)
                if candidate == path:
                    values = list(result); values[0] = rejected_mode
                    return os.stat_result(values)
                return result
            with tempfile.TemporaryDirectory(prefix='gcc-node-type-synthetic-') as name:
                output = Path(name)
                with mock.patch.object(Path, 'lstat', mode_observation), mock.patch.object(h.subprocess, 'run') as execute:
                    with self.assertRaisesRegex(ValueError, 'regular executable'):
                        h.admit_host_node(record, output)
                    execute.assert_not_called()
                observed = json.loads((output/'HOST-NODE-OBSERVATION.json').read_bytes())
                self.assertEqual(observed['mode'], rejected_mode & 0o777)
                self.assertTrue(not observed['regularFile'] or not observed['executable'])

    def test_refused_image_keeps_only_its_exact_admission_fields_before_failure(self):
        runtime = h.admit_host_node(node_record())
        image, selected, registry, _ = image_fixture(); image['Id'] = 'sha256:' + '0'*64
        image['Config'] = {'Env': ['EXCLUDED_SYNTHETIC=not-an-identity-field']}
        with tempfile.TemporaryDirectory(prefix='gcc-image-synthetic-') as name:
            output = Path(name)
            with self.assertRaisesRegex(ValueError, 'pinned image validation failed'):
                h.validate_and_retain_image(output, image, selected, registry, runtime)
            observed = json.loads((output/'IMAGE-OBSERVATION.json').read_bytes())
            self.assertEqual(observed, h.observed_image_fields(image))
            self.assertEqual(observed['Id'], 'sha256:'+'0'*64)
            self.assertNotIn('Config', observed)
            self.assertEqual(sorted(p.name for p in output.iterdir()), ['IMAGE-OBSERVATION.json'])

    def test_image_near_misses_cannot_bypass_the_shared_raw_registry_contract(self):
        mutations = [lambda i, r:i.update(Id='sha256:'+'e'*64), lambda i, r:i.update(Architecture='arm64'),
            lambda i, r:i.update(Os='windows'), lambda i, r:i.update(RepoDigests=['wrong/repository@'+i['Id']]),
            lambda i, r:i['RootFS'].update(Type='wrong'), lambda i, r:i['RootFS']['Layers'].reverse(),
            lambda i, r:r['config'].update(bytes=r['config']['bytes']+1),
            lambda i, r:r['manifest'].update(sha256='f'*64), lambda i, r:r.update(rawManifestConfigVerified=False),
            lambda i, r:r.update(compilerBuildExecuted=True), lambda i, r:r.update(gateAComplete=True)]
        runtime = h.admit_host_node(node_record())
        for mutate in mutations:
            image, selected, registry, _ = image_fixture(); mutate(image, registry)
            with self.subTest(mutation=mutations.index(mutate)), self.assertRaisesRegex(ValueError, 'pinned image validation failed'):
                h.validate_image(image, selected, registry, runtime)

    def test_summary_finalizes_both_cache_flags_only_after_complete_service_replay_and_cleanup(self):
        carrier={'ownedContainerCleanup':'removed','cacheSaveCompleted':False,'cacheRestoreReplayQualified':False,'capturedOriginalExit':0}
        replay={'state':'phase0-service-cache-restored-and-physical-state-replayed','cacheSaveAndRestoreReplayed':True,
                'fullSourceReportsAndMountStatePhysicallyReplayed':True,'receipt':{'physicalTreeVerified':True},
                'nextPhase':'native','fullCompilerSdkBootstrapClosureVerified':False,'gateAComplete':False}
        h.record_service_replay(carrier,replay)
        self.assertEqual(carrier,{'ownedContainerCleanup':'removed','capturedOriginalExit':0,
            'cacheSaveCompleted':True,'cacheRestoreReplayQualified':True,
            'state':replay['state'],'serviceCacheRestoredAndReplayed':True,
            'localLedgerIsProvisionalUntilServiceReplay':False,'phaseAdvancedTo':'native',
            'allSelectedOriginalPhasesCompleted':False})
        for key,value in [('cacheSaveAndRestoreReplayed',False),('fullSourceReportsAndMountStatePhysicallyReplayed',False),
                          ('nextPhase','jit'),('gateAComplete',True),('receipt',{'physicalTreeVerified':False})]:
            before={'ownedContainerCleanup':'removed','cacheSaveCompleted':False,'cacheRestoreReplayQualified':False}
            changed={**replay,key:value}
            with self.assertRaisesRegex(ValueError,'Incomplete service replay'):h.record_service_replay(before,changed)
            self.assertFalse(before['cacheSaveCompleted']);self.assertFalse(before['cacheRestoreReplayQualified'])

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

    def racing_listing(self,directory,names):
        """List directory as a running build would see it, then unlink names
        before the walk reaches them: the listing/lstat race, made certain."""
        original=Path.iterdir
        def iterdir(path):
            listed=list(original(path))
            if path==directory:
                for item in names:(directory/item).unlink()
            return iter(listed)
        return mock.patch.object(Path,'iterdir',iterdir)

    def test_live_sample_skips_an_entry_unlinked_between_listing_and_lstat(self):
        with tempfile.TemporaryDirectory(prefix='gcc-live-race-synthetic-') as name:
            root=Path(name).resolve();(root/'kept-object').write_bytes(b'k'*1375);(root/'cc1-tmp.s').write_bytes(b't'*9137)
            with self.racing_listing(root,['cc1-tmp.s']):value=h.allocated_state(root,live=True)
            self.assertFalse((root/'cc1-tmp.s').exists())
            self.assertEqual(value['logicalBytes'],1375);self.assertEqual(value['entries'],2);self.assertEqual(value['vanishedEntries'],1)

    def test_stopped_scan_still_refuses_an_entry_that_vanishes_mid_walk(self):
        with tempfile.TemporaryDirectory(prefix='gcc-stopped-race-synthetic-') as name:
            root=Path(name).resolve();(root/'kept-object').write_bytes(b'k'*1375);(root/'cc1-tmp.s').write_bytes(b't'*9137)
            with self.racing_listing(root,['cc1-tmp.s']),self.assertRaises(FileNotFoundError):h.allocated_state(root)
            # The same tree, no longer changing, is measured normally.
            self.assertEqual(h.allocated_state(root)['logicalBytes'],1375)
            self.assertNotIn('vanishedEntries',h.allocated_state(root))

    def test_live_sample_still_refuses_a_vanished_root(self):
        with tempfile.TemporaryDirectory(prefix='gcc-live-root-synthetic-') as name:
            with self.assertRaises(FileNotFoundError):h.allocated_state(Path(name).resolve()/'never-mounted-state',live=True)

    def test_live_tolerance_is_bounded_for_a_tree_that_keeps_changing(self):
        with tempfile.TemporaryDirectory(prefix='gcc-live-churn-synthetic-') as name:
            root=Path(name).resolve();churn=['churn-%d.o'%index for index in range(7)]
            for item in churn:(root/item).write_bytes(b'c'*613)
            with mock.patch.object(h,'LIVE_VANISHED_CEILING',7),self.racing_listing(root,churn):
                self.assertEqual(h.allocated_state(root,live=True)['vanishedEntries'],7)
            for item in churn:(root/item).write_bytes(b'c'*613)
            with mock.patch.object(h,'LIVE_VANISHED_CEILING',6),self.racing_listing(root,churn):
                with self.assertRaisesRegex(ValueError,'beyond its sampling tolerance'):h.allocated_state(root,live=True)

    def test_live_observation_race_neither_terminates_nor_drops_the_sample(self):
        with tempfile.TemporaryDirectory(prefix='gcc-observe-race-synthetic-') as name:
            output=Path(name).resolve();state=output/'state';state.mkdir()
            (state/'kept-object').write_bytes(b'k'*1375);(state/'cc1-tmp.s').write_bytes(b't'*9137)
            with self.racing_listing(state,['cc1-tmp.s']):value,calls=self.observation(output)
            self.assertFalse(any(call[0]=='kill' for call in calls),calls)
            self.assertIsNone(json.loads((output/'ATTEMPT.json').read_bytes())['cutoffOrRetentionError'])
            samples=json.loads((output/'resource-samples.json').read_bytes())['samples']
            self.assertEqual(len(samples),1);self.assertEqual(samples[0]['logicalBytes'],1375);self.assertEqual(samples[0]['vanishedEntries'],1)
            self.assertTrue(value['quiescenceObserved'])

    def test_sparse_logical_overrun_cannot_be_admitted_from_small_physical_allocation(self):
        with self.assertRaisesRegex(ValueError,'logical/physical'):
            h.admit_state({}, {}, {'logicalBytes':h.STATE_CEILING+1,'allocatedBytes':4096})

    def observation(self,output,*,running=False,oom=False,clock=None,maximum=60,late_terminal=False,scope='configure'):
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
                with mock.patch.object(h.time,'monotonic',side_effect=clock):return h.native_observation(output,'synthetic-owner',maximum,service,scope=scope),calls
            return h.native_observation(output,'synthetic-owner',maximum,service,scope=scope),calls

    def test_sdk_observer_scope_retains_true_body_terminal_without_claiming_a_gcc_phase(self):
        with tempfile.TemporaryDirectory(prefix='gcc-sdk-observe-synthetic-') as name:
            output=Path(name).resolve();(output/'state').mkdir()
            result,_=self.observation(output,scope='sdk-reconstruction')
            self.assertEqual(result['containerState']['ExitCode'],0)
            attempt=json.loads((output/'ATTEMPT.json').read_bytes())
            self.assertEqual(attempt['nativePhase'],'sdk-reconstruction')
            self.assertFalse(attempt['originalCommandTerminalAssessed'])
            self.assertIsNone(attempt['nativeOriginalCommandExitCode'])
        with mock.patch.object(h.subprocess,'Popen') as start:
            with self.assertRaisesRegex(ValueError,'Unknown fixed hosted observation scope'):
                h.native_observation(Path('/not-created'),'synthetic-owner',60,{},scope='arbitrary-target')
            start.assert_not_called()

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
