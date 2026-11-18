"""Mocked transports/physical inert files only; no Docker/image/native/key action."""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent))
import common
import target_pause_controls as t
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
    def test_target_refuses_wrong_physical_selected_image_before_volume_creation(self):
        profile = common.read_json(Path(__file__).parent / 'profile.json')
        for key, value in [('Id', 'sha256:' + '0' * 64), ('Architecture', 'arm64'), ('RootFS', {'Layers': []})]:
            root = self.root / key
            capacity = self.root / ('capacity-' + key); capacity.write_text('"amd64" 4\n')
            calls = []
            image = {'Id': 'sha256:' + profile['image']['configSHA256'], 'Architecture': 'amd64', 'Os': 'linux', 'RootFS': {'Layers': ['sha256:' + x for x in profile['image']['diffIDs']]}}
            image[key] = value
            def make_controller(path, ctx, selected):
                return SimpleNamespace(root=path, ctx=ctx, profile=selected, state=None, save=lambda: None, docker=lambda args, **kw: (calls.append(args) or GOOD, capacity), inspect=lambda *args: image)
            env = {'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64', 'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REPOSITORY': profile['repository'], 'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_RUN_ID': '123', 'GITHUB_SHA': 'a' * 40}
            with self.subTest(key=key), patch.dict(os.environ, env), patch.object(t.sys, 'platform', 'linux'), patch.object(t, 'manifest_check', return_value=profile), patch.object(t, 'Controller', side_effect=make_controller), patch.object(t.time, 'monotonic', return_value=0), patch.object(t.platform, 'machine', return_value='x86_64'), patch.object(Path, 'stat', autospec=True, side_effect=lambda path, **kwargs: SimpleNamespace(st_size=32) if str(path) == '/etc/os-release' else os.stat(path, **kwargs)), patch.object(Path, 'read_bytes', autospec=True, side_effect=lambda path: b'ID=ubuntu\nVERSION_ID="26.04"\n' if str(path) == '/etc/os-release' else path.open('rb').read()):
                self.assertEqual(t.run(root, 'synthetic-target', 'b' * 64), 1)
            result = common.read_json(root / 'RESULT.json'); self.assertFalse(result['complete']); self.assertFalse(result['originalSdkBuildTestQuotaOrGateAQualified']); self.assertEqual(len(calls), 2); self.assertEqual(calls[1][:3], ['pull', '--platform', 'linux/amd64'])
    def test_ambiguous_volume_create_is_reserved_for_owned_cleanup_before_transport(self):
        profile=common.read_json(Path(__file__).parent/'profile.json');root=self.root/'ambiguous-create';capacity=self.root/'capacity';capacity.write_text('"amd64" 4\n')
        image={'Id':'sha256:'+profile['image']['configSHA256'],'Architecture':'amd64','Os':'linux','RootFS':{'Layers':['sha256:'+x for x in profile['image']['diffIDs']]}}
        calls=[];cleanup=[]
        def make_controller(path,ctx,selected):
            def docker(args,**kwargs):
                calls.append(args)
                if args[:2]==['volume','create']:raise TimeoutError('synthetic ambiguous create')
                return GOOD,capacity
            return SimpleNamespace(root=path,ctx=ctx,profile=selected,state=None,save=lambda:None,docker=docker,inspect=lambda kind,name:image if kind=='image' else None)
        env={'RUNNER_OS':'Linux','RUNNER_ARCH':'X64','GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REPOSITORY':profile['repository'],'GITHUB_RUN_ATTEMPT':'1','GITHUB_RUN_ID':'123','GITHUB_SHA':'a'*40}
        with patch.dict(os.environ,env),patch.object(t.sys,'platform','linux'),patch.object(t,'manifest_check',return_value=profile),patch.object(t,'Controller',side_effect=make_controller),patch.object(t.time,'monotonic',return_value=0),patch.object(t.platform,'machine',return_value='x86_64'),patch.object(Path,'stat',autospec=True,side_effect=lambda path,**kw:SimpleNamespace(st_size=32) if str(path)=='/etc/os-release' else os.stat(path,**kw)),patch.object(Path,'read_bytes',autospec=True,side_effect=lambda path:b'ID=ubuntu\nVERSION_ID="26.04"\n' if str(path)=='/etc/os-release' else path.open('rb').read()),patch.object(t,'remove_control_volume',side_effect=lambda c,name,deadline:cleanup.append(name) or True):
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
        c=SimpleNamespace(root=root,ctx=self.ctx,state={'prefix':prefix,'gid':gid,'containers':[],'imageAlias':'synthetic-pinned-image','volume':'inert-work','tempVolume':'inert-temp','phaseDeadline':100,'nativeDeadline':100,'cleanupDeadline':120},save=lambda:None,inspect=lambda *args:None)
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
                if not source.is_file():return {**GOOD,'exitCode':1},body
                Path(args[2]).write_bytes(source.read_bytes());return GOOD,body
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
        self.assertTrue(any(args[:2]==['cp',binding['id']+':/native-control/START.json'] for args in model['calls']))
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
        self.c.state.update(prefix=prefix,gid=gid,containers=[],imageAlias='synthetic-pinned-image');self.c.save=lambda:None;self.c.inspect=lambda *args:None
        obj={'Id':'b'*64,'Name':'/'+name,'Config':{'Labels':common.owned_labels(self.ctx)},'State':{'Running':False,'Paused':False},'HostConfig':{'NetworkMode':'none','ReadonlyRootfs':True,'Privileged':False,'Memory':256*1024**2,'CapDrop':['ALL'],'GroupAdd':[str(gid)]}}
        self.c.own_container=lambda _:copy.deepcopy(obj);calls=[]
        def docker(args,**kwargs):
            calls.append(args)
            if args[0]=='create':obj['Mounts']=self.declared_mounts(args)
            return GOOD,None
        self.c.docker=docker
        with patch.object(t,'wait_counter',return_value={'synthetic':True}):
            binding,_=t.create_producer(self.c,'build',100)
        self.assertEqual(binding['id'],'b'*64);created=calls[0];self.assertEqual(created[created.index('--group-add')+1],str(gid));self.assertIn('type=bind,source='+str(self.root/'evidence')+',target=/coord',created);self.assertEqual(calls[1],['start','b'*64])
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

if __name__ == '__main__': unittest.main()
