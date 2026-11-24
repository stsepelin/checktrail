"""Mocked transports/physical inert files only; no Docker/image/native/key action."""
import copy
import json
import hashlib
import io
import tarfile
import os
import shutil
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent))
import common
import target_pause_controls as t
import driver
import producer_adapter
import pause_control_worker as worker
import meter

GOOD = {'exitCode': 0, 'reason': None, 'ownedChildStarted': True, 'ownedChildReaped': True}

class Target(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'control').mkdir(); (self.root / 'evidence').mkdir()
        self.ctx = {'run': 123, 'attempt': 1, 'nonce': 'synthetic-target', 'head': 'a' * 40}
        self.c = SimpleNamespace(root=self.root, ctx=self.ctx, state={'volume': 'inert-work', 'tempVolume': 'inert-tmp', 'prefix': 'ct-sdk10-synthetic-target'})
    def test_fixed_counter_metadata_requires_bounded_decimal_and_complete_transport(self):
        for value, row, accepted in [(b'0000000000000000001\n', GOOD, True), (b'0000000000000000000\n', GOOD, False), (b'1\n', GOOD, False), (b'0000000000000000001\n', {**GOOD, 'reason': 'owned command deadline'}, False)]:
            def command(args, deadline):
                Path(args[-1]).write_bytes(value); return row, None
            api = SimpleNamespace(c=self.c, binding={'id': 'a' * 64, 'name': 'ct-sdk10-synthetic-target-original-build'}, record={'expectedProtectedBinding': {'role':'build','purpose':'first-party-inert-control-only'}}, command=command)
            with self.subTest(value=value, row=row):
                if accepted: self.assertEqual(t.counter(api, 10), 1)
                else:
                    with self.assertRaises(common.Refusal): t.counter(api, 10)
    def test_control_cleanup_has_one_durable_exact_owned_delete_and_positive_absence(self):
        calls = []
        self.c.volume_owned = lambda name: {'Name': name, 'Labels': common.owned_labels(self.ctx)}
        self.c.docker = lambda args, **kw: (calls.append(args) or GOOD, None)
        inspected = iter([{'Name':'inert-work','Labels':common.owned_labels(self.ctx)}, None])
        self.c.inspect = lambda *args: next(inspected)
        with patch.object(t.time, 'monotonic', return_value=0):
            self.assertTrue(t.remove_control_volume(self.c, 'inert-work', 100))
            with self.assertRaises(common.Refusal): t.remove_control_volume(self.c, 'inert-work', 100)
        self.assertEqual(calls, [['volume', 'rm', 'inert-work']])
        self.assertNotIn('operatorFullRoundtripAcknowledged', self.c.state)
    def test_absent_intended_control_volume_is_recorded_without_delete_or_recovery_spoof(self):
        calls=[];self.c.inspect=lambda *args:None;self.c.docker=lambda *args,**kwargs:calls.append(args)
        with patch.object(t.time,'monotonic',return_value=0):self.assertTrue(t.remove_control_volume(self.c,'inert-work',100))
        self.assertEqual(calls,[]);self.assertNotIn('operatorFullRoundtripAcknowledged',self.c.state)
        row=common.read_json(self.root/'control/CONTROL-VOLUME-work-ALREADY-ABSENT.json');self.assertFalse(row['deleteAttempted']);self.assertTrue(row['positiveOwnedAbsenceObserved'])
    def test_foreign_volume_and_expired_cleanup_never_issue_delete(self):
        calls = []; self.c.docker = lambda *args, **kw: calls.append(args)
        self.c.volume_owned = lambda name: {'Name': name, 'Labels': common.owned_labels(self.ctx)}
        with self.assertRaises(common.Refusal): t.remove_control_volume(self.c, 'foreign', 100)
        with patch.object(t.time, 'monotonic', return_value=100), self.assertRaises(common.Refusal): t.remove_control_volume(self.c, 'inert-work', 100)
        self.assertEqual(calls, [])
    def test_physical_image_proof_refusal_precedes_volume_creation(self):
        profile = common.bundle_json(Path(__file__).parent / 'profile.json'); root = self.root / 'refused-image'
        capacity = self.root / 'capacity-image'; capacity.write_text('"amd64" 4\n'); calls = []
        def make_controller(path, ctx, selected):
            return SimpleNamespace(root=path, ctx=ctx, profile=selected, state=None, save=lambda:None, publish_observer=lambda:None, docker=lambda args, **kw:(calls.append(args) or GOOD, capacity))
        env = {'RUNNER_OS':'Linux','RUNNER_ARCH':'X64','GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REPOSITORY':profile['repository'],'GITHUB_RUN_ATTEMPT':'1','GITHUB_RUN_ID':'123','GITHUB_SHA':'a'*40}
        with patch.dict(os.environ, env), patch.object(t.sys,'platform','linux'), patch.object(t,'manifest_check',return_value=profile), patch.object(t,'Controller',side_effect=make_controller), patch.object(t,'prove_control_image',side_effect=common.Refusal('synthetic physical proof refusal')), patch.object(t.time,'monotonic',return_value=0), patch.object(t.platform,'machine',return_value='x86_64'), patch.object(Path,'stat',autospec=True,side_effect=lambda path,**kw:SimpleNamespace(st_size=32) if str(path)=='/etc/os-release' else os.stat(path,**kw)), patch.object(Path,'read_bytes',autospec=True,side_effect=lambda path:b'ID=ubuntu\nVERSION_ID="26.04"\n' if str(path)=='/etc/os-release' else path.open('rb').read()):
            self.assertEqual(t.run(root,'synthetic-target','b'*64),1)
        row=common.read_json(root/'RESULT.json');self.assertFalse(row['complete']);self.assertFalse(row['originalSdkBuildTestQuotaOrGateAQualified']);self.assertEqual(calls,[['info','--format','{{json .Architecture}} {{json .NCPU}}']])
    def test_ambiguous_volume_create_is_reserved_for_owned_cleanup_before_transport(self):
        profile=common.bundle_json(Path(__file__).parent/'profile.json');root=self.root/'ambiguous-create';capacity=self.root/'capacity';capacity.write_text('"amd64" 4\n')
        image={'Id':'sha256:'+profile['image']['configSHA256'],'Architecture':'amd64','Os':'linux','RootFS':{'Layers':['sha256:'+x for x in profile['image']['diffIDs']]}}
        calls=[];cleanup=[]
        def make_controller(path,ctx,selected):
            def docker(args,**kwargs):
                calls.append(args)
                if args[:2]==['volume','create']:raise TimeoutError('synthetic ambiguous create')
                return GOOD,capacity
            return SimpleNamespace(root=path,ctx=ctx,profile=selected,state=None,save=lambda:None,publish_observer=lambda:None,observer=lambda:None,docker=docker,inspect=lambda kind,name:image if kind=='image' else None)
        env={'RUNNER_OS':'Linux','RUNNER_ARCH':'X64','GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REPOSITORY':profile['repository'],'GITHUB_RUN_ATTEMPT':'1','GITHUB_RUN_ID':'123','GITHUB_SHA':'a'*40}
        with patch.dict(os.environ,env),patch.object(t.sys,'platform','linux'),patch.object(t,'manifest_check',return_value=profile),patch.object(t,'Controller',side_effect=make_controller),patch.object(t.time,'monotonic',return_value=0),patch.object(t.platform,'machine',return_value='x86_64'),patch.object(Path,'stat',autospec=True,side_effect=lambda path,**kw:SimpleNamespace(st_size=32) if str(path)=='/etc/os-release' else os.stat(path,**kw)),patch.object(Path,'read_bytes',autospec=True,side_effect=lambda path:b'ID=ubuntu\nVERSION_ID="26.04"\n' if str(path)=='/etc/os-release' else path.open('rb').read()),patch.object(t,'prove_control_image',return_value={'actualRuntimeImageID':image['Id'],'originalConfigSHA256':profile['image']['configSHA256']}),patch.object(t,'remove_control_volume',side_effect=lambda c,name,deadline:cleanup.append(name) or True):
            self.assertEqual(t.run(root,'synthetic-target','b'*64),1)
        self.assertEqual(cleanup,['ct-sdk10-123-synthetic-target-work']);row=common.read_json(root/'RESULT.json');self.assertEqual(row['failureType'],'TimeoutError');self.assertFalse(row['complete']);self.assertEqual(row['cleanupErrors'],[])
    def test_controlled_churn_output_is_runner_readable_and_restored_under_umask077(self):
        evidence=self.root/'worker-output';evidence.mkdir(mode=0o770);evidence.chmod(0o770);(evidence/'churn-delete.ack').write_bytes(b'inert ack')
        actual_path=Path;uid=os.getuid();gid=os.getgid();calls=[]
        def sample(root,deadline,hook):
            hook('after-stat',None,'churn-probe',None)
            return {'samplingComplete':False,'incompleteCode':'entry-vanished-during-sample'}
        old=os.umask(0o077)
        try:
            with patch.object(worker,'Path',side_effect=lambda value:evidence if str(value)=='/evidence' else actual_path(value)),patch.object(worker.os,'chown',side_effect=lambda *args:calls.append(args)),patch.object(meter,'sample_once',side_effect=sample):self.assertEqual(worker.strict_churn(uid,gid),0)
        finally:os.umask(old)
        target=evidence/'CONTROLLED-CHURN.json';self.assertEqual(target.stat().st_mode&0o777,0o400);self.assertEqual(target.stat().st_uid,uid)
        self.assertEqual(calls,[(evidence,0,gid),(target,uid,gid),(evidence,uid,gid)])
        self.assertEqual(common.read_json(target)['incompleteCode'],'entry-vanished-during-sample');self.assertFalse(common.read_json(target)['sampledWorkOrQuotaCredit'])
    def test_controlled_churn_sampler_failure_still_restores_exact_evidence_owner(self):
        evidence=self.root/'worker-failure';evidence.mkdir(mode=0o770);evidence.chmod(0o770);actual_path=Path;calls=[];uid=os.getuid();gid=os.getgid()
        with patch.object(worker,'Path',side_effect=lambda value:evidence if str(value)=='/evidence' else actual_path(value)),patch.object(worker.os,'chown',side_effect=lambda *args:calls.append(args)),patch.object(meter,'sample_once',side_effect=RuntimeError('synthetic scanner failure')),self.assertRaises(RuntimeError):worker.strict_churn(uid,gid)
        self.assertEqual(calls,[(evidence,0,gid),(evidence,uid,gid)]);self.assertFalse((evidence/'CONTROLLED-CHURN.json').exists())
    def declared_mounts(self,args):
        result=[]
        for i,value in enumerate(args):
            if value!='--mount':continue
            options=args[i+1].split(',');fields=dict(x.split('=',1) for x in options if '=' in x);kind=fields['type']
            result.append({'Type':kind,'Destination':fields['target'],'Name' if kind=='volume' else 'Source':fields['source'],'RW':'readonly' not in options})
        return result
    def canary_assembly(self,fault=None):
        number=getattr(self,'assembly_number',0)+1;self.assembly_number=number;root=self.root/('assembly-'+str(number));root.mkdir()
        for name in ['protected','evidence','control']:(root/name).mkdir()
        prefix='ct-sdk10-synthetic-assembly-'+str(number);name=prefix+'-original-build';gid=os.getgid()
        c=SimpleNamespace(root=root,ctx=self.ctx,state={'prefix':prefix,'gid':gid,'containers':[],'imageAlias':'synthetic-pinned-image','imageID':'sha256:'+'9'*64,'volume':'inert-work','tempVolume':'inert-temp','phaseDeadline':100,'nativeDeadline':100,'cleanupDeadline':120},save=lambda:None,inspect=lambda *args:None)
        snapshot=driver.publish_observer(root,common.verified_bundle());c.observer=lambda:driver.verify_observer(snapshot,common.verified_bundle());c.observer_entry=lambda args:driver.Controller.observer_entry(c,args)
        model={'calls':[],'declaredMounts':[],'obj':{'Id':'b'*64,'Name':'/'+name,'Config':{'Labels':common.owned_labels(self.ctx)},'State':{'Running':False,'Paused':False},'HostConfig':{'NetworkMode':'none','ReadonlyRootfs':True,'Privileged':False,'Memory':256*1024**2,'CapDrop':['ALL'],'GroupAdd':[str(gid)]}}};self.last_assembly=model
        def docker(args,**kwargs):
            model['calls'].append(args)
            if args[0]=='create':
                model['declaredMounts']=self.declared_mounts(args);mounts=copy.deepcopy(model['declaredMounts'])
                if fault is not None:
                    selected=next(m for m in mounts if m['Destination']=='/native-control')
                    if fault=='source':selected['Source']=str(root/'foreign')
                    elif fault=='destination':selected['Destination']='/native-control-suffix'
                    elif fault=='rw':selected['RW']=True
                    elif fault=='type':selected.update(Type='volume',Name='foreign')
                    elif fault=='missing':mounts.remove(selected)
                    elif fault=='duplicate':mounts[-2]=copy.deepcopy(selected)
                    elif fault=='foreign':mounts.append({'Type':'bind','Destination':'/foreign','Source':'/foreign','RW':False})
                model['obj']['Mounts']=mounts
            if args[0]=='start':model['obj']['State']['Running']=True
            return GOOD,None
        c.docker=docker;c.own_container=lambda _:copy.deepcopy(model['obj'])
        c.create_owned=lambda name,args,seconds=60:(docker(args),copy.deepcopy(model['obj']))[1]
        sequence=[0]
        def command(argv,seconds,check,cap):
            sequence[0]+=1;args=argv[1:];model['calls'].append(args);body=root/'control'/('command-'+str(sequence[0]));body.write_bytes(b'')
            if args[:2]==['container','inspect']:body.write_bytes(common.encoded([model['obj']]));return GOOD,body
            if args[0]=='cp':
                # Resolve ONLY the mounts actually present in Docker create.
                # The host protected path is not an implicit container path.
                identity,container_path=args[1].split(':',1);self.assertEqual(identity,'b'*64)
                matches=[m for m in model['declaredMounts'] if m['Type']=='bind' and (container_path==m['Destination'] or container_path.startswith(m['Destination']+'/'))]
                if not matches:return {**GOOD,'exitCode':1},body
                mount=max(matches,key=lambda m:len(m['Destination']));relative=container_path.removeprefix(mount['Destination']).lstrip('/');source=Path(mount['Source'])/relative
                if container_path!='/native-control/.' or not source.is_dir():return {**GOOD,'exitCode':1},body
                shutil.copytree(source,Path(args[2]),dirs_exist_ok=True,symlinks=True);return GOOD,body
            return GOOD,body
        c.cmd=command
        with patch.object(t,'wait_counter',return_value={'syntheticStartupFixture':True}):binding,api=t.create_producer(c,'build',100)
        return c,model,binding,api
    def test_canary_protected_start_custody_reads_only_declared_readonly_native_control_mount(self):
        c,model,binding,api=self.canary_assembly();native=next(m for m in model['declaredMounts'] if m['Destination']=='/native-control')
        self.assertEqual(native,{'Type':'bind','Destination':'/native-control','Source':str(c.root/'protected'/binding['name']),'RW':False});self.assertEqual(len(model['declaredMounts']),4)
        marker=Path(native['Source'])/'START.json';self.assertIs(common.read_json(marker)['originalCommandStarted'],False)
        model['obj']['State']['Running']=False
        with patch.object(producer_adapter.time,'monotonic',return_value=0):self.assertTrue(api.preserve_protected_metadata(binding,90))
        self.assertEqual(api.preservation['members']['START']['state'],'PRESERVED');self.assertFalse(api.preservation['originalExitOrBuildCredit'])
        self.assertTrue(any(args[:2]==['cp',binding['id']+':/native-control/.'] for args in model['calls']))
        # If the physical container path is not declared, cp must fail even
        # though the matching host START still exists. A fresh adapter avoids
        # reusing any earlier preservation state in this negative control.
        model['declaredMounts']=[m for m in model['declaredMounts'] if m['Destination']!='/native-control'];fresh=producer_adapter.ProducerAPI(c,binding['name'])
        with patch.object(producer_adapter.time,'monotonic',return_value=0),self.assertRaisesRegex(t.protocol.Refusal,'protected-copy-transport-incomplete'):fresh.preserve_protected_metadata(binding,90)
        with self.assertRaises(t.protocol.Refusal):fresh.force_remove_id(binding['id'],90)
        self.assertIsNone(fresh.preservation);self.assertFalse(any(args[:2]==['rm','-f'] for args in model['calls']))
    def test_canary_physical_mount_family_refuses_missing_foreign_duplicate_or_writable_protected_binding(self):
        for fault in ['source','destination','rw','type','missing','duplicate','foreign']:
            with self.subTest(fault=fault),self.assertRaises(common.Refusal):self.canary_assembly(fault)
            self.assertFalse(any(args[0]=='start' for args in self.last_assembly['calls']))
    def test_inert_writer_group_and_coord_mount_are_exact_and_guarded_before_start(self):
        (self.root/'protected').mkdir();prefix='ct-sdk10-synthetic-control';name=prefix+'-original-build';gid=os.getgid()
        self.c.state.update(prefix=prefix,gid=gid,containers=[],imageAlias='synthetic-pinned-image',imageID='sha256:'+'9'*64);self.c.save=lambda:None;self.c.inspect=lambda *args:None
        snapshot=driver.publish_observer(self.root,common.verified_bundle());self.c.observer=lambda:driver.verify_observer(snapshot,common.verified_bundle());self.c.observer_entry=lambda args:driver.Controller.observer_entry(self.c,args)
        obj={'Id':'b'*64,'Name':'/'+name,'Config':{'Labels':common.owned_labels(self.ctx)},'State':{'Running':False,'Paused':False},'HostConfig':{'NetworkMode':'none','ReadonlyRootfs':True,'Privileged':False,'Memory':256*1024**2,'CapDrop':['ALL'],'GroupAdd':[str(gid)]}}
        self.c.own_container=lambda _:copy.deepcopy(obj);calls=[]
        self.c.create_owned=lambda name,args,seconds=60:(self.c.docker(args),copy.deepcopy(obj))[1]
        def docker(args,**kwargs):
            calls.append(args)
            if args[0]=='create':obj['Mounts']=self.declared_mounts(args)
            return GOOD,None
        self.c.docker=docker
        with patch.object(t,'wait_counter',return_value={'synthetic':True}):
            binding,_=t.create_producer(self.c,'build',100)
        self.assertEqual(binding['id'],'b'*64);created=calls[0];self.assertEqual(created[created.index('--group-add')+1],str(gid));self.assertIn('type=bind,source='+str(self.root/'evidence')+',target=/coord',created);self.assertEqual(calls[1],['start','b'*64])
        self.assertIn('sha256:'+'9'*64,created);self.assertNotIn('synthetic-pinned-image',created)
        # A differing actual supplemental group is rejected before any start.
        self.c.state['containers']=[];self.c.state['nativeProducers']={};(self.root/'protected'/name/'START.json').unlink();(self.root/'protected'/name).rmdir();calls.clear();obj['HostConfig']['GroupAdd']=['foreign']
        with patch.object(t,'wait_counter',return_value={'synthetic':True}),self.assertRaises(common.Refusal):t.create_producer(self.c,'build',100)
        self.assertFalse(any(args[0]=='start' for args in calls));self.assertIn(name,self.c.state['nativeProducers'])
    def marker_api(self,role='tests',states=None):
        binding={'id':'b'*64,'name':self.c.state['prefix']+'-original-'+role,'labels':common.owned_labels(self.ctx)}
        obj={'Id':binding['id'],'Name':'/'+binding['name'],'Config':{'Labels':binding['labels']},'State':{'Running':True,'Paused':False}}
        volume=self.root/'shared-volume';volume.mkdir(exist_ok=True);calls=[];sequence=iter(states) if states is not None else None
        def inspect(identity,deadline):
            calls.append(('inspect',identity));value=copy.deepcopy(obj)
            if sequence is not None:value['State']['Running']=next(sequence,False)
            return value
        def command(args,deadline):
            calls.append(('command',args));marker=args[1].split(':/work/',1)[1];source=volume/marker
            if not source.is_file():return {**GOOD,'exitCode':1},None
            Path(args[2]).write_bytes(source.read_bytes());return GOOD,None
        api=SimpleNamespace(c=self.c,binding=binding,record={'expectedProtectedBinding':{'purpose':'first-party-inert-control-only','role':role}},inspect_id=inspect,command=command)
        return api,volume,calls
    def test_old_build_generic_and_suffix_markers_cannot_start_tests_writer(self):
        api,volume,calls=self.marker_api('tests');clock=[0.0]
        for name in ['counter-build','counter','counter-tests-suffix']:(volume/name).write_bytes(b'0000000000000000999\n')
        def sleep(value):clock[0]+=value
        with patch.object(t.time,'monotonic',side_effect=lambda:clock[0]),patch.object(t.time,'sleep',side_effect=sleep),self.assertRaises(t.ControlRefusal):t.wait_counter(api,0.12)
        copies=[x[1][1] for x in calls if x[0]=='command'];self.assertTrue(copies);self.assertTrue(all(x=='b'*64+':/work/counter-tests' for x in copies))
        (volume/'counter-tests').write_bytes(b'0000000000000000002\n');clock[0]=0;calls.clear()
        with patch.object(t.time,'monotonic',side_effect=lambda:clock[0]):row=t.wait_counter(api,1)
        self.assertEqual((row['id'],row['role'],row['marker'],row['positiveCounter']),('b'*64,'tests','counter-tests',2));self.assertTrue(row['freshRunningBeforeAndAfterMarkerRead']);self.assertFalse(row['originalSourceStartupOrBuildCredit'])
        self.assertEqual([x[1] for x in calls if x[0]=='inspect'],['b'*64,'b'*64])
    def test_positive_current_marker_needs_running_exact_id_before_and_after_read(self):
        for states in [[False],[True,False]]:
            with self.subTest(states=states):
                api,volume,calls=self.marker_api('tests',states);(volume/'counter-tests').write_bytes(b'0000000000000000003\n')
                with patch.object(t.time,'monotonic',return_value=0),self.assertRaises(common.Refusal):t.wait_counter(api,1)
                self.assertEqual(len([x for x in calls if x[0]=='command']),int(states[0]))
        api,volume,calls=self.marker_api();(volume/'counter-tests').write_bytes(b'0000000000000000003\n');original=api.inspect_id
        def foreign(identity,deadline):value=original(identity,deadline);value['Id']='f'*64;return value
        api.inspect_id=foreign
        with patch.object(t.time,'monotonic',return_value=0),self.assertRaises(t.protocol.Refusal):t.wait_counter(api,1)
        self.assertFalse(any(x[0]=='command' for x in calls))
    def test_two_real_inert_writers_start_sequentially_on_shared_filesystem_with_role_markers(self):
        volume=self.root/'writer-shared';volume.mkdir();coord=self.root/'writer-coord';coord.mkdir();real_path=Path;clock=[0]
        def path(value):
            value=str(value)
            if value=='/work':return volume
            if value.startswith('/coord/'):return coord/value.removeprefix('/coord/')
            return real_path(value)
        def sleep(seconds):clock[0]+=1
        with patch.object(worker,'Path',side_effect=path),patch.object(worker.time,'monotonic',side_effect=lambda:clock[0]),patch.object(worker.time,'sleep',side_effect=sleep):
            self.assertEqual(worker.writer(2,'build'),0);build=(volume/'counter-build').read_bytes();self.assertGreater(int(build),0)
            self.assertEqual(worker.writer(4,'tests'),0);tests=(volume/'counter-tests').read_bytes();self.assertGreater(int(tests),0)
        self.assertEqual((volume/'counter-build').read_bytes(),build);self.assertFalse((volume/'counter').exists());self.assertEqual(len(build),20);self.assertEqual(len(tests),20)
    def test_counter_role_binding_refuses_suffix_foreign_name_and_original_source_context(self):
        api,_,calls=self.marker_api('tests')
        for change in [{'role':'tests-suffix'},{'purpose':'original-sdk-source'}]:
            previous=api.record['expectedProtectedBinding'].copy();api.record['expectedProtectedBinding'].update(change)
            with self.subTest(change=change),self.assertRaises(common.Refusal):t.counter(api,1)
            api.record['expectedProtectedBinding']=previous
        api.binding['name']+='-suffix'
        with self.assertRaises(common.Refusal):t.counter(api,1)
        self.assertEqual(calls,[])
    def test_pause_counter_changes_are_not_accepted_as_paused_stability(self):
        api = object.__new__(t.ObservedAPI); api.events = []; api.binding = {'id': 'a' * 64}
        api.inspect_id = lambda *args: {'State': {'Paused': True}}
        with patch.object(producer_adapter.ProducerAPI, 'pause_id', return_value=GOOD), patch.object(t, 'counter', side_effect=[1, 2]), patch.object(t.time, 'sleep'), patch.object(t.time, 'monotonic', return_value=0), self.assertRaises(common.Refusal): api.pause_id('a' * 64, 5)
        self.assertEqual(api.events, [])
    def test_pause_success_observes_real_state_and_two_equal_counter_reads(self):
        api = object.__new__(t.ObservedAPI); api.events = []; api.binding = {'id': 'a' * 64}
        api.inspect_id = lambda *args: {'State': {'Paused': True}}
        with patch.object(producer_adapter.ProducerAPI, 'pause_id', return_value=GOOD), patch.object(t, 'counter', side_effect=[3, 3]) as reads, patch.object(t.time, 'sleep'), patch.object(t.time, 'monotonic', return_value=0): self.assertEqual(api.pause_id('a' * 64, 5), GOOD)
        self.assertEqual(reads.call_count, 2); self.assertEqual(api.events, [{'case': 'actual-pause-counter-stability', 'passed': True}])
    def test_unpause_transport_failure_has_no_counter_advancement_credit(self):
        api = object.__new__(t.ObservedAPI); api.events = []; api.binding = {'id': 'a' * 64}
        bad = {**GOOD, 'reason': 'owned command deadline'}
        with patch.object(producer_adapter.ProducerAPI, 'unpause_id', return_value=bad), patch.object(t, 'counter') as reads: self.assertEqual(api.unpause_id('a' * 64, 5), bad)
        reads.assert_not_called(); self.assertEqual(api.events, [])

class PhysicalImage(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        for name in ['control','evidence']:(self.root/name).mkdir()
        self.ctx={'run':123,'head':'a'*40,'attempt':1,'nonce':'synthetic-image'}
    def model(self, runtime='manifest', fault=None, preexisting=None, backend='classic'):
        config=b'{"firstPartyInertImageConfig":true}\n';layers=[b'a',b'b',b'cc',b'ddd'];configsha=hashlib.sha256(config).hexdigest();diffs=[hashlib.sha256(x).hexdigest() for x in layers]
        selected={'reference':'mcr.microsoft.com/dotnet-buildtools/prereqs@sha256:'+'d'*64,'manifestSHA256':'d'*64,'configSHA256':configsha,'diffIDs':diffs,'rawLayerBytes':sum(map(len,layers)),'staticNoticePackageHandoffSHA256':'e'*64}
        alias='checktrail-sdk10-controls-owned:123-synthetic-image';image={'Id':'sha256:'+('d'*64 if runtime=='manifest' else configsha),'Architecture':'amd64','Os':'linux','RootFS':{'Layers':['sha256:'+x for x in diffs]}}
        calls=[];state={'imageAlias':alias,'imageAliasCreated':False,'preparationDeadline':100,'cleanupDeadline':100};live={'alias':False,'canonical':False,'preexistingParent':True};c=SimpleNamespace(root=self.root,ctx=self.ctx,profile={'image':selected},state=state,save=lambda:None)
        base_tags=['foreign-cache:keep'] if preexisting=='foreign-tag' else []
        def inspect(kind,name):
            calls.append(['inspect',kind,name])
            exists=live['canonical'] if name==selected['reference'] else live['alias']
            if not exists:return None
            tags=base_tags+([alias] if live['alias'] else [])
            if backend in ['containerd','canonical-tag-only'] and live['canonical']:tags+=[selected['reference']]
            if fault=='foreign-tag':tags+=['foreign-concurrent:keep']
            digests=([selected['reference']] if live['canonical'] else [])
            if backend in ['containerd','derived-digest-only'] and live['alias']:digests+=[alias.rsplit(':',1)[0]+'@sha256:'+selected['manifestSHA256']]
            if fault=='foreign-digest':digests+=['foreign.invalid/image@sha256:'+'f'*64]
            return {**copy.deepcopy(image),'RepoTags':tags,'RepoDigests':digests}
        def cmd(args,**kwargs):
            self.assertEqual(args,['docker','image','ls','--all','--quiet','--no-trunc']);self.assertEqual(kwargs,{'seconds':30,'check':False,'cap':65536});calls.append(['baseline',*args])
            ids=[image['Id']] if preexisting in ['foreign-tag','dangling'] or live['canonical'] or live['alias'] else (['sha256:'+'0'*64] if preexisting in ['unrelated','parent'] else [])
            path=self.root/'control/baseline-command.stdout';path.write_bytes(b'abbreviated\n' if fault=='baseline' else ''.join(x+'\n' for x in ids).encode());return GOOD,path
        def docker(args,**kwargs):
            calls.append(args)
            if args[0]=='pull':
                live['canonical']=True
                if fault=='ambiguous-pull':raise TimeoutError('inert ambiguous pull')
            if args[0]=='tag':
                live['alias']=True
                if fault=='ambiguous-tag':raise TimeoutError('inert ambiguous tag')
            if args[0]=='save':
                with tarfile.open(Path(args[2]),'w') as archive:
                    bodies={configsha+'.json':b'{"firstPartyInertImageConfig":false}\n' if fault=='config' else config,'manifest.json':json.dumps([{'Config':configsha+'.json','Layers':['layer-'+str(i) for i in range(4)]}]).encode()}
                    bodies.update({'layer-'+str(i):(b'zz' if fault=='layer' and i==2 else raw) for i,raw in enumerate(layers)})
                    for name,raw in bodies.items():
                        info=tarfile.TarInfo(name);info.size=len(raw);archive.addfile(info,io.BytesIO(raw))
            if args[:2]==['image','rm']:
                if fault!='removal-present':
                    if args[-1]==alias:
                        live['alias']=False
                        if fault not in ['removal-alias-only','removal-canonical-present'] and backend!='containerd':live['canonical']=False
                    else:
                        self.assertEqual(args[-1],selected['reference'])
                        if fault!='removal-canonical-present':live['canonical']=False
                if not live['alias'] and not live['canonical'] and '--no-prune' not in args:live['preexistingParent']=False
                if fault=='removal-throws-absent':live['alias']=False;live['canonical']=False;raise TimeoutError('inert ambiguous delete after both gone')
                if fault=='removal-throws-canonical' and args[-1]==alias:raise TimeoutError('inert ambiguous alias delete with canonical remaining')
                if fault in ['removal-present','removal-ambiguous-absent']:return {**GOOD,'reason':'owned command deadline'},None
            return GOOD,None
        c.inspect=inspect;c.docker=docker;c.cmd=cmd;return c,calls,live,image
    def image_scope(self):
        return patch.object(t.shutil,'disk_usage',return_value=SimpleNamespace(free=16*1024**3))
    def test_original_physical_proof_accepts_manifest_runtime_id_separately_from_config(self):
        c,calls,live,image=self.model()
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0):result=t.prove_control_image(c,100)
        self.assertEqual(result['actualRuntimeImageID'],'sha256:'+'d'*64);self.assertEqual(result['originalConfigSHA256'],c.profile['image']['configSHA256']);self.assertNotEqual(result['actualRuntimeImageID'],'sha256:'+result['originalConfigSHA256']);self.assertTrue(result['imageConfigAndRawLayersPhysicallyVerified']);self.assertEqual(result['imageProofOpaqueRawLayerBytes'],7)
        self.assertEqual([x[0] for x in calls if x[0]!='inspect'],['baseline','pull','tag','save']);self.assertFalse((self.root/'original-image-proof.tar').exists())
    def test_alias_is_tagged_exported_and_recorded_by_the_admitted_image_id(self):
        c,calls,_,image=self.model()
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0):t.prove_control_image(c,100)
        tag=[x for x in calls if x[0]=='tag'];save=[x for x in calls if x[0]=='save']
        self.assertEqual(tag,[['tag','sha256:'+'d'*64,c.state['imageAlias']]]);self.assertEqual(save[0][-1],'sha256:'+'d'*64);self.assertEqual(c.state['imageID'],'sha256:'+'d'*64)
    def test_alias_bound_to_other_content_after_tag_is_never_exported_or_recorded(self):
        c,calls,live,image=self.model();original=c.inspect
        def rebound(kind,name):
            value=original(kind,name)
            # Another daemon client moves the owned alias to other content right after the tag.
            if value is not None and name==c.state['imageAlias'] and any(x[0]=='tag' for x in calls if type(x) is list):value={**value,'Id':'sha256:'+'f'*64}
            return value
        c.inspect=rebound
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0),self.assertRaisesRegex(common.Refusal,'owned alias names the admitted image ID'):t.prove_control_image(c,100)
        self.assertFalse(any(x[0]=='save' for x in calls));self.assertNotIn('imageID',c.state)
    def test_config_runtime_backend_is_also_physical_not_a_boolean_waiver(self):
        c,_,_,_=self.model(runtime='config')
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0):result=t.prove_control_image(c,100)
        self.assertEqual(result['actualRuntimeImageID'],'sha256:'+result['originalConfigSHA256'])
    def test_changed_raw_config_is_rejected_even_with_expected_manifest_runtime_id(self):
        c,calls,_,_=self.model(fault='config')
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0),self.assertRaisesRegex(common.Refusal,'config bytes'):t.prove_control_image(c,100)
        self.assertFalse((self.root/'evidence/ORIGINAL-IMAGE-IDENTITY.json').exists());self.assertIn('save',[x[0] for x in calls])
    def test_changed_raw_layer_is_rejected_even_with_expected_inspect_layer_ids(self):
        c,_,_,_=self.model(fault='layer')
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0),self.assertRaisesRegex(common.Refusal,'rawdiffID'):t.prove_control_image(c,100)
        self.assertFalse((self.root/'evidence/ORIGINAL-IMAGE-IDENTITY.json').exists())
    def test_no_physical_proof_cannot_be_replaced_by_caller_boolean(self):
        c,_,_,_=self.model()
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0),patch.object(t,'prove_image',return_value={'verified':True}),self.assertRaises(FileNotFoundError):t.prove_control_image(c,100)
    def test_ambiguous_tag_is_reserved_for_exact_alias_cleanup(self):
        c,calls,live,_=self.model(fault='ambiguous-tag')
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0):
            with self.assertRaises(TimeoutError):t.prove_control_image(c,100)
            self.assertTrue(c.state['ownedImageInputsReserved']);self.assertTrue(live['alias']);self.assertTrue(t.cleanup_image_inputs(c,100)['positiveOwnedCanonicalAbsenceObserved'])
        self.assertEqual([x for x in calls if x[:2]==['image','rm']],[['image','rm','--no-prune',c.state['imageAlias']]])
    def test_only_exact_owned_alias_removed_once_with_final_absence(self):
        c,calls,_,_=self.model()
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0):
            t.prove_control_image(c,100);self.assertTrue(t.cleanup_image_inputs(c,100)['positiveOwnedCanonicalAbsenceObserved'])
            with self.assertRaisesRegex(common.Refusal,'one image inputs cleanup'):t.cleanup_image_inputs(c,100)
        self.assertEqual([x for x in calls if x[:2]==['image','rm']],[['image','rm','--no-prune',c.state['imageAlias']]])
    def test_still_present_after_ambiguous_delete_never_repeats_request(self):
        c,calls,_,_=self.model(fault='removal-present')
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0):
            t.prove_control_image(c,100)
            with self.assertRaisesRegex(common.Refusal,'alias still present or uncertain'):t.cleanup_image_inputs(c,100)
            with self.assertRaisesRegex(common.Refusal,'one image inputs cleanup'):t.cleanup_image_inputs(c,100)
        self.assertEqual(len([x for x in calls if x[:2]==['image','rm']]),1)
    def test_absence_after_ambiguous_delete_is_recorded_without_second_delete(self):
        c,calls,_,_=self.model(fault='removal-ambiguous-absent')
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0):
            t.prove_control_image(c,100);self.assertTrue(t.cleanup_image_inputs(c,100)['positiveOwnedCanonicalAbsenceObserved'])
        proof=common.read_json(self.root/'control/IMAGE-INPUT-CLEANUP-RESULT.json');self.assertTrue(proof['positiveOwnedAliasAbsenceObserved']);self.assertEqual(proof['operations'][0]['removeCommand']['reason'],'owned command deadline');self.assertEqual(len([x for x in calls if x[:2]==['image','rm']]),1)
    def test_existing_foreign_alias_refuses_before_image_pull_or_cleanup_reservation(self):
        c,calls,live,_=self.model();live['alias']=True
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0),self.assertRaisesRegex(common.Refusal,'initially absent'):t.prove_control_image(c,100)
        self.assertNotIn('ownedImageInputsReserved',c.state);self.assertEqual([x for x in calls if x[0]!='inspect'],[])
    def test_insufficient_export_scratch_refuses_before_pull(self):
        c,calls,_,_=self.model()
        with patch.object(t.shutil,'disk_usage',return_value=SimpleNamespace(free=9*1024**3-1)),patch.object(t.time,'monotonic',return_value=0),self.assertRaisesRegex(common.Refusal,'nine GiB'):t.prove_control_image(c,100)
        self.assertEqual([x for x in calls if x[0]!='inspect'],[])
    def test_foreign_alias_content_after_proof_never_issues_removal(self):
        c,calls,_,image=self.model()
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0):
            t.prove_control_image(c,100);original=c.inspect
            c.inspect=lambda kind,name:{**original(kind,name),'Id':'sha256:'+'0'*64} if name==c.state['imageAlias'] else original(kind,name)
            with self.assertRaisesRegex(common.Refusal,'same newly owned selected image content'):t.cleanup_image_inputs(c,100)
        self.assertEqual([x for x in calls if x[:2]==['image','rm']],[])
    def test_preexisting_selected_content_under_foreign_tag_cannot_be_adopted_or_deleted(self):
        c,calls,live,_=self.model(preexisting='foreign-tag')
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0):
            with self.assertRaisesRegex(common.Refusal,'genuinely new'):t.prove_control_image(c,100)
            with self.assertRaisesRegex(common.Refusal,'existed before'):t.cleanup_image_inputs(c,100)
        self.assertTrue(live['canonical']);self.assertFalse(live['alias']);self.assertNotIn('tag',[x[0] for x in calls]);self.assertEqual([x for x in calls if x[:2]==['image','rm']],[])
        row=common.read_json(self.root/'control/IMAGE-PULL-ADMISSION.json');self.assertTrue(row['selectedRuntimeContentWasInPrePullBaseline']);self.assertFalse(row['ownedNewSelectedContent']);self.assertFalse(row['newCanonicalRefSideEffectResolved'])
    def test_preexisting_dangling_selected_content_cannot_be_adopted_or_deleted(self):
        c,calls,live,_=self.model(preexisting='dangling')
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0):
            with self.assertRaisesRegex(common.Refusal,'genuinely new'):t.prove_control_image(c,100)
            with self.assertRaisesRegex(common.Refusal,'existed before'):t.cleanup_image_inputs(c,100)
        self.assertTrue(live['canonical']);self.assertFalse(live['alias']);self.assertEqual([x for x in calls if x[:2]==['image','rm']],[])
    def test_unrelated_baseline_image_is_a_valid_near_miss_not_empty_daemon_requirement(self):
        c,calls,live,_=self.model(preexisting='unrelated')
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0):
            self.assertTrue(t.prove_control_image(c,100)['imageConfigAndRawLayersPhysicallyVerified']);row=t.cleanup_image_inputs(c,100)
        self.assertTrue(row['positiveOwnedCanonicalAbsenceObserved']);self.assertTrue(row['positiveOwnedAliasAbsenceObserved']);self.assertFalse(live['canonical']);self.assertFalse(live['alias']);self.assertEqual([x for x in calls if x[:2]==['image','rm']],[['image','rm','--no-prune',c.state['imageAlias']]])
    def test_canonical_preexists_refuses_before_pull_and_no_ownership_reservation(self):
        c,calls,live,_=self.model();live['canonical']=True
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0),self.assertRaisesRegex(common.Refusal,'canonical image initially absent'):t.prove_control_image(c,100)
        self.assertEqual([x for x in calls if x[0]!='inspect'],[]);self.assertFalse((self.root/'control/IMAGE-INPUT-OWNERSHIP.json').exists())
    def test_abbreviated_baseline_refuses_before_any_pull_or_reservation(self):
        c,calls,_,_=self.model(fault='baseline')
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0),self.assertRaisesRegex(common.Refusal,'full image IDs'):t.prove_control_image(c,100)
        self.assertEqual([x[0] for x in calls if x[0]!='inspect'],['baseline']);self.assertFalse((self.root/'control/IMAGE-INPUT-OWNERSHIP.json').exists())
    def test_ambiguous_pull_new_owned_canonical_is_cleaned_once_without_alias(self):
        c,calls,live,_=self.model(fault='ambiguous-pull')
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0):
            with self.assertRaises(TimeoutError):t.prove_control_image(c,100)
            row=t.cleanup_image_inputs(c,100)
        self.assertTrue(row['positiveOwnedCanonicalAbsenceObserved']);self.assertFalse(live['canonical']);self.assertFalse(live['alias']);self.assertEqual([x for x in calls if x[:2]==['image','rm']],[['image','rm','--no-prune',c.profile['image']['reference']]])
    def test_foreign_tags_or_digests_after_owned_proof_forbid_delete(self):
        base=self.root
        for field,extra in [('RepoTags','foreign-cache:keep'),('RepoDigests','foreign.invalid/x@sha256:'+'f'*64)]:
            self.root=base/field;self.root.mkdir();(self.root/'control').mkdir();(self.root/'evidence').mkdir();c,calls,_,_=self.model()
            with self.image_scope(),patch.object(t.time,'monotonic',return_value=0):
                t.prove_control_image(c,100);original=c.inspect
                def inspect(kind,name):
                    row=original(kind,name)
                    return {**row,field:row[field]+[extra]} if row is not None else None
                c.inspect=inspect
                with self.subTest(field=field),self.assertRaisesRegex(common.Refusal,'foreign image tags|newly owned selected digest'):t.cleanup_image_inputs(c,100)
            self.assertEqual([x for x in calls if x[:2]==['image','rm']],[])
        self.root=base
    def test_production_recovery_gate_uses_same_owned_cleanup_and_truthful_last_tag_semantics(self):
        import driver
        c,calls,live,_=self.model();cleanup=[]
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0):
            t.prove_control_image(c,100);driver.finalize_image_inputs(c,False,cleanup);self.assertEqual(cleanup,[]);self.assertTrue(live['canonical']);self.assertTrue(live['alias'])
            driver.finalize_image_inputs(c,True,cleanup)
        self.assertFalse(live['canonical']);self.assertFalse(live['alias']);self.assertEqual(cleanup[0]['kind'],'owned-image-inputs');self.assertTrue(cleanup[0]['positiveOwnedAbsenceObserved']);self.assertTrue(cleanup[0]['positiveOwnedAliasAbsenceObserved']);self.assertTrue(cleanup[0]['positiveOwnedCanonicalAbsenceObserved']);self.assertNotIn('preexistingCanonicalImageOrOtherTagsRemoved',cleanup[0]);self.assertFalse(cleanup[0]['daemonLayersOrBytesReclaimedAssessed'])
    def test_partial_reference_absence_is_preserved_without_generic_cleanup_credit(self):
        import driver
        c,calls,live,_=self.model(fault='removal-canonical-present');cleanup=[]
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0):
            t.prove_control_image(c,100);driver.finalize_image_inputs(c,True,cleanup)
        self.assertFalse(cleanup[0]['positiveOwnedAbsenceObserved']);row=common.read_json(self.root/'control/IMAGE-INPUT-CLEANUP-RESULT.json');self.assertTrue(row['positiveOwnedAliasAbsenceObserved']);self.assertFalse(row['positiveOwnedCanonicalAbsenceObserved']);self.assertFalse(row['positiveOwnedAbsenceObserved']);self.assertIsNotNone(row['operations'][0]['removeCommand']);self.assertEqual(len([x for x in calls if x[:2]==['image','rm']]),2)
    def test_missing_required_image_ownership_after_recovery_is_explicit_incomplete(self):
        import driver
        c,calls,live,_=self.model();cleanup=[]
        with patch.object(t.time,'monotonic',return_value=0):driver.finalize_image_inputs(c,True,cleanup)
        self.assertEqual(len(cleanup),1);self.assertEqual(cleanup[0]['kind'],'owned-image-inputs');self.assertFalse(cleanup[0]['positiveOwnedAbsenceObserved']);self.assertFalse(cleanup[0]['positiveOwnedAliasAbsenceObserved']);self.assertFalse(cleanup[0]['positiveOwnedCanonicalAbsenceObserved']);self.assertEqual(cleanup[0]['cleanupErrorType'],'Refusal');self.assertEqual(calls,[])
    def test_invalid_required_image_ownership_after_recovery_cannot_be_omitted(self):
        import driver
        c,calls,live,_=self.model();cleanup=[]
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0):
            t.prove_control_image(c,100);ownership=self.root/'control/IMAGE-INPUT-OWNERSHIP.json';value=common.read_json(ownership);value['context']={**self.ctx,'nonce':'foreign-context'};ownership.chmod(0o600);ownership.write_bytes(common.encoded(value));driver.finalize_image_inputs(c,True,cleanup)
        self.assertEqual(len(cleanup),1);self.assertFalse(cleanup[0]['positiveOwnedAbsenceObserved']);self.assertEqual(cleanup[0]['cleanupErrorType'],'Refusal');self.assertTrue(live['alias']);self.assertTrue(live['canonical']);self.assertEqual([x for x in calls if x[:2]==['image','rm']],[])
    def test_containerd_exact_names_pass_physical_proof_and_two_distinct_reference_deletes(self):
        c,calls,live,_=self.model(backend='containerd')
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0):
            t.prove_control_image(c,100);row=t.cleanup_image_inputs(c,100)
        self.assertTrue(row['positiveOwnedAbsenceObserved']);self.assertFalse(live['alias']);self.assertFalse(live['canonical']);self.assertEqual([x for x in calls if x[:2]==['image','rm']],[['image','rm','--no-prune',c.state['imageAlias']],['image','rm','--no-prune',c.profile['image']['reference']]]);self.assertEqual([x['role'] for x in row['operations']],['alias','canonical'])
    def test_finite_classic_and_derived_exact_reference_forms_are_valid_near_misses(self):
        base=self.root
        for backend in ['classic','canonical-tag-only','derived-digest-only']:
            self.root=base/backend;self.root.mkdir();(self.root/'control').mkdir();(self.root/'evidence').mkdir();c,_,_,_=self.model(backend=backend)
            with self.subTest(backend=backend),self.image_scope(),patch.object(t.time,'monotonic',return_value=0):
                self.assertTrue(t.prove_control_image(c,100)['imageConfigAndRawLayersPhysicallyVerified']);self.assertTrue(t.cleanup_image_inputs(c,100)['positiveOwnedAbsenceObserved'])
        self.root=base
    def test_prefix_suffix_duplicate_and_foreign_derived_names_never_enter_reference_allowlist(self):
        import owned_image
        c,_,_,image=self.model();alias=c.state['imageAlias'];canonical=c.profile['image']['reference'];derived=owned_image.reference_sets(alias,canonical)
        valid={**image,'RepoTags':[alias,canonical],'RepoDigests':[canonical,derived]}
        self.assertEqual(owned_image.references(valid,alias,canonical,True)['repoDigestCount'],2)
        for field,items in [('RepoTags',[alias+'-suffix',canonical]),('RepoTags',[alias,canonical+'-suffix']),('RepoDigests',[canonical,derived+'-suffix']),('RepoDigests',[canonical,derived.replace('controls-owned','controls-owned-foreign')]),('RepoTags',[alias,alias]),('RepoDigests',[canonical,canonical]),('RepoTags',None),('RepoDigests',[True])]:
            with self.subTest(field=field,items=items),self.assertRaises(common.Refusal):owned_image.references({**valid,field:items},alias,canonical,True)
    def test_classic_last_tag_removes_both_so_no_second_operation_or_request(self):
        c,calls,_,_=self.model()
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0):t.prove_control_image(c,100);row=t.cleanup_image_inputs(c,100)
        self.assertEqual([x['role'] for x in row['operations']],['alias']);self.assertFalse((self.root/'control/IMAGE-DELETE-CANONICAL-REQUEST.json').exists());self.assertEqual(len([x for x in calls if x[:2]==['image','rm']]),1)
    def test_unavailable_alias_inspection_after_delete_blocks_canonical_operation(self):
        c,calls,_,_=self.model(backend='containerd')
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0):
            t.prove_control_image(c,100);original=c.inspect
            def inspect(kind,name):
                if name==c.state['imageAlias'] and any(x[:2]==['image','rm'] for x in calls):raise TimeoutError('inert alias read unavailable')
                return original(kind,name)
            c.inspect=inspect
            with self.assertRaises(common.Refusal):t.cleanup_image_inputs(c,100)
        self.assertEqual([x for x in calls if x[:2]==['image','rm']],[['image','rm','--no-prune',c.state['imageAlias']]]);row=common.read_json(self.root/'control/IMAGE-INPUT-CLEANUP-RESULT.json');self.assertFalse(row['positiveOwnedAbsenceObserved']);self.assertFalse(row['positiveOwnedAliasAbsenceObserved']);self.assertEqual(row['inspectionErrors'],{'alias':'TimeoutError'});self.assertFalse((self.root/'control/IMAGE-DELETE-CANONICAL-REQUEST.json').exists())
    def test_throwing_delete_after_positive_absence_retains_unknown_process_provenance(self):
        c,_,_,_=self.model(fault='removal-throws-absent')
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0):t.prove_control_image(c,100);row=t.cleanup_image_inputs(c,100)
        self.assertTrue(row['positiveOwnedAbsenceObserved']);self.assertEqual(len(row['operations']),1);op=row['operations'][0];self.assertIsNone(op['removeCommand']);self.assertEqual(op['operatorCommandErrorType'],'TimeoutError');self.assertNotIn('exitCode',op);self.assertNotIn('ownedChildStarted',op)
    def test_unknown_alias_command_with_known_absence_allows_one_separate_owned_canonical_delete(self):
        c,calls,_,_=self.model(fault='removal-throws-canonical',backend='containerd')
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0):t.prove_control_image(c,100);row=t.cleanup_image_inputs(c,100)
        self.assertTrue(row['positiveOwnedAbsenceObserved']);self.assertEqual([x['role'] for x in row['operations']],['alias','canonical']);self.assertIsNone(row['operations'][0]['removeCommand']);self.assertEqual(row['operations'][0]['operatorCommandErrorType'],'TimeoutError');self.assertEqual(row['operations'][1]['removeCommand']['exitCode'],0);self.assertEqual(len([x for x in calls if x[:2]==['image','rm']]),2)
    def test_foreign_reference_appearing_after_alias_operation_blocks_second_delete(self):
        c,calls,_,_=self.model(backend='containerd')
        with self.image_scope(),patch.object(t.time,'monotonic',return_value=0):
            t.prove_control_image(c,100);original=c.inspect
            def inspect(kind,name):
                value=original(kind,name)
                if name==c.profile['image']['reference'] and value is not None and any(x[:2]==['image','rm'] for x in calls):value['RepoTags'].append('foreign-cache:keep')
                return value
            c.inspect=inspect
            with self.assertRaisesRegex(common.Refusal,'foreign image tags'):t.cleanup_image_inputs(c,100)
        row=common.read_json(self.root/'control/IMAGE-INPUT-CLEANUP-RESULT.json');self.assertTrue(row['positiveOwnedAliasAbsenceObserved']);self.assertFalse(row['positiveOwnedCanonicalAbsenceObserved']);self.assertFalse(row['positiveOwnedAbsenceObserved']);self.assertEqual([x for x in calls if x[:2]==['image','rm']],[['image','rm','--no-prune',c.state['imageAlias']]])
    def test_late_final_image_cleanup_persistence_retains_absences_without_budget_credit(self):
        import owned_image
        c,_,_,_=self.model();clock=[0]
        with self.image_scope(),patch.object(t.time,'monotonic',side_effect=lambda:clock[0]):
            t.prove_control_image(c,100);original=owned_image.deadline_receipt
            def late(*args,**kwargs):clock[0]=101;return original(*args,**kwargs)
            with patch.object(owned_image,'deadline_receipt',side_effect=late),self.assertRaisesRegex(common.Refusal,'final persistence deadline'):t.cleanup_image_inputs(c,100)
        row=common.read_json(self.root/'control/IMAGE-INPUT-CLEANUP-RESULT.json');self.assertTrue(row['positiveOwnedAliasAbsenceObserved']);self.assertTrue(row['positiveOwnedCanonicalAbsenceObserved']);self.assertFalse(row['positiveOwnedAbsenceObserved']);self.assertTrue(row['completionBudgetExhausted'])
    def test_owned_image_cleanup_never_prunes_preexisting_dangling_parent_content(self):
        base=self.root
        for backend in ['classic','containerd']:
            self.root=base/backend;self.root.mkdir();(self.root/'control').mkdir();(self.root/'evidence').mkdir();c,calls,live,_=self.model(backend=backend,preexisting='parent')
            with self.subTest(backend=backend),self.image_scope(),patch.object(t.time,'monotonic',return_value=0):t.prove_control_image(c,100);row=t.cleanup_image_inputs(c,100)
            self.assertTrue(row['positiveOwnedAbsenceObserved']);self.assertTrue(live['preexistingParent']);self.assertTrue(all(x[2]=='--no-prune' and len(x)==4 for x in calls if x[:2]==['image','rm']))
        self.root=base
    def test_pull_consuming_save_scratch_refuses_before_tag_save_and_retains_owned_cleanup(self):
        c,calls,live,_=self.model();nine=9*1024**3
        with patch.object(t.shutil,'disk_usage',side_effect=[SimpleNamespace(free=nine),SimpleNamespace(free=nine-1)]) as disks,patch.object(t.time,'monotonic',return_value=0):
            with self.assertRaisesRegex(common.Refusal,'after pull before tag/save'):t.prove_control_image(c,100)
            self.assertEqual(disks.call_count,2);self.assertTrue(live['canonical']);self.assertFalse(live['alias']);self.assertEqual([x[0] for x in calls if x[0]!='inspect'],['baseline','pull']);row=t.cleanup_image_inputs(c,100)
        self.assertTrue(row['positiveOwnedAbsenceObserved']);self.assertEqual([x for x in calls if x[:2]==['image','rm']],[['image','rm','--no-prune',c.profile['image']['reference']]])
    def test_exact_nine_gib_postpull_scratch_near_miss_permits_original_tag_and_save(self):
        c,calls,_,_=self.model();nine=9*1024**3
        with patch.object(t.shutil,'disk_usage',side_effect=[SimpleNamespace(free=nine),SimpleNamespace(free=nine)]) as disks,patch.object(t.time,'monotonic',return_value=0):row=t.prove_control_image(c,100)
        self.assertTrue(row['imageConfigAndRawLayersPhysicallyVerified']);self.assertEqual(disks.call_count,2);self.assertEqual([x[0] for x in calls if x[0]!='inspect'],['baseline','pull','tag','save'])
    def test_nonowned_or_expired_alias_never_issues_delete(self):
        c,calls,_,_=self.model()
        with patch.object(t.time,'monotonic',return_value=0),self.assertRaises(common.Refusal):t.cleanup_image_inputs(c,100)
        c.state['ownedImageInputsReserved']=True;c.state['imageAlias']=c.profile['image']['reference']
        with patch.object(t.time,'monotonic',return_value=0),self.assertRaises(common.Refusal):t.cleanup_image_inputs(c,100)
        c.state['imageAlias']='checktrail-sdk10-controls-owned:123-synthetic-image'
        with patch.object(t.time,'monotonic',return_value=100),self.assertRaises(common.Refusal):t.cleanup_image_inputs(c,100)
        self.assertEqual(calls,[])

if __name__ == '__main__': unittest.main()
