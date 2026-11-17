"""Synthetic report/package bodies only; no SDK, Docker or source execution."""
import copy,gzip,io,json,os,struct,sys,tarfile,tempfile,time,unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0,str(Path(__file__).resolve().parent))
import common,observer

class ObserverControls(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory(prefix='sdk10-observer-synthetic-');self.root=Path(self.temp.name)
 def tearDown(self):self.temp.cleanup()
 def report(self,body):return observer.natural_report(body.encode())
 def test_junit_positive_nested_suites_with_actual_rows_and_reconciled_counters(self):
  row=self.report('<testsuites tests="2"><testsuite tests="1" failures="0"><testcase name="one"/></testsuite><testsuite tests="1" errors="0"><testcase name="two" status="run" result="completed"/></testsuite></testsuites>')
  self.assertEqual(row['outcomes'],['passed','passed']);self.assertTrue(row['allReportedTestsPassed'])
 def test_junit_counters_unknown_states_skips_failures_and_hidden_rows_get_no_pass(self):
  bodies=['<testsuite tests="2"><testcase/></testsuite>','<testsuite tests="1"><testcase status="banana"/></testsuite>','<testsuite tests="1"><testcase><skipped/></testcase></testsuite>','<testsuite tests="1" failures="0"><testcase><failure/></testcase></testsuite>','<testsuite tests="1"><wrapper><testcase/></wrapper></testsuite>','<testsuite tests="1"><testcase><wrapper><failure/></wrapper></testcase></testsuite>','<testsuite tests="1"><error/><testcase/></testsuite>','<testsuites tests="1"><testcase/></testsuites>']
  for body in bodies:
   with self.subTest(body=body):self.assertFalse(self.report(body)['allReportedTestsPassed'])
 def test_trx_positive_two_rows_requires_counters_and_success_summary(self):
  row=self.report('<TestRun><Results><UnitTestResult outcome="Passed"/><UnitTestResult outcome="Passed"/></Results><ResultSummary outcome="Completed"><Counters total="2" executed="2" passed="2" failed="0"/></ResultSummary></TestRun>')
  self.assertEqual(row['tests'],2);self.assertTrue(row['allReportedTestsPassed'])
 def test_trx_missing_summary_counter_mismatch_duplicate_result_scope_or_skip_no_pass(self):
  bodies=['<TestRun><Results><UnitTestResult outcome="Passed"/></Results></TestRun>','<TestRun><Results><UnitTestResult outcome="Passed"/></Results><ResultSummary outcome="Passed"><Counters total="1" executed="1" passed="2"/></ResultSummary></TestRun>','<TestRun><Results><UnitTestResult outcome="NotExecuted"/></Results><ResultSummary outcome="Completed"><Counters total="1" executed="0" passed="0" notExecuted="1"/></ResultSummary></TestRun>','<TestRun><Results><UnitTestResult outcome="Passed"/></Results><Results/><ResultSummary outcome="Passed"><Counters total="1" executed="1" passed="1"/></ResultSummary></TestRun>']
  for body in bodies:
   with self.subTest(body=body):self.assertFalse(self.report(body)['allReportedTestsPassed'])
 def test_trx_error_info_and_run_level_error_cannot_hide_behind_passing_counters(self):
  for error in ['<RunInfos><RunInfo outcome="Error"/></RunInfos>','<Output><ErrorInfo><Message>synthetic error</Message></ErrorInfo></Output>']:
   body='<TestRun><Results><UnitTestResult outcome="Passed"/></Results><ResultSummary outcome="Passed"><Counters total="1" executed="1" passed="1"/>'+error+'</ResultSummary></TestRun>'
   self.assertFalse(self.report(body)['allReportedTestsPassed'])
 def test_escaped_diagnostic_text_is_not_an_xml_failure_element(self):
  self.assertTrue(self.report('<testsuite tests="1"><testcase/><system-out>&lt;error/&gt;</system-out></testsuite>')['allReportedTestsPassed'])
 def test_xunit_positive_assembly_and_collection_counters_reconcile(self):
  row=self.report('<assemblies><assembly total="2" passed="2" failed="0" skipped="0" errors="0"><collection total="2" passed="2"><test result="Pass"/><test result="Pass"/></collection></assembly></assemblies>')
  self.assertTrue(row['allReportedTestsPassed']);self.assertEqual(row['outcomes'],['passed','passed'])
 def test_xunit_root_error_or_hidden_pass_failure_or_summary_mismatch_no_pass(self):
  bodies=['<assemblies><error/><assembly total="1" passed="1" failed="0" skipped="0"><test result="Pass"/></assembly></assemblies>','<assembly total="1" passed="1" failed="0" skipped="0"><test result="Pass"><wrapper><failure/></wrapper></test></assembly>','<assembly total="1" passed="1" failed="0" skipped="0"><collection total="2"><test result="Pass"/></collection></assembly>','<assembly total="1" passed="0" failed="0" skipped="1"><test result="Skip"><reason/></test></assembly>']
  for body in bodies:
   with self.subTest(body=body):self.assertFalse(self.report(body)['allReportedTestsPassed'])
 def test_unknown_empty_and_external_declarations_never_earn_pass(self):
  for body in ['<root><testcase/></root>','<testsuite tests="0"/>','<assemblies/>','<TestRun/>']:
   with self.subTest(body=body):self.assertFalse(self.report(body)['allReportedTestsPassed'])
  with self.assertRaises(common.Refusal):self.report('<!DOCTYPE testsuite [<!ENTITY x "synthetic">]><testsuite tests="1"><testcase name="&x;"/></testsuite>')
 def test_report_credit_needs_successful_original_test_and_fresh_nonfixture_body(self):
  folder=self.root/'artifacts/TestResults';folder.mkdir(parents=True);before=observer.output_inventory([self.root],time.monotonic()+10,'test-reports')
  body=b'<testsuite tests="1"><testcase name="actual-synthetic-result"/></testsuite>';p=folder/'fresh.xml';p.write_bytes(body);passed={'originalCodeExecuted':True,'exitCode':0,'stopReason':None}
  row=observer.reports(self.root,time.monotonic()+10,before=before,original_test=passed);self.assertTrue(row['allCreditedFreshTestsPassed'])
  for command in [None,{'originalCodeExecuted':True,'exitCode':1,'stopReason':None},{'originalCodeExecuted':True,'exitCode':False,'stopReason':None},{'originalCodeExecuted':False,'exitCode':0,'stopReason':None}]:self.assertFalse(observer.reports(self.root,time.monotonic()+10,before=before,original_test=command)['allCreditedFreshTestsPassed'])
  self.assertFalse(observer.reports(self.root,time.monotonic()+10,{'artifacts/TestResults/fresh.xml'},before=before,original_test=passed)['allCreditedFreshTestsPassed'])
  stale=observer.output_inventory([self.root],time.monotonic()+10,'test-reports');os.utime(p,(time.time()+3600,time.time()+3600));self.assertFalse(observer.reports(self.root,time.monotonic()+10,before=stale,original_test=passed)['allCreditedFreshTestsPassed'])
 def test_renamed_stale_body_and_unparsed_or_empty_fresh_report_block_credit(self):
  folder=self.root/'artifacts/TestResults';folder.mkdir(parents=True);p=folder/'old.xml';p.write_bytes(b'<testsuite tests="1"><testcase/></testsuite>');before=observer.output_inventory([self.root],time.monotonic()+10,'test-reports');p.rename(folder/'renamed.xml');passed={'originalCodeExecuted':True,'exitCode':0,'stopReason':None}
  self.assertFalse(observer.reports(self.root,time.monotonic()+10,before=before,original_test=passed)['allCreditedFreshTestsPassed'])
  (folder/'valid.xml').write_bytes(b'<testsuite tests="1"><testcase name="new"/></testsuite>');(folder/'empty.xml').write_bytes(b'<testsuite tests="0"/>')
  self.assertFalse(observer.reports(self.root,time.monotonic()+10,before=before,original_test=passed)['allCreditedFreshTestsPassed'])
 def elf(self,machine=183,interpreter=b'/lib/ld-musl-aarch64.so.1\0'):
  ident=b'\x7fELF\x02\x01\x01'+b'\0'*9;start=64+112;size=start+len(interpreter)
  return struct.pack('<16sHHIQQQIHHHHHH',ident,3,machine,1,0,64,0,0,64,56,2,0,0,0)+struct.pack('<IIQQQQQQ',1,5,0,0,0,size,size,4096)+struct.pack('<IIQQQQQQ',3,4,start,0,0,len(interpreter),len(interpreter),1)+interpreter
 def sdk(self,path=None,changes=None,prefix=''):
  path=path or self.root/'dotnet-sdk-synthetic.tar.gz';members={'dotnet':self.elf(),'sdk/10.0.401/.version':b'a'*40+b'\n10.0.401\nlinux-musl-arm64\n','sdk/10.0.401/dotnet.dll':b'synthetic-sdk-assembly','host/fxr/10.0.1/libhostfxr.so':b'synthetic-hostfxr','shared/Microsoft.NETCore.App/10.0.1/libcoreclr.so':b'synthetic-coreclr','shared/Microsoft.NETCore.App/10.0.1/System.Private.CoreLib.dll':b'synthetic-corelib'}
  for key,value in (changes or {}).items():
   if value is None:members.pop(key,None)
   else:members[key]=value
  with tarfile.open(path,'w:gz') as tar:
   for name,body in members.items():item=tarfile.TarInfo(prefix+name);item.size=len(body);item.mode=0o755 if name=='dotnet' else 0o644;tar.addfile(item,io.BytesIO(body))
  return path
 def fresh(self,before=None,command=None):
  profile={'source':{'commit':'a'*40},'targetRID':'linux-musl-arm64'}
  if before is None:before={'schemaVersion':2,'kind':'sdk-archives','roots':[str(self.root)],'snapshotComplete':True,'createdBeforeOriginalCommand':True,'identityPolicy':'regular-no-symlinks-content-sha256-before-command','entries':{}}
  if command is None:command={'originalCodeExecuted':True,'exitCode':0,'stopReason':None}
  return observer.fresh_sdks([self.root],profile,time.monotonic()+10,before,command)
 def test_complete_fresh_selected_sdk_packaging_qualified_as_metadata_only(self):
  self.sdk();row=self.fresh();self.assertTrue(row['selectedSDKArchiveMetadataAndAttributionObserved']);self.assertFalse(row['productOrBuildQualificationClaimed']);self.assertFalse(row['historicalPublisherBinaryEqualityClaimed'])
 def test_single_dot_prefix_preserves_valid_package_layout_and_full_gzip_integrity(self):
  self.sdk(prefix='./');row=self.fresh();self.assertTrue(row['selectedSDKArchiveMetadataAndAttributionObserved']);self.assertTrue(row['candidates'][0]['fullGzipStreamIntegrityVerified'])
 def test_seed_arch_wrong_rid_version_source_and_missing_runtime_layout_no_credit(self):
  for changes in [{'dotnet':self.elf(machine=62)},{'dotnet':self.elf(interpreter=b'/lib/ld-linux-aarch64.so.1\0')},{'sdk/10.0.401/.version':b'a'*40+b'\n10.0.400\nlinux-musl-arm64\n'},{'sdk/10.0.401/.version':b'b'*40+b'\n10.0.401\nlinux-musl-arm64\n'},{'sdk/10.0.401/.version':b'a'*40+b'\n10.0.401\nlinux-arm64\n'},{'shared/Microsoft.NETCore.App/10.0.1/libcoreclr.so':None}]:
   with self.subTest(changes=list(changes)):self.sdk(changes=changes);self.assertFalse(self.fresh()['selectedSDKArchiveMetadataAndAttributionObserved'])
 def test_copied_or_renamed_prebuild_archive_and_failed_build_no_fresh_credit(self):
  p=self.sdk();before=observer.output_inventory([self.root],time.monotonic()+10,'sdk-archives');p.rename(self.root/'dotnet-sdk-renamed.tar.gz');self.assertFalse(self.fresh(before)['selectedSDKArchiveMetadataAndAttributionObserved'])
  empty={**before,'entries':{}}
  self.assertFalse(self.fresh(empty,{'originalCodeExecuted':True,'exitCode':1,'stopReason':None})['selectedSDKArchiveMetadataAndAttributionObserved'])
 def test_corrupt_gzip_crc_and_truncated_sdk_package_never_earn_credit(self):
  p=self.sdk();good=p.read_bytes();bad=bytearray(good);bad[-8]^=1;p.write_bytes(bad);self.assertFalse(self.fresh()['selectedSDKArchiveMetadataAndAttributionObserved'])
  p.write_bytes(good[:-5]);self.assertFalse(self.fresh()['selectedSDKArchiveMetadataAndAttributionObserved'])
 def test_traversal_and_duplicate_package_member_names_never_earn_credit(self):
  p=self.sdk(changes={'../escape':b'inert'});self.assertFalse(self.fresh()['selectedSDKArchiveMetadataAndAttributionObserved'])
  p=self.sdk();good=p.read_bytes()
  with tarfile.open(fileobj=io.BytesIO(good),mode='r:gz') as tar:members=[(x,tar.extractfile(x).read()) for x in tar if x.isfile()]
  with tarfile.open(p,'w:gz') as tar:
   for item,body in members+[members[0]]:tar.addfile(item,io.BytesIO(body))
  self.assertFalse(self.fresh()['selectedSDKArchiveMetadataAndAttributionObserved'])

if __name__=='__main__':unittest.main(verbosity=2)
