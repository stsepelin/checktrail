"""Broken/valid-near-miss first-party target assembly; never contacts Docker."""
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(Path(os.environ.get('CHECKTRAIL_SYNTHETIC_BUNDLE',str(HERE)))))
sys.path.insert(0,str(HERE))
import common
import protected_control_worker as w
import target_protected_controls as t

GOOD={'exitCode':0,'reason':None,'ownedChildStarted':True,'ownedChildReaped':True}

class ProtectedTarget(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.binding={'case':'interrupt-build','syntheticControlOnly':True,'originalSDKCommandStarted':False}
        self.state={'uid':10001,'gid':10002}
        self.child={'binding':self.binding,'originalSDKSourceSeedBuildTestsOrKeysExecuted':False,'uid':10001,'euid':10001,'gid':10002,'supplementaryGroups':[],'capabilities':{'CapEff':0,'CapPrm':0,'CapInh':0,'CapAmb':0},'NoNewPrivs':1,'parentPID':1,'childPID':9,'protectedOpenErrno':13,'rootParentSignalProbeErrno':1,'rootSetuidProbeErrno':1}

    def test_only_four_exact_cases_and_distinct_natural_exit_modes(self):
        self.assertEqual(w.CASES,{'natural-build':('build',0),'natural-tests':('test',7),'interrupt-build':('build',None),'denied-kill-tests':('test',None)})
        for name in ['build','natural-build-suffix','prefix-natural-build','Natural-build','../../natural-build']:
            with self.subTest(name=name),self.assertRaises(common.Refusal):w.selected(name)
        for case in w.CASES:
            argv=w.child_argv(case,self.binding,90.0)
            # The child starts through the launcher bootstrap and runs from the verified bundle.
            self.assertEqual(argv[:5],['/usr/bin/python3','-I','-S','-B','-c']);self.assertEqual(argv[6:8],['/observer/run_checks.py',hashlib.sha256(common.bundle_bytes(HERE/'run_checks.py')).hexdigest()])
            self.assertEqual(argv[argv.index('--entry'):argv.index('--entry')+5],['--entry','protected_control_worker.py','child','--case',case]);self.assertNotIn('./build.sh',argv)

    def test_supervisor_protects_first_then_uses_real_candidate_supervisor_and_exact_canary_argv(self):
        events=[]
        def protect(folder):events.append(('protect',folder));return self.root
        def supervise(*args):events.append(('supervise',args));return {'supervisorExitCode':130}
        with patch.object(w.os,'geteuid',return_value=0),patch.object(w.native_entry,'protect_control',side_effect=protect),patch.object(w.native_entry,'supervise',side_effect=supervise):
            self.assertEqual(w.supervisor('interrupt-build',self.binding,90.0,10001,10002),130)
        self.assertEqual(events[0],('protect','/native-control'))
        actual=events[1][1];self.assertEqual(actual[0],w.child_argv('interrupt-build',self.binding,90.0));self.assertEqual(actual[1:3],(90.0,'/work/source'));self.assertEqual(actual[4:],(self.root,self.binding,10001,10002))

    def test_invalid_preparation_identity_refuses_before_filesystem_access(self):
        for uid,gid in [(0,1),(-1,1),(10001,-1),(True,1)]:
            with self.subTest(uid=uid,gid=gid),patch.object(w.os,'geteuid',return_value=0),patch.object(w,'Path') as path,self.assertRaises(common.Refusal):
                w.prepare('natural-build',uid,gid)
            path.assert_not_called()

    def test_owned_canary_preparation_sets_required_modes_despite_umask077(self):
        real_path=Path;work=self.root/'work';work.mkdir();source=work/'source';parent=work/'control-reports';real_stat=Path.stat
        def mapped(value):return self.root/str(value).lstrip('/')
        def metadata(path,*args,**kwargs):
            actual=real_stat(path,*args,**kwargs)
            if path in [source,parent]:
                values=list(actual);values[4]=0;return os.stat_result(values)
            return actual
        before=os.umask(0o077)
        try:
            with patch.object(w,'Path',side_effect=mapped),patch.object(w.os,'geteuid',return_value=0),patch.object(Path,'stat',metadata),patch.object(w.os,'chown') as owned:
                w.prepare('natural-build',10001,10002)
        finally:os.umask(before)
        self.assertEqual(real_stat(source).st_mode&0o777,0o755);self.assertEqual(real_stat(parent).st_mode&0o777,0o755);self.assertEqual(real_stat(parent/'natural-build').st_mode&0o777,0o700)
        owned.assert_called_once_with(parent/'natural-build',10001,10002)

    def test_actual_child_probes_are_fixed_inert_and_report_observed_fields_only(self):
        status='CapEff:\t0\nCapPrm:\t0\nCapInh:\t0\nCapAmb:\t0\nNoNewPrivs:\t1\n';records=[]
        binding={**self.binding,'case':'natural-build'}
        with patch.object(w.Path,'read_text',return_value=status),patch.object(w.os,'getpid',return_value=9),patch.object(w.os,'getppid',return_value=1),patch.object(w.os,'getuid',return_value=10001),patch.object(w.os,'geteuid',return_value=10001),patch.object(w.os,'getgid',return_value=10002),patch.object(w.os,'getgroups',return_value=[]),patch.object(w.os,'open',side_effect=PermissionError(13,'inert denied')) as opened,patch.object(w.os,'kill',side_effect=PermissionError(1,'inert denied')) as kill,patch.object(w.os,'setuid',side_effect=PermissionError(1,'inert denied')) as uid,patch.object(w,'freeze',side_effect=lambda p,body:records.append((p,json.loads(body)))):
            self.assertEqual(w.child('natural-build',binding,90.0),0)
        kill.assert_called_once_with(1,0);uid.assert_called_once_with(0);opened.assert_called_once_with('/native-control/START.json',os.O_RDONLY|os.O_NOFOLLOW)
        self.assertEqual(len(records),1);self.assertEqual(records[0][0],Path('/work/control-reports/natural-build/READY.json'));self.assertEqual(records[0][1],{**self.child,'binding':binding})

    def test_child_contract_valid_then_missing_nonzero_boolean_foreign_and_scope_cases_refuse(self):
        self.assertEqual(t.child_contract(self.child,self.binding,self.state),self.child)
        variants=[]
        for key in self.child:
            value=copy.deepcopy(self.child);value.pop(key);variants.append(value)
        for key in ['CapEff','CapPrm','CapInh','CapAmb']:
            value=copy.deepcopy(self.child);value['capabilities'][key]=32;variants.append(value)
            value=copy.deepcopy(self.child);value['capabilities'][key]=False;variants.append(value)
        for change in [{'NoNewPrivs':0},{'NoNewPrivs':True},{'rootParentSignalProbeErrno':True},{'rootSetuidProbeErrno':None},{'uid':0},{'euid':0},{'supplementaryGroups':[0]},{'originalSDKSourceSeedBuildTestsOrKeysExecuted':True},{'binding':{**self.binding,'case':'natural-tests'}},{'parentPID':True},{'childPID':1}]:variants.append({**copy.deepcopy(self.child),**change})
        for ordinal,value in enumerate(variants):
            with self.subTest(ordinal=ordinal),self.assertRaises(common.Refusal):t.child_contract(value,self.binding,self.state)

    def ready_fixture(self,value=None,row=None,running=True):
        (self.root/'evidence').mkdir(exist_ok=True);calls=[]
        c=SimpleNamespace(root=self.root,state=self.state)
        def docker(args,**kwargs):
            calls.append(args)
            if value is not None:Path(args[2]).write_bytes(common.encoded(value))
            return copy.deepcopy(row or GOOD),self.root/'unused'
        c.docker=docker
        api=SimpleNamespace(binding={'id':'b'*64},inspect_id=lambda *args:{'State':{'Running':running}})
        return c,api,calls

    def test_readiness_requires_current_waiting_role_running_and_bound_positive_child(self):
        c,api,calls=self.ready_fixture(self.child)
        with patch.object(t.time,'monotonic',return_value=0):result=t.ready(c,api,'interrupt-build',self.binding,10)
        self.assertEqual(result,self.child);self.assertEqual(calls,[['cp','b'*64+':/work/control-reports/interrupt-build/READY.json',str(self.root/'evidence/READY-1.json')]])
        # A retained valid marker from a producer that is already terminal
        # cannot arm the cross-UID interrupt/kill control.
        c,api,calls=self.ready_fixture(self.child,running=False)
        with patch.object(t.time,'monotonic',return_value=0),self.assertRaisesRegex(common.Refusal,'fresh-exact-waiting-producer-running'):t.ready(c,api,'interrupt-build',self.binding,10)

    def test_readiness_transport_unknown_and_late_read_never_credit_old_or_complete_data(self):
        c,api,calls=self.ready_fixture(self.child,{**GOOD,'reason':'owned command deadline'})
        with patch.object(t.time,'monotonic',return_value=0),self.assertRaisesRegex(common.Refusal,'ready-transport-unknown'):t.ready(c,api,'interrupt-build',self.binding,10)
        c,api,calls=self.ready_fixture(self.child);clock=[0];real=t.read_json
        def late(*args):value=real(*args);clock[0]=11;return value
        with patch.object(t.time,'monotonic',side_effect=lambda:clock[0]),patch.object(t,'read_json',side_effect=late),self.assertRaisesRegex(common.Refusal,'ready-readback-completion-deadline'):t.ready(c,api,'interrupt-build',self.binding,10)

    def test_control_manifest_binds_exact_files_not_missing_extra_or_tampered_copy(self):
        names=['protected_control_worker.py','target_protected_controls.py','test_protected_control_target.py'];rows=[]
        for name in names:
            body=('first-party-inert-'+name).encode();(self.root/name).write_bytes(body);rows.append({'path':name,'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()})
        def install(selection):
            raw=common.encoded({'files':selection});(self.root/'PROTECTED-CONTROLS.json').write_bytes(raw);return hashlib.sha256(raw).hexdigest()
        with patch.object(t,'HERE',self.root):
            t.verify_control_inputs(install(rows))
            for bad in [rows[:-1],rows+[rows[0]],[{**rows[0],'path':rows[0]['path']+'-suffix'},*rows[1:]]]:
                with self.subTest(bad=bad),self.assertRaises(common.Refusal):t.verify_control_inputs(install(bad))
            pin=install(rows);(self.root/names[0]).write_bytes(b'foreign')
            with self.assertRaises(common.Refusal):t.verify_control_inputs(pin)

if __name__=='__main__':unittest.main(verbosity=2)
