import contextlib,hashlib,io,json,os,pathlib,subprocess,sys,tarfile,tempfile,time,unittest
from unittest.mock import patch
sys.dont_write_bytecode=True
ROOT=pathlib.Path(__file__).resolve().parent;sys.path.insert(0,str(ROOT))
import common,driver,native_entry,capture,collect,meter,git_ack,threading,zipfile
class Controls(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory(prefix='ct-sdk10-synthetic-');self.root=pathlib.Path(self.tmp.name)
 def tearDown(self):self.tmp.cleanup()
 def test_expired_process_has_failure_receipt_and_no_child(self):
  with patch.object(common.subprocess,'Popen') as child:
   with self.assertRaises(common.Refusal):common.process([sys.executable,'-c','raise SystemExit(0)'],self.root/'expired',time.monotonic()-1)
   child.assert_not_called()
  row=common.read_json(self.root/'expired.receipt.json');self.assertEqual(row['ownedChildStarted'],False);self.assertIsNone(row['exitCode']);self.assertIn('before start',row['reason'])
 def test_first_party_child_exit_is_recorded_and_reaped(self):
  row,p=common.process([sys.executable,'-c','print("synthetic"); raise SystemExit(7)'],self.root/'child',time.monotonic()+10);self.assertEqual(row['exitCode'],7);self.assertTrue(row['ownedChildStarted']);self.assertTrue(row['ownedChildReaped']);self.assertEqual(p.read_text(),'synthetic\n')
 def controller(self,replies):
  c=object.__new__(driver.Controller);c.ctx={'run':123,'head':'a'*40,'nonce':'synthetic-test','attempt':1};calls=[]
  def fake(args,**kw):
   calls.append(args);exitcode,reason,body=replies.pop(0);p=self.root/('reply-'+str(len(calls)));p.write_text(body);return {'exitCode':exitcode,'reason':reason},p
  c.docker=fake;return c,calls
 def test_docker_inspect_deadline_is_unavailable_not_absence(self):
  c,calls=self.controller([(137,'owned command deadline','')]);self.assertRaises(common.Refusal,c.inspect,'container','owned-name');self.assertEqual(len(calls),1)
 def test_docker_failed_inspect_plus_failed_listing_is_unavailable(self):
  c,_=self.controller([(1,None,''),(1,None,'')]);self.assertRaises(common.Refusal,c.inspect,'volume','owned-volume')
 def test_docker_failed_inspect_plus_successful_exact_empty_listing_is_absent(self):
  c,calls=self.controller([(1,None,''),(0,None,'')]);self.assertIsNone(c.inspect('container','owned-name'));self.assertEqual(calls[1],['container','ls','-aq','--no-trunc','--filter','name=^/owned-name$'])
 def test_docker_failed_inspect_plus_existing_identity_refuses_absence(self):
  c,_=self.controller([(1,None,''),(0,None,'existing\n')]);self.assertRaises(common.Refusal,c.inspect,'image','owned:tag')
 def test_native_expired_budget_has_no_original_child(self):
  with patch.object(native_entry.subprocess,'Popen') as child:
   row=native_entry.supervise(['unexecuted'],time.monotonic()-1,str(self.root),{},self.root,{'context':'synthetic'})
   child.assert_not_called();self.assertFalse(row['originalCommandStarted']);self.assertIsNone(row['originalExitCode']);self.assertFalse(row['ownChildReaped'])
  self.assertFalse(common.read_json(self.root/'RESULT.json')['originalCommandStarted'])
 def test_native_original_nonzero_separate_supervisor_receipt(self):
  row=native_entry.supervise([sys.executable,'-c','raise SystemExit(9)'],time.monotonic()+5,str(self.root),{'GITHUB_TOKEN':'SYNTHETIC','HOME':str(self.root)},self.root,{'context':'synthetic'});self.assertTrue(row['originalCommandStarted']);self.assertEqual(row['originalExitCode'],9);self.assertTrue(row['ownChildReaped']);self.assertEqual(common.read_json(self.root/'RESULT.json')['originalExitCode'],9)
 def test_native_credentials_removed_by_whole_identifier_family(self):
  self.assertEqual(native_entry.clean_project_env({'GITHUB_TOKEN':'x','GH_DEBUG':'x','ACTIONS_RUNTIME_TOKEN':'x','NUGET_PASSWORD':'x','NORMAL':'literal'}),{'NORMAL':'literal'})
 def test_full_fsync_ancestry_through_preexisting_parent(self):
  folder=self.root/'collection'/'window'/'worker';folder.mkdir(parents=True);trace=[]
  with patch.object(common,'syncdir',side_effect=lambda p:trace.append(pathlib.Path(p))):common.sync_chain(folder,self.root)
  self.assertEqual(trace,[folder,folder.parent,folder.parent.parent,self.root])
 def test_capture_full_bytes_duplicate_aliases_modes_and_symlink(self):
  source=self.root/'source';source.mkdir();(source/'a').write_bytes(b'first-party synthetic body');(source/'b').write_bytes((source/'a').read_bytes());(source/'b').chmod(0o751);(source/'link').symlink_to('a');os.mkfifo(source/'pipe');archive=self.root/'snapshot.tar.gz';summary=capture.capture({'work':source},archive,time.monotonic()+10,1024**2);self.assertTrue(summary['archiveRoundtripVerified']);self.assertEqual(summary['persistentRegularPaths'],2);self.assertGreater(summary['provenDuplicateBodyBytesStoredByReference'],0);self.assertEqual(summary['IPCMetadataOnlyPaths'],1)
 def test_duplicate_internal_member_map_rejected(self):
  archive=self.root/'dup.tar.gz'
  with tarfile.open(archive,'w:gz') as t:
   for _ in range(2):
    item=tarfile.TarInfo(capture.MEMBER_MAP);item.size=0;t.addfile(item,io.BytesIO(b''))
  self.assertRaises(common.Refusal,capture.roundtrip,archive,time.monotonic()+10,1024**2)
 def test_member_map_cannot_erase_owner_or_alias_mismatch(self):
  source=self.root/'src';source.mkdir();(source/'a').write_bytes(b'synthetic');archive=self.root/'ok.tar.gz';capture.capture({'work':source},archive,time.monotonic()+10,1024**2);bad=self.root/'bad.tar.gz'
  with tarfile.open(archive,'r:gz') as incoming,tarfile.open(bad,'w:gz') as out:
   for item in incoming:
    raw=incoming.extractfile(item).read() if item.isfile() else None
    if item.name==capture.MEMBER_MAP:
     row=json.loads(raw);row['uid']+=1;raw=(json.dumps(row)+'\n').encode();item.size=len(raw)
    out.addfile(item,io.BytesIO(raw) if raw is not None else None)
  self.assertRaises(common.Refusal,capture.roundtrip,bad,time.monotonic()+10,1024**2)
 def test_partial_custody_error_cannot_trigger_delete(self):
  folder=self.root/'worker';folder.mkdir();(folder/'CUSTODY.json').write_bytes(b'{"state":"CUSTODIED"}');row={'workerDirectory':str(folder),'state':'CUSTODIED','error':'OSError','custodyReceiptSHA256':common.hash_file(folder/'CUSTODY.json')[1]}
  with patch.object(collect,'Calls') as calls:
   self.assertRaises(common.Refusal,collect.delete_after_custody,row,{},time.monotonic()+10,None);calls.assert_not_called()
 def test_partial_custody_receipt_hash_mismatch_cannot_trigger_delete(self):
  folder=self.root/'worker';folder.mkdir();(folder/'CUSTODY.json').write_bytes(b'{"state":"CUSTODIED"}');row={'workerDirectory':str(folder),'state':'CUSTODIED','error':None,'custodyReceiptSHA256':'a'*64}
  with patch.object(collect,'Calls') as calls:
   self.assertRaises(common.Refusal,collect.delete_after_custody,row,{},time.monotonic()+10,None);calls.assert_not_called()
 def test_failed_crypto_authentication_never_calls_plaintext_parser(self):
  series={'plan':{'payloadParts':1},'archive':{'plaintext':{'bytes':1,'sha256':'a'*64,'internalMemberMapSHA256':'b'*64}},'context':{}};p=self.root/'part';p.write_bytes(b'x');row={'ordinal':1,'state':'CUSTODIED','error':None,'physicalPartFile':str(p),'part':{'bytes':1,'sha256':common.hash_file(p)[1]}}
  with patch.object(collect,'operation',return_value={'authenticated':False}),patch.object(collect,'roundtrip') as parser:
   self.assertRaises(common.Refusal,collect.archive_roundtrip,self.root,[row],series,time.monotonic()+10,self.root/'TEST-ONLY-KEY');parser.assert_not_called()
 def test_actual_worker_partial_receipt_failure_remains_incomplete_and_cannot_delete(self):
  ctx={'run':123,'head':'a'*40,'nonce':'synthetic-test','attempt':1};data=b'abc';series={'context':ctx,'kind':'encrypted-original-sdk10-stopped-persistent-evidence','archive':{'bytes':3,'sha256':common.digest(data)},'plan':common.body_plan(3)};part={'series':series,'seriesSHA256':common.digest(common.encoded(series)),'ordinal':1,'window':1,'finalWindow':True,'payload':True,'offset':0,'bytes':3,'sha256':common.digest(data)};buffer=io.BytesIO()
  with zipfile.ZipFile(buffer,'w',compression=zipfile.ZIP_STORED) as z:z.writestr('part.bin',data);z.writestr('part.json',common.encoded(part))
  raw=buffer.getvalue();meta={'id':11,'name':common.name(ctx,1),'size_in_bytes':len(raw),'expired':False,'workflow_run':{'id':123,'head_sha':ctx['head']},'digest':'sha256:'+common.digest(raw)};window=self.root/'collection'/'window';window.mkdir(parents=True);worker=window/'worker';original=collect.freeze
  class Calls:
   def __init__(this,folder,deadline,stop):this.events=[];this.startedPIDs=[];this.reapedPIDs=[];this.folder=folder
   def metadata(this,*args,**kwargs):return meta
   def run(this,*args):p=this.folder/'zip.stdout';p.write_bytes(raw);return 0,raw,p
  def fail_receipt(path,body):
   if pathlib.Path(path).name=='CUSTODY.json':pathlib.Path(path).write_bytes(b'{partial');raise OSError('synthetic partial receipt write')
   return original(path,body)
  with patch.object(collect,'Calls',Calls),patch.object(collect,'freeze',side_effect=fail_receipt):row=collect.worker(worker,ctx,1,meta,time.monotonic()+10,threading.Event())
  self.assertEqual(row['state'],'INCOMPLETE');self.assertEqual(row['error'],'OSError');self.assertIsNone(row.get('custodyReceiptSHA256'))
  with patch.object(collect,'Calls') as calls:self.assertRaises(common.Refusal,collect.delete_after_custody,row,ctx,time.monotonic()+10,threading.Event());calls.assert_not_called()
 def test_meter_exact_regular_unlink_race_retries_without_counter_credit(self):
  (self.root/'temporary').write_bytes(b'123');(self.root/'stable').write_bytes(b'4567');removed=[]
  def hook(stage,fd,name,value):
   if stage=='after-stat' and name=='temporary' and not removed:os.unlink(name,dir_fd=fd);removed.append(True)
  result=meter.sample(str(self.root),hook);self.assertTrue(result['samplingComplete']);self.assertEqual(result['wholeSampleRetries'],1);self.assertEqual(result['regularLogicalBytes'],4);self.assertFalse(result['failedAttemptCountersCredited']);self.assertEqual(result['attempts'][0]['incompleteCode'],'entry-vanished-during-sample')
 def test_meter_persistent_regular_replacement_race_refuses_after_two_attempts(self):
  (self.root/'temporary').write_bytes(b'123')
  def hook(stage,fd,name,value):
   if stage=='before-attempt':(self.root/'temporary').write_bytes(b'123')
   if stage=='after-stat' and name=='temporary':os.unlink(name,dir_fd=fd)
  result=meter.sample(str(self.root),hook);self.assertFalse(result['samplingComplete']);self.assertEqual(result['wholeSampleRetries'],1);self.assertFalse(result['failedAttemptCountersCredited'])
 def test_ack_channel_requires_exact_preexisting_context_ref(self):
  ctx={'run':123,'head':'a'*40,'nonce':'synthetic-test','attempt':1};self.assertRaises(common.Refusal,git_ack.binding,{'ref':'heads/main','parent':'a'*40},ctx);self.assertRaises(common.Refusal,git_ack.binding,{'ref':'heads/diagnostic/sdk10-recovery-synthetic-test','parent':'malformed'},ctx)
 def test_unsigned_artifact_absence_has_no_cleanup_authority(self):
  import crypto_bridge
  series={'context':{'run':123,'head':'a'*40,'nonce':'synthetic-test','attempt':1},'archive':{'bytes':100,'sha256':'a'*64,'headerSHA256':'b'*64,'plaintext':{'bytes':50,'sha256':'c'*64,'internalMemberMapSHA256':'d'*64}},'plan':{'payloadParts':1,'totalCarriers':2}}
  payload=crypto_bridge.ack_payload(series,'e'*64,'f'*64);self.assertEqual(crypto_bridge.validate_ack_payload(payload,series),payload);payload['plaintext']['sha256']='0'*64;self.assertRaises(common.Refusal,crypto_bridge.validate_ack_payload,payload,series)
 def test_final_exact404_pair_with_invalid_signature_keeps_recovery_false(self):
  import types,crypto_bridge
  ctx={'run':123,'head':'a'*40,'nonce':'synthetic-test','attempt':1};series={'context':ctx,'archive':{'bytes':100,'sha256':'a'*64,'headerSHA256':'b'*64,'plaintext':{'bytes':50,'sha256':'c'*64,'internalMemberMapSHA256':'d'*64}},'plan':{'payloadParts':1,'totalCarriers':2}};payload=crypto_bridge.ack_payload(series,'e'*64,'f'*64);state={'windows':{'1':{'window':1,'ids':[11,12],'ordinals':[1,2]}},'exportDeadline':time.monotonic()+20,'bodyPlan':{'windows':1},'series':series,'recoveryACKChannel':{},'publicRecipientJWK':{},'operatorFullRoundtripAcknowledged':False};c=types.SimpleNamespace(state=state,ctx=ctx,root=self.root,profile={'workflowPath':'.github/workflows/ci.yml'},save=lambda:None)
  class API:
   def __init__(this,*a):pass
   def bind(this,*a):pass
   def call(this,path,**kwargs):return {'total_count':0,'artifacts':[]} if '/runs/' in path else None
  class ACK:
   def __init__(this,*a):pass
   def fetch(this):return {'ack':{'payload':payload,'signature':'invalid'}}
  with patch.object(driver,'load_controller',return_value=c),patch.object(driver,'GitHub',API),patch.object(driver,'AckAPI',ACK),patch.object(driver,'operation',side_effect=common.Refusal('synthetic invalid signature')):
   self.assertRaises(common.Refusal,driver.wait_window,'synthetic-test','unused',1)
  self.assertFalse(state['operatorFullRoundtripAcknowledged']);self.assertFalse(state.get('authenticatedRecoveryACKVerified',False))
 def test_protected_control_ownership_precedes_enumeration(self):
  owner={'root':False};trace=[];original=pathlib.Path.iterdir
  def chown(path,uid,gid):owner['root']=True;trace.append('chown')
  def listing(path):
   if path==self.root:self.assertTrue(owner['root']);trace.append('enumerate')
   return original(path)
  with patch.object(native_entry.os,'chown',side_effect=chown),patch.object(native_entry.os,'chmod',side_effect=lambda *a:trace.append('chmod')),patch.object(pathlib.Path,'iterdir',listing):native_entry.protect_control(self.root)
  self.assertEqual(trace,['chown','chmod','enumerate'])
 def test_actual_mount_identity_and_rw_guards_reject_wrong_temp(self):
  c=object.__new__(driver.Controller);c.root=self.root;c.state={'volume':'owned-work','tempVolume':'owned-temp'};name='synthetic-native';obj={'Mounts':[{'Destination':'/work','Type':'volume','Name':'owned-work','RW':True},{'Destination':'/tmp','Type':'volume','Name':'owned-temp','RW':True},{'Destination':'/work/tmp','Type':'volume','Name':'owned-temp','RW':True},{'Destination':'/observer','Type':'bind','Source':str(driver.HERE),'RW':False},{'Destination':'/native-control','Type':'bind','Source':str(self.root/'protected'/name),'RW':True}],'HostConfig':{'ReadonlyRootfs':True,'Privileged':False,'PidMode':'','CpusetCpus':'0-3','NetworkMode':'bridge','CapDrop':['ALL'],'SecurityOpt':['no-new-privileges:true'],'Mounts':[{'Type':'volume','Source':'owned-work','Target':'/work','VolumeOptions':{'NoCopy':True}},{'Type':'volume','Source':'owned-temp','Target':'/tmp','VolumeOptions':{'NoCopy':True}},{'Type':'volume','Source':'owned-temp','Target':'/work/tmp','VolumeOptions':{'NoCopy':True}}]}};self.assertTrue(c.validate_container(obj,name,[]));obj['Mounts'][1]['Name']='wrong-unowned-temp';self.assertRaises(common.Refusal,c.validate_container,obj,name,[]);obj['Mounts'][1]['Name']='owned-temp';obj['Mounts'][3]['RW']=True;self.assertRaises(common.Refusal,c.validate_container,obj,name,[])
 def test_ack_transport_is_one_existing_ref_append_without_force(self):
  import base64
  ctx={'run':123,'head':'a'*40,'nonce':'synthetic-test','attempt':1};channel={'ref':'heads/diagnostic/sdk10-recovery-synthetic-test','parent':'b'*40};ack={'payload':{'context':ctx,'syntheticHashesOnly':True},'signature':'SYNTHETIC','algorithm':'RSA-PSS-SHA256-salt32'};raw=common.encoded(ack);sha=hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest();events=[];tip=[channel['parent']]
  class API(git_ack.AckAPI):
   def call(this,suffix,method='GET',payload=None):
    events.append((suffix,method,payload))
    if suffix=='git/ref/'+channel['ref']:return {'ref':'refs/'+channel['ref'],'object':{'type':'commit','sha':tip[0]}}
    if suffix=='git/commits/'+channel['parent']:return {'tree':{'sha':'c'*40}}
    if suffix=='git/blobs' and method=='POST':return {'sha':sha}
    if suffix=='git/trees' and method=='POST':return {'sha':'d'*40}
    if suffix=='git/commits' and method=='POST':return {'sha':'f'*40}
    if suffix=='git/refs/'+channel['ref'] and method=='PATCH':tip[0]=payload['sha'];return {}
    if suffix=='git/commits/'+'f'*40:return {'sha':'f'*40,'message':git_ack.MESSAGE,'parents':[{'sha':channel['parent']}],'tree':{'sha':'d'*40}}
    if suffix=='git/trees/'+'d'*40:return {'sha':'d'*40,'truncated':False,'tree':[{'path':'.checktrail-recovery','type':'tree','mode':'040000','sha':'e'*40}]}
    if suffix=='git/trees/'+'e'*40:return {'sha':'e'*40,'truncated':False,'tree':[{'path':git_ack.ack_path(ctx).split('/')[-1],'type':'blob','mode':'100644','sha':sha}]}
    if suffix=='git/blobs/'+sha:return {'size':len(raw),'encoding':'base64','content':base64.b64encode(raw).decode()}
    raise AssertionError('unexpected API effect '+suffix)
  api=API(self.root/'ack',time.monotonic()+10,channel,ctx,True);proof=api.publish(ack);self.assertEqual(proof['ack'],ack);writes=[x for x in events if x[1]!='GET'];self.assertEqual([x[1] for x in writes],['POST','POST','POST','PATCH']);self.assertEqual(writes[-1][2],{'sha':'f'*40,'force':False});self.assertEqual(writes[1][2]['base_tree'],'c'*40);self.assertEqual(writes[1][2]['tree'],[{'path':git_ack.ack_path(ctx),'mode':'100644','type':'blob','sha':sha}]);self.assertEqual(base64.b64decode(writes[0][2]['content']),raw)
 def test_ack_moved_parent_refuses_all_public_writes(self):
  ctx={'run':123,'head':'a'*40,'nonce':'synthetic-test','attempt':1};channel={'ref':'heads/diagnostic/sdk10-recovery-synthetic-test','parent':'b'*40};calls=[]
  class API(git_ack.AckAPI):
   def call(this,suffix,method='GET',payload=None):calls.append(method);return {'ref':'refs/'+channel['ref'],'object':{'type':'commit','sha':'c'*40}}
  api=API(self.root/'ack',time.monotonic()+10,channel,ctx,True);self.assertRaises(common.Refusal,api.publish,{'synthetic':True});self.assertEqual(calls,['GET'])

 def control_bundle(self):
  # Real run_checks.py/common.py beside synthetic controls. Each control's
  # import writes a marker, so an absent marker proves it was never imported.
  base=pathlib.Path(tempfile.mkdtemp(dir=self.root,prefix='controls-'));bundle=base/'bundle';bundle.mkdir();markers=base/'markers';markers.mkdir()
  for name in ['run_checks.py','common.py']:(bundle/name).write_bytes((ROOT/name).read_bytes())
  def control(name,label):
   (bundle/name).write_text('import pathlib,unittest\npathlib.Path('+repr(str(markers/label))+').write_text("imported-7319")\nclass Synthetic(unittest.TestCase):\n def test_'+label.replace('-','_')+'(self):self.assertEqual(7319,7319)\n')
  control('test_listed_marker.py','listed');control('test_protected_marker.py','protected')
  def rows(names):return [{'path':x,'bytes':len((bundle/x).read_bytes()),'sha256':hashlib.sha256((bundle/x).read_bytes()).hexdigest()} for x in names]
  def pin(protected=True,manifest_protected=True):
   if protected:(bundle/'PROTECTED-CONTROLS.json').write_bytes(common.encoded({'schemaVersion':1,'firstPartyControlsOnly':True,'files':rows(['test_protected_marker.py'])}))
   raw=common.encoded({'schemaVersion':1,'files':rows(['run_checks.py','common.py','test_listed_marker.py']+(['PROTECTED-CONTROLS.json'] if manifest_protected else []))});(bundle/'MANIFEST.json').write_bytes(raw);return hashlib.sha256(raw).hexdigest()
  return bundle,markers,control,pin
 def control_worker(self,bundle,pin,write_bytecode=False):
  out=pathlib.Path(tempfile.mkdtemp(dir=self.root,prefix='out-'));args=[str(bundle/'run_checks.py'),'--python-worker','--out',str(out),'--manifest-sha256',pin]
  # Some interpreter builds never write bytecode; the wrapper turns it on so
  # only run_checks.py itself can keep a cache out of the verified directory.
  command=[sys.executable,'-I','-S','-c','import runpy,sys;sys.dont_write_bytecode=False;sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name="__main__")',*args] if write_bytecode else [sys.executable,'-I','-S','-B',*args]
  done=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=60)
  return done.returncode,done.stdout.decode('utf8','replace'),out
 def test_reviewed_control_set_runs_listed_and_protected_controls(self):
  bundle,markers,control,pin=self.control_bundle();code,log,out=self.control_worker(bundle,pin())
  self.assertEqual(code,0,log);self.assertEqual(json.loads((out/'PYTHON.json').read_bytes())['tests'],2)
  self.assertEqual(sorted(x.name for x in markers.iterdir()),['listed','protected']);self.assertIn('test_protected',log)
 def test_repeated_runs_without_bytecode_flag_leave_no_cache_to_refuse(self):
  bundle,markers,control,pin=self.control_bundle();value=pin()
  for attempt in range(2):
   code,log,out=self.control_worker(bundle,value,True);self.assertEqual(code,0,(attempt,log));self.assertIn('test_listed',log)
  self.assertEqual(sorted(x.name for x in bundle.iterdir()),sorted(['MANIFEST.json','PROTECTED-CONTROLS.json','common.py','run_checks.py','test_listed_marker.py','test_protected_marker.py']))
 def test_unreviewed_directory_entry_is_refused_before_any_control_import(self):
  # An unlisted helper is importable by name just like an unlisted test, and
  # a stale bytecode cache can stand in for a pinned module.
  for extra in ['test_unlisted_marker.py','unlisted_helper.py','__pycache__']:
   with self.subTest(extra=extra):
    bundle,markers,control,pin=self.control_bundle();value=pin()
    if extra=='__pycache__':(bundle/extra).mkdir()
    else:control(extra,'unlisted')
    code,log,out=self.control_worker(bundle,value)
    self.assertNotEqual(code,0);self.assertIn('unreviewed entry in executed control directory: '+extra,log);self.assertEqual(list(markers.iterdir()),[]);self.assertFalse((out/'PYTHON.json').exists())
 def test_changed_listed_or_protected_control_or_unpinned_protected_manifest_is_refused(self):
  for case in ['listed','protected','verifier-helper','protected-manifest-unpinned','protected-manifest-changed']:
   with self.subTest(case=case):
    bundle,markers,control,pin=self.control_bundle();value=pin(manifest_protected=case!='protected-manifest-unpinned')
    if case in ['listed','protected']:target=bundle/('test_'+case+'_marker.py');target.write_bytes(target.read_bytes()+b'# foreign-7319\n');expected='frozen first-party control file changed: test_'+case+'_marker.py'
    elif case=='verifier-helper':
     # common.py is pinned like any control; changing it must not run before the pin is checked.
     target=bundle/'common.py';target.write_bytes(target.read_bytes()+('\nimport pathlib\npathlib.Path('+repr(str(markers/'helper'))+').write_text("imported-7319")\n').encode());expected='frozen first-party control file changed: common.py'
    elif case=='protected-manifest-changed':target=bundle/'PROTECTED-CONTROLS.json';target.write_bytes(target.read_bytes()+b' ');expected='frozen first-party control file changed: PROTECTED-CONTROLS.json'
    else:expected='unreviewed entry in executed control directory: PROTECTED-CONTROLS.json, test_protected_marker.py'
    code,log,out=self.control_worker(bundle,value)
    self.assertNotEqual(code,0);self.assertIn(expected,log);self.assertEqual(list(markers.iterdir()),[])
 def test_controller_refuses_unreviewed_entry_before_creating_output_or_children(self):
  import run_checks
  bundle,markers,control,pin=self.control_bundle();value=pin();control('test_unlisted_marker.py','unlisted');out=self.root/'controller-out'
  with patch.object(run_checks,'HERE',bundle),patch.object(run_checks.subprocess,'run') as child,self.assertRaisesRegex(run_checks.Unreviewed,'unreviewed entry in executed control directory: test_unlisted_marker.py'):run_checks.run(out,value)
  child.assert_not_called();self.assertFalse(out.exists());self.assertEqual(list(markers.iterdir()),[])
  (bundle/'test_unlisted_marker.py').unlink();self.assertEqual(run_checks.bound_tests(bundle,value),['test_listed_marker','test_protected_marker'])
 def entry_bundle(self,listed=True):
  # An entry script that, like driver.py, puts its directory on sys.path and
  # imports a sibling at module level; both imports write marker files.
  bundle,markers,control,pin=self.control_bundle()
  (bundle/'helper_marker.py').write_text('import pathlib\npathlib.Path('+repr(str(markers/'helper'))+').write_text("imported-4421")\n')
  (bundle/'entry_marker.py').write_text('import pathlib,sys\nsys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))\nimport helper_marker\npathlib.Path('+repr(str(markers/'entry'))+').write_text(" ".join(sys.argv[1:]))\nraise SystemExit(7 if "--exit-7" in sys.argv else 0)\n')
  (bundle/'PROTECTED-CONTROLS.json').write_bytes(common.encoded({'schemaVersion':1,'firstPartyControlsOnly':True,'files':[{'path':x,'bytes':len((bundle/x).read_bytes()),'sha256':hashlib.sha256((bundle/x).read_bytes()).hexdigest()} for x in ['test_protected_marker.py']]}))
  names=['run_checks.py','common.py','test_listed_marker.py','PROTECTED-CONTROLS.json','entry_marker.py']+(['helper_marker.py'] if listed else [])
  raw=common.encoded({'schemaVersion':1,'files':[{'path':x,'bytes':len((bundle/x).read_bytes()),'sha256':hashlib.sha256((bundle/x).read_bytes()).hexdigest()} for x in names]});(bundle/'MANIFEST.json').write_bytes(raw)
  return bundle,markers,hashlib.sha256(raw).hexdigest()
 def entry(self,bundle,pin,*argv):
  done=subprocess.run([sys.executable,'-I','-S','-B',str(bundle/'run_checks.py'),'--manifest-sha256',pin,'--entry',*argv],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=60)
  return done.returncode,done.stdout.decode('utf8','replace')
 def test_pinned_entry_script_runs_with_its_arguments_and_exit_status(self):
  bundle,markers,pin=self.entry_bundle()
  code,log=self.entry(bundle,pin,'entry_marker.py','finalize','--nonce','synthetic-4421','--manifest-sha256',pin);self.assertEqual(code,0,log)
  self.assertEqual((markers/'helper').read_text(),'imported-4421');self.assertEqual((markers/'entry').read_text(),'finalize --nonce synthetic-4421 --manifest-sha256 '+pin)
  code,log=self.entry(bundle,pin,'entry_marker.py','--exit-7');self.assertEqual(code,7,log)
 def test_entry_script_and_its_siblings_are_verified_before_any_import(self):
  cases=[('changed-sibling','frozen first-party control file changed: helper_marker.py'),('unlisted-sibling','unreviewed entry in executed control directory: helper_marker.py'),('wrong-pin','operator-reviewed first-party bundle manifest'),
   ('unreviewed-entry','entry script is not a reviewed first-party file: absent_entry.py'),('path-entry','direct first-party entry script name'),('verifier-entry','direct first-party entry script name')]
  for case,expected in cases:
   with self.subTest(case=case):
    bundle,markers,pin=self.entry_bundle(listed=case!='unlisted-sibling');script='entry_marker.py'
    if case=='changed-sibling':(bundle/'helper_marker.py').write_bytes((bundle/'helper_marker.py').read_bytes()+b'# foreign-4421\n')
    if case=='wrong-pin':pin='0'*64
    if case=='unreviewed-entry':script='absent_entry.py'
    if case=='path-entry':script='../bundle/entry_marker.py'
    if case=='verifier-entry':script='run_checks.py'
    code,log=self.entry(bundle,pin,script,'finalize','--nonce','synthetic-4421')
    self.assertNotEqual(code,0);self.assertIn(expected,log);self.assertEqual(list(markers.iterdir()),[])
 def generated(self,launcher=None):
  import make_pause_workflow,make_workflow
  checkout=self.root/'generated';folder=checkout/'scripts'/'producer-sdk10';folder.mkdir(parents=True)
  for name in make_workflow.FILES:(folder/name).write_bytes((ROOT/name).read_bytes())
  if launcher is not None:(folder/'run_checks.py').write_bytes(launcher)
  make_pause_workflow.generate(folder,checkout/'pause.yml')
  commands={workflow:[x.strip().removeprefix('run: ') for x in (checkout/workflow).read_text().splitlines() if 'python' in x or '.py' in x] for workflow in ['pause.yml','ORIGINAL-NATIVE-UNGRANTED.yml']}
  return checkout,folder,commands,make_workflow.launcher(folder)
 def test_every_generated_first_party_step_enters_through_the_pinned_verifier(self):
  import make_workflow
  _,folder,generated,boot=self.generated()
  entry='--manifest-sha256 "$CHECKTRAIL_MANIFEST_SHA256" --entry '
  self.assertTrue(boot.endswith(' scripts/producer-sdk10/run_checks.py '+hashlib.sha256((ROOT/'run_checks.py').read_bytes()).hexdigest()+' '))
  for workflow,controls,entries in [('pause.yml',0,5),('ORIGINAL-NATIVE-UNGRANTED.yml',1,1+49*3+1)]:
   with self.subTest(workflow=workflow):
    commands=generated[workflow]
    # Every first-party command starts run_checks.py only through the bootstrap, in one
    # interpreter, and a failure ends the whole shell.
    self.assertEqual([x for x in commands if not x.startswith(boot) or not x.endswith(' || exit 1') or x.count('python3 ')!=1],[]);commands=[x[len(boot):-len(' || exit 1')] for x in commands]
    routed=[x for x in commands if x.startswith(entry)];checked=[x for x in commands if x.startswith('--out ')]
    self.assertEqual(sorted(routed+checked),sorted(commands));self.assertEqual((len(checked),len(routed)),(controls,entries))
    for command in routed:self.assertIn(command[len(entry):].split()[0],make_workflow.FILES)
 def run_generated(self,checkout,commands,markers):
  # One command of every distinct shape, as the hosted bash step runs it.
  shapes={}
  for command in commands:
   words=command.split();shapes.setdefault(tuple(words[words.index('--entry')+1:words.index('--entry')+3]) if '--entry' in words else 'controls',command)
  env={**os.environ,'CHECKTRAIL_MANIFEST_SHA256':'5'*64,'CHECKTRAIL_NONCE':'synthetic-6421','EXACT_ARTIFACT_IDS':'61,62','RUNNER_TEMP':str(self.root/'runner-6421')}
  results=[]
  for command in shapes.values():
   done=subprocess.run(['bash','--noprofile','--norc','-eo','pipefail','-c',command],cwd=checkout,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=60);results.append((done.returncode,done.stdout.decode('utf8','replace')))
  return results
 def marker_launcher(self,markers):
  return ('import pathlib,sys\npathlib.Path('+repr(str(markers))+').joinpath(str(len(list(pathlib.Path('+repr(str(markers))+').iterdir())))).write_text(" ".join(sys.argv[1:]))\nraise SystemExit(7 if "--exit-7" in sys.argv else 0)\n').encode()
 def test_generated_steps_run_the_launcher_whose_bytes_were_pinned_at_generation(self):
  markers=self.root/'markers-6421';markers.mkdir();checkout,folder,generated,_=self.generated(self.marker_launcher(markers))
  for workflow,commands in generated.items():
   with self.subTest(workflow=workflow):
    before=len(list(markers.iterdir()));results=self.run_generated(checkout,commands,markers)
    self.assertEqual([code for code,_ in results],[0]*len(results),results);self.assertEqual(len(list(markers.iterdir()))-before,len(results))
  written=[x.read_text() for x in markers.iterdir()];self.assertEqual(len(written),11)
  self.assertIn('--manifest-sha256 '+'5'*64+' --entry driver.py produce --nonce synthetic-6421 --manifest-sha256 '+'5'*64,written)
 def test_failed_launcher_check_on_an_early_line_fails_the_whole_controls_block(self):
  markers=self.root/'markers-6421';markers.mkdir();checkout,folder,generated,check=self.generated(self.marker_launcher(markers))
  block=[x for x in generated['pause.yml'] if 'test_' in x];self.assertEqual(len(block),4)
  # Only the first line's pin is wrong, so later lines alone would pass.
  pin=hashlib.sha256((folder/'run_checks.py').read_bytes()).hexdigest();block[0]=block[0].replace(pin,'0'*64,1);self.assertNotIn(pin,block[0])
  env={**os.environ,'CHECKTRAIL_MANIFEST_SHA256':'5'*64}
  done=subprocess.run(['bash','--noprofile','--norc','-eo','pipefail','-c','\n'.join(block)],cwd=checkout,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=60)
  self.assertNotEqual(done.returncode,0,done.stdout);self.assertIn(b'run_checks.py differs from its generated launcher pin',done.stdout);self.assertEqual(list(markers.iterdir()),[])
 def bootstrap(self,launcher,pin,*argv,wrapper=''):
  import make_workflow
  code=wrapper+'exec('+repr(make_workflow.BOOTSTRAP)+')'
  done=subprocess.run(['python3','-I','-S','-B','-c',code,str(launcher),pin,*argv],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=60)
  return done.returncode,done.stdout.decode('utf8','replace')
 def test_bootstrap_executes_the_bytes_it_hashed_and_never_reopens_the_launcher(self):
  markers=self.root/'markers-6421';markers.mkdir();launcher=self.root/'run_checks.py';original=self.marker_launcher(markers);launcher.write_bytes(original)
  swapped=('import pathlib\npathlib.Path('+repr(str(markers/'swapped'))+').write_text("swapped-6421")\n').encode();count=self.root/'opens-6421'
  # The hook swaps the file the moment the verified bytes are compiled and
  # counts every open of it; a bootstrap that reopened it would run the swap.
  wrapper=('import atexit,sys\nopens=[];path='+repr(str(launcher))+'\nbusy=[]\n'
   'def hook(event,args):\n'
   ' if busy:return\n'
   ' if event=="open" and str(args[0])==path:opens.append(args[1])\n'
   ' if event=="compile" and args[1]==path:\n'
   '  busy.append(1)\n'
   '  with open(path,"wb") as f:f.write('+repr(swapped)+')\n'
   '  busy.clear()\n'
   'sys.addaudithook(hook)\n'
   'atexit.register(lambda:open('+repr(str(count))+',"w").write(str(len(opens))))\n')
  code,log=self.bootstrap(launcher,hashlib.sha256(original).hexdigest(),'--entry','driver.py','finalize','--exit-7',wrapper=wrapper)
  self.assertEqual(code,7,log);self.assertEqual(launcher.read_bytes(),swapped);self.assertFalse((markers/'swapped').exists())
  self.assertEqual([x.read_text() for x in markers.iterdir()],['--entry driver.py finalize --exit-7']);self.assertEqual(count.read_text(),'1')
 def test_bootstrap_runs_the_real_launcher_with_its_arguments_and_exit_status(self):
  bundle,markers,pin=self.entry_bundle();launcher=bundle/'run_checks.py'
  code,log=self.bootstrap(launcher,hashlib.sha256(launcher.read_bytes()).hexdigest(),'--manifest-sha256',pin,'--entry','entry_marker.py','finalize','--nonce','synthetic-6421','--exit-7')
  self.assertEqual(code,7,log);self.assertEqual((markers/'helper').read_text(),'imported-4421');self.assertEqual((markers/'entry').read_text(),'finalize --nonce synthetic-6421 --exit-7')
  code,log=self.bootstrap(launcher,hashlib.sha256(launcher.read_bytes()).hexdigest(),'--manifest-sha256','0'*64,'--entry','entry_marker.py')
  self.assertNotEqual(code,0);self.assertIn('operator-reviewed first-party bundle manifest',log)
 def test_bootstrap_refuses_a_changed_launcher_without_running_it(self):
  markers=self.root/'markers-6421';markers.mkdir();launcher=self.root/'run_checks.py';original=self.marker_launcher(markers);launcher.write_bytes(original+b'# changed-6421\n')
  code,log=self.bootstrap(launcher,hashlib.sha256(original).hexdigest(),'--entry','driver.py')
  self.assertEqual(code,1);self.assertIn('run_checks.py differs from its generated launcher pin',log);self.assertEqual(list(markers.iterdir()),[])
 def test_generated_steps_refuse_a_changed_launcher_before_it_runs(self):
  markers=self.root/'markers-6421';markers.mkdir();checkout,folder,generated,_=self.generated(self.marker_launcher(markers))
  (folder/'run_checks.py').write_bytes((folder/'run_checks.py').read_bytes()+b'# changed-6421\n')
  for workflow,commands in generated.items():
   with self.subTest(workflow=workflow):
    results=self.run_generated(checkout,commands,markers)
    self.assertTrue(results);self.assertTrue(all(code!=0 and 'run_checks.py differs from its generated launcher pin' in log for code,log in results),results)
  self.assertEqual(list(markers.iterdir()),[])
if __name__=='__main__':
 result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Controls));print(json.dumps({'testsRun':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'skips':len(result.skipped),'nativeUpstreamDockerNetworkActions':0}));sys.exit(not result.wasSuccessful())
