"""Concrete Controller bridge with synthetic Docker transports only."""
import copy
import json
import os
import shutil
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
                self.assertEqual(args[2], self.obj['Id'] + ':/native-control/.')
                shutil.copytree(root / 'protected' / self.name, Path(args[3]), dirs_exist_ok=True, symlinks=True)
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
    def test_refused_inspection_transport_is_unavailable_and_never_suppresses_the_inverse(self):
        # common.process refuses a command it cannot start or whose output
        # overflows; after an ambiguous pause that read must not skip unpause.
        real = self.c.cmd
        for stage in ['inspect', 'ls']:
            with self.subTest(stage=stage):
                self.calls.clear(); self.row = {**GOOD, 'exitCode': 1} if stage == 'ls' else copy.deepcopy(GOOD)
                def refusing(args, seconds, check, cap):
                    if args[1:3] == ['container', stage]: self.calls.append((args, seconds, None, cap)); raise common.Refusal('owned command incomplete; receipt retained 6143')
                    return real(args, seconds, check, cap)
                self.c.cmd = refusing
                try:
                    with self.assertRaises(a.MetadataUnavailable) as caught: self.run_at_zero(self.api.inspect_id, 'b' * 64, 60)
                    self.assertIsInstance(caught.exception.__cause__, common.Refusal)
                    self.assertEqual(self.run_at_zero(self.api.unpause_id, 'b' * 64, 60), GOOD)
                finally: self.c.cmd = real
                self.assertEqual(self.calls[-1][0], ['docker', 'unpause', 'b' * 64])
    def test_positively_foreign_identity_still_forbids_the_inverse_after_a_complete_read(self):
        self.obj['Config']['Labels'] = {'org.checktrail.sdk10.run': '6143'}
        with self.assertRaises(p.Refusal): self.run_at_zero(self.api.unpause_id, 'b' * 64, 60)
        self.assertFalse(any(call[0][1] == 'unpause' for call in self.calls))
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
        folder=next((self.c.root/'evidence').glob('*-PRESERVED-*'));body=folder/'protected/START.json';report=folder/'PRESERVATION.json'
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
            controller = object.__new__(driver.Controller); controller.state = {**self.c.state, 'containers': [name], 'nativeProducers': {name: {'synthetic': 'registered'}}}; controller.ctx = self.ctx
            controller.own_container = lambda _: self.obj
            calls = []; controller.docker = lambda *args, **kw: calls.append(args)
            fake = SimpleNamespace(binding={'id': 'b' * 64}, inspect_id=lambda *a: {**self.obj, 'State': {'Running': False, 'Paused': False}}, preserve_protected_metadata=lambda *a: False, force_remove_id=lambda *a: calls.append('removed'))
            with self.subTest(role=role), patch.object(driver, 'ProducerAPI', return_value=fake), self.assertRaises(common.Refusal): controller.stop_owned(name)
            self.assertNotIn('removed', calls)
    def test_daemon_copy_precedes_any_host_child_inspection_despite_denied_original_parent(self):
        self.assertNotEqual(os.geteuid(), 0)
        self.protected();source=self.c.root/'protected'/self.name;body=(source/'START.json').read_bytes();original=self.c.cmd
        def daemon(args,*rest,**kw):
            if args[1]=='cp':
                self.calls.append((args,0,self.c.state['phaseDeadline'],65536));self.assertEqual(args[2],'b'*64+':/native-control/.');Path(args[3],'START.json').write_bytes(body)
                return copy.deepcopy(GOOD),self.c.root/'unused-daemon-copy-output'
            return original(args,*rest,**kw)
        os.chmod(source,0)
        try:
            with patch.object(self.c,'cmd',side_effect=daemon):self.assertTrue(self.run_at_zero(self.api.preserve_protected_metadata,self.binding,60))
        finally:os.chmod(source,0o700)
        self.assertEqual([x[0][1] for x in self.calls],['container','cp','container'])
        self.assertEqual(self.api.preservation['copiedMemberNames'],['START.json'])
        self.assertEqual(self.api.preservation['members']['RESULT'],{'state':'POSITIVELY_ABSENT'})
    def test_full_directory_copy_rejects_extra_case_alias_directory_and_oversized_members(self):
        for fault in ['extra','case-alias','directory','oversized']:
            with self.subTest(fault=fault):
                source=self.c.root/'protected'/self.name
                for path in source.iterdir():
                    if path.is_dir():path.rmdir()
                    else:path.unlink()
                self.protected()
                if fault=='extra':(source/'unselected.json').write_bytes(b'{}')
                if fault=='case-alias':(source/'start.json').write_bytes(b'{}')
                if fault=='directory':(source/'START.json').unlink();(source/'START.json').mkdir()
                if fault=='oversized':(source/'START.json').write_bytes(b'x'*65537)
                with self.assertRaises(p.Refusal):self.run_at_zero(self.api.preserve_protected_metadata,self.binding,60)
                with self.assertRaises(p.Refusal):self.run_at_zero(self.api.force_remove_id,'b'*64,60)
        self.assertFalse(any(x[0][1:3]==['rm','-f'] for x in self.calls))
    def test_failed_fresh_copy_revokes_prior_preservation_instead_of_reusing_it(self):
        self.protected();self.assertTrue(self.run_at_zero(self.api.preserve_protected_metadata,self.binding,60));self.copy_failure=True
        with self.assertRaises(p.Refusal):self.run_at_zero(self.api.preserve_protected_metadata,self.binding,60)
        self.assertIsNone(self.api.preservation)
        with self.assertRaises(p.Refusal):self.run_at_zero(self.api.force_remove_id,'b'*64,60)
    def test_copy_and_report_failures_preserve_primary_with_secondary_chained(self):
        self.protected();self.copy_failure=True;secondary=OSError('synthetic private report durability error')
        with patch.object(a,'freeze',side_effect=secondary),self.assertRaises(p.Refusal) as caught:self.run_at_zero(self.api.preserve_protected_metadata,self.binding,60)
        self.assertIs(caught.exception.__cause__,secondary);self.assertIsNone(self.api.preservation)
        self.assertFalse(any(x[0][1:3]==['rm','-f'] for x in self.calls))

class DockerTable(unittest.TestCase):
    """A real Controller over a synthetic daemon table keyed by immutable ID."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name); (root / 'evidence').mkdir()
        self.ctx = {'run': 4417, 'attempt': 1, 'nonce': 'synthetic-table', 'head': 'a' * 40}
        self.name = 'ct-sdk10-synthetic-table-original-tests'; self.id = '4' * 64; self.foreign = 'f' * 64
        c = object.__new__(driver.Controller); c.root = root; c.ctx = self.ctx; c.save = lambda: None
        c.state = {'prefix': 'ct-sdk10-synthetic-table', 'containers': [self.name], 'phaseDeadline': time.monotonic() + 600, 'cleanupDeadline': time.monotonic() + 600}
        self.table = {}; self.effects = []; self.counter = 0; self.commands = []; self.created = []; self.receipts = None; self.on_create = None; self.create_output = None; self.unavailable_inspections = {}
        def find(key): return [x for x in self.table.values() if x['Id'] == key or x['Name'] == '/' + key]
        self.find = find
        def cmd(args, seconds=60, check=True, cap=2 * 1024 ** 2):
            self.assertEqual(args[0], 'docker'); args = args[1:]; self.counter += 1; self.commands.append(list(args))
            out = root / ('transport-' + str(self.counter)); out.write_bytes(b''); row = copy.deepcopy(GOOD)
            if args[0] == 'create':
                identity, name = self.created.pop(0); self.container(identity, name, running=False); out.write_bytes(self.create_output or (identity + '\n').encode())
                if self.on_create is not None: self.on_create(identity, name)
            elif args[0] == 'start':
                target = args[-1]; self.effects.append(('start', target)); found = find(target)
                # An attached start returns once the container exits.
                for x in found: x['State'].update(Running=False, ExitCode=0)
                if not found: row['exitCode'] = 1
            elif args[0] == 'top':
                self.effects.append(('top', args[1])); row['exitCode'] = 1
            elif args[:2] == ['container', 'inspect'] and self.unavailable_inspections.get(args[2]):
                self.unavailable_inspections[args[2]] -= 1; row.update(exitCode=-9, reason='owned command deadline')
            elif args[:2] == ['container', 'inspect']:
                found = find(args[2])
                if found: out.write_bytes(common.encoded(copy.deepcopy(found)))
                else: row['exitCode'] = 1
            elif args[:2] == ['container', 'ls']:
                selector = args[-1]
                ids = [x['Id'] for x in self.table.values() if (selector.startswith('id=') and x['Id'] == selector[3:]) or (selector.startswith('name=^/') and x['Name'] == '/' + selector[7:-1])]
                out.write_bytes(''.join(x + '\n' for x in ids).encode())
            elif args[0] in ['stop', 'rm', 'unpause', 'pause']:
                target = args[-1]; self.effects.append((args[0], target))
                for x in find(target):
                    if args[0] == 'stop': x['State']['Running'] = False
                    if args[0] == 'rm': del self.table[x['Id']]
            elif args[0] == 'cp':
                self.effects.append(('cp', args[1].split(':', 1)[0])); member = args[1].rsplit('/', 1)[-1]
                if self.receipts is not None and member in ['START.json', 'RESULT.json']: Path(args[2]).write_bytes(common.encoded(self.receipts[member[:-5]]))
            else: self.fail('unexpected synthetic docker command ' + repr(args))
            common.need(not check or row['exitCode'] == 0, 'first-party command incomplete: docker')
            return row, out
        c.cmd = cmd; self.c = c
        original = self.container(self.id, self.name)
        a.ProducerAPI.register(c, self.name, original, {'context': self.ctx}, ['./build.sh', '--synthetic-table'])
    def container(self, identity, name, labels=True, running=True):
        value = {'Id': identity, 'Name': '/' + name, 'Config': {'User': '0:0', 'Labels': common.owned_labels(self.ctx) if labels else {'synthetic': 'foreign-4417'}}, 'State': {'Running': running, 'Paused': False, 'ExitCode': 0, 'OOMKilled': False},
                 'HostConfig': {'PidMode': '', 'Privileged': False, 'Memory': 4417 * 1024, 'CapAdd': ['CHOWN', 'SETUID', 'SETGID', 'KILL']}}
        self.table[identity] = value; return value
    def test_renamed_running_producer_gets_no_quiescence_credit_from_name_absence(self):
        self.container(self.id, 'renamed-producer-4417')
        with self.assertRaises((common.Refusal, p.Refusal, a.MetadataUnavailable)): self.c.stop_owned(self.name)
        self.assertTrue(self.table[self.id]['State']['Running']); self.assertEqual(self.effects, [])
    def test_exact_producer_id_absence_is_quiescence(self):
        self.table.clear()
        self.assertIs(self.c.stop_owned(self.name), True); self.assertEqual(self.effects, [])
    def test_running_producer_under_its_own_name_is_stopped_and_removed_by_exact_id(self):
        self.container(self.id, self.name)
        self.assertIs(self.c.stop_owned(self.name), True)
        self.assertEqual(self.table, {}); self.assertEqual([x for x in self.effects if x[0] != 'cp'], [('stop', self.id), ('rm', self.id)])
    def test_name_rebound_to_a_foreign_container_is_never_stopped(self):
        cases = [('renamed-original-forged-labels', True, True), ('renamed-original-foreign-labels', True, False), ('removed-original-forged-labels', False, True)]
        for case, keep_original, labels in cases:
            with self.subTest(case=case):
                self.table.clear(); self.effects.clear()
                if keep_original: self.container(self.id, 'renamed-producer-4417')
                self.container(self.foreign, self.name, labels=labels)
                with self.assertRaises((common.Refusal, p.Refusal, a.MetadataUnavailable)): self.c.stop_owned(self.name)
                self.assertTrue(self.table[self.foreign]['State']['Running']); self.assertEqual(self.effects, [])

    # Each lifecycle below is driven through the real Controller. "rebind" moves
    # the owned name to the foreign container right after the owned ID is known:
    # 'renamed' renames the owned container first, 'removed' deletes it.
    def rebind(self, owned, name, case, labels=True):
        if case == 'renamed': self.table[owned]['Name'] = '/renamed-owned-4417'
        if case == 'removed': del self.table[owned]
        self.container(self.foreign, name, labels=labels); self.rebound_at = len(self.commands)
    def assert_foreign_untouched(self, name_lookups_allowed):
        self.assertNotIn(self.foreign, [x[1] for x in self.effects])
        self.assertTrue(self.table[self.foreign]['State']['Running'])
        after = self.commands[self.rebound_at:]
        self.assertFalse([x for x in after if self.foreign in x], after)
        # After the rebind the name is at most looked up, which refuses; no
        # command acts through it. The native phase does not even look it up.
        by_name = [x for x in after if any(self.name_under_test in y for y in x)]
        self.assertFalse([x for x in by_name if not name_lookups_allowed or x[:2] not in [['container', 'inspect'], ['container', 'ls']]], after)
    def native_phase(self, case=None, labels=True):
        self.c.state.update(containers=[], nativeProducers={}, uid=4417, gid=4417, manifestSHA256='9' * 64, nativeDeadline=time.monotonic() + 600)
        self.table.clear(); self.rebound_at = None; self.name_under_test = self.name
        bundle = self.c.root / 'bundle'; bundle.mkdir(mode=0o755); bundle.chmod(0o755); (self.c.root / 'protected').mkdir()
        for name in ['native_entry.py', 'common.py', 'profile.json']: (bundle / name).write_bytes(b'synthetic-4417 ' + name.encode()); (bundle / name).chmod(0o644)
        argv = ['./build.sh', '--synthetic-table-tests']; binding = {'context': self.ctx, 'manifestSHA256': '9' * 64, 'phase': 'test', 'profileSHA256': common.hash_file(bundle / 'profile.json')[1], 'supervisorSHA256': common.hash_file(bundle / 'native_entry.py')[1]}
        base = {'schemaVersion': 2, 'binding': binding, 'originalArgv': argv, 'originalCommandStarted': True, 'originalChildPID': 4417, 'originalStartedWallTime': 4417.0, 'originalStartedMonotonic': 17.0, 'ownChildReaped': True, 'timedOut': False, 'interrupted': False, 'supervisorErrorType': None}
        self.receipts = {'START': {**base, 'originalExitCode': None}, 'RESULT': {**base, 'originalExitCode': 0, 'supervisorExitCode': 0}}
        self.c.profile = {'limits': {'nativeMemory': 4417 * 1024, 'logBytes': 1 << 20, 'freeReserve': 0}}
        self.c.helper = lambda *args, **kwargs: None; self.c.validate_container = lambda *args, **kwargs: True
        self.c.container_args = lambda name, *rest: self.created.append((self.id, name)) or ['create', '--name', name]
        real_register = a.ProducerAPI.register
        def register(*args):
            value = real_register(*args)
            if case is not None: self.rebind(self.id, self.name, case, labels)
            return value
        table = self
        class Client:
            def __init__(inner, args, stdout, stderr, **kwargs):
                self.assertEqual(args[:3], ['docker', 'start', '-a']); table.commands.append(args[1:]); table.effects.append(('start', args[3]))
                inner.found = table.find(args[3]); inner.polls = 0; inner.pid = 99999999
                for x in inner.found: x['State']['Running'] = True
            def poll(inner):
                inner.polls += 1
                if inner.polls == 1: return None
                for x in inner.found: x['State'].update(Running=False, ExitCode=0)
                return 0 if inner.found else 1
            def wait(inner, timeout=None): return inner.poll()
        # The synthetic directory stands in for the verified bundle the launcher holds in memory.
        with patch.object(driver, 'HERE', bundle), patch.object(driver, 'bundle_bytes', side_effect=lambda path: Path(path).read_bytes()), patch.object(driver.subprocess, 'Popen', Client), patch.object(a.ProducerAPI, 'register', side_effect=register), patch.object(driver.time, 'sleep'):
            return self.c.native('original-tests', argv, time.monotonic() + 600)
    def test_native_phase_never_starts_observes_inspects_or_copies_a_container_given_its_name(self):
        for case, labels in [('renamed', True), ('renamed', False), ('removed', True)]:
            with self.subTest(case=case, labels=labels):
                self.setUp()
                with self.assertRaises((common.Refusal, p.Refusal, a.MetadataUnavailable)): self.native_phase(case, labels)
                self.assertIsNotNone(self.rebound_at); self.assert_foreign_untouched(False)
                self.assertEqual([x for x in self.effects if x[0] in ['start', 'top']][:2], [('start', self.id), ('top', self.id)])
                self.assertFalse(any(x[0] == 'cp' for x in self.effects))
    def test_native_phase_with_an_unchanged_name_runs_through_the_registered_id(self):
        row = self.native_phase()
        self.assertEqual((row['exitCode'], row['stopReason'], row['protectedReceiptErrors']), (0, None, []))
        self.assertEqual(self.effects, [('start', self.id), ('top', self.id), ('cp', self.id), ('cp', self.id), ('cp', self.id), ('rm', self.id)])
        inspected = [x[2] for x in self.commands if x[:2] == ['container', 'inspect']]
        # The name is looked up only to prove it starts absent; the creation is inspected by its printed ID.
        self.assertEqual(inspected[:2], [self.name, self.id]); self.assertEqual(set(inspected[2:]) - {self.name}, {self.id}); self.assertEqual(self.table, {})
    def helper_phase(self, case=None, labels=True):
        self.table.clear(); self.rebound_at = None; helper = '5' * 64; self.name_under_test = self.c.state['prefix'] + '-materialize'
        self.c.container_args = lambda name, *rest: self.created.append((helper, name)) or ['create', '--name', name]
        def validate(obj, name, *rest):
            if case is not None: self.rebind(helper, name, case, labels)
            return True
        self.c.validate_container = validate
        return self.c.helper('materialize', ['/observer/input_prep.py', 'materialize'], time.monotonic() + 60), helper
    def test_helper_container_given_away_after_creation_is_never_started_stopped_or_removed(self):
        for case, labels in [('renamed', True), ('renamed', False), ('removed', True)]:
            with self.subTest(case=case, labels=labels):
                self.setUp()
                with self.assertRaises((common.Refusal, p.Refusal)): self.helper_phase(case, labels)
                # A removed helper's ID start simply fails; nothing else is attempted.
                self.assert_foreign_untouched(True); self.assertEqual(self.effects, [('start', '5' * 64)])
    def test_helper_with_an_unchanged_name_is_started_and_removed_by_its_id(self):
        row, helper = self.helper_phase()
        self.assertEqual(row['exitCode'], 0); self.assertEqual(self.effects, [('start', helper), ('rm', helper)]); self.assertEqual(self.table, {})
        self.assertEqual(self.c.state['ownedContainerIDs'], {self.c.state['prefix'] + '-materialize': helper})
        self.assertEqual(self.commands[-2:], [['container', 'inspect', helper], ['container', 'ls', '-aq', '--no-trunc', '--filter', 'id=' + helper]])
    def meter_phase(self, case=None, labels=True):
        import live_resource
        meter = '6' * 64; self.name_under_test = self.c.state['prefix'] + '-meter-4417'; self.rebound_at = None
        self.c.state.update(nativeDeadline=time.monotonic() + 600, uid=4417, gid=4417, capacityAdmission={'DockerRootDir': '/synthetic/docker-4417'})
        self.c.profile = {'limits': {'workBytes': 4417}}
        self.c.container_args = lambda name, *rest: self.created.append((meter, name)) or ['create', '--name', name]
        def validate(obj, name, *rest):
            if case is not None: self.rebind(meter, name, case, labels)
            return True
        self.c.validate_container = validate
        def protocol(binding, api, scan, *rest):
            try: scan()
            except common.Refusal: pass
            return {'outcome': 'producer-terminal-no-sample'}
        binding = self.c.state['nativeProducers'][self.name]['binding']
        with patch.object(live_resource.producer_pause, 'run', side_effect=protocol), patch('builtins.print'):
            return live_resource.observe(self.c, 'meter-4417', time.monotonic() + 600, producer_binding=binding), meter
    def test_meter_given_away_after_creation_is_never_attached_or_reaped(self):
        import live_resource
        for case, labels in [('renamed', True), ('renamed', False)]:
            with self.subTest(case=case, labels=labels):
                self.setUp()
                with self.assertRaises(live_resource.ObservationIncomplete): self.meter_phase(case, labels)
                self.assert_foreign_untouched(True); self.assertEqual(self.effects, [('start', '6' * 64)])
    def test_meter_with_an_unchanged_name_is_attached_and_reaped_by_its_id(self):
        record, meter = self.meter_phase()
        self.assertTrue(record['helperPositivelyAbsent']); self.assertEqual(self.effects, [('start', meter), ('rm', meter)])

    CREATE_RACES = [('renamed', True), ('renamed', False), ('removed', True)]
    def race_create(self, case, labels):
        # Between docker create and the first lookup, the new container is
        # renamed or removed and the foreign container takes its name.
        self.on_create = lambda identity, name: self.rebind(identity, name, case, labels)
    def assert_never_adopted(self, name, owned):
        self.assertEqual(self.effects, []); self.assertEqual(self.c.state['ownedContainerIDs'][name], owned)
        self.assertNotIn(self.foreign, json.dumps(self.c.state)); self.assertTrue(self.table[self.foreign]['State']['Running'])
        # Cleanup of the registered name refuses rather than acting on the foreign container.
        with self.assertRaises((common.Refusal, p.Refusal, a.MetadataUnavailable)): self.c.stop_owned(name)
        self.assertEqual(self.effects, []); self.assertTrue(self.table[self.foreign]['State']['Running'])
    def test_helper_whose_name_moves_between_create_and_lookup_is_never_adopted(self):
        for case, labels in self.CREATE_RACES:
            with self.subTest(case=case, labels=labels):
                self.setUp(); self.race_create(case, labels)
                with self.assertRaisesRegex(common.Refusal, 'created container still holds its owned name and labels'): self.helper_phase()
                self.assert_never_adopted(self.name_under_test, '5' * 64)
    def test_meter_whose_name_moves_between_create_and_lookup_is_never_adopted(self):
        import live_resource
        for case, labels in self.CREATE_RACES:
            with self.subTest(case=case, labels=labels):
                self.setUp(); self.race_create(case, labels)
                with self.assertRaises(live_resource.ObservationIncomplete): self.meter_phase()
                self.assert_never_adopted(self.name_under_test, '6' * 64)
    def test_native_producer_whose_name_moves_between_create_and_lookup_is_never_registered(self):
        for case, labels in self.CREATE_RACES:
            with self.subTest(case=case, labels=labels):
                self.setUp(); self.race_create(case, labels)
                with self.assertRaisesRegex(common.Refusal, 'created container still holds its owned name and labels'): self.native_phase()
                self.assertEqual(self.c.state['nativeProducers'], {}); self.assert_never_adopted(self.name, self.id)

    def test_container_without_a_recorded_create_id_is_never_removed_by_name(self):
        import live_resource
        # docker create printed no usable ID; a container now holds the name and the owned labels.
        for phase, name, created in [(self.helper_phase, 'materialize', '5' * 64), (self.meter_phase, 'meter-4417', '6' * 64)]:
            with self.subTest(phase=name):
                self.setUp(); self.create_output = b'Created-4417 container\n'
                with self.assertRaises((common.Refusal, live_resource.ObservationIncomplete)): phase()
                full = self.c.state['prefix'] + '-' + name; self.assertNotIn(full, self.c.state.get('ownedContainerIDs', {}))
                with self.assertRaisesRegex(common.Refusal, 'owned container name still bound to its create ID'): self.c.stop_owned(full)
                self.assertEqual(self.effects, []); self.assertTrue(self.table[created]['Name'].endswith(name))
    def test_never_started_native_container_refused_at_creation_is_removed_by_its_create_id(self):
        self.unavailable_inspections = {self.id: 1}
        with self.assertRaisesRegex(common.Refusal, 'Docker inspect unavailable'): self.native_phase()
        self.assertEqual(self.c.state['nativeProducers'], {}); self.assertEqual(self.c.state['ownedContainerIDs'][self.name], self.id)
        self.assertIs(self.c.stop_owned(self.name), True)
        self.assertEqual(self.effects, [('rm', self.id)]); self.assertNotIn(self.id, self.table)

if __name__ == '__main__': unittest.main()
