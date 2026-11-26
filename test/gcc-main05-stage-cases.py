import copy
import importlib.util
import json
import hashlib
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parent.parent

def load(path):
    spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


m=load(ROOT/'scripts/producer-qualification/gcc-main05-stage.py')
f=load(Path(__file__).with_name('gcc-staged-cases.py'))


class MainStage(unittest.TestCase):
    def test_actual_retained_command_helper_nonzero_is_not_wrapper_exit_or_exception_type(self):
        with tempfile.TemporaryDirectory() as d:
            source=Path(d);records=source/'commands.jsonl'
            with patch.object(m.stage.subprocess,'run',return_value=SimpleNamespace(returncode=3)) as run:
                with self.assertRaisesRegex(ValueError,'Original native command failed'):
                    m.stage.command_record(m.COMMAND,source,records,'original-main05')
            run.assert_called_once_with(m.COMMAND,cwd=source,check=False)
            observed=m.command_terminal(records,source)
            self.assertEqual(observed['exitCode'],3);self.assertIsNone(observed['signal'])
            self.assertTrue(observed['terminalObserved']);self.assertGreaterEqual(observed['elapsedSeconds'],0)

    def test_signal_is_retained_without_inventing_exit137(self):
        with tempfile.TemporaryDirectory() as d:
            source=Path(d);records=source/'commands.jsonl'
            with patch.object(m.stage.subprocess,'run',return_value=SimpleNamespace(returncode=-15)):
                with self.assertRaises(ValueError):m.stage.command_record(m.COMMAND,source,records,'original-main05')
            observed=m.command_terminal(records,source)
            self.assertIsNone(observed['exitCode']);self.assertEqual(observed['signal'],15)

    def test_partial_wrong_reordered_command_and_malformed_terminal_refuse(self):
        with tempfile.TemporaryDirectory() as d:
            source=Path(d);records=source/'commands.jsonl'
            with patch.object(m.stage.subprocess,'run',return_value=SimpleNamespace(returncode=0)):
                m.stage.command_record(m.COMMAND,source,records,'original-main05')
            original=[json.loads(raw) for raw in records.read_bytes().splitlines()]
            mutations=[original[:1],list(reversed(original)),copy.deepcopy(original),copy.deepcopy(original),copy.deepcopy(original)]
            mutations[2][1]['command']=m.COMMAND[:-1]+['--rules-target=build']
            mutations[3][1]['exitCode']=True
            mutations[4][1]['signal']=15
            for changed in mutations:
                records.write_text(''.join(json.dumps(row)+'\n' for row in changed))
                with self.subTest(changed=changed),self.assertRaises(ValueError):m.command_terminal(records,source)

    def test_sdk_projection_binds_the_current_validated_cache_not_historical_or_later_changed_bodies(self):
        handoff_fixtures=load(Path(__file__).with_name('gcc-main05-sdk-cases.py'))
        with tempfile.TemporaryDirectory() as name:
            root=Path(name).resolve();values=list(handoff_fixtures.fixture(root));original,current,binding=values[:3]
            payload=b'synthetic\t1\tamd64\n';package_sha=hashlib.sha256(payload).hexdigest()
            binding['binding']['packageInventorySha256']=package_sha;values[4]['originalPackageManifestSha256']=package_sha
            verified=m.prepared_sdk.inspect(*values[:6])
            state=root/'state';(state/'__carrier_work').mkdir(parents=True)
            (state/'__carrier_work/external-sdk-before.json').write_bytes(m.stage.canonical(original))
            output=root/'observations';output.mkdir()
            def package_query(command,**kwargs):
                self.assertEqual(command,['dpkg-query','-W','-f=${Package}\t${Version}\t${Architecture}\n'])
                self.assertTrue(kwargs['check']);kwargs['stdout'].write(payload);return SimpleNamespace(returncode=0)
            self.assertFalse(m.material.compare(original,current,package_sha,package_sha)['materialProjectionMatches'])
            with patch.object(m.prepared_sdk,'read_prepared',return_value=verified),patch.object(m.stage,'external_inventory',return_value=current),\
                 patch.object(m.subprocess,'run',side_effect=package_query):
                witness=m.sdk_projection(state,binding,output,'before')
                self.assertTrue(witness['materialProjectionMatches']);self.assertEqual(witness['counts']['unresolvedMaterial'],0)
                self.assertEqual(witness['preparedGeneratedStateWitness']['files'],51);self.assertFalse(witness['historicalCacheBodyEqualityClaimed'])
                changed=copy.deepcopy(current);path=next(iter(m.prepared_sdk.d.KNOWN_MODES))
                next(row for row in changed['entries'] if row['path']==path)['sha256']='f'*64
                with patch.object(m.stage,'external_inventory',return_value=changed):
                    with self.assertRaisesRegex(ValueError,'SDK material/mtime mismatch'):m.sdk_projection(state,binding,output,'after')
                self.assertTrue((output/'SDK-PROJECTION-after.json').exists())
                self.assertEqual(json.loads((output/'SDK-PROJECTION-after.json').read_bytes())['counts']['unresolvedMaterial'],1)

    def test_physical_complete_predecessor_and_each_state_or_rule_change_refuse(self):
        with tempfile.TemporaryDirectory() as d:
            state=Path(d).resolve();source=state/'source';source.mkdir();(source/'stamps').mkdir()
            (source/'stamps/04-configure-stamp').write_bytes(b'synthetic-configured')
            work=state/'__carrier_work';work.mkdir();(work/'home').mkdir();(work/'original-report.log').write_bytes(b'synthetic old report')
            config=f.configuration(hppa64=True)
            config['variables']['CONFARGS']='--enable-languages='+m.stage.LANGUAGES+' --enable-multilib --enable-offload-targets=nvptx-none,amdgcn-amdhsa'
            ledger=m.planner.new_ledger(config);ledger=m.planner.append_attempt(ledger,config,f.completed(ledger,config))
            ledger['attempts'][0]['checkpointSha256']=m.PREDECESSOR_SHA
            binding=f.binding(configurationSha256=m.planner.sha(m.planner.canonical(config)))
            tree=m.codec.snapshot(state,m.codec.Budget({'treeBytes':m.codec.LIMITS['treeBytes']}))
            digest=m.codec.sha(m.codec.canonical({'schemaVersion':1,'binding':binding,'tree':tree}))
            root={'binding':binding,'archiveSha256':m.PREDECESSOR_SHA,'manifestSha256':digest}
            # Only the independent synthetic archive-manifest identity and
            # synthetic rendered-reader are injected. Real filesystem byte,
            # mode, link and report inventory plus full selection guards run.
            with patch.object(m,'PREDECESSOR_MANIFEST_SHA',digest),patch.object(m.planner,'read_configuration',return_value=config):
                self.assertEqual(m.predecessor(state,root,ledger)[0],config)
                report=work/'original-report.log';original=report.read_bytes();report.write_bytes(b'changed report')
                with self.assertRaisesRegex(ValueError,'Complete physical'):m.predecessor(state,root,ledger)
                report.write_bytes(original)
                # Restoring bytes alone leaves changed timestamps. Restore ALL
                # original typed metadata before testing a distinct boundary.
                for row in sorted(tree['entries'],key=lambda row:len(Path(row['path']).parts),reverse=True):m.codec.set_metadata(state/row['path'],row)
                config['variables']['CONFARGS']=config['variables']['CONFARGS'].replace('--enable-multilib','--disable-multilib')
                with self.assertRaisesRegex(ValueError,'multilib'):m.predecessor(state,root,ledger)


if __name__=='__main__':unittest.main(verbosity=2)
