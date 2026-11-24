"""Synthetic report/package bodies only; no SDK, Docker or source execution."""
import contextlib,copy,gzip,io,json,os,struct,sys,tarfile,tempfile,time,unittest
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

 def phases(self,build=None,tests=None,record=True,preexisting=None):
  # Drives the production phase handler. Build and test phases share the
  # staging and artifacts roots; only the before-test observer sits between them.
  evidence=self.root/'evidence';evidence.mkdir();staging=self.root/'staging';staging.mkdir();source=self.root/'source';source.mkdir();roots=[str(staging),str(self.root/'artifacts')];profile={'source':{'commit':'a'*40},'targetRID':'linux-musl-arm64'};archive=staging/'dotnet-sdk-10.0.401-linux-musl-arm64.tar.gz'
  if preexisting:preexisting(staging)
  with mock.patch.object(observer,'SDK_OUTPUT_ROOTS',roots),mock.patch.object(observer,'SOURCE_ROOT',str(source)):
   observer.phase('before-build',profile,evidence,time.monotonic()+10)
   if build:build(archive)
   common.freeze(evidence/'original-build-TERMINAL.json',common.encoded({'originalCodeExecuted':True,'exitCode':0,'stopReason':None}))
   if tests is not None:
    if record:observer.phase('before-test',profile,evidence,time.monotonic()+10);self.assertTrue((evidence/'PRE-TEST-OUTPUT-IDENTITIES.json').exists())
    else:common.freeze(evidence/'PRE-TEST-OUTPUT-IDENTITIES.json',common.encoded(observer.output_inventory([str(source)],time.monotonic()+10,'test-reports')))
    tests(archive)
   observer.phase('after',profile,evidence,time.monotonic()+30)
  return common.read_json(evidence/'FRESH-SELECTED-SDK-OUTPUTS.json'),str(archive)
 def test_archive_first_created_during_test_phase_is_not_build_output(self):
  row,path=self.phases(tests=lambda archive:self.sdk(path=archive))
  self.assertFalse(row['selectedSDKArchiveMetadataAndAttributionObserved']);self.assertEqual(row['candidates'],[]);self.assertEqual(row['buildOutputObservation'],'post-build-before-test-record')
  self.assertEqual([(x['path'],x['creditedAsBuildOutput']) for x in row['outputsFirstObservedAfterBuildNotCredited']],[(path,False)])
 def test_build_archive_replaced_during_tests_keeps_the_recorded_build_identity(self):
  wrong_rid={'sdk/10.0.401/.version':b'a'*40+b'\n10.0.401\nlinux-arm64\n'};replacement={'sdk/10.0.401/test-phase-4471.txt':b'replaced-during-tests-4471'}
  for name,built,valid in [('invalid-build-valid-replacement',wrong_rid,False),('valid-build-valid-replacement',None,True)]:
   with self.subTest(name=name):
    self.temp.cleanup();self.temp=tempfile.TemporaryDirectory(prefix='sdk10-observer-synthetic-');self.root=Path(self.temp.name);hashes=[]
    def build(archive):self.sdk(path=archive,changes=built);hashes.append(common.hash_file(archive)[1])
    def tests(archive):self.sdk(path=archive,changes=replacement);hashes.append(common.hash_file(archive)[1])
    row,path=self.phases(build,tests);self.assertNotEqual(hashes[0],hashes[1]);self.assertEqual([x['archive']['sha256'] for x in common.read_json(self.root/'evidence/POST-BUILD-SDK-OUTPUTS.json')['candidates']],[hashes[0]])
    self.assertEqual(row['selectedSDKArchiveMetadataAndAttributionObserved'],valid);self.assertEqual([(x['path'],x['archive']['sha256'],x['finalObservation']) for x in row['candidates']],[(path,hashes[0],'replaced')])
    self.assertEqual(row['buildOutputsAbsentOrReplacedAtFinalObservation'],[path]);self.assertEqual([(x['archive']['sha256'],x['creditedAsBuildOutput']) for x in row['outputsFirstObservedAfterBuildNotCredited']],[(hashes[1],False)])
 def test_build_archive_removed_during_tests_stays_build_output_and_is_reported_absent(self):
  row,path=self.phases(lambda archive:self.sdk(path=archive),lambda archive:archive.unlink())
  self.assertTrue(row['selectedSDKArchiveMetadataAndAttributionObserved']);self.assertEqual([(x['path'],x['finalObservation']) for x in row['candidates']],[(path,'absent')])
  self.assertEqual(row['buildOutputsAbsentOrReplacedAtFinalObservation'],[path]);self.assertEqual(row['outputsFirstObservedAfterBuildNotCredited'],[])
 def test_build_archive_unchanged_through_tests_is_credited_from_the_post_build_record(self):
  row,path=self.phases(lambda archive:self.sdk(path=archive),lambda archive:None)
  self.assertTrue(row['selectedSDKArchiveMetadataAndAttributionObserved']);self.assertEqual([(x['path'],x['finalObservation']) for x in row['candidates']],[(path,'unchanged')]);self.assertTrue(row['observedAfterBuildStoppedBeforeTestPhase'])
  self.assertEqual(row['buildOutputsAbsentOrReplacedAtFinalObservation'],[]);self.assertEqual(row['outputsFirstObservedAfterBuildNotCredited'],[])
 def test_admitted_test_phase_without_post_build_record_gets_no_build_credit(self):
  row,path=self.phases(lambda archive:self.sdk(path=archive),lambda archive:None,record=False)
  self.assertFalse(row['selectedSDKArchiveMetadataAndAttributionObserved']);self.assertIn('INCOMPLETE',row['buildOutputObservation'])
 def test_final_tree_stands_in_for_the_post_build_record_only_without_a_test_phase(self):
  row,path=self.phases(lambda archive:self.sdk(path=archive))
  self.assertTrue(row['selectedSDKArchiveMetadataAndAttributionObserved']);self.assertEqual(row['buildOutputObservation'],'final-tree-no-test-phase-admitted');self.assertEqual([x['finalObservation'] for x in row['candidates']],['unchanged'])

 def report_tree(self):
  results=self.root/'artifacts/TestResults';readable=results/'readable-3301';locked=results/'locked-3301';readable.mkdir(parents=True);locked.mkdir()
  (readable/'visible.xml').write_bytes(b'<testsuite tests="1"><testcase name="visible-preexisting-3301"/></testsuite>');(locked/'hidden.xml').write_bytes(b'<testsuite tests="1"><testcase name="hidden-preexisting-3301"/></testsuite>')
  self.addCleanup(lambda:locked.exists() and os.chmod(locked,0o755));return readable,locked
 @contextlib.contextmanager
 def unlistable(self,folder):
  # Root lists a mode-000 directory, and run_checks fails on any skip, so as
  # root the same listing failure is raised for that one directory instead.
  if os.geteuid()!=0:
   os.chmod(folder,0)
   try:yield
   finally:os.chmod(folder,0o755)
   return
  real=os.scandir
  def scandir(path='.'):
   if os.fspath(path)==str(folder):raise PermissionError(13,'synthetic unlistable directory',str(folder))
   return real(path)
  with mock.patch.object(os,'scandir',scandir):yield
 def test_unlisted_directory_leaves_pre_test_snapshot_incomplete_without_freshness_credit(self):
  readable,locked=self.report_tree()
  with self.unlistable(locked):before=observer.output_inventory([self.root],time.monotonic()+10,'test-reports')
  self.assertFalse(before['snapshotComplete']);self.assertEqual(list(before['entries']),[str(readable/'visible.xml')]);self.assertEqual([x['path'] for x in before['unlistedDirectories']],[str(locked)])
  row=observer.reports(self.root,time.monotonic()+10,before=before,original_test={'originalCodeExecuted':True,'exitCode':0,'stopReason':None})
  self.assertEqual({Path(x['path']).name:x['changedSinceProtectedPreTestSnapshot'] for x in row['reports']},{'visible.xml':False,'hidden.xml':False});self.assertFalse(row['allCreditedFreshTestsPassed'])
 def test_complete_snapshot_credits_only_the_report_written_after_it(self):
  readable,locked=self.report_tree();before=observer.output_inventory([self.root],time.monotonic()+10,'test-reports');self.assertTrue(before['snapshotComplete']);self.assertEqual(before['unlistedDirectories'],[])
  (readable/'fresh.xml').write_bytes(b'<testsuite tests="1"><testcase name="fresh-after-snapshot-3301"/></testsuite>')
  row=observer.reports(self.root,time.monotonic()+10,before=before,original_test={'originalCodeExecuted':True,'exitCode':0,'stopReason':None})
  self.assertEqual({Path(x['path']).name:x['changedSinceProtectedPreTestSnapshot'] for x in row['reports']},{'visible.xml':False,'hidden.xml':False,'fresh.xml':True});self.assertTrue(row['allCreditedFreshTestsPassed']);self.assertTrue(row['reportInventoryComplete'])
 def test_unlisted_directory_in_final_report_scan_blocks_passing_credit(self):
  # A failing report the final scan cannot list must not leave the readable
  # passing report as the whole answer.
  readable,locked=self.report_tree();before=observer.output_inventory([self.root],time.monotonic()+10,'test-reports')
  (readable/'fresh.xml').write_bytes(b'<testsuite tests="1"><testcase name="fresh-after-snapshot-3301"/></testsuite>');(locked/'failed.xml').write_bytes(b'<testsuite tests="1" failures="1"><testcase name="failed-3301"><failure/></testcase></testsuite>')
  with self.unlistable(locked):row=observer.reports(self.root,time.monotonic()+10,before=before,original_test={'originalCodeExecuted':True,'exitCode':0,'stopReason':None})
  self.assertEqual(sorted(Path(x['path']).name for x in row['reports']),['fresh.xml','visible.xml']);self.assertFalse(row['reportInventoryComplete']);self.assertFalse(row['allCreditedFreshTestsPassed'])

 def test_undecodable_build_archive_still_freezes_the_post_build_record(self):
  # A valid gzip header over an invalid DEFLATE block raises zlib.error; the
  # before-test observer must record a negative candidate, not stop the tests.
  def build(archive):archive.write_bytes(bytes.fromhex('1f8b0800000000000003')+b'\x07'+b'undecodable-6627'*8)
  row,path=self.phases(build,lambda archive:None)
  self.assertFalse(row['selectedSDKArchiveMetadataAndAttributionObserved']);self.assertEqual([(x['path'],x['selectedSDKArchiveMetadataAndAttributionMatched'],x['finalObservation']) for x in row['candidates']],[(path,False,'unchanged')])
 def test_only_build_outputs_positively_lost_are_summarized_as_absent_or_replaced(self):
  older=[]
  def preexisting(staging):older.append(self.sdk(path=staging/'dotnet-sdk-preexisting-6627.tar.gz',changes={'sdk/10.0.401/preexisting-6627.txt':b'before-build-6627'}))
  def tests(archive):older[0].unlink();archive.unlink()
  row,path=self.phases(lambda archive:self.sdk(path=archive),tests,preexisting=preexisting)
  self.assertEqual({x['path']:(x['changedSinceProtectedPreBuildSnapshot'],x['finalObservation']) for x in row['candidates']},{str(older[0]):(False,'absent'),path:(True,'absent')})
  self.assertEqual(row['buildOutputsAbsentOrReplacedAtFinalObservation'],[path]);self.assertTrue(row['selectedSDKArchiveMetadataAndAttributionObserved'])
 def test_build_output_hidden_by_an_incomplete_final_inventory_is_not_reported_removed(self):
  hidden=[]
  def build(archive):folder=archive.parent/'nested-6627';folder.mkdir();hidden.append(folder);self.sdk(path=folder/archive.name)
  def tests(archive):stack.enter_context(self.unlistable(hidden[0]))
  with contextlib.ExitStack() as stack:row,path=self.phases(build,tests)
  self.assertEqual([x['finalObservation'] for x in row['candidates']],['not-found-in-incomplete-final-inventory']);self.assertFalse(row['finalOutputInventoryComplete']);self.assertEqual(row['buildOutputsAbsentOrReplacedAtFinalObservation'],[]);self.assertTrue(row['selectedSDKArchiveMetadataAndAttributionObserved'])

if __name__=='__main__':unittest.main(verbosity=2)
