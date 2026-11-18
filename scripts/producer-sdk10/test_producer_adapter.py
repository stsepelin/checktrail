"""Concrete Controller bridge with synthetic Docker transports only."""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent))
import common
import driver
import producer_adapter as a
import producer_pause as p

GOOD = {'exitCode': 0, 'reason': None, 'ownedChildStarted': True, 'ownedChildReaped': True}

class Adapter(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        (root / 'evidence').mkdir(); (root / 'protected').mkdir()
        self.ctx = {'run': 123, 'attempt': 1, 'nonce': 'synthetic-adapter', 'head': 'a' * 40}
        self.name = 'ct-sdk10-synthetic-adapter-original-build'
        self.c = SimpleNamespace(root=root, ctx=self.ctx, state={'prefix': 'ct-sdk10-synthetic-adapter', 'containers': [self.name], 'phaseDeadline': 100, 'nativeDeadline': 100, 'cleanupDeadline': 120}, save=lambda: None)
        self.obj = {'Id': 'b' * 64, 'Name': '/' + self.name, 'Config': {'Labels': common.owned_labels(self.ctx)}, 'State': {'Running': True, 'Paused': True}}
        self.expected = {'context': self.ctx, 'manifestSHA256': 'c' * 64, 'phase': 'build', 'profileSHA256': 'd' * 64, 'supervisorSHA256': 'e' * 64}
        self.argv = ['./build.sh', '--synthetic-original']
        self.calls = []; self.counter = 0; self.row = copy.deepcopy(GOOD); self.inspection_body = None; self.listing = b''; self.copy_failure = False
        (root / 'protected' / self.name).mkdir()
        def cmd(args, seconds, check, cap):
            self.calls.append((args, seconds, self.c.state['phaseDeadline'], cap)); self.counter += 1
            out = root / ('transport-' + str(self.counter))
            if args[1:3] == ['container', 'inspect']:
                out.write_bytes(self.inspection_body if self.inspection_body is not None else common.encoded([self.obj])); return copy.deepcopy(self.row), out
            if args[1:3] == ['container', 'ls']:
                out.write_bytes(self.listing); return copy.deepcopy(GOOD), out
            if args[1] == 'cp':
                if self.copy_failure: return {**GOOD, 'exitCode': 1}, out
                member = args[2].split('/')[-1]; Path(args[3]).write_bytes((root / 'protected' / self.name / member).read_bytes())
            out.write_bytes(b''); return copy.deepcopy(GOOD), out
        self.c.cmd = cmd
        with patch.object(a.time, 'monotonic', return_value=0):
            self.binding = a.ProducerAPI.register(self.c, self.name, self.obj, self.expected, self.argv)
        self.api = a.ProducerAPI(self.c, self.name)
    def run_at_zero(self, method, *args):
        with patch.object(a.time, 'monotonic', return_value=0): return method(*args)
    def protected(self, member='START', **changes):
        value = {'schemaVersion': 2, 'binding': self.expected, 'originalArgv': self.argv, 'originalCommandStarted': True, **changes}
        (self.c.root / 'protected' / self.name / (member + '.json')).write_bytes(common.encoded(value))
    def test_registered_exact_current_role_id_and_original_protected_context(self):
        self.assertEqual(self.api.binding, self.binding)
        self.assertEqual(self.run_at_zero(self.api.inspect_id, 'b' * 64, 60), self.obj)
        self.assertEqual(self.calls[0][0], ['docker', 'container', 'inspect', 'b' * 64])
        for name in ['ct-sdk10-foreign-original-build', self.name + '-suffix', 'ct-sdk10-synthetic-adapter-materialize']:
            with self.subTest(name=name), self.assertRaises(p.Refusal): a.ProducerAPI(self.c, name)
    def test_failed_inspect_requires_exact_full_id_listing_not_name_filter(self):
        self.row['exitCode'] = 1
        self.assertIsNone(self.run_at_zero(self.api.inspect_id, 'b' * 64, 60))
        self.assertEqual(self.calls[-1][0][-1], 'id=' + 'b' * 64)
        for body in [('b' * 64 + '\n').encode(), b'b\n', b' \n']:
            self.listing = body
            with self.subTest(body=body), self.assertRaises(a.MetadataUnavailable): self.run_at_zero(self.api.inspect_id, 'b' * 64, 60)
    def test_reason_unreaped_bool_exit_and_malformed_inspect_refuse_absence_credit(self):
        for change in [{'reason': 'owned command deadline'}, {'ownedChildReaped': False}, {'exitCode': False}]:
            self.row = {**GOOD, **change}
            with self.subTest(change=change), self.assertRaises(a.MetadataUnavailable): self.run_at_zero(self.api.inspect_id, 'b' * 64, 60)
        self.row = GOOD.copy(); self.inspection_body = b'[]'
        with self.assertRaises(a.MetadataUnavailable): self.run_at_zero(self.api.inspect_id, 'b' * 64, 60)
    def test_foreign_actual_id_name_labels_and_argument_id_never_mutate(self):
        for field in ['Id', 'Name', 'Labels']:
            original = copy.deepcopy(self.obj)
            if field == 'Labels': self.obj['Config']['Labels'] = {}
            else: self.obj[field] = 'foreign'
            before = len(self.calls)
            with self.subTest(field=field), self.assertRaises(p.Refusal): self.run_at_zero(self.api.pause_id, 'b' * 64, 60)
            self.assertFalse(any(x[0][1] == 'pause' for x in self.calls[before:])); self.obj = original
        with self.assertRaises(p.Refusal): self.run_at_zero(self.api.unpause_id, 'f' * 64, 60)
    def test_inverse_after_unavailable_read_uses_captured_id_and_reserved_deadline(self):
        self.row['reason'] = 'owned command deadline'; self.c.state['phaseDeadline'] = -1
        row = self.run_at_zero(self.api.unpause_id, 'b' * 64, 70)
        self.assertEqual(row, GOOD)
        self.assertEqual(self.calls[-1][0], ['docker', 'unpause', 'b' * 64])
        self.assertTrue(all(x[2] == 70 for x in self.calls)); self.assertEqual(self.c.state['phaseDeadline'], -1)
    def test_invalid_state_metadata_does_not_suppress_inverse_on_positive_bound_identity(self):
        self.obj['State']['Paused'] = None
        self.assertEqual(self.run_at_zero(self.api.unpause_id, 'b' * 64, 60), GOOD)
        self.assertEqual(self.calls[-1][0], ['docker', 'unpause', 'b' * 64])
    def test_absent_before_inverse_is_observation_without_zero_or_child_execution_credit(self):
        self.row['exitCode']=1
        observed=self.run_at_zero(self.api.unpause_id,'b'*64,60)
        self.assertEqual(observed,p.absent_inverse_observation('b'*64));self.assertTrue(p.valid_absent_inverse(observed,'b'*64))
        self.assertIsNone(observed['exitCode']);self.assertIs(observed['ownedChildStarted'],False);self.assertIs(observed['ownedChildReaped'],False);self.assertIs(observed['commandSent'],False)
        self.assertFalse(p.complete_command(observed));self.assertEqual([x[0][1:3] for x in self.calls],[['container','inspect'],['container','ls']])
    def no_op_race(self,fault=None,before_inverse=False,resurrect=False,forged=None):
        self.obj['State'].update(Running=True,Paused=False);self.row=GOOD.copy();self.calls.clear();original_cmd=self.c.cmd
        api=a.ProducerAPI(self.c,self.name);real_inspect=api.inspect_id;real_unpause=api.unpause_id;gone=[False];after_scan=[False];post_scan_reads=[0];gone_reads=[0]
        def command(args,*rest,**kwargs):
            row,path=original_cmd(args,*rest,**kwargs)
            if args[1]=='pause':
                self.obj['State']['Paused']=True
                if fault=='pause':row={**row,'exitCode':-9,'reason':'owned command deadline'}
            if args[1:3]==['container','inspect'] and gone[0]:gone_reads[0]+=1;row={**row,'exitCode':1};path.write_bytes(b'')
            return row,path
        def inspect(identity,deadline):
            if after_scan[0]:
                post_scan_reads[0]+=1
                if fault=='inspection' and post_scan_reads[0]==2:raise a.MetadataUnavailable('synthetic lifecycle metadata unavailable')
            return real_inspect(identity,deadline)
        def scan():
            after_scan[0]=True
            if before_inverse:gone[0]=True
            if fault=='measurement':raise ValueError('synthetic primary measurement refusal')
            return {'samplingComplete':True}
        def inverse(identity,deadline):
            gone[0]=True  # Disappears after protocol read, before adapter read.
            observed=real_unpause(identity,deadline)
            if resurrect:gone[0]=False
            if forged is not None:observed.update(forged)
            return observed
        api.inspect_id=inspect;api.unpause_id=inverse;self.c.cmd=command
        try:row=self.run_at_zero(p.run,self.binding,api,scan,100,90,lambda:0)
        finally:self.c.cmd=original_cmd
        return row,gone_reads[0],list(self.calls)
    def assert_no_fake_inverse(self,row,calls):
        self.assertFalse(any(call[0][1]=='unpause' for call in calls));self.assertFalse(any(command['operation']=='unpause' for command in row['commands']))
        for entry in row['noOpObservations']:
            observed=entry['observation'];self.assertIsNone(observed['exitCode']);self.assertIs(observed['ownedChildStarted'],False);self.assertIs(observed['ownedChildReaped'],False);self.assertIs(observed['commandSent'],False);self.assertFalse(p.complete_command(observed))
        self.assertFalse(row['sourceBuildOrTestOrQuotaPassingCredit'])
    def test_protocol_absence_before_inverse_keeps_primary_failure_and_rechecks_absence(self):
        row,reads,calls=self.no_op_race(fault='measurement',before_inverse=True)
        self.assertEqual(row['outcome'],'refused');self.assertEqual(row['primaryError'],'ValueError');self.assertEqual(row['lifecycleOutcome'],'absent');self.assertTrue(row['lifecycleVerified'])
        self.assertFalse(row['inverseRequested']);self.assertFalse(row['unpauseAttempted']);self.assertEqual([x['stage'] for x in row['noOpObservations']],['before-inverse']);self.assertGreaterEqual(reads,2);self.assert_no_fake_inverse(row,calls)
    def test_disappearance_inside_inverse_is_separate_noop_and_preserves_every_failure_layer(self):
        for fault in [None,'pause','measurement','inspection']:
            with self.subTest(fault=fault):
                row,reads,calls=self.no_op_race(fault=fault)
                self.assertTrue(row['inverseRequested']);self.assertFalse(row['unpauseAttempted']);self.assertTrue(row['lifecycleVerified']);self.assertEqual(row['lifecycleOutcome'],'absent');self.assertGreaterEqual(reads,2)
                self.assertEqual([x['stage'] for x in row['noOpObservations']],['inside-inverse']);self.assert_no_fake_inverse(row,calls)
                if fault is None:self.assertEqual(row['outcome'],'complete-sample-lifecycle')
                else:
                    self.assertEqual(row['outcome'],'refused')
                    if fault=='pause':self.assertEqual(row['primaryError'],'pause-transport-incomplete')
                    if fault=='measurement':self.assertEqual(row['primaryError'],'ValueError')
                    if fault=='inspection':self.assertIn('MetadataUnavailable',row['lifecycleErrors'])
    def test_noop_observation_never_replaces_independent_final_absence(self):
        row,reads,calls=self.no_op_race(resurrect=True)
        self.assertEqual(row['outcome'],'producer-cleanup-unproven');self.assertFalse(row['lifecycleVerified']);self.assertIn('inverse-noop-final-absence-unproven',row['lifecycleErrors']);self.assert_no_fake_inverse(row,calls)
    def test_forged_noop_fields_and_near_miss_identifiers_do_not_become_command_success(self):
        cases=[{'exitCode':0,'ownedChildStarted':True,'ownedChildReaped':True},{'operation':'pause'},{'containerID':'f'*64},{'positiveAbsenceObserved':1},{'commandSent':0},{'exitCode':0},{'ownedChildStarted':True},{'ownedChildReaped':True},{'outcome':'positively-absent-noop-suffix'},{'reason':None}]
        for change in cases:
            with self.subTest(change=change):
                row,reads,calls=self.no_op_race(forged=change)
                self.assertEqual(row['outcome'],'refused');self.assertIn('inverse-noop-receipt-differs',row['lifecycleErrors']);self.assertEqual(row['noOpObservations'],[]);self.assert_no_fake_inverse(row,calls)
    def test_existing_protected_members_copied_and_absence_recorded_before_owned_removal(self):
        self.protected()
        self.assertTrue(self.run_at_zero(self.api.preserve_protected_metadata, self.binding, 60))
        self.assertEqual(self.api.preservation['members']['START']['state'], 'PRESERVED')
        self.assertEqual(self.api.preservation['members']['RESULT']['state'], 'POSITIVELY_ABSENT')
        self.assertEqual(self.run_at_zero(self.api.force_remove_id, 'b' * 64, 60), GOOD)
        self.assertEqual(self.calls[-1][0], ['docker', 'rm', '-f', 'b' * 64])
        self.assertFalse(self.c.state['nativeRemovalAttempts'][self.name]['originalExitOrBuildCredit'])
    def test_preservation_binding_copy_symlink_and_parent_failure_block_remove(self):
        for fault in ['binding', 'copy', 'symlink', 'parent']:
            with self.subTest(fault=fault):
                source = self.c.root / 'protected' / self.name
                source.mkdir(exist_ok=True)
                member = source / 'START.json'
                if member.exists() or member.is_symlink(): member.unlink()
                self.copy_failure = False
                self.protected(binding={} if fault == 'binding' else self.expected)
                if fault == 'copy': self.copy_failure = True
                if fault == 'symlink': member.unlink(); member.symlink_to('/not-selected')
                if fault == 'parent': member.unlink(); source.rmdir()
                with self.assertRaises((p.Refusal, OSError)): self.run_at_zero(self.api.preserve_protected_metadata, self.binding, 60)
                with self.assertRaises(p.Refusal): self.run_at_zero(self.api.force_remove_id, 'b' * 64, 60)
        self.assertFalse(any(x[0][1:3] == ['rm', '-f'] for x in self.calls))
    def test_copied_body_file_and_directory_durability_precede_passing_report_and_remove(self):
        self.protected();events=[];real_fsync=os.fsync;real_sync=a.syncdir;original_command=self.c.cmd
        def fsync(fd):
            info=os.fstat(fd);events.append(('fsync',info.st_ino,info.st_size));return real_fsync(fd)
        def directory(path):events.append(('directory',str(path)));return real_sync(path)
        def command(args,*rest,**kwargs):
            if args[1:3]==['rm','-f']:events.append(('remove',))
            return original_command(args,*rest,**kwargs)
        with patch.object(a.os,'fsync',side_effect=fsync),patch.object(a,'syncdir',side_effect=directory),patch.object(self.c,'cmd',side_effect=command):
            self.run_at_zero(self.api.preserve_protected_metadata,self.binding,60)
            self.run_at_zero(self.api.force_remove_id,'b'*64,60)
        folder=next((self.c.root/'evidence').glob('*-PRESERVED-*'));body=folder/'START.json';report=folder/'PRESERVATION.json'
        body_event=next(i for i,e in enumerate(events) if e[0]=='fsync' and e[1]==body.stat().st_ino)
        folder_event=events.index(('directory',str(folder)));parent_event=events.index(('directory',str(folder.parent)))
        report_event=next(i for i,e in enumerate(events) if e[0]=='fsync' and e[1]==report.stat().st_ino)
        self.assertLess(body_event,folder_event);self.assertLess(folder_event,parent_event);self.assertLess(parent_event,report_event);self.assertLess(report_event,events.index(('remove',)))
    def test_copied_body_file_or_directory_fsync_failure_blocks_passing_preservation_and_remove(self):
        for failure in ['file','directory']:
            with self.subTest(failure=failure):
                self.api.preservation=None;self.protected();real=os.fsync;failed=[False]
                def fsync(fd):
                    if failure=='file' and not failed[0]:failed[0]=True;raise OSError('synthetic protected body fsync refusal')
                    return real(fd)
                def directory(path):
                    if failure=='directory':raise OSError('synthetic protected directory fsync refusal')
                    return common.syncdir(path)
                with patch.object(a.os,'fsync',side_effect=fsync),patch.object(a,'syncdir',side_effect=directory),self.assertRaises(OSError):self.run_at_zero(self.api.preserve_protected_metadata,self.binding,60)
                with self.assertRaises(p.Refusal):self.run_at_zero(self.api.force_remove_id,'b'*64,60)
                self.assertIsNone(self.api.preservation)
        self.assertFalse(any(x[0][1:3]==['rm','-f'] for x in self.calls))
    def test_resumed_state_after_preservation_blocks_forced_removal(self):
        self.protected(); self.run_at_zero(self.api.preserve_protected_metadata, self.binding, 60)
        self.obj['State']['Paused'] = False
        with self.assertRaises(p.Refusal): self.run_at_zero(self.api.force_remove_id, 'b' * 64, 60)
        self.assertFalse(any(x[0][1:3] == ['rm', '-f'] for x in self.calls))
    def test_global_stop_owned_native_cleanup_cannot_bypass_failed_preservation(self):
        for role in ['build', 'tests']:
            name = 'ct-sdk10-synthetic-adapter-original-' + role
            controller = object.__new__(driver.Controller); controller.state = {**self.c.state, 'containers': [name]}; controller.ctx = self.ctx
            controller.own_container = lambda _: self.obj
            calls = []; controller.docker = lambda *args, **kw: calls.append(args)
            fake = SimpleNamespace(binding={'id': 'b' * 64}, inspect_id=lambda *a: {**self.obj, 'State': {'Running': False, 'Paused': False}}, preserve_protected_metadata=lambda *a: False, force_remove_id=lambda *a: calls.append('removed'))
            with self.subTest(role=role), patch.object(driver, 'ProducerAPI', return_value=fake), self.assertRaises(common.Refusal): controller.stop_owned(name)
            self.assertNotIn('removed', calls)

if __name__ == '__main__': unittest.main()
