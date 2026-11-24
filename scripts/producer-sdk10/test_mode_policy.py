"""Synthetic mode/config/XML controls; never evaluates upstream build metadata."""
import copy,json,pathlib,sys,tempfile,time,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent));import common,observer
HERE=pathlib.Path(__file__).resolve().parent
# These controls exercise report rules against a verified empty tracked
# baseline; an unavailable baseline withholds all credit.
def known_baseline(*args,**kwargs):return observer.reports(*args,tracked_contents=frozenset(),**kwargs)
class ModeControls(unittest.TestCase):
 def profile(self):return common.bundle_json(HERE/'profile.json')
 def test_both_original_argv_vectors_only_add_the_same_supported_operator_id(self):
  profile=self.profile();suffix=['--official-build-id','20261117.1']
  self.assertEqual(profile['buildArgv'],common.ORIGINAL_BUILD_ARGV+suffix);self.assertEqual(profile['testArgv'],common.ORIGINAL_TEST_ARGV+suffix)
  row=common.original_mode_configuration(profile);self.assertEqual(row['operatorBuildID'],'20261117.1');self.assertFalse(row['historicalPublisherIdentityClaimed'])
 def test_wrong_missing_duplicate_or_different_id_in_either_vector_refuses(self):
  for key in ['buildArgv','testArgv']:
   for change in ['remove','different','duplicate','move','original-changed']:
    profile=self.profile();values=profile[key]
    if change=='remove':del values[-2:]
    if change=='different':values[-1]='20261118.1'
    if change=='duplicate':values+=values[-2:]
    if change=='move':profile[key]=values[-2:]+values[:-2]
    if change=='original-changed':values[0]='different-build.sh'
    with self.subTest(key=key,change=change),self.assertRaises(common.Refusal):common.original_mode_configuration(profile)
 def test_audit_mute_sign_or_skip_flags_are_not_the_supported_mode(self):
  for key in ['buildArgv','testArgv']:
   for arg in ['/p:NuGetAudit=false','--sign','/p:DotNetBuildSign=true','--source-only','--skip-tests']:
    profile=self.profile();profile[key].insert(-2,arg)
    with self.subTest(key=key,arg=arg),self.assertRaises(common.Refusal):common.original_mode_configuration(profile)
 def test_identity_is_operator_metadata_without_historical_publisher_claim(self):
  for patch in [{'historicalPublisherIdentity':True},{'mode':'vendor-official'},{'buildID':'20261118.1'}]:
   profile=self.profile();profile['operatorBuildIdentity'].update(patch)
   with self.subTest(patch=patch),self.assertRaises(common.Refusal):common.original_mode_configuration(profile)
 def test_disabled_audit_is_never_a_pass_or_a_per_project_observation(self):
  mode=common.original_mode_configuration(self.profile());self.assertEqual(mode['auditConfiguredState'],'disabled-by-original-official-mode');self.assertFalse(mode['auditPassingCredit']);self.assertFalse(mode['securityAuditPerformedByController']);self.assertEqual(mode['actualPerProjectEffectiveAuditState'],'unassessed');self.assertFalse(mode['explicitNuGetAuditOverrideAdded'])
 def test_successful_source_build_does_not_turn_zero_or_skipped_tests_into_pass(self):
  for body in [b'<testsuite tests="0"/>',b'<testsuite tests="1" skipped="1"><testcase><skipped/></testcase></testsuite>']:
   with self.subTest(body=body),tempfile.TemporaryDirectory() as td:
    root=pathlib.Path(td);folder=root/'artifacts/TestResults';folder.mkdir(parents=True);before=observer.output_inventory([root],time.monotonic()+10,'test-reports');(folder/'fresh.xml').write_bytes(body)
    row=known_baseline(root,time.monotonic()+10,before=before,original_test={'originalCodeExecuted':True,'exitCode':0,'stopReason':None})
    self.assertFalse(row['allCreditedFreshTestsPassed']);self.assertFalse(row['skippedUnavailableOrEmptyCountAsPassing']);self.assertFalse(common.original_mode_configuration(self.profile())['auditPassingCredit'])
 def test_original_nonwindows_sdk_test_optout_is_separate_nonpassing_metadata(self):
  mode=common.original_mode_configuration(self.profile());self.assertEqual(len(mode['declaredUpstreamTestOptOuts']),1);row=mode['declaredUpstreamTestOptOuts'][0];self.assertEqual(row['project'],'sdk');self.assertEqual(row['originalProperty'],'DotNetBuildTestsOptOut=true');self.assertEqual(row['evidenceKind'],'original-source-metadata-not-runtime-test-result');self.assertFalse(row['passingCredit']);self.assertFalse(mode['upstreamTestOptOutsZeroAndSkippedReportsCountAsPassing'])
 def test_valid_fresh_two_case_report_remains_separate_from_disabled_audit(self):
  with tempfile.TemporaryDirectory() as td:
   root=pathlib.Path(td);folder=root/'artifacts/TestResults';folder.mkdir(parents=True);before=observer.output_inventory([root],time.monotonic()+10,'test-reports');(folder/'fresh.xml').write_bytes(b'<testsuite tests="2"><testcase name="one"/><testcase name="two"/></testsuite>')
   row=known_baseline(root,time.monotonic()+10,before=before,original_test={'originalCodeExecuted':True,'exitCode':0,'stopReason':None});self.assertTrue(row['allCreditedFreshTestsPassed']);self.assertFalse(common.original_mode_configuration(self.profile())['auditPassingCredit'])
if __name__=='__main__':unittest.main(verbosity=2)
