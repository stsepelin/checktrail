"""Synthetic SDK hosted lifecycle and real inert predecessor replay controls."""
import copy
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parent.parent

def load(path):
    spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

s=load(ROOT/'scripts/producer-qualification/gcc-hosted-sdk.py')
b=load(ROOT/'scripts/producer-qualification/gcc-sdk-reconstruct.py')
fixtures=load(ROOT/'test/gcc-hosted-carrier-cases.py')
material_fixtures=load(ROOT/'test/gcc-sdk-material-cases.py')

class Hosted(unittest.TestCase):
    def test_cache_identity_is_exact_across_key_ref_id_version_size_and_duplicates(self):
        policy=s.PREDECESSOR
        row={'key':policy['key'],'ref':policy['ref'],'id':policy['cacheId'],'version':policy['cacheVersion'],'size_in_bytes':697525348}
        expected='/repos/stsepelin/checktrail/actions/caches?per_page=100&key='+s.urllib.parse.quote(policy['key'],safe='')+'&ref='+s.urllib.parse.quote(policy['ref'],safe='')
        class Api:
            def __init__(self,rows):self.rows=rows;self.calls=[]
            def get(self,path):self.calls.append(path);return {'total_count':len(self.rows),'actions_caches':self.rows},{}
        api=Api([row]);self.assertEqual(s.verify_cache_identity(api),row);self.assertEqual(api.calls,[expected])
        for fields in [{'key':row['key']+'-suffix'},{'ref':'refs/heads/main'},{'id':row['id']+1},
                       {'version':'changed'},{'size_in_bytes':0},{'size_in_bytes':True},{'size_in_bytes':900000000}]:
            changed={**row,**fields}
            with self.assertRaises(ValueError):s.verify_cache_identity(Api([changed]))
        for rows in [[],[row,row]]:
            with self.assertRaises(ValueError):s.verify_cache_identity(Api(rows))

    def predecessor(self,base):
        c,p=s.codec,s.planner;config=fixtures.configuration();tree=base/'source-tree';(tree/'source/stamps').mkdir(parents=True)
        (tree/'source/stamps/04-configure-stamp').write_bytes(b'Synthetic configure stamp')
        (tree/'source/object').write_bytes(b'Synthetic source object');os.link(tree/'source/object',tree/'source/alias')
        os.symlink('/inert/synthetic-sdk',tree/'source/pointer');(tree/'__carrier_work/gcc-staged-configuration').mkdir(parents=True)
        binding=fixtures.existing.binding(configurationSha256=p.sha(p.canonical(config)))
        transport=base/'transport';receipt=c.capture(tree,transport,binding)
        row=fixtures.existing.completed(p.new_ledger(config),config);row['checkpointSha256']=receipt['archiveSha256']
        ledger=p.append_attempt(p.new_ledger(config),config,row)
        policy={'run':1,'job':2,'head':'a'*40,'ref':'refs/heads/diagnostic/synthetic',
                'configurationSha256':binding['configurationSha256'],'externalSdkSha256':'d'*64,
                'archive':{'bytes':receipt['archiveBytes'],'sha256':receipt['archiveSha256']}}
        root={'sourceServiceContext':{'GITHUB_RUN_ID':'1','GITHUB_SHA':'a'*40,'GITHUB_REF':policy['ref']},
              'sourceJobId':2,'binding':binding,'externalSdkSha256':'d'*64}
        (transport/'CHECKPOINT-ROOT.json').write_bytes(c.canonical(root));(transport/'PHASE-LEDGER.json').write_bytes(p.canonical(ledger))
        policy['members']={}
        for name in ['CHECKPOINT-ROOT.json','PHASE-LEDGER.json','receipt.json']:
            raw=(transport/name).read_bytes();policy['members'][name]={'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
        return tree,transport,config,policy

    def test_original_predecessor_replays_physical_bytes_links_times_before_sdk_code(self):
        with tempfile.TemporaryDirectory() as name:
            base=Path(name).resolve();tree,transport,config,policy=self.predecessor(base);out=base/'output';out.mkdir()
            with mock.patch.object(s.planner,'read_configuration',return_value=config),mock.patch.object(s.h,'docker') as docker:
                restored,root=s.verify_predecessor(transport,out,policy)
                self.assertEqual(s.codec.snapshot(restored,s.codec.Budget()),s.codec.snapshot(tree,s.codec.Budget()))
                docker.assert_not_called()
            proof=json.loads((out/'PREDECESSOR-REPLAY.json').read_bytes())
            self.assertTrue(proof['physicalPredecessorReplayed']);self.assertEqual(proof['reportedCompletePhases'],1)
            self.assertEqual(proof['nextOriginalTarget']['phase'],'native');self.assertFalse(proof['originalPhaseAdvanced'])
            self.assertFalse(proof['externalSdkReconstructionQualified'])
            changed={**policy,'archive':{**policy['archive'],'sha256':'0'*64}};bad=base/'bad';bad.mkdir()
            with mock.patch.object(s.codec,'restore') as restore,mock.patch.object(s.h,'docker') as docker:
                with self.assertRaisesRegex(ValueError,'Pinned input differs'):s.verify_predecessor(transport,bad,changed)
                restore.assert_not_called();docker.assert_not_called()

    def test_readonly_keyring_time_is_prepared_from_bound_inventory_without_changing_bytes_or_permissions(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name).resolve();old=root/'old';(old/'usr/share/keyrings').mkdir(parents=True)
            keyring=old/'usr/share/keyrings/debian-keyring.gpg';keyring.write_bytes(b'Synthetic public keyring')
            os.utime(keyring,ns=(1234567890123456789,1234567890123456789))
            inventory=s.stage.external_inventory(old);predecessor=root/'predecessor';(predecessor/'__carrier_work').mkdir(parents=True)
            (predecessor/'__carrier_work/external-sdk-before.json').write_bytes(s.stage.canonical(inventory))
            expected={'externalSdkSha256':hashlib.sha256(s.stage.canonical(inventory)).hexdigest()}
            fresh=root/'fresh-keyring';fresh.write_bytes(keyring.read_bytes());fresh.chmod(0o640);before=fresh.lstat()
            result=s.prepare_readonly_keyring(fresh,predecessor,expected)
            self.assertTrue(result['preparedBeforeReadOnlyMount']);self.assertEqual(fresh.read_bytes(),keyring.read_bytes())
            self.assertEqual(fresh.stat().st_mtime_ns,keyring.stat().st_mtime_ns)
            self.assertEqual(fresh.lstat().st_mode,before.st_mode)
            fresh.write_bytes(b'Wrong keyring bytes')
            with mock.patch.object(s.os,'utime') as touch:
                with self.assertRaisesRegex(ValueError,'keyring bytes differ'):s.prepare_readonly_keyring(fresh,predecessor,expected)
                touch.assert_not_called()

    def test_sdk_container_has_readonly_predecessor_exact_environment_and_no_gcc_target(self):
        output=Path('/synthetic/sdk');catalog={'image':'synthetic-image','environment':s.stage.FIXED_ENVIRONMENT}
        args=s.arguments(catalog,output,'synthetic-owner');self.assertEqual(args[-5:],s.BODY)
        self.assertIn('target=/inputs/predecessor,readonly',','.join(args));self.assertNotIn('--rules-target=configure',args)
        mounts={'/build':(output/'state',True),'/inputs':(output/'inputs/source',False),'/controller':(output/'controls',False),
                '/inputs/predecessor':(output/'predecessor',False),'/controller/observations':(output/'observations',True),
                '/usr/share/keyrings/debian-keyring.gpg':(output/'inputs/keyrings/debian-keyring.gpg',False)}
        mounts.update({target:(output/'state'/relative,True) for relative,target in s.h.MUTABLE_MOUNTS.items()})
        owner={'Id':'synthetic-id','Config':{'Labels':{'io.checktrail.gcc-staged-owner':'synthetic-owner'},'User':'0:0','WorkingDir':'/work','Image':'synthetic-image','Entrypoint':['/usr/bin/env'],
          'Cmd':['-i',*[k+'='+v for k,v in catalog['environment'].items()],*s.BODY]},'HostConfig':{'NetworkMode':'none','Privileged':False,'Init':True,'NanoCpus':4000000000,'Memory':6*s.h.GIB,'PidsLimit':1024},
          'State':{'Status':'created','Running':False,'Pid':0},'Mounts':[{'Type':'bind','Destination':target,'Source':str(path),'RW':rw} for target,(path,rw) in mounts.items()]}
        self.assertTrue(s.validate_container(owner,'synthetic-id','synthetic-owner',catalog,output)['readOnlyPredecessorObserved'])
        for mutate in [lambda v:next(x for x in v['Mounts'] if x['Destination']=='/inputs/predecessor').update(RW=True),
                       lambda v:v['Config']['Cmd'].__setitem__(-1,'native'),lambda v:v['HostConfig'].update(NetworkMode='host'),
                       lambda v:v['HostConfig'].update(Memory=0),lambda v:v['State'].update(Running=True,Pid=1)]:
            changed=copy.deepcopy(owner);mutate(changed)
            with self.assertRaises(ValueError):s.validate_container(changed,'synthetic-id','synthetic-owner',catalog,output)

    def test_sdk_admission_requires_measured_scratch_memory_clock_without_a_successor_cache(self):
        resources={'architecture':'x86_64','cpus':4,'memoryBytes':16*s.h.GIB,'availableMemoryBytes':12*s.h.GIB,'freeDiskBytes':80*s.h.GIB}
        service={'clock':{'remainingSeconds':20000},'cache':{'observedOccupiedBytes':10*s.h.GIB-1}}
        self.assertFalse(s.admit(resources,service)['newCacheWriteRequired'])
        for key,value in [('cpus',3),('freeDiskBytes',39*s.h.GIB),('availableMemoryBytes',7*s.h.GIB),('architecture','aarch64')]:
            with self.assertRaises(ValueError):s.admit({**resources,key:value},service)
        for value in [{'clock':{'remainingSeconds':s.h.capacity.FINALIZE_SECONDS+1199},'cache':service['cache']},
                      {'clock':service['clock'],'cache':{'observedOccupiedBytes':10*s.h.GIB+1}}]:
            with self.assertRaises(ValueError):s.admit(resources,value)

class Body(unittest.TestCase):
    def test_real_timestamp_normalization_keeps_matched_material_bytes_and_visible_logs(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name).resolve();before=material_fixtures.Material().fixture(root)
            tool=root/'usr/bin/compiler';original=tool.read_bytes();os.utime(tool,ns=(1234567890123456789,1234567890123456789))
            (root/'var/log/apt/history.log').write_bytes(b'Visible new transaction log')
            observed=s.stage.external_inventory(root);comparison=b.material.compare(before,observed,'a'*64,'a'*64)
            comparison.update(expectedPackageInventorySha256='a'*64,observedPackageInventorySha256='a'*64)
            setter=b.codec.set_metadata
            with mock.patch.object(b.stage,'external_inventory',side_effect=lambda:s.stage.external_inventory(root)),\
                 mock.patch.object(b.codec,'set_metadata',side_effect=lambda path,row:setter(root/str(path).lstrip('/'),row)):
                after,final=b.normalize_verified_timestamps(before,observed,comparison)
            self.assertEqual(tool.read_bytes(),original);self.assertTrue(final['materialProjectionMatches'])
            self.assertEqual(final['counts']['timestampOnlyMaterial'],0);self.assertEqual(final['counts']['incidentalDifferences'],1)
            self.assertFalse(final['wholeRootIdentityClaimed'])
            observed=copy.deepcopy(after);next(row for row in observed['entries'] if row['path']=='/usr/bin/compiler')['sha256']='b'*64
            bad=b.material.compare(before,observed,'a'*64,'a'*64)
            with mock.patch.object(b.codec,'set_metadata') as write:
                with self.assertRaisesRegex(ValueError,'Unresolved SDK material'):b.normalize_verified_timestamps(before,observed,bad)
                write.assert_not_called()

    def test_original_sdk_stdout_is_retained_as_exact_bounded_bytes(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name).resolve();raw=b'Synthetic SDK stdout\n'*4;(root/'native.log').write_bytes(raw)
            retained=s.retain_sdk_stdout(root)
            self.assertTrue(retained['complete']);self.assertEqual(gzip.decompress((root/'sdk-native.log.gz').read_bytes()),raw)
            self.assertEqual(retained['original']['sha256'],hashlib.sha256(raw).hexdigest())
            empty=root/'not-started';empty.mkdir();self.assertFalse(s.retain_sdk_stdout(empty)['complete'])
            oversized=root/'oversized';oversized.mkdir();(oversized/'native.log').write_bytes(os.urandom(9*1024**2))
            rejected=s.retain_sdk_stdout(oversized)
            self.assertFalse(rejected['complete']);self.assertFalse((oversized/'sdk-native.log.gz').exists())
            self.assertEqual((oversized/'native.log').stat().st_size,9*1024**2)

    def test_sdk_diagnostics_include_complete_stdout_and_do_not_claim_phase_or_native_credit(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name).resolve();output=root/'sdk-output';output.mkdir()
            raw=b'Synthetic original SDK log\n'*3;(output/'native.log').write_bytes(raw)
            (output/'SDK-CARRIER.json').write_text('{"state":"synthetic-test-only"}')
            with mock.patch.dict(os.environ,{'RUNNER_TEMP':str(root),'SUDO_UID':str(os.getuid()),'SUDO_GID':str(os.getgid())}):
                s.export(output)
                summary=json.loads((root/'gcc-sdk-diagnostics/SUMMARY.json').read_bytes())
                self.assertTrue(summary['completeRawSdkStdoutExportAssessed'])
                self.assertFalse(summary['nativeEvidenceCreditAssessed']);self.assertFalse(summary['originalGccPhaseAdvanced'])
                self.assertEqual(gzip.decompress((root/'gcc-sdk-diagnostics/sdk-native.log.gz').read_bytes()),raw)
                with self.assertRaisesRegex(ValueError,'Fresh SDK diagnostic'):s.export(output)

    def test_compressed_sdk_metadata_has_exact_roundtrip_and_no_source_body_execution(self):
        with tempfile.TemporaryDirectory() as name:
            path=Path(name)/'metadata.json.gz';value={'syntheticRows':[{'path':'/usr/synthetic-a','hash':'a'*64},{'path':'/usr/synthetic-b','hash':'b'*64}]}
            result=b.compressed_json(path,value);raw=gzip.decompress(path.read_bytes());self.assertEqual(json.loads(raw),value)
            self.assertEqual(result['expandedSha256'],hashlib.sha256(raw).hexdigest())
            self.assertEqual(result['bytes'],path.stat().st_size)

if __name__=='__main__':
    result=unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite([unittest.defaultTestLoader.loadTestsFromTestCase(Hosted),unittest.defaultTestLoader.loadTestsFromTestCase(Body)]))
    print(json.dumps({'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'skips':len(result.skipped),
                      'dockerCompilerOrUpstreamExecuted':False,'originalSourceConfigurationReaderInjectedForSyntheticPredecessor':True}));raise SystemExit(not result.wasSuccessful())
