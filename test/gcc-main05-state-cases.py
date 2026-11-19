"""Physical synthetic predecessor relocation; no producer or Docker execution."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('main05_state',ROOT/'scripts/producer-qualification/gcc-main05-state.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


class Relocation(unittest.TestCase):
    def fixture(self,root):
        sdk=root/'gcc-main05/sdk-frame';source=sdk/'predecessor';source.mkdir(parents=True)
        native=root/'gcc-main05/native-frame';native.mkdir()
        (source/'source').mkdir();(source/'__carrier_work').mkdir();(source/'__carrier_apt_lists').mkdir()
        (source/'__carrier_work/report').write_bytes(b'Synthetic complete report')
        (source/'source/object').write_bytes(b'Synthetic original object');os.link(source/'source/object',source/'source/alias')
        (source/'source/pointer').symlink_to('/inert/synthetic-sdk')
        for path in [source/'source/object',source/'source',source/'__carrier_work/report',source]:
            os.utime(path,ns=(1234567890123456789,1234567890123456789),follow_symlinks=False)
        (source/'source/object').chmod(0o640)
        proof={'state':'original-sdk-for-main-prepared-and-locally-snapshotted','ownedContainerCleanup':'removed','ownedSeedCleanup':'removed',
               'originalGccTargetInvoked':False,'originalPhaseAdvanced':False}
        (sdk/'SDK-FOR-MAIN.json').write_text(json.dumps(proof))
        return {'frame':sdk,'predecessor':source,'expectedRoot':{'syntheticNotOriginalProducer':True}},native

    def guard(self,expected):
        # The separately tested original binding/graph guard is injected here;
        # this helper's filesystem relocation and full snapshots remain real.
        def verify(state,root,ledger):
            self.assertEqual(root,{'syntheticNotOriginalProducer':True});self.assertEqual(ledger,{'syntheticLedger':True})
            actual=m.codec.snapshot(state,m.codec.Budget());self.assertEqual(actual,expected)
            return {'syntheticConfiguration':True},actual,12.5
        return verify

    def test_complete_manifest_modes_ns_times_links_and_root_inode_survive_atomic_relocation(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name).resolve();prepared,native=self.fixture(root);source=prepared['predecessor'];identity=source.lstat()
            before=m.codec.snapshot(source,m.codec.Budget())
            with mock.patch.dict(os.environ,{'RUNNER_TEMP':str(root)}),mock.patch.object(m.body,'predecessor',side_effect=self.guard(before)) as guard:
                result=m.activate(prepared,native,{'syntheticLedger':True});self.assertEqual(guard.call_count,2)
            destination=result['state'];self.assertFalse(source.exists());self.assertEqual(destination,native/'state')
            self.assertEqual((destination.stat().st_dev,destination.stat().st_ino),(identity.st_dev,identity.st_ino))
            self.assertEqual(m.codec.snapshot(destination,m.codec.Budget()),before)
            self.assertEqual((destination/'source/object').stat().st_ino,(destination/'source/alias').stat().st_ino)
            self.assertEqual((destination/'source/object').stat().st_mtime_ns,1234567890123456789)
            self.assertEqual(os.readlink(destination/'source/pointer'),'/inert/synthetic-sdk')
            self.assertEqual(result['activeTreeBytes'],min(result['activeTreeLogicalBytes'],result['activeTreeAllocatedBytes']))
            receipt=json.loads((native/'PREDECESSOR-ACTIVATION.json').read_bytes())
            self.assertEqual(receipt['state'],'complete-original-predecessor-relocated-and-reverified')
            self.assertFalse(receipt['secondSourceCopyPerformed']);self.assertFalse(receipt['hostDiskFitQualified']);self.assertFalse(receipt['gateAComplete'])

    def test_wrong_paths_stale_destinations_and_unstopped_sdk_preserve_original_source(self):
        for kind in ['wrong-path','existing-state','linked-state','running-sdk','seed-not-removed']:
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as name:
                root=Path(name).resolve();prepared,native=self.fixture(root);before=m.codec.snapshot(prepared['predecessor'],m.codec.Budget())
                if kind=='wrong-path':prepared['predecessor']=root/'unowned'
                if kind=='existing-state':(native/'state').mkdir()
                if kind=='linked-state':(native/'state').symlink_to('/inert/missing')
                if kind in ['running-sdk','seed-not-removed']:
                    file=prepared['frame']/'SDK-FOR-MAIN.json';proof=json.loads(file.read_bytes());proof['ownedContainerCleanup' if kind=='running-sdk' else 'ownedSeedCleanup']='not-removed';file.write_text(json.dumps(proof))
                source=root/'gcc-main05/sdk-frame/predecessor'
                with mock.patch.dict(os.environ,{'RUNNER_TEMP':str(root)}),mock.patch.object(m.codec,'rename_no_replace') as rename:
                    with self.assertRaises(ValueError):m.activate(prepared,native,{'syntheticLedger':True})
                    rename.assert_not_called()
                self.assertEqual(m.codec.snapshot(source,m.codec.Budget()),before)
                self.assertFalse((native/'PREDECESSOR-ACTIVATION.json').exists())

    def test_predecessor_binding_failure_cannot_move_any_bytes(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name).resolve();prepared,native=self.fixture(root)
            with mock.patch.dict(os.environ,{'RUNNER_TEMP':str(root)}),mock.patch.object(m.body,'predecessor',side_effect=ValueError('Synthetic original binding mismatch')),mock.patch.object(m.codec,'rename_no_replace') as rename:
                with self.assertRaisesRegex(ValueError,'original binding'):m.activate(prepared,native,{})
                rename.assert_not_called()
            self.assertTrue(prepared['predecessor'].exists());self.assertFalse((native/'state').exists())

    def test_failed_post_move_verification_retains_actual_data_and_unqualified_receipt(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name).resolve();prepared,native=self.fixture(root);before=m.codec.snapshot(prepared['predecessor'],m.codec.Budget())
            def verify(state,root,ledger):
                if state==native/'state':raise ValueError('Synthetic after-move mismatch')
                return {},before,0
            with mock.patch.dict(os.environ,{'RUNNER_TEMP':str(root)}),mock.patch.object(m.body,'predecessor',side_effect=verify):
                with self.assertRaisesRegex(ValueError,'after-move'):m.activate(prepared,native,{})
            self.assertFalse(prepared['predecessor'].exists());self.assertEqual(m.codec.snapshot(native/'state',m.codec.Budget()),before)
            receipt=json.loads((native/'PREDECESSOR-ACTIVATION.json').read_bytes())
            self.assertEqual(receipt['state'],'predecessor-relocation-requested');self.assertIn('after-move mismatch',receipt['error'])
            self.assertNotIn('completeManifestVerifiedAfterRelocation',receipt);self.assertFalse(receipt['gateAComplete'])

    def test_stale_receipt_refuses_before_relocation(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name).resolve();prepared,native=self.fixture(root);before=m.codec.snapshot(prepared['predecessor'],m.codec.Budget())
            receipt=native/'PREDECESSOR-ACTIVATION.json';receipt.write_bytes(b'Synthetic stale receipt')
            with mock.patch.dict(os.environ,{'RUNNER_TEMP':str(root)}),mock.patch.object(m.body,'predecessor',side_effect=self.guard(before)),mock.patch.object(m.codec,'rename_no_replace') as rename:
                with self.assertRaisesRegex(ValueError,'Fresh predecessor activation'):m.activate(prepared,native,{'syntheticLedger':True})
                rename.assert_not_called()
            self.assertEqual(receipt.read_bytes(),b'Synthetic stale receipt');self.assertTrue(prepared['predecessor'].exists())


if __name__=='__main__':unittest.main(verbosity=2)
