"""Synthetic cache bytes/identity controls; no HTTP or producer code executes.

The source-catalog validator is separately covered by the 37 core controls;
these transport fixtures inject its valid data result, never third-party source.
"""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
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
t=load(MODULE/'gcc-main05-transport.py');cap=load(MODULE/'gcc-main05-service.py')
existing=load(ROOT/'test/gcc-staged-cases.py');codec=existing.c;p=existing.p


class Transport(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='gcc-cache-synthetic-');self.root=Path(self.tmp.name).resolve()
        self.output=self.root/'output';self.output.mkdir();self.state=self.output/'state';self.state.mkdir()
        (self.state/'source').mkdir();(self.state/'source/synthetic-source').write_bytes(b'Complete synthetic source bytes')
        (self.state/'__carrier_work').mkdir();(self.state/'__carrier_work/report').write_bytes(b'Complete synthetic report bytes')
        (self.state/'source/stamps').mkdir();(self.state/'source/stamps/04-configure-stamp').write_bytes(b'Synthetic configure stamp');(self.state/'source/stamps/05-build-stamp').write_bytes(b'Synthetic complete bootstrap stamp')
        self.config=existing.configuration(hppa64=True);self.config_hash=p.sha(p.canonical(self.config))
        old=p.new_ledger(self.config);old=p.append_attempt(old,self.config,existing.completed(old,self.config))
        self.binding={**existing.binding(configurationSha256=self.config_hash),'phase':'native','sequence':1,'predecessorSha256':p.validate_ledger(old,self.config)[1]}
        self.checkpoint=codec.capture(self.state,self.output/'checkpoint',self.binding)
        ledger=old;row=existing.completed(ledger,self.config);row['checkpointSha256']=self.checkpoint['archiveSha256']
        self.ledger=p.append_attempt(ledger,self.config,row)
        (self.output/'PHASE-LEDGER.json').write_bytes(p.canonical(self.ledger))
        self.selected={'GITHUB_SHA':'a'*40,'GITHUB_RUN_ID':'12','GITHUB_RUN_ATTEMPT':'1','GITHUB_REF':'refs/heads/diagnostic/synthetic'}
        (self.output/'CHECKPOINT-ROOT.json').write_bytes(t.canonical({'binding':self.binding,'sourceServiceContext':self.selected}))
        self.environment={'RUNNER_TEMP':str(self.root),'SUDO_UID':str(os.getuid() or 1001),'SUDO_GID':str(os.getgid() or 1001)}
        original_stat=Path.stat
        expected_paths={self.output/'TRANSPORT-EXPECTED.json',self.output/'SERVICE-RESTORE-REQUEST.json'}
        def root_owned(path,*args,**kwargs):
            value=original_stat(path,*args,**kwargs)
            if path in expected_paths:
                fields=list(value);fields[4]=0;return os.stat_result(fields)
            return value
        self.stat_patch=mock.patch.object(Path,'stat',root_owned);self.stat_patch.start()
        self.chown_patch=mock.patch.object(t.os,'chown');self.chown_patch.start()
        self.uid_patch=mock.patch.object(t.os,'getuid',return_value=0);self.uid_patch.start()
        self.expected=t.prepare(self.output,cap,self.selected,self.environment,codec)
    def tearDown(self):
        self.uid_patch.stop();self.chown_patch.stop();self.stat_patch.stop();self.tmp.cleanup()

    def replay_copy(self):
        t.prepare_restore(self.output,self.selected,cap,codec,self.environment)
        original=t.transport_path(self.environment)
        shutil.copytree(original.with_name(original.name+'-captured-original'),original)
        return original

    def verify(self,*,size=None,occupied=9727804720):
        fake_planner=types.SimpleNamespace(read_configuration=lambda *args:self.config,
            sha=p.sha,canonical=p.canonical,validate_ledger=p.validate_ledger)
        entry={'id':123,'key':self.expected['key'],'ref':self.expected['ref'],
               'size_in_bytes':size or self.expected['archive']['bytes']+2048}
        api=types.SimpleNamespace(get=lambda query:({'total_count':1,'actions_caches':[entry]},{}))
        service={'clock':{'remainingSeconds':20000},'cache':{'observedOccupiedBytes':occupied}}
        with mock.patch.object(cap,'capture_service',return_value=service):
            return t.verify(self.output,self.selected,cap,codec,fake_planner,api,self.environment)

    def test_closed_envelope_is_measured_and_original_must_be_moved_aside(self):
        self.assertGreater(self.expected['envelope']['envelopeLogicalBytesMeasured'],0)
        self.assertFalse(self.expected['restoreReplayed'])
        with self.assertRaises((ValueError,FileNotFoundError)):self.verify()
        self.assertTrue(t.transport_path(self.environment).is_dir())

    def test_service_restore_physically_replays_all_synthetic_source_report_state(self):
        self.replay_copy();value=self.verify()
        self.assertTrue(value['fullSourceReportsAndMountStatePhysicallyReplayed'])
        self.assertTrue(value['cacheSaveAndRestoreReplayed']);self.assertEqual(value['nextPhase'],'jit')
        self.assertEqual(p.validate_ledger(value['phaseLedger'],self.config)[3],2)
        self.assertFalse(value['fullCompilerSdkBootstrapClosureVerified']);self.assertFalse(value['gateAComplete'])

    def test_changed_archive_cannot_authenticate_itself_from_cache_metadata(self):
        restored=self.replay_copy();archive=restored/'tree.tar.gz';archive.chmod(0o600)
        raw=bytearray(archive.read_bytes());raw[4]^=1;archive.write_bytes(raw)
        receipt=json.loads((restored/'receipt.json').read_bytes());receipt['archiveSha256']=hashlib.sha256(raw).hexdigest()
        (restored/'receipt.json').chmod(0o600);(restored/'receipt.json').write_bytes(t.canonical(receipt))
        with self.assertRaisesRegex(ValueError,'independent captured identity'):self.verify()
        self.assertFalse((self.output/'FINAL-PHASE-LEDGER.json').exists())

    def test_extra_missing_and_changed_envelope_members_refuse(self):
        restored=self.replay_copy();(restored/'extra.json').write_bytes(b'{}')
        with self.assertRaisesRegex(ValueError,'Missing/extra'):self.verify()
        (restored/'extra.json').unlink();(restored/'PHASE-LEDGER.json').chmod(0o600)
        (restored/'PHASE-LEDGER.json').write_bytes(b'{}')
        with self.assertRaisesRegex(ValueError,'metadata differs'):self.verify()

    def test_source_branch_head_and_actual_service_size_or_free_bound_cannot_drift(self):
        changed={**self.selected,'GITHUB_SHA':'b'*40}
        with self.assertRaisesRegex(ValueError,'source/policy'):
            t.expected_record(self.output,changed,cap)
        self.replay_copy()
        with self.assertRaisesRegex(ValueError,'service cache wrapper'):
            self.verify(size=cap.CHECKPOINT_BYTES+cap.ENVELOPE_BYTES+1)
        self.assertFalse((self.output/'FINAL-PHASE-LEDGER.json').exists())

    def test_over_free_storage_observation_withholds_phase_advance(self):
        self.replay_copy()
        with self.assertRaisesRegex(ValueError,'free-included storage'):
            self.verify(occupied=cap.FREE_CACHE_BYTES+1)
        self.assertFalse((self.output/'FINAL-PHASE-LEDGER.json').exists())

    def test_stale_restore_intent_refuses_without_moving_original(self):
        (self.output/'SERVICE-RESTORE-REQUEST.json').write_bytes(b'{}')
        with self.assertRaisesRegex(ValueError,'Stale service-restore request'):
            t.prepare_restore(self.output,self.selected,cap,codec,self.environment)
        self.assertTrue(t.transport_path(self.environment).is_dir())


if __name__=='__main__':
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Transport))
    print(json.dumps({'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'skips':len(result.skipped),
                     'sourceOrCompilerExecuted':False,'httpRequested':False,'sourceCatalogResultInjectedForSyntheticTransportFixture':True,'rootOwnershipMetadataInjectedForSyntheticTransportFixture':True}))
    raise SystemExit(not result.wasSuccessful())
