"""Synthetic original-file metadata only; no stock app, license or SDK read."""
from pathlib import Path
from dataclasses import replace
from types import SimpleNamespace
from unittest import mock
import errno,hashlib,io,json,os,signal,stat,sys,tempfile,time,unittest
from contextlib import redirect_stdout
sys.path.insert(0,str(Path(__file__).resolve().parent))
import resolve_sla as S
class Clock:
 def __init__(self,now=0):self.now=now
 def __call__(self):return self.now
class Resolver(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(dir='/private/tmp');self.root=Path(self.tmp.name).resolve();self.app=self.root/'Xcode_26.2.app';self.resources=self.app/'Contents/Resources';self.resources.mkdir(parents=True);self.patch=mock.patch.object(S,'SELECTED_APP',self.app);self.patch.start()
 def tearDown(self):self.patch.stop();self.tmp.cleanup()
 def probe(self,policy=None,clock=None):return S.inventory(policy=policy,clock=clock or Clock())
 def localizations(self,count,body=True):
  for i in range(count):
   p=self.resources/(f'language{i:02}.lproj');p.mkdir()
   if body:(p/'License.rtf').write_bytes(b'SYNTHETIC NOT AN ORIGINAL LICENSE')
 def test_n2_localizations_both_enumerated_once_without_reading_regular_bodies(self):
  self.localizations(2)
  with mock.patch.object(Path,'read_bytes',side_effect=AssertionError('No original regular body reads')):r,body=self.probe()
  self.assertEqual(4,r['counts']['directoriesScanned']);self.assertEqual(2,r['counts']['localizationsScanned']);self.assertEqual(6,r['counts']['entries']);self.assertEqual(2,sum(x['relativePath'].endswith('/License.rtf') for x in r['entries']));self.assertFalse(r['nativeAdmissionGranted']);self.assertFalse(r['originalRegularFileBodiesOpened']);self.assertEqual(r,json.loads(body));self.assertEqual(str(self.app),r['selectedApp'])
 def test_original_regular_candidate_is_metadata_not_license_qualification(self):
  p=self.resources/'English.lproj';p.mkdir();(p/'License.rtf').write_bytes(b'UNREAD SYNTHETIC BODY')
  r,_=self.probe();self.assertEqual({'status':'observed','kind':'regular','relativePath':S.ORIGINAL_SELECTOR},r['originalSelector']);self.assertFalse(r['licenseLocatedQualifiedOrRetained']);self.assertNotIn('UNREAD SYNTHETIC BODY',json.dumps(r))
 def test_missing_localization_and_missing_file_are_distinct(self):
  a,_=self.probe();self.assertEqual('missing-localization-directory',a['originalSelector']['status']);(self.resources/'English.lproj').mkdir();b,_=self.probe();self.assertEqual('missing-file',b['originalSelector']['status'])
 def test_wrong_type_localization_is_not_traversed(self):
  (self.resources/'English.lproj').write_bytes(b'synthetic');r,_=self.probe();self.assertEqual('blocked-by-ancestor',r['originalSelector']['status']);self.assertEqual('regular',r['originalSelector']['ancestorKind']);self.assertEqual(2,r['counts']['directoriesScanned'])
 def test_symlink_localization_and_regular_candidate_not_followed(self):
  other=self.root/'outside';other.mkdir();(other/'secret').write_bytes(b'NEVER READ');(self.resources/'English.lproj').symlink_to(other,target_is_directory=True);r,_=self.probe();self.assertEqual('symlink',r['originalSelector']['ancestorKind']);self.assertFalse(any('secret' in x['relativePath'] for x in r['entries']));(self.resources/'English.lproj').unlink();p=self.resources/'English.lproj';p.mkdir();(p/'License.rtf').symlink_to(other/'secret');r,_=self.probe();self.assertEqual('symlink',r['originalSelector']['kind']);self.assertFalse(r['licenseLocatedQualifiedOrRetained'])
 def test_resources_wrong_type_and_missing_are_distinct_incomplete_observations(self):
  self.resources.rmdir();self.resources.write_bytes(b'SYNTHETIC');r,_=self.probe();self.assertFalse(r['requestedScopeFullyObserved']);self.assertEqual('regular',r['originalSelector']['ancestorKind']);self.resources.unlink();r,_=self.probe();self.assertFalse(r['requestedScopeFullyObserved']);self.assertEqual('missing',r['originalSelector']['ancestorStatus'])
 def test_inaccessible_required_directory_is_not_reported_missing(self):
  real=os.stat
  def denied(path,*a,**kw):
   if path=='Resources' and kw.get('dir_fd') is not None:raise PermissionError(errno.EACCES,'synthetic denied')
   return real(path,*a,**kw)
  with mock.patch.object(S.os,'stat',side_effect=denied):r,_=self.probe()
  self.assertFalse(r['requestedScopeFullyObserved']);self.assertEqual('inaccessible',r['originalSelector']['ancestorStatus'])
 def test_scandir_denial_is_explicit_and_does_not_gain_full_scope(self):
  real=os.scandir;target=self.resources.stat().st_ino
  def denied(path):
   if isinstance(path,int) and os.fstat(path).st_ino==target:raise PermissionError(errno.EACCES,'synthetic denied')
   return real(path)
  with mock.patch.object(S.os,'scandir',side_effect=denied):r,_=self.probe()
  self.assertFalse(r['requestedScopeFullyObserved']);self.assertEqual('inaccessible',r['directoryScopes'][-1]['status']);self.assertEqual('not-observed',r['originalSelector']['status'])
 def test_unknown_os_error_stays_unknown(self):
  real=os.stat
  def bad(path,*a,**kw):
   if path=='Resources' and kw.get('dir_fd') is not None:raise OSError(errno.EIO,'SYNTHETIC UNKNOWN NEVER EMITTED')
   return real(path,*a,**kw)
  with mock.patch.object(S.os,'stat',side_effect=bad):r,_=self.probe()
  self.assertEqual('unknown-os-error',r['originalSelector']['ancestorStatus']);self.assertNotIn('NEVER EMITTED',json.dumps(r));self.assertFalse(r['requestedScopeFullyObserved'])
 def test_ancestor_symlink_refuses_before_any_enumeration(self):
  alias=self.root/'alias';alias.symlink_to(self.app,target_is_directory=True)
  with mock.patch.object(S,'SELECTED_APP',alias),mock.patch.object(S.os,'scandir',side_effect=AssertionError('Must not enumerate aliased app')),self.assertRaises(S.Refusal) as c:self.probe()
  self.assertEqual('selected-app-ancestor-not-physical-directory',c.exception.reason);self.assertEqual('symlink',c.exception.observation['kind'])
 def test_missing_selected_app_ancestor_preserves_missing(self):
  with mock.patch.object(S,'SELECTED_APP',self.root/'Missing.app'),self.assertRaises(S.Refusal) as c:self.probe()
  self.assertEqual('missing',c.exception.observation['status'])
 def test_substitution_before_open_refuses_without_following_new_symlink(self):
  other=self.root/'outside';other.mkdir();real=os.open;swapped=[]
  def changed(path,flags,*a,**kw):
   if path=='Resources' and not swapped:self.resources.rename(self.resources.with_name('old-resources'));self.resources.symlink_to(other,target_is_directory=True);swapped.append(True)
   return real(path,flags,*a,**kw)
  with mock.patch.object(S.os,'open',side_effect=changed),self.assertRaises(S.Refusal) as c:self.probe()
  self.assertEqual('directory-open-refused',c.exception.reason);self.assertTrue(swapped)
 def test_substitution_after_open_reads_held_original_only_then_refuses(self):
  (self.resources/'original-marker').write_bytes(b'synthetic');other=self.root/'outside';other.mkdir();(other/'forbidden-marker').write_bytes(b'synthetic');real=os.scandir;target=self.resources.stat().st_ino;names=[];swapped=[]
  def changed(path):
   if isinstance(path,int) and os.fstat(path).st_ino==target and not swapped:self.resources.rename(self.resources.with_name('old-resources'));self.resources.symlink_to(other,target_is_directory=True);swapped.append(True)
   result=real(path)
   if isinstance(path,int) and os.fstat(path).st_ino==target:
    class Wrapped:
     def __enter__(self):self.it=result.__enter__();return self
     def __iter__(self):return self
     def __next__(self):item=next(self.it);names.append(item.name);return item
     def __exit__(self,*args):return result.__exit__(*args)
    return Wrapped()
   return result
  with mock.patch.object(S.os,'scandir',side_effect=changed),self.assertRaises(S.Refusal) as c:self.probe()
  self.assertEqual('scanned-directory-changed',c.exception.reason);self.assertIn('original-marker',names);self.assertNotIn('forbidden-marker',names)
 def test_concurrent_scanned_namespace_mutation_refuses(self):
  (self.resources/'a').touch();real=os.scandir;target=self.resources.stat().st_ino;changed=[]
  def swap(path):
   result=real(path)
   if isinstance(path,int) and os.fstat(path).st_ino==target and not changed:(self.resources/'b').touch();changed.append(True)
   return result
  with mock.patch.object(S.os,'scandir',side_effect=swap),self.assertRaisesRegex(S.Refusal,'^scanned-directory-changed$'):self.probe()
 def test_all_proved_directory_descriptors_close_after_success_or_refusal(self):
  self.localizations(2);real=os.open
  for policy in [S.Policy(),replace(S.Policy(),directories=3)]:
   fds=[]
   def tracked(*a,**kw):fd=real(*a,**kw);fds.append(fd);return fd
   with mock.patch.object(S.os,'open',side_effect=tracked):
    try:self.probe(policy)
    except S.Refusal:pass
   self.assertGreaterEqual(len(fds),6)
   for fd in set(fds):
    with self.assertRaises(OSError) as c:os.fstat(fd)
    self.assertEqual(errno.EBADF,c.exception.errno)
 def test_n2_directory_guard_actual_boundary(self):
  self.localizations(2);r,_=self.probe(replace(S.Policy(),directories=4));self.assertEqual(4,r['counts']['directoriesScanned'])
  with self.assertRaisesRegex(S.Refusal,'^metadata-directory-bound$'):self.probe(replace(S.Policy(),directories=3))
 def test_exact_64_localizations_and_66_directories_pass_65th_refuses(self):
  self.localizations(64,False);r,_=self.probe();self.assertEqual(64,r['counts']['localizationsScanned']);self.assertEqual(66,r['counts']['directoriesScanned']);(self.resources/'language64.lproj').mkdir()
  with self.assertRaisesRegex(S.Refusal,'^localization-directory-bound$'):self.probe()
 def test_independent_directory_limit_fires_before_its_66th_scan(self):
  self.localizations(64,False)
  with self.assertRaisesRegex(S.Refusal,'^metadata-directory-bound$'):self.probe(replace(S.Policy(),directories=65))
 def test_exact_4096_material_metadata_records_pass_then_one_more_refuses(self):
  for i in range(4094):(self.resources/f'f{i:04}').touch()
  r,_=self.probe();self.assertEqual(4096,r['counts']['entries']);(self.resources/'one-more').touch()
  with self.assertRaisesRegex(S.Refusal,'^metadata-entry-bound$'):self.probe()
 def test_n2_entry_limit_integration(self):
  (self.resources/'a').touch();(self.resources/'b').touch();r,_=self.probe(replace(S.Policy(),entries=4));self.assertEqual(4,r['counts']['entries'])
  with self.assertRaisesRegex(S.Refusal,'^metadata-entry-bound$'):self.probe(replace(S.Policy(),entries=3))
 def test_name_1024_byte_guard_exact_and_one_over(self):
  b=S.Budget(S.Policy(),Clock());b.name('n'*1024)
  with self.assertRaisesRegex(S.Refusal,'^entry-name-byte-bound$'):b.name('n'*1025)
 def test_name_guard_is_wired_into_real_enumeration(self):
  cap=max(len(os.fsencode(x)) for x in self.app.parts)+1;policy=replace(S.Policy(),name_bytes=cap);self.probe(policy);name='f'*(cap+1);(self.resources/name).touch()
  with self.assertRaisesRegex(S.Refusal,'^entry-name-byte-bound$'):self.probe(policy)
  (self.resources/name).rename(self.resources/('f'*cap));r,_=self.probe(policy);self.assertEqual(3,r['counts']['entries'])
 def test_canonical_name_near_misses_refuse(self):
  for name in ['', '.', '..', 'a/b','a\0b']:
   with self.subTest(name=repr(name)),self.assertRaisesRegex(S.Refusal,'^noncanonical-entry-name$'):S.Budget(S.Policy(),Clock()).name(name)
 def test_readlink_4096_exact_and_one_over_no_link_activation(self):
  (self.resources/'link').symlink_to('not-followed');fd=os.open(self.resources,os.O_RDONLY|os.O_DIRECTORY)
  try:
   for length in [4096,4097]:
    with mock.patch.object(S.os,'readlink',return_value='x'*length):
     if length==4096:row,_=S.lstat_at(fd,'link','link',S.Budget(S.Policy(),Clock()));self.assertEqual(length,len(row['linkText']))
     else:
      with self.assertRaisesRegex(S.Refusal,'^readlink-byte-bound$'):S.lstat_at(fd,'link','link',S.Budget(S.Policy(),Clock()))
  finally:os.close(fd)
 def test_real_readlink_limit_is_wired_into_inventory(self):
  (self.resources/'link').symlink_to('target');r,_=self.probe(replace(S.Policy(),readlink_bytes=6));self.assertEqual('target',r['entries'][-1]['linkText'])
  with self.assertRaisesRegex(S.Refusal,'^readlink-byte-bound$'):self.probe(replace(S.Policy(),readlink_bytes=5))
 def test_two_megabyte_output_boundary_exact_and_one_over(self):
  policy=S.Policy();overhead=len(S.encode({'v':''},policy));self.assertEqual(policy.output_bytes,len(S.encode({'v':'x'*(policy.output_bytes-overhead)},policy)))
  with self.assertRaisesRegex(S.Refusal,'^metadata-output-byte-bound$'):S.encode({'v':'x'*(policy.output_bytes-overhead+1)},policy)
 def test_output_bound_is_wired_to_whole_inventory(self):
  with self.assertRaisesRegex(S.Refusal,'^metadata-output-byte-bound$'):self.probe(replace(S.Policy(),output_bytes=128))
  r,body=self.probe();self.assertGreater(len(body),128);self.assertLess(len(body),S.Policy().output_bytes)
 def test_clock_strict_60_second_boundary_and_timely_near_miss(self):
  clock=Clock();budget=S.Budget(S.Policy(),clock);clock.now=59.999;budget.tick();clock.now=60
  with self.assertRaisesRegex(S.Refusal,'^metadata-deadline$'):budget.tick()
 def test_late_during_physical_metadata_encoding_is_not_accepted(self):
  clock=Clock();real=S.encode
  def late(*a):body=real(*a);clock.now=60;return body
  with mock.patch.object(S,'encode',side_effect=late),self.assertRaisesRegex(S.Refusal,'^metadata-deadline$'):self.probe(clock=clock)
 def test_late_own_result_finalization_revokes_result_name(self):
  value,_=self.probe();out=self.root/'own-result';out.mkdir();clock=mock.Mock(side_effect=[0,0,60])
  with self.assertRaisesRegex(S.Refusal,'^metadata-deadline$'):S.write_result(out,value,{'GITHUB_RUN_ID':'1'},'a'*64,S.Policy(),clock,0)
  self.assertFalse((out/'RESULT.json').exists());self.assertTrue((out/'UNACCEPTED-METADATA.json').is_file())
 def test_timely_result_binds_context_and_source_with_closed_public_summary(self):
  value,_=self.probe();out=self.root/'own-result';out.mkdir();context={'GITHUB_RUN_ID':'1','GITHUB_RUN_ATTEMPT':'2','GITHUB_SHA':'a'*40,'GITHUB_REPOSITORY':'stsepelin/checktrail','GITHUB_EVENT_NAME':'workflow_dispatch','RUNNER_ARCH':'ARM64'};summary=S.write_result(out,value,context,'b'*64,S.Policy(),Clock(59.999),0);result=json.loads((out/'RESULT.json').read_bytes());self.assertEqual(context,result['runContext']);self.assertEqual('b'*64,result['firstPartyResolverSHA256']);self.assertEqual(S.PROFILE_SHA256,result['selectedProfileSHA256']);self.assertFalse(summary['nativeAdmissionGranted']);self.assertNotIn('entries',summary);self.assertEqual(0o400,stat.S_IMODE((out/'RESULT.json').stat().st_mode))
 def test_context_extra_bytes_do_not_escape_output_bound_or_partial_write(self):
  value,body=self.probe();out=self.root/'own-result';out.mkdir()
  with self.assertRaisesRegex(S.Refusal,'^metadata-output-byte-bound$'):S.write_result(out,value,{'extra':'x'*1000},'a'*64,replace(S.Policy(),output_bytes=len(body)),Clock(),0)
  self.assertEqual([],list(out.iterdir()))
 def test_output_symlink_or_existing_file_is_not_overwritten(self):
  value,_=self.probe();out=self.root/'own-result';out.mkdir();target=self.root/'preserved';target.write_bytes(b'PRESERVED');(out/'RESULT.json').symlink_to(target)
  with self.assertRaises(FileExistsError):S.write_result(out,value,{},'a'*64,S.Policy(),Clock(),0)
  self.assertEqual(b'PRESERVED',target.read_bytes())
 def test_exact_context_identifiers_and_prefix_suffix_near_misses(self):
  value={'GITHUB_RUN_ID':'12','GITHUB_RUN_ATTEMPT':'2','GITHUB_SHA':'a'*40,'GITHUB_REPOSITORY':'stsepelin/checktrail','GITHUB_EVENT_NAME':'workflow_dispatch','RUNNER_ARCH':'ARM64'};self.assertEqual(value,S.context(value))
  for key,bad in [('GITHUB_RUN_ID','012'),('GITHUB_RUN_ID','12x'),('GITHUB_RUN_ATTEMPT','0'),('GITHUB_RUN_ATTEMPT','2\n'),('GITHUB_SHA','a'*40+'x'),('GITHUB_SHA','A'*40)]:
   with self.subTest(key=key,bad=bad),self.assertRaisesRegex(S.Refusal,'^exact-hosted-context$'):S.context({**value,key:bad})
 def test_only_finite_resources_localizations_scanned_no_arbitrary_subtree(self):
  arbitrary=self.resources/'not-a-localization';arbitrary.mkdir();(arbitrary/'hidden-license').touch();nested=self.resources/'English.lproj';nested.mkdir();(nested/'subdirectory').mkdir();(nested/'subdirectory/hidden').touch();r,_=self.probe();paths={x['relativePath'] for x in r['entries']};self.assertNotIn('Contents/Resources/not-a-localization/hidden-license',paths);self.assertNotIn('Contents/Resources/English.lproj/subdirectory/hidden',paths);self.assertEqual(3,r['counts']['directoriesScanned'])
 def test_original_sdk_paths_permissions_and_app_file_bytes_are_untouched(self):
  file=self.resources/'fixture';file.write_bytes(b'PRESERVED SYNTHETIC BODY');before=(file.read_bytes(),S.endpoint(file.lstat()),S.endpoint(self.resources.lstat()));self.probe();after=(file.read_bytes(),S.endpoint(file.lstat()),S.endpoint(self.resources.lstat()));self.assertEqual(before,after)
 def test_whole_deadline_is_charged_before_inventory_and_hard_timer_restores_handler(self):
  clock=Clock(60)
  with self.assertRaisesRegex(S.Refusal,'^metadata-deadline$'):S.inventory(clock=clock,started=0)
  prior=signal.getsignal(signal.SIGALRM);out=io.StringIO();start=time.monotonic()
  with mock.patch.object(S,'main',side_effect=lambda:time.sleep(1)),redirect_stdout(out):code=S.run(replace(S.Policy(),seconds=.02))
  self.assertEqual(1,code);self.assertLess(time.monotonic()-start,.5);self.assertEqual('metadata-deadline',json.loads(out.getvalue())['reasonIdentifier']);self.assertEqual(prior,signal.getsignal(signal.SIGALRM));self.assertEqual(0,signal.getitimer(signal.ITIMER_REAL)[0])
 def test_output_write_os_failure_preserves_only_owned_partial_as_unaccepted(self):
  value,_=self.probe();out=self.root/'own-result';out.mkdir()
  with mock.patch.object(S.os,'fsync',side_effect=OSError(errno.EIO,'synthetic')),self.assertRaises(OSError):S.write_result(out,value,{},'a'*64,S.Policy(),Clock(),0)
  self.assertFalse((out/'RESULT.json').exists());self.assertTrue((out/'UNACCEPTED-METADATA.json').is_file())
 def test_every_original_open_is_directory_only_nofollow(self):
  (self.resources/'regular-license-fixture').write_bytes(b'UNREAD');real=os.open;calls=[]
  def opened(path,flags,*a,**kw):calls.append((path,flags));self.assertTrue(flags&os.O_DIRECTORY);self.assertTrue(flags&os.O_NOFOLLOW);return real(path,flags,*a,**kw)
  with mock.patch.object(S.os,'open',side_effect=opened):self.probe()
  self.assertGreaterEqual(len(calls),5)
 def test_post_scan_original_name_substitution_fires_final_binding_guard(self):
  other=self.root/'outside';other.mkdir();real=os.stat;calls=[]
  def changed(path,*args,**kwargs):
   if path=='Resources' and kwargs.get('dir_fd') is not None:
    calls.append(True)
    if len(calls)==2:self.resources.rename(self.resources.with_name('old-resources'));self.resources.symlink_to(other,target_is_directory=True)
   return real(path,*args,**kwargs)
  with mock.patch.object(S.os,'stat',side_effect=changed),self.assertRaises(S.Refusal) as caught:self.probe()
  self.assertEqual(2,len(calls));self.assertEqual('selected-directory-binding-changed',caught.exception.reason)
 def test_wrong_firstparty_source_hash_refuses_before_output_or_app_metadata(self):
  source=self.root/'firstparty.py';source.write_bytes(b'# SYNTHETIC FIRSTPARTY SOURCE');source.chmod(0o444);real=Path.lstat;environment={'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','GITHUB_RUN_ID':'1','GITHUB_RUN_ATTEMPT':'1','GITHUB_SHA':'a'*40,'GITHUB_REPOSITORY':'stsepelin/checktrail','GITHUB_EVENT_NAME':'workflow_dispatch','RUNNER_ARCH':'ARM64'}
  def root_source(path,*args,**kwargs):
   value=real(path,*args,**kwargs)
   if path==source:return SimpleNamespace(**{name:(0 if name=='st_uid' else getattr(value,name)) for name in ['st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns']})
   return value
  with mock.patch.object(S,'__file__',str(source)),mock.patch.object(Path,'lstat',root_source),mock.patch.object(S.os,'getuid',return_value=0),mock.patch.object(S.platform,'system',return_value='Darwin'),mock.patch.object(S.platform,'machine',return_value='arm64'),mock.patch.dict(os.environ,environment),mock.patch.object(sys,'argv',['resolver','--expected-source-sha256','0'*64]),mock.patch.object(S,'inventory',side_effect=AssertionError('No app metadata before source binding')),mock.patch.object(Path,'mkdir',side_effect=AssertionError('No output before source binding')),self.assertRaisesRegex(S.Refusal,'^exact-reviewed-firstparty-source-hash$'):S.main()
 def test_cli_argument_does_not_grant_root_metadata_startup(self):
  with mock.patch.object(S.os,'getuid',return_value=501),mock.patch.object(sys,'argv',['resolver','--expected-source-sha256','a'*64]),mock.patch.object(S,'inventory',side_effect=AssertionError('No metadata without actual startup identity')),self.assertRaisesRegex(S.Refusal,'^reviewed-root-standard-macos-arm-metadata-startup$'):S.main()
 def test_physical_metadata_and_public_failure_reserves_fit_total_two_megabytes(self):
  value,_=self.probe();context={};base={**value,'runContext':context,'firstPartyResolverSHA256':'a'*64,'padding':''};cap=S.Policy().output_bytes-S.STDOUT_RESERVE-S.FAILURE_RESERVE;overhead=len(S.encode(base,S.Policy()));base['padding']='x'*(cap-overhead);value={k:v for k,v in base.items() if k not in ('runContext','firstPartyResolverSHA256')};out=self.root/'exact-output';out.mkdir();summary=S.write_result(out,value,context,'a'*64,S.Policy(),Clock(),0);self.assertEqual(cap,(out/'RESULT.json').stat().st_size);self.assertLess(len(json.dumps(summary).encode())+S.FAILURE_RESERVE,S.STDOUT_RESERVE+S.FAILURE_RESERVE)
  out2=self.root/'over-output';out2.mkdir();value['padding']+='x'
  with self.assertRaisesRegex(S.Refusal,'^metadata-output-byte-bound$'):S.write_result(out2,value,context,'a'*64,S.Policy(),Clock(),0)
  self.assertEqual([],list(out2.iterdir()))
 def test_failure_path_metadata_stays_private_and_public_summary_is_closed(self):
  out=self.root/'failure';out.mkdir();error=S.Refusal('selected-app-ancestor-not-physical-directory',{'status':'observed','kind':'symlink','linkText':'/SYNTHETIC-PRIVATE-DESTINATION'});stdout=io.StringIO()
  with redirect_stdout(stdout):S.write_refusal(out,error)
  self.assertNotIn('PRIVATE-DESTINATION',stdout.getvalue());self.assertNotIn('linkText',stdout.getvalue());self.assertLessEqual(len(stdout.getvalue().encode()),S.STDOUT_RESERVE);self.assertEqual(error.observation,json.loads((out/'REFUSAL.json').read_bytes())['observation']);self.assertLess((out/'REFUSAL.json').stat().st_size+len(stdout.getvalue().encode()),S.Policy().output_bytes)
 def test_n2_known_english_directory_inaccessible_differs_from_genuinely_missing(self):
  english=self.resources/'English.lproj';english.mkdir();french=self.resources/'French.lproj';french.mkdir();(french/'License.rtf').write_bytes(b'SYNTHETIC UNREAD');target=english.stat().st_ino;real=os.scandir
  def denied(path):
   if isinstance(path,int) and os.fstat(path).st_ino==target:raise PermissionError(errno.EACCES,'synthetic known-directory readdir denial')
   return real(path)
  with mock.patch.object(S.os,'scandir',side_effect=denied):observed,_=self.probe()
  self.assertFalse(observed['requestedScopeFullyObserved']);self.assertEqual(2,observed['counts']['localizationsScanned']);self.assertTrue(any(x['relativePath']=='Contents/Resources/French.lproj/License.rtf' for x in observed['entries']));self.assertEqual('inaccessible',observed['originalSelector']['status']);self.assertTrue(observed['originalSelector']['directoryPresenceObserved']);self.assertFalse(observed['originalSelector']['fileAbsenceEstablished']);self.assertEqual('directory-enumeration',observed['originalSelector']['observationScope'])
  english.rmdir();missing,_=self.probe();self.assertEqual('missing-localization-directory',missing['originalSelector']['status']);self.assertTrue(missing['requestedScopeFullyObserved']);self.assertNotEqual(observed['originalSelector']['status'],missing['originalSelector']['status'])
 def test_n2_known_english_unknown_enumeration_error_is_not_absence(self):
  english=self.resources/'English.lproj';english.mkdir();(self.resources/'French.lproj').mkdir();target=english.stat().st_ino;real=os.scandir
  def unknown(path):
   if isinstance(path,int) and os.fstat(path).st_ino==target:raise OSError(errno.EIO,'synthetic unknown body must stay unreported')
   return real(path)
  with mock.patch.object(S.os,'scandir',side_effect=unknown):r,_=self.probe()
  self.assertEqual('unknown-os-error',r['originalSelector']['status']);self.assertTrue(r['originalSelector']['directoryPresenceObserved']);self.assertEqual(errno.EIO,r['originalSelector']['errno']);self.assertFalse(r['originalSelector']['fileAbsenceEstablished']);self.assertFalse(r['requestedScopeFullyObserved']);self.assertNotIn('must stay unreported',json.dumps(r))
 def test_required_scope_family_missing_type_and_symlink_are_not_unavailable_absence(self):
  for part in ['Contents','Contents/Resources','Contents/Resources/English.lproj']:
   for state in ['missing','regular','symlink']:
    with self.subTest(part=part,state=state):
     app=self.root/('case-'+part.replace('/','-')+'-'+state);resources=app/'Contents/Resources';(resources/'English.lproj').mkdir(parents=True);node=app/part;__import__('shutil').rmtree(node)
     if state=='regular':node.write_bytes(b'SYNTHETIC')
     if state=='symlink':node.symlink_to(self.root,target_is_directory=True)
     with mock.patch.object(S,'SELECTED_APP',app):r,_=self.probe()
     if part.endswith('English.lproj') and state=='missing':self.assertEqual('missing-localization-directory',r['originalSelector']['status'])
     else:
      self.assertEqual('blocked-by-ancestor',r['originalSelector']['status']);self.assertEqual('missing' if state=='missing' else 'observed',r['originalSelector']['ancestorStatus']);self.assertEqual(None if state=='missing' else state,r['originalSelector']['ancestorKind'])
     self.assertFalse(r['licenseLocatedQualifiedOrRetained']);self.assertFalse(r['nativeAdmissionGranted'])
 def test_n2_scandir_refusal_scope_family_never_invents_missing_english(self):
  english=self.resources/'English.lproj';english.mkdir();(english/'License.rtf').write_bytes(b'SYNTHETIC');(self.resources/'French.lproj').mkdir();real=os.scandir
  for path,expected in [(self.app/'Contents','observed'),(self.resources,'not-observed'),(english,'inaccessible')]:
   inode=path.stat().st_ino
   def denied(fd):
    if isinstance(fd,int) and os.fstat(fd).st_ino==inode:raise PermissionError(errno.EACCES,'synthetic')
    return real(fd)
   with self.subTest(path=path.name),mock.patch.object(S.os,'scandir',side_effect=denied):r,_=self.probe()
   self.assertFalse(r['requestedScopeFullyObserved']);self.assertEqual(expected,r['originalSelector']['status']);self.assertNotEqual('missing-localization-directory',r['originalSelector']['status'])
 def test_fixed_repository_manual_event_and_arm64_context_match_exactly(self):
  good={'GITHUB_RUN_ID':'1','GITHUB_RUN_ATTEMPT':'1','GITHUB_SHA':'a'*40,'GITHUB_REPOSITORY':'stsepelin/checktrail','GITHUB_EVENT_NAME':'workflow_dispatch','RUNNER_ARCH':'ARM64'};self.assertEqual(good,S.context(good))
  for key,bad in [('GITHUB_REPOSITORY','stsepelin/checktrail-extra'),('GITHUB_REPOSITORY','other/checktrail'),('GITHUB_EVENT_NAME','workflow_dispatch_extra'),('GITHUB_EVENT_NAME','pull_request'),('RUNNER_ARCH','ARM64x'),('RUNNER_ARCH','arm64'),('RUNNER_ARCH','X64')]:
   with self.subTest(key=key,bad=bad),self.assertRaisesRegex(S.Refusal,'^exact-repository-event-architecture-context$'):S.context({**good,key:bad})
if __name__=='__main__':unittest.main()
