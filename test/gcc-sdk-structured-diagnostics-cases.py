"""Synthetic SDK metadata and real first-party writer children; no SDK runs."""
import ast
import copy
import gzip
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parent.parent
RAW1='RAW_SYNTHETIC_SDK_PATH_PACKAGE_BODY_17'
RAW2='RAW_SYNTHETIC_SDK_PATH_PACKAGE_BODY_29'

def load(name):
    path=ROOT/'scripts/producer-qualification'/name
    spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

h=load('gcc-sdk-onhost-receipt.py');m=h.structured

class Structured(unittest.TestCase):
    def folder(self):
        temporary=tempfile.TemporaryDirectory(prefix='gcc-structured-synthetic-');self.addCleanup(temporary.cleanup);return Path(temporary.name).resolve()
    def canonical(self,value):return h.canonical(value)
    def fixture(self):
        root=self.folder();original=root/'synthetic-inert-sdk';(original/'usr/bin').mkdir(parents=True);(original/'usr/sbin').mkdir()
        for name in m.d.KNOWN_PROGRAMS:
            path=original/name[1:];path.write_bytes((RAW1+' '+name).encode());path.chmod(0o755)
        (original/'bin').symlink_to('/usr/bin');(original/'sbin').symlink_to('/usr/sbin')
        inventory=m.sdk.stage.external_inventory(original);expected=m.d.d.material.inventory(inventory)
        apt=json.loads((ROOT/'scripts/producer-qualification/gcc-sdk-receipt-policy.v1.json').read_bytes())['originalOfflineAptCommand']
        commands=m.catalog(expected,apt);output=root/'gcc-sdk-reconstruction';(output/'observations').mkdir(parents=True)
        (output/'checkpoint').mkdir();(output/'predecessor/__carrier_work').mkdir(parents=True)
        (output/'predecessor/__carrier_work/external-sdk-before.json').write_bytes(self.canonical(inventory))
        sdk_hash=m.digest(m.sdk.stage.canonical(inventory));typed={'externalSdkSha256':sdk_hash}
        typed_path=output/'checkpoint/CHECKPOINT-ROOT.json';typed_path.write_bytes(self.canonical(typed))
        frozen={**m.sdk.PREDECESSOR,'externalSdkSha256':sdk_hash,'members':{'CHECKPOINT-ROOT.json':h.file_pin(typed_path,m.MAX_JSON)}}
        patch=mock.patch.object(m.sdk,'PREDECESSOR',frozen);patch.start();self.addCleanup(patch.stop)
        env={'RUNNER_TEMP':str(root),'GITHUB_SHA':'a'*40,'GITHUB_RUN_ID':'101','GITHUB_RUN_ATTEMPT':'1','GITHUB_JOB':'gcc-staged-first'}
        admission={'resources':{'context':{key:env[key] for key in ['GITHUB_SHA','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_JOB']}},
          'service':{'clock':{'runId':101,'runAttempt':1,'headSha':'a'*40}},'container':{'ownedContainer':'b'*64}}
        (output/'ADMISSION.json').write_bytes(self.canonical(admission))
        (output/'ATTEMPT.json').write_bytes(self.canonical({'nativePhase':'sdk-reconstruction'}))
        (output/'SDK-CARRIER.json').write_bytes(self.canonical({'source':{'headSha':'a'*40}}))
        f={'root':root,'output':output,'env':env,'commands':commands,'observations':output/'observations'}
        self.write_journal(f,1);self.times(f);return f
    def times(self,f):
        start=1700000000000000000
        os.utime(f['output']/'ADMISSION.json',ns=(start,start))
        for p in f['observations'].iterdir():
            if p.is_file() and not p.is_symlink():os.utime(p,ns=(start+100,start+100))
        for name,n in [('ATTEMPT.json',1000),('SDK-CARRIER.json',2000)]:os.utime(f['output']/name,ns=(start+n,start+n))
    def pair(self,entry,**changes):
        request={'label':entry['label'],'command':entry['commands'][0],'cwd':'/work','state':'requested'}
        if entry['id']==0:request.update(schemaVersion=1,elapsedSeconds=0,exitCode=None)
        terminal={**request,'state':'terminal','elapsedSeconds':0.25,'exitCode':0,'signal':None,'terminalObserved':True}
        if entry['id']:
            terminal.update(stdoutBytesRetained=2,stdoutSha256='c'*64,stdoutComplete=True,error=None)
        terminal.update(changes);return request,terminal
    def rows(self,f,slots):return [row for entry in f['commands'][:slots] for row in self.pair(entry)]
    def write_journal(self,f,slots,rows=None):
        rows=self.rows(f,slots) if rows is None else rows
        (f['observations']/m.FILES['journal']).write_bytes(b''.join(self.canonical(row) for row in rows));return rows
    def project(self,f):return m.collect(f['output'],f['env'],h.read_json,h.file_pin)
    def software(self,f,*,matches=True,packages=True):
        counts={'matched':2,'timestampOnlyMaterial':0,'incidentalDifferences':0,'unresolvedMaterial':0 if matches else 1,'generatedState':51}
        value={'state':'data-only-software-and-generated-state-comparison','policy':m.d.d.POLICY,'counts':counts,'entries':sum(counts.values()),
         'categories':{key:[RAW1 if index%2 else RAW2 for index in range(n)] for key,n in counts.items()},
         'installedPackageInventoryMatches':packages,'completeGeneratedInventory':True,'materialProjectionMatches':matches and packages,
         'generatedBytes':{'expected':51,'observed':51,'aggregateLimit':m.d.d.AGGREGATE_LIMIT},'missingGeneratedPaths':[]}
        self.write_software(f,value);return value
    def write_software(self,f,value,state='sdk-material-reconstruction-unqualified'):
        raw=self.canonical(value);path=f['observations']/m.FILES['comparison']
        with path.open('wb') as sink:
            with gzip.GzipFile(fileobj=sink,mode='wb',mtime=0) as stream:stream.write(raw)
        pin=h.file_pin(path,m.MAX_JSON);pin.update(expandedBytes=len(raw),expandedSha256=m.digest(raw))
        sdk={'state':state,'packageInventoryMatches':value['installedPackageInventoryMatches'],'comparisonCounts':value['counts'],'comparison':pin,'raw':RAW1}
        (f['observations']/m.FILES['sdk']).write_bytes(self.canonical(sdk));self.times(f)
    def generation(self,f,*,completed=0,fresh=0,error=None,state='derived-sdk-generation-incomplete'):
        terminals={index:self.pair(row)[1] for index,row in enumerate(f['commands'])}
        formats=[row['outputPath'] for _,row in sorted(m.d.FORMAT_MAP.items())]
        value={'state':state,'toolIdentities':{p:{'raw':RAW2} for p in m.d.KNOWN_PROGRAMS},'removedOwnedFreshOutputs':list(m.d.d.KNOWN_MODES),
               'generatorCommands':[terminals[index+20] for index in range(completed)],'newlyGeneratedOutputs':{p:RAW1 for p in formats[:fresh]}}
        if error is not None:value['error']=error
        (f['observations']/m.FILES['generation']).write_bytes(self.canonical(value));self.times(f);return value
    def validation(self,f,*,completed=0,final=0,error=None,state='derived-sdk-final-validation-incomplete'):
        value={'state':state,'validators':[{'command':self.pair(f['commands'][index+37])[1],'validation':RAW2} for index in range(completed)],
               'finalGeneratedIdentities':{p:RAW1 for p in list(m.d.d.KNOWN_MODES)[:final]}}
        if error is not None:value['error']=error
        (f['observations']/m.FILES['validation']).write_bytes(self.canonical(value));self.times(f);return value
    def assert_closed(self,value):
        m.validate(value);raw=self.canonical(value)
        for token in [RAW1,RAW2,'/usr/bin/','/var/lib/','/controller/','command','label']:
            # Schema keys such as completedGenerators are intentional; literal
            # argv/label fields and raw rows must not be projected.
            if token in ['command','label']:self.assertNotIn(('"'+token+'"').encode(),raw)
            else:self.assertNotIn(token.encode(),raw)
        self.assertLessEqual(len(raw),8192);self.assertFalse(value['sdkQualifiedByProjection']);self.assertFalse(value['underlyingRootCauseAssessed'])
    def test_catalog_is_finite74_from_pinned_pure_constants_and_exact_physical_alias_resolution(self):
        f=self.fixture();commands=f['commands'];self.assertEqual(len(commands),74)
        self.assertEqual([sum(row['stage']==kind for row in commands) for kind in ['apt','ownership','mapping','generator','validator']],[1,18,1,17,37])
        owner=commands[1];self.assertEqual(owner['commands'],[['/usr/bin/dpkg-query','--search','--','/bin/fc-cache'],['/usr/bin/dpkg-query','--search','--','/usr/bin/fc-cache']])
        literal=next(row['commands'][0][-1] for row in commands if row['label']=='sdk-validate-font-inputs')
        original=ast.parse((ROOT/'scripts/producer-qualification/gcc-sdk-derived-run.py').read_bytes())
        expected=next(n.value for n in ast.walk(original) if isinstance(n,ast.Constant) and type(n.value) is str and n.value.startswith('--format=%{file}'))
        self.assertEqual(literal,expected);self.assertEqual([ord(c) for c in literal[-2:]],[92,110])
    def test_exact_valid_alias_and_recorded_prefix_remain_observed_without_naming_last_zero_as_cause(self):
        f=self.fixture();rows=self.rows(f,2);rows[2]['command']=rows[3]['command']=f['commands'][1]['commands'][1]
        self.write_journal(f,0,rows);self.times(f);value=self.project(f);self.assertEqual(value['state'],'observed')
        self.assertEqual(value['journal']['state'],'complete-prefix');self.assertEqual(value['journal']['terminalZero'],2)
        self.assertEqual(value['journal']['lastTerminal']['exitCode'],0);self.assertEqual(value['cause'],'unestablished');self.assert_closed(value)
    def test_full74_slot_synthetic_record_set_has_reconciled_counts_but_never_sdk_or_root_cause_credit(self):
        f=self.fixture();self.write_journal(f,74);self.software(f);self.generation(f,completed=17,fresh=13,state='derived-sdk-outputs-generated-not-yet-finally-validated')
        self.validation(f,completed=37,final=51,state='derived-sdk-outputs-finally-validated')
        sdk=json.loads((f['observations']/m.FILES['sdk']).read_bytes());sdk['state']='sdk-material-reconstructed-and-physically-verified';(f['observations']/m.FILES['sdk']).write_bytes(self.canonical(sdk));self.times(f)
        value=self.project(f);self.assertEqual(value['state'],'observed');self.assertEqual(value['journal']['state'],'complete')
        self.assertEqual(value['journal']['requested'],74);self.assertEqual(value['journal']['terminals'],74)
        self.assertEqual(value['generation']['completedGenerators'],17);self.assertEqual(value['validation']['completedValidators'],37);self.assert_closed(value)
    def test_recorded_apt_or_tool_nonzero_and_signal_are_genuine_child_outcomes_not_inferred_sdk_exit(self):
        for slots,fields in [(1,{'exitCode':7}),(2,{'exitCode':1}),(2,{'exitCode':None,'signal':9})]:
            with self.subTest(slots=slots,fields=fields):
                f=self.fixture();rows=self.rows(f,slots);rows[-1].update(fields);self.write_journal(f,0,rows);self.times(f);value=self.project(f)
                self.assertEqual(value['state'],'observed');self.assertEqual(value['cause'],'recorded-command-nonzero')
                self.assertEqual(value['journal']['lastTerminal']['exitCode'],fields['exitCode']);self.assertEqual(value['journal']['terminalNonzero'],1);self.assert_closed(value)
    def test_zero_tool_exit_with_wrapper_error_stays_zero_and_pending_or_missing_terminal_is_unknown(self):
        f=self.fixture();rows=self.rows(f,2);rows[-1].update(stdoutComplete=False,error=RAW1);self.write_journal(f,0,rows);self.times(f)
        value=self.project(f);self.assertEqual(value['cause'],'recorded-wrapper-error');self.assertEqual(value['journal']['lastTerminal']['exitCode'],0);self.assert_closed(value)
        for kind in ['pending','partial','empty']:
            with self.subTest(kind=kind):
                f=self.fixture();rows=self.rows(f,2)[:-1]
                raw=b''.join(self.canonical(row) for row in rows) if kind=='pending' else b''.join(self.canonical(row) for row in rows[:-1])+b'{"label":' if kind=='partial' else b''
                (f['observations']/m.FILES['journal']).write_bytes(raw);self.times(f);value=self.project(f)
                self.assertEqual(value['state'],'incomplete');self.assertEqual(value['cause'],'unestablished');self.assert_closed(value)
    def test_unobserved_command_terminal_false_does_not_turn_into_zero_or_a_causal_command_failure(self):
        f=self.fixture();rows=self.rows(f,2);rows[-1].update(exitCode=None,terminalObserved=False,stdoutComplete=False,error=RAW2)
        self.write_journal(f,0,rows);self.times(f);value=self.project(f)
        self.assertEqual(value['journal']['terminalUnknown'],1);self.assertIsNone(value['journal']['lastTerminal']['exitCode']);self.assertFalse(value['journal']['lastTerminal']['terminalObserved'])
        self.assertEqual(value['cause'],'recorded-wrapper-error');self.assert_closed(value)
    def test_unknown_duplicate_out_of_order_terminal_without_request_and_followup_after_nonzero_refuse(self):
        for kind in ['unknown-label','duplicate','order','terminal-first','followup','extra-key','wrong-cwd','wrong-argv','foreign-path']:
            with self.subTest(kind=kind):
                f=self.fixture();rows=self.rows(f,2)
                if kind=='unknown-label':
                    for row in rows[:2]:row['label']+='-suffix'
                elif kind=='duplicate':rows=rows[:2]+rows[:2]
                elif kind=='order':rows=rows[2:]+rows[:2]
                elif kind=='terminal-first':rows=rows[1:]
                elif kind=='followup':rows[1]['exitCode']=2
                elif kind=='extra-key':rows[0]['raw']=RAW1
                elif kind=='wrong-cwd':
                    for row in rows[:2]:row['cwd']='/work-other'
                elif kind=='wrong-argv':
                    for row in rows[:2]:row['command']=row['command']+[RAW1]
                else:
                    for row in rows[2:4]:row['command']=['/usr/bin/dpkg-query','--search','--','/usr/bin/fc-cache-suffix']
                self.write_journal(f,0,rows);self.times(f);value=self.project(f);self.assertEqual(value['state'],'invalid');self.assert_closed(value)
    def test_boolean_exit_signal_terminal_and_nonfinite_elapsed_or_path_hash_refuse(self):
        for fields in [{'exitCode':False},{'signal':True,'exitCode':None},{'terminalObserved':1},{'elapsedSeconds':float('nan')},
                       {'elapsedSeconds':-1},{'exitCode':None,'terminalObserved':True},{'stdoutSha256':'/path/'+RAW1},
                       {'stdoutComplete':False,'error':None},{'stdoutComplete':True,'error':RAW1}]:
            with self.subTest(fields=fields):
                f=self.fixture();rows=self.rows(f,2);rows[-1].update(fields);self.write_journal(f,0,rows);self.times(f)
                value=self.project(f);self.assertEqual(value['state'],'invalid');self.assert_closed(value)
    def test_software_comparison_counts_reconcile_and_false_material_is_only_a_recorded_rejection(self):
        for matches,packages in [(True,True),(False,True),(True,False)]:
            with self.subTest(matches=matches,packages=packages):
                f=self.fixture();self.software(f,matches=matches,packages=packages);value=self.project(f)
                self.assertEqual(value['state'],'observed');self.assertEqual(sum(value['sdk']['counts'].values()),value['sdk']['entries'])
                self.assertEqual(value['sdk']['materialProjectionMatches'],matches and packages)
                self.assertEqual(value['cause'],'unestablished' if matches and packages else 'recorded-material-comparison-false');self.assert_closed(value)
    def test_category_total_lengths_boolean_and_material_flags_near_misses_refuse(self):
        for kind in ['sum','length','boolean','unknown-category','flag','state','size']:
            with self.subTest(kind=kind):
                f=self.fixture();value=self.software(f)
                if kind=='sum':value['entries']+=1
                elif kind=='length':value['categories']['matched'].append(RAW1)
                elif kind=='boolean':value['counts']['matched']=True
                elif kind=='unknown-category':value['counts'][RAW1]=0
                elif kind=='flag':value['materialProjectionMatches']=False
                elif kind=='state':value['state']=RAW1
                else:value['generatedBytes']['aggregateLimit']+=1
                self.write_software(f,value);observed=self.project(f);self.assertEqual(observed['state'],'invalid');self.assert_closed(observed)
    def test_generation_and_validation_reported_errors_are_hashes_and_do_not_replace_last_genuine_zero(self):
        f=self.fixture();self.write_journal(f,20);self.software(f);self.generation(f,error=RAW1)
        value=self.project(f);self.assertEqual(value['cause'],'generation-reported-error');self.assertEqual(value['generation']['errorSha256'],m.digest(RAW1.encode()));self.assertEqual(value['journal']['lastTerminal']['exitCode'],0);self.assert_closed(value)
        f=self.fixture();self.write_journal(f,37);self.software(f);self.generation(f,completed=17,fresh=13,state='derived-sdk-outputs-generated-not-yet-finally-validated');self.validation(f,error=RAW2)
        value=self.project(f);self.assertEqual(value['cause'],'validation-reported-error');self.assertEqual(value['validation']['errorSha256'],m.digest(RAW2.encode()));self.assert_closed(value)
    def test_missing_or_inconsistent_generation_validator_commands_and_contradictory_markers_refuse(self):
        for kind in ['generator-command','validator-command','unknown-output','false-complete','impossible-generation']:
            with self.subTest(kind=kind):
                f=self.fixture();self.write_journal(f,38);self.software(f)
                gen=self.generation(f,completed=17,fresh=13,state='derived-sdk-outputs-generated-not-yet-finally-validated');val=self.validation(f,completed=1)
                if kind=='generator-command':gen['generatorCommands'][0]['label']+='-suffix'
                elif kind=='validator-command':val['validators'][0]['command']['exitCode']=1
                elif kind=='unknown-output':gen['newlyGeneratedOutputs']['/unknown/'+RAW1]=RAW2
                elif kind=='false-complete':
                    sdk=json.loads((f['observations']/m.FILES['sdk']).read_bytes());sdk['state']='sdk-material-reconstructed-and-physically-verified';(f['observations']/m.FILES['sdk']).write_bytes(self.canonical(sdk))
                else:self.software(f,matches=False)
                (f['observations']/m.FILES['generation']).write_bytes(self.canonical(gen));(f['observations']/m.FILES['validation']).write_bytes(self.canonical(val));self.times(f)
                value=self.project(f);self.assertEqual(value['state'],'invalid');self.assert_closed(value)
    def test_current_source_run_attempt_job_head_and_predecessor_bindings_refuse_stale_or_foreign_records(self):
        for kind in ['run','attempt','job','head','root','inventory','carrier']:
            with self.subTest(kind=kind):
                f=self.fixture()
                if kind in ['run','attempt','job','head']:
                    key={'run':'GITHUB_RUN_ID','attempt':'GITHUB_RUN_ATTEMPT','job':'GITHUB_JOB','head':'GITHUB_SHA'}[kind];f['env'][key]=RAW1
                elif kind=='root':(f['output']/'checkpoint/CHECKPOINT-ROOT.json').write_bytes(b'{}')
                elif kind=='inventory':(f['output']/'predecessor/__carrier_work/external-sdk-before.json').write_bytes(b'{}')
                else:(f['output']/'SDK-CARRIER.json').write_bytes(self.canonical({'source':{'headSha':'d'*40}}));self.times(f)
                value=self.project(f);self.assertEqual(value['state'],'invalid');self.assert_closed(value)
    def test_record_before_admission_after_attempt_symlink_and_corrupt_json_gzip_are_not_accepted(self):
        for kind in ['old','late','symlink','json','gzip','gzip-pin','oversized']:
            with self.subTest(kind=kind):
                f=self.fixture();path=f['observations']/m.FILES['journal']
                if kind=='old':os.utime(path,ns=(1,1))
                elif kind=='late':os.utime(path,ns=(1800000000000000000,1800000000000000000))
                elif kind=='symlink':target=f['root']/'outside';path.rename(target);path.symlink_to(target)
                elif kind=='json':path.write_bytes(b'{"label": invalid}\n');self.times(f)
                elif kind=='oversized':path.write_bytes(b'x'*(m.MAX_JOURNAL+1));self.times(f)
                else:
                    self.software(f);path=f['observations']/m.FILES['comparison']
                    if kind=='gzip':path.write_bytes(b'not-a-gzip')
                    else:path.write_bytes(path.read_bytes()+b'foreign-trailer')
                    self.times(f)
                value=self.project(f);self.assertEqual(value['state'],'invalid');self.assert_closed(value)
    def test_missing_records_and_missing_admission_stay_unobserved_without_invented_collection_or_normalization_success(self):
        f=self.fixture();(f['observations']/m.FILES['journal']).unlink();value=self.project(f)
        self.assertEqual(value['state'],'unobserved');self.assertEqual(value['journal']['state'],'unobserved');self.assertIsNone(value['journal']['requested']);self.assertEqual(value['sdk']['state'],'unobserved');self.assertEqual(value['cause'],'unestablished')
        self.assertEqual(value['unjournaledCollectionAndNormalizationTerminals'],'unobserved');self.assert_closed(value)
        (f['output']/'ADMISSION.json').unlink();value=self.project(f);self.assertEqual(value['state'],'unobserved');self.assert_closed(value)
    def test_real_original_apt_writer_records_n2_genuine_zero_and_seven_before_raising_and_never_becomes_sdk_evidence(self):
        root=self.folder();records=root/'journal';events=[];original_fsync=os.fsync
        def sync(fd):events.append('fsync');return original_fsync(fd)
        with h.local_only_output(root/'private-writer-output'),mock.patch.object(m.sdk.stage.os,'fsync',side_effect=sync):
            for code in [0,7]:
                command=[sys.executable,'-c','import os;os.write(1,'+repr((RAW1+RAW2).encode())+');raise SystemExit('+str(code)+')']
                if code:
                    with self.assertRaisesRegex(ValueError,'Original native command failed'):m.sdk.stage.command_record(command,root,records,'synthetic-'+str(code))
                else:m.sdk.stage.command_record(command,root,records,'synthetic-'+str(code))
        rows=[json.loads(line) for line in records.read_bytes().splitlines()]
        self.assertEqual(len(rows),4);self.assertEqual([rows[i]['exitCode'] for i in [1,3]],[0,7]);self.assertTrue(all(rows[i]['terminalObserved'] for i in [1,3]));self.assertEqual(len(events),4)
        f=self.fixture()
        with self.assertRaises(m.Bad):m.journal(records.read_bytes(),f['commands'])
        self.assertIn(RAW1.encode(),(root/'private-writer-output').read_bytes())
    def test_real_original_derived_writer_records_n2_child_status_output_hash_and_private_error_without_sdk_execution(self):
        root=self.folder();records=root/'journal';original_popen=subprocess.Popen
        def spawn(command,**kwargs):kwargs['cwd']=root;return original_popen(command,**kwargs)
        with h.local_only_output(root/'private-derived-output'),mock.patch.object(m.d,'KNOWN_PROGRAMS',(sys.executable,)),mock.patch.object(m.d.subprocess,'Popen',side_effect=spawn):
            for code in [0,7]:
                command=[sys.executable,'-c','import os;os.write(1,'+repr((RAW1+RAW2).encode())+');raise SystemExit('+str(code)+')']
                if code:
                    with self.assertRaisesRegex(ValueError,'SDK generator/validator failed'):m.d.run(command,'synthetic-'+str(code),records,m.d.time.monotonic()+10)
                else:m.d.run(command,'synthetic-'+str(code),records,m.d.time.monotonic()+10)
        rows=[json.loads(line) for line in records.read_bytes().splitlines()]
        self.assertEqual(len(rows),4);self.assertEqual([rows[i]['exitCode'] for i in [1,3]],[0,7]);self.assertTrue(all(rows[i]['stdoutComplete'] and rows[i]['terminalObserved'] for i in [1,3]))
        for i in [1,3]:self.assertEqual(rows[i]['stdoutSha256'],m.digest((RAW1+RAW2).encode()))
        f=self.fixture()
        with self.assertRaises(m.Bad):m.journal(records.read_bytes(),f['commands'])
    def test_original_ownership_loop_writes_exactly_one_pair_for_each18_program_with_either_valid_alias_first(self):
        for choice in [0,-1]:
            with self.subTest(aliasChoice=choice):
                f=self.fixture();records=f['root']/'real-alias-journal';identities={};calls=[];original_popen=subprocess.Popen
                for entry,requested in zip(f['commands'][1:19],m.d.KNOWN_PROGRAMS):
                    # Independent fixture aliases: every synthetic program is an
                    # ordinary /usr/{bin,sbin} file, with /{bin,sbin} symlinks.
                    queries=[requested[4:],requested]
                    query=queries[choice];registered=[query,*[other for other in queries if other!=query]]
                    identities[requested]={'originalPackageOwners':[{'package':RAW1,'architecture':'all','version':'1','registeredPaths':registered}]}
                def spawn(command,**kwargs):
                    calls.append(command)
                    self.assertEqual(command[:4],['/usr/bin/dpkg-query','--search','--',command[-1]])
                    program='import os;os.write(1,'+repr((RAW1+': '+command[-1]+'\n').encode())+')'
                    kwargs['cwd']=f['root'];return original_popen([sys.executable,'-c',program],**kwargs)
                with h.local_only_output(f['root']/'private-alias-output'),mock.patch.object(m.d.subprocess,'Popen',side_effect=spawn):
                    proof=m.d.validate_ownership(identities,records,m.d.time.monotonic()+30)
                self.assertEqual(len(calls),18);self.assertEqual(len(proof),18)
                raw=records.read_bytes();self.assertEqual(len(raw.splitlines()),36)
                apt=b''.join(self.canonical(row) for row in self.pair(f['commands'][0]))
                (f['observations']/m.FILES['journal']).write_bytes(apt+raw);self.times(f)
                value=self.project(f);self.assertEqual(value['state'],'observed');self.assertEqual(value['journal']['terminals'],19)
                self.assertEqual(value['journal']['terminalZero'],19);self.assertEqual(value['cause'],'unestablished');self.assert_closed(value)
    def test_specific_command_nonzero_or_wrapper_error_is_not_overwritten_by_generic_generation_error(self):
        for code,wrapper in [(7,False),(0,True)]:
            with self.subTest(code=code,wrapper=wrapper):
                f=self.fixture();self.software(f);rows=self.rows(f,2);rows[-1]['exitCode']=code
                if wrapper:rows[-1].update(stdoutComplete=False,error=RAW2)
                self.write_journal(f,0,rows);self.generation(f,error=RAW1);self.times(f)
                value=self.project(f);self.assertEqual(value['state'],'observed')
                self.assertEqual(value['journal']['lastTerminal']['exitCode'],code)
                self.assertEqual(value['cause'],'recorded-wrapper-error' if wrapper else 'recorded-command-nonzero')
                self.assertEqual(value['generation']['errorSha256'],m.digest(RAW1.encode()));self.assert_closed(value)

    def test_closed_schema_rejects_raw_extra_fields_unknown_statuses_boolean_counters_and_overbudget_receipt(self):
        good=m.empty();self.assert_closed(good)
        for mutate in [lambda v:v.update(raw=RAW1),lambda v:v['hashes'].update(raw=RAW2),lambda v:v.update(state=RAW1),
                       lambda v:v['journal'].update(requested=True),lambda v:v.update(sdkQualifiedByProjection=True),
                       lambda v:v.update(underlyingRootCauseAssessed=True),lambda v:v['generation'].update(errorSha256='/raw/'+RAW2)]:
            value=copy.deepcopy(good);mutate(value)
            with self.assertRaises((m.Bad,TypeError)):m.validate(value)
        value=h.empty_receipt('a'*40);value['errorId']='sdk-incomplete';value['structuredSdk']=good
        self.assertLessEqual(len(h.PREFIX+h.canonical(h.validate_receipt(value))),h.MAX_RECEIPT)
    def test_projection_unavailability_does_not_replace_a_genuine_sdk_zero_or_one_or_elapsed_and_emits_only_closed_receipt(self):
        for code in [0,1]:
            with self.subTest(code=code):
                root=self.folder();private=root/'private';private.mkdir()
                def fail():
                    output=private/'synthetic-sdk';output.mkdir()
                    (output/'SDK-CARRIER.json').write_bytes(self.canonical({'ownedContainerCleanup':'removed','ownedSeedCleanup':'removed','observed':{'nativeSeconds':91.5,'containerState':{'Running':False,'Pid':0,'Status':'exited','ExitCode':code}}}))
                    h.retain_attempt(output,private)
                    with mock.patch.object(h.structured,'collect',return_value={**m.empty(),'state':'invalid','errorId':'record-unavailable'}):h.retain_structured(output,private)
                    raise h.Refusal('sdk-incomplete')
                value=h.guarded(fail,private,'a'*40);self.assertEqual(value['sdkContainerExitCode'],code);self.assertEqual(value['sdkContainerSeconds'],91.5)
                self.assertEqual(value['structuredSdk']['state'],'invalid');self.assertFalse(value['sdkVerifiedOnHost']);self.assertLessEqual(len(h.PREFIX+h.canonical(value)),16384)
                self.assertNotIn(RAW1.encode(),h.canonical(value));self.assertNotIn(RAW2.encode(),h.canonical(value))

if __name__=='__main__':unittest.main(verbosity=2)
