"""Synthetic UID/capability and original-exit/cleanup contracts; no Docker."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent))
import common
import driver
import native_entry

class SupervisorAuthority(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def child(self, first_error=None, terminal=0, refuse_signal=False):
        class Child:
            pid = 123456789
            code = None
            waits = 0
            def __init__(self, *args, **kwargs): pass
            def poll(self): return self.code
            def wait(self, timeout):
                self.waits += 1
                if self.waits == 1 and first_error is not None: raise first_error
                if refuse_signal: raise subprocess.TimeoutExpired('inert', timeout)
                self.code = terminal
                return terminal
        return Child

    def run_child(self, child, kill=None):
        with patch.object(native_entry.subprocess, 'Popen', child), patch.object(native_entry.os, 'killpg', side_effect=kill) as signalling:
            result = native_entry.supervise(['inert-never-executed'], time.monotonic()+10, str(self.root), {}, self.root, {'synthetic': True})
        self.assertEqual(common.read_json(self.root/'RESULT.json'), result)
        return result, signalling

    def test_original_natural_nonzero_remains_original_exit_without_signal(self):
        row, kill = self.run_child(self.child(terminal=7))
        self.assertEqual(row['originalExitCode'],7);self.assertEqual(row['supervisorExitCode'],7);self.assertTrue(row['ownChildReaped']);self.assertFalse(row['supervisorSignalAttempted']);kill.assert_not_called()

    def test_timeout_forced_signal_preserves_actual_negative_child_exit_separate_from_124(self):
        row, kill = self.run_child(self.child(first_error=subprocess.TimeoutExpired('inert',1),terminal=-9))
        kill.assert_called_once_with(123456789,signal.SIGKILL)
        self.assertEqual(row['originalExitCode'],-9);self.assertEqual(row['supervisorExitCode'],124);self.assertTrue(row['timedOut']);self.assertTrue(row['supervisorSignalSent']);self.assertTrue(row['ownChildReaped'])

    def test_interrupt_keeps_forced_child_exit_and_wrapper_130_separate(self):
        row, kill = self.run_child(self.child(first_error=InterruptedError(),terminal=-9))
        self.assertEqual(row['originalExitCode'],-9);self.assertEqual(row['supervisorExitCode'],130);self.assertTrue(row['interrupted']);self.assertTrue(row['ownChildReaped']);kill.assert_called_once()

    def test_signal_permission_and_wait_failure_retain_terminal_unknown_without_fake_reaping(self):
        row, kill = self.run_child(self.child(first_error=subprocess.TimeoutExpired('inert',1),refuse_signal=True),PermissionError(1,'inert cross-UID signal denied'))
        self.assertIsNone(row['originalExitCode']);self.assertFalse(row['ownChildReaped']);self.assertTrue(row['supervisorSignalAttempted']);self.assertFalse(row['supervisorSignalSent']);self.assertEqual(row['cleanupSignalErrorType'],'PermissionError');self.assertEqual(row['cleanupWaitErrorType'],'TimeoutExpired');self.assertEqual(row['supervisorExitCode'],124);kill.assert_called_once()

    def test_restore_error_never_changes_actual_zero_but_withholds_wrapper_success(self):
        real = native_entry.signal.signal;calls=[]
        def restore(sig, handler):
            calls.append((sig,handler))
            if len(calls)>2: raise OSError('inert restoration failure')
            return real(sig,handler)
        previous={sig:signal.getsignal(sig) for sig in [signal.SIGTERM,signal.SIGINT]}
        try:
            with patch.object(native_entry.signal,'signal',side_effect=restore):row,kill=self.run_child(self.child(terminal=0))
        finally:
            for sig,handler in previous.items():real(sig,handler)
        self.assertEqual(row['originalExitCode'],0);self.assertEqual(row['supervisorExitCode'],125);self.assertEqual(row['signalRestoreErrorTypes'],['OSError','OSError']);self.assertTrue(row['ownChildReaped']);kill.assert_not_called()

    def test_child_drop_requires_all_four_zero_capability_sets_and_no_new_privileges(self):
        good='CapEff:\t0000000000000000\nCapPrm:\t0000000000000000\nCapInh:\t0000000000000000\nCapAmb:\t0000000000000000\nNoNewPrivs:\t1\n'
        cases=[(good,True),(good.replace('NoNewPrivs:\t1','NoNewPrivs:\t0'),False)]
        cases += [(good.replace(name+':\t0000000000000000',name+':\t0000000000000020'),False) for name in ['CapEff','CapPrm','CapInh','CapAmb']]
        for status,valid in cases:
            with self.subTest(status=status),patch.object(native_entry.os,'setgroups') as groups,patch.object(native_entry.os,'setgid') as gid,patch.object(native_entry.os,'setuid') as uid,patch.object(native_entry.os,'getuid',return_value=10001),patch.object(native_entry.os,'geteuid',return_value=10001),patch.object(native_entry.os,'getgid',return_value=10001),patch.object(native_entry.os,'getgroups',return_value=[]),patch.object(native_entry.pathlib.Path,'read_text',return_value=status):
                if valid:native_entry.drop_to(10001,10001)()
                else:
                    with self.assertRaises(common.Refusal):native_entry.drop_to(10001,10001)()
                groups.assert_called_once_with([]);gid.assert_called_once_with(10001);uid.assert_called_once_with(10001)

    def test_only_native_supervisor_receives_kill_helpers_keep_existing_caps_and_nnp(self):
        profile=json.loads((Path(driver.__file__).parent/'profile.json').read_bytes())
        c=driver.Controller(self.root,{'run':123,'attempt':1,'nonce':'inert','head':'a'*40},profile)
        c.state={'volume':'inert-work','tempVolume':'inert-tmp','imageAlias':'inert-alias','uid':10001,'gid':10001}
        for helper in [False,True]:
            args=c.container_args('ct-sdk10-inert-original-build',['/usr/bin/python3','/observer/inert.py'],helper=helper)
            caps=[args[i+1] for i,x in enumerate(args) if x=='--cap-add']
            self.assertEqual(caps,['DAC_READ_SEARCH','CHOWN'] if helper else ['CHOWN','SETUID','SETGID','KILL'])
            self.assertIn('no-new-privileges:true',args);self.assertEqual(args[args.index('--cap-drop')+1],'ALL')

if __name__=='__main__':unittest.main(verbosity=2)
