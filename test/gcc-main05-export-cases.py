"""Physical bounded metadata/opaque stdout export; no source/tool/API execution."""
import contextlib
import gzip
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('gcc_main05_export',ROOT/'scripts/producer-qualification/gcc-main05-export.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


class Export(unittest.TestCase):
 def fixture(self,root,*,logs=True):
  output=root/'gcc-main05';output.mkdir();(output/'CARRIER.json').write_text('{"synthetic":true,"gateAComplete":false}')
  for name in ['native-frame','sdk-frame']:
   frame=output/name;(frame/'observations').mkdir(parents=True)
   if logs:(frame/'native.log').write_bytes(b'Synthetic public original opaque stdout\xff\n'*100)
   (frame/'resource-samples.json').write_text('{"synthetic":true,"samples":[]}')
   (frame/'observations/private-source.txt').write_bytes(b'Synthetic excluded unknown body')
   (frame/'state').mkdir();(frame/'state/source.c').write_bytes(b'Synthetic excluded source body')
  (output/'sdk-frame/observations/SDK-RECONSTRUCTION.json').write_text('{"synthetic":true}')
  (output/'native-frame/observations/MAIN05-STAGE.json').write_text('{"synthetic":true}')
  return output

 def active(self,root):
  stack=contextlib.ExitStack();stack.enter_context(mock.patch.dict(os.environ,{'RUNNER_TEMP':str(root),'SUDO_UID':'1001','SUDO_GID':'1001'}))
  stack.enter_context(mock.patch.object(m.os,'chown'));return stack

 def test_complete_opaque_bytes_roundtrip_and_closed_metadata_scope(self):
  with tempfile.TemporaryDirectory() as name:
   root=Path(name).resolve();output=self.fixture(root)
   with self.active(root):summary=m.export(output)
   destination=root/'gcc-main05-diagnostics';self.assertTrue(summary['allPresentOriginalSdkAndMainStdoutExported'])
   self.assertTrue(summary['bothOriginalStdoutFilesActuallyPresent']);self.assertFalse(summary['gateAComplete']);self.assertFalse(summary['originalExecutionCreditAssessed'])
   for label in ['native-frame','sdk-frame']:
    self.assertEqual(gzip.decompress((destination/(label+'-native.log.gz')).read_bytes()),(output/label/'native.log').read_bytes())
   files={row['path'] for row in summary['files']};self.assertIn('sdk-frame/observations/SDK-RECONSTRUCTION.json',files)
   self.assertIn('native-frame/observations/MAIN05-STAGE.json',files)
   self.assertFalse(any('source.c' in p or 'private-source.txt' in p for p in files));self.assertFalse((destination/'native-frame/state').exists())
   self.assertEqual(json.loads((destination/'SUMMARY.json').read_bytes()),summary)
   with self.active(root):
    with self.assertRaisesRegex(ValueError,'Fresh'):m.export(output)

 def test_missing_stdout_is_reported_as_missing_and_never_as_an_execution_pass(self):
  with tempfile.TemporaryDirectory() as name:
   root=Path(name).resolve();output=self.fixture(root,logs=False)
   with self.active(root):summary=m.export(output)
   self.assertFalse(summary['bothOriginalStdoutFilesActuallyPresent']);self.assertFalse(summary['originalExecutionCreditAssessed'])
   for row in summary['logs'].values():self.assertFalse(row['present']);self.assertFalse(row['complete']);self.assertEqual(row['state'],'not-created')

 def test_log_symlink_or_raw_or_compressed_limit_preserves_metadata_and_reports_failed_retention(self):
  for kind in ['link','raw','compressed']:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as name:
    root=Path(name).resolve();output=self.fixture(root);log=output/'native-frame/native.log'
    if kind=='link':
     log.rename(root/'foreign.log');log.symlink_to(root/'foreign.log')
    with self.active(root),mock.patch.object(m,'RAW_LOG_LIMIT',10 if kind=='raw' else 512*1024**2),mock.patch.object(m,'COMPRESSED_LOG_LIMIT',10 if kind=='compressed' else 8*1024**2):
     with self.assertRaisesRegex(ValueError,'stdout export failed'):m.export(output)
    destination=root/'gcc-main05-diagnostics';summary=json.loads((destination/'SUMMARY.json').read_bytes())
    self.assertFalse(summary['allPresentOriginalSdkAndMainStdoutExported']);self.assertEqual(summary['logs']['native-frame']['state'],'original-stdout-retention-failed')
    self.assertFalse((destination/'native-frame-native.log.gz').exists());self.assertTrue((destination/'CARRIER.json').is_file())

 def test_metadata_symlink_or_member_or_total_bound_publishes_no_partial_export(self):
  for kind in ['link','member','total']:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as name:
    root=Path(name).resolve();output=self.fixture(root);metadata=output/'CARRIER.json'
    if kind=='link':
     metadata.rename(root/'foreign.json');metadata.symlink_to(root/'foreign.json')
    with self.active(root),mock.patch.object(m,'METADATA_MEMBER_LIMIT',10 if kind=='member' else 32*1024**2),mock.patch.object(m,'TOTAL_EXPORT_LIMIT',10 if kind=='total' else 64*1024**2):
     with self.assertRaises(ValueError):m.export(output)
    self.assertFalse((root/'gcc-main05-diagnostics').exists());self.assertFalse(list(root.glob('.gcc-main05-diagnostics-*')))

 def test_copy_interruption_or_whole_deadline_cannot_publish_partial_success(self):
  for kind in ['copy','deadline']:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as name:
    root=Path(name).resolve();output=self.fixture(root)
    with self.active(root),mock.patch.object(m,'EXPORT_SECONDS',-1 if kind=='deadline' else 300):
     if kind=='copy':
      with mock.patch.object(m.h,'copy_pinned',side_effect=OSError('Synthetic physical copy failure')):
       with self.assertRaisesRegex(OSError,'physical copy'):m.export(output)
     else:
      with self.assertRaisesRegex(ValueError,'deadline'):m.export(output)
    self.assertFalse((root/'gcc-main05-diagnostics').exists());self.assertFalse(list(root.glob('.gcc-main05-diagnostics-*')))


if __name__=='__main__':unittest.main(verbosity=2)
