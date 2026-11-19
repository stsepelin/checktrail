"""Synthetic lossless reports and package identities; no producer/project executes."""
import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('gcc_staged_evidence',ROOT/'scripts/producer-qualification/gcc-staged-phase-evidence.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


class Evidence(unittest.TestCase):
 def fixture(self,root,*,empty=False,logs=True):
  state=root.resolve()/'state';output=root.resolve()/'observations';output.mkdir()
  reports=state/'source/build-jit/gcc/testsuite/jit';reports.mkdir(parents=True)
  (reports/'jit.sum').write_bytes(b'' if empty else b'PASS: synthetic-one\nFAIL: synthetic-two\n')
  if logs:(reports/'jit.log').write_bytes(b'Synthetic raw original associated log\xff\x00\n')
  return state,output,reports

 def test_existing_firstparty_collector_and_codec_retain_all_synthetic_report_and_log_bytes(self):
  with tempfile.TemporaryDirectory() as name:
   state,output,source=self.fixture(Path(name));result=m.collect_reports(state,output)
   self.assertEqual(result['originalTestReportEvidence']['reports'],1)
   self.assertEqual(result['originalTestReportEvidence']['logicalBytes'],(source/'jit.sum').stat().st_size)
   self.assertFalse(result['originalTestReportEvidence']['allOriginalTestsPassRequired']);self.assertFalse(result['allOriginalTestsPassedAssessed'])
   self.assertFalse(result['reportBodiesCreatedByThisPhaseAssessed']);self.assertFalse(result['gateAComplete'])
   manifest=json.loads((output/'test-reports.json').read_bytes());self.assertEqual(manifest['reports'][0]['counts']['FAIL'],1)
   rows=result['replay']['logicalFiles'];self.assertEqual(len(rows),2)
   for row in rows:
    original=state/'source'/row['file'];self.assertEqual(row['sha256'],m.codec.sha(original.read_bytes()))
   self.assertEqual(result['replay']['decodedBytes'],sum(row['bytes'] for row in rows))
   self.assertTrue(result['replay']['allRetainedOriginalReportsAndAssociatedLogsPhysicallyReplayed'])
   with self.assertRaisesRegex(ValueError,'Fresh'):m.collect_reports(state,output)

 def test_empty_reports_nonempty_logs_or_orphan_logs_cannot_be_nonempty_report_evidence(self):
  for kind in ['empty','orphan']:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as name:
    state,output,source=self.fixture(Path(name),empty=kind=='empty')
    if kind=='orphan':(source/'jit.sum').unlink()
    with self.assertRaisesRegex(ValueError,'nonempty report bodies unavailable'):m.collect_reports(state,output)
    self.assertTrue((output/'test-reports.json').is_file())

 def test_later_report_chunk_corruption_is_not_authenticated_from_original_manifest_alone(self):
  with tempfile.TemporaryDirectory() as name:
   state,output,_=self.fixture(Path(name));m.collect_reports(state,output)
   manifest=json.loads((output/'test-reports.json').read_bytes());chunk=output/'original-test-reports'/manifest['reports'][0]['chunks'][0]['file']
   raw=bytearray(chunk.read_bytes());raw[-1]^=1;chunk.write_bytes(raw)
   with self.assertRaises((ValueError,RuntimeError)):m.replay_reports(manifest,output/'original-test-reports')

 def test_associated_log_is_independently_replayed_not_just_the_sum_file(self):
  with tempfile.TemporaryDirectory() as name:
   state,output,_=self.fixture(Path(name));m.collect_reports(state,output)
   manifest=json.loads((output/'test-reports.json').read_bytes());chunk=output/'original-test-reports'/manifest['reports'][0]['log']['chunks'][0]['file']
   chunk.unlink()
   with self.assertRaises((ValueError,RuntimeError,FileNotFoundError)):m.replay_reports(manifest,output/'original-test-reports')

 def test_report_or_associated_log_symlink_refuses_without_reading_foreign_bytes(self):
  for name in ['jit.sum','jit.log']:
   with self.subTest(name=name),tempfile.TemporaryDirectory() as dirname:
    root=Path(dirname).resolve();state,output,reports=self.fixture(root);(reports/name).unlink();foreign=root/'foreign';foreign.write_bytes(b'Synthetic foreign data')
    (reports/name).symlink_to(foreign)
    with self.assertRaises((ValueError,RuntimeError)):m.collect_reports(state,output)
    self.assertEqual(foreign.read_bytes(),b'Synthetic foreign data')

 def packages(self,root):
  state=root.resolve()/'state';state.mkdir()
  for name in ['synthetic_1_amd64.deb','synthetic_1_amd64.changes','synthetic_1_amd64.buildinfo']:(state/name).write_bytes(b'Synthetic opaque artifact '+name.encode())
  return state

 def test_exact_package_suffix_identities_do_not_claim_binary_format_or_license_closure(self):
  with tempfile.TemporaryDirectory() as name:
   state=self.packages(Path(name));(state/'synthetic_1_amd64.udeb').write_bytes(b'Synthetic installer artifact')
   (state/'synthetic_1_amd64.deb.saved').write_bytes(b'Synthetic untouched unclassified file')
   result=m.package_outputs(state);self.assertEqual(result['packageOutputKinds'],['buildinfo','changes','deb','udeb'])
   self.assertEqual(len(result['files']),4);self.assertFalse(result['packageFormatVerified']);self.assertFalse(result['packageOutputSetCompletenessVerified'])
   self.assertFalse(result['originalNoticeOrLicenseClosureVerified']);self.assertFalse(result['producerOrPackageExecuted']);self.assertFalse(result['gateAComplete'])
   self.assertTrue(result['allOriginalMutableStateMustStillBeCheckpointed']);self.assertTrue((state/'synthetic_1_amd64.deb.saved').exists())
   for row in result['files']:self.assertEqual(row['sha256'],m.codec.sha((state/row['file']).read_bytes()))

 def test_empty_missing_symlink_or_near_suffix_does_not_supply_required_package_families(self):
  for kind in ['empty','missing','link','near']:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as name:
    root=Path(name).resolve();state=self.packages(root);package=state/'synthetic_1_amd64.deb'
    if kind=='empty':package.write_bytes(b'')
    if kind=='missing':package.unlink()
    if kind=='near':package.rename(package.with_suffix('.deb.backup'))
    if kind=='link':package.rename(root/'foreign');package.symlink_to(root/'foreign')
    with self.assertRaises(ValueError):m.package_outputs(state)


if __name__=='__main__':unittest.main(verbosity=2)
