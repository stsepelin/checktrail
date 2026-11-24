"""First-party synthetic files/processes only; no Docker, SDK tool or upstream execution."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parent.parent

def load(path):
    spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

m=load(ROOT/'scripts/producer-qualification/gcc-sdk-derived-run.py')
b=load(ROOT/'scripts/producer-qualification/gcc-sdk-reconstruct.py')
REAL_PATH=Path


def mapping_text():
    rows=['Synthetic native protocol prelude','List of all formats:']
    for name,entry in sorted(m.FORMAT_MAP.items()):
        rows += [name+' (engine='+entry['configuredEngine']+') enabled',
                 '  hyphen='+entry['hyphenInput']+', args='+' '.join(entry['generatorArguments']),
                 '  origin=/var/lib/texmf/fmtutil.cnf-SYNTHETIC']
    return ('\n'.join(rows)+'\n').encode()


def pin(path,body=b'Synthetic code',mode=0o755):
    return {'path':path,'kind':'file','uid':0,'gid':0,'mode':mode,'mtimeNs':1234567890000000000,
            'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()}


class Metadata(unittest.TestCase):
    def mapping_fixture(self):
        path='/var/lib/texmf/fmtutil.cnf-SYNTHETIC';rows={path:pin(path)}
        for entry in m.FORMAT_MAP.values():
            value=pin(entry['sourceConfigPath']);value['sha256']=entry['sourceConfigSha256'];rows[value['path']]=value
        return path,rows

    def test_exact13_enabled_effective_mappings_include_mf_nowin_and_physical_config(self):
        path,rows=self.mapping_fixture();row=rows[path]
        with mock.patch.object(m,'expected_leaf',return_value=(path,[row])),mock.patch.object(m,'file_pin',side_effect=lambda p:rows[str(p)]):
            result=m.parse_mapping(mapping_text(),rows)
            self.assertEqual(set(result),set(m.FORMAT_MAP));self.assertEqual(len(result),13)
            self.assertEqual(result['mf']['engine'],'mf-nowin');self.assertEqual(result['mf']['outputPath'],'/var/lib/texmf/web2c/metafont/mf.base')
            self.assertEqual(result['lualatex']['engine'],'luahbtex')
        self.assertIn('/usr/bin/fc-list',m.KNOWN_PROGRAMS);self.assertIn('/usr/bin/mf-nowin',m.KNOWN_PROGRAMS)

    def test_absent_disabled_wrong_engine_args_duplicate_unknown_and_changed_origin_refuse(self):
        path,rows=self.mapping_fixture();row=rows[path];raw=mapping_text()
        changes=[b'',raw.replace(b' enabled',b' disabled',1),raw.replace(b'(engine=mf-nowin)',b'(engine=mf)',1),
                 raw.replace(b'args=tex.ini',b'args=other.ini',1),raw.replace(b'tex (engine=tex)',b'unknown (engine=tex)',1),
                 raw+raw[raw.index(b'dvilualatex ('):raw.index(b'dviluatex (')],raw.replace(b'List of all formats:',b'List of all formats:\nList of all formats:')]
        with mock.patch.object(m,'expected_leaf',return_value=(path,[row])),mock.patch.object(m,'file_pin',side_effect=lambda p:rows[str(p)]):
            for changed in changes:
                with self.subTest(changed=changed[:80]),self.assertRaises(ValueError):m.parse_mapping(changed,rows)
        with mock.patch.object(m,'expected_leaf',return_value=(path,[row])),mock.patch.object(m,'file_pin',side_effect=lambda p:{**row,'sha256':'f'*64} if str(p)==path else rows[str(p)]):
            with self.assertRaisesRegex(ValueError,'configuration differs'):m.parse_mapping(raw,rows)
        with mock.patch.object(m,'expected_leaf',return_value=('/usr/share/fmtutil.cnf',[row])),mock.patch.object(m,'file_pin',side_effect=lambda p:rows[str(p)]):
            with self.assertRaisesRegex(ValueError,'configuration origin'):m.parse_mapping(raw,rows)
        for entry in m.FORMAT_MAP.values():
            changed=copy.deepcopy(rows);changed[entry['sourceConfigPath']]['sha256']='f'*64
            with mock.patch.object(m,'file_pin',side_effect=lambda p:rows[str(p)]),self.assertRaisesRegex(ValueError,'configuration identity differs'):
                m.parse_mapping(raw,changed)

    def test_original_symlink_ancestry_resolves_exact_leaf_and_rejects_loops_missing_or_directory(self):
        rows={'/usr':{'kind':'directory'},'/usr/bin':{'kind':'directory'},'/bin':{'kind':'symlink','target':'usr/bin'},
              '/usr/bin/tool':{'kind':'symlink','target':'../lib/script'},'/usr/lib':{'kind':'directory'},
              '/usr/lib/script':pin('/usr/lib/script')}
        leaf,chain=m.expected_leaf('/bin/tool',rows);self.assertEqual(leaf,'/usr/lib/script');self.assertEqual(len(chain),3)
        for change in [{'kind':'symlink','target':'tool'},{'kind':'directory'}]:
            with self.assertRaises(ValueError):m.expected_leaf('/bin/tool',{**rows,'/usr/bin/tool':change})
        with self.assertRaisesRegex(ValueError,'ancestry missing'):m.expected_leaf('/usr/bin/missing',rows)

    def test_package_identity_duplicates_shapes_and_architectures(self):
        self.assertEqual(m.package_rows(b'tool\t1\tamd64\ntool\t1\ti386\n'),{('tool','amd64'):'1',('tool','i386'):'1'})
        for raw in [b'tool\t1\n',b'tool\t\tamd64\n',b'tool\t1\tamd64\ntool\t2\tamd64\n']:
            with self.assertRaises(ValueError):m.package_rows(raw)

    def test_package_owner_uses_exact_registered_usrmerge_path_and_nonempty_matching_owner(self):
        identities={'/usr/sbin/ldconfig':{'originalPackageOwners':[{'package':'libc-bin','architecture':'amd64','version':'synthetic1',
                                                                  'registeredPaths':['/sbin/ldconfig']}]}}
        with mock.patch.object(m,'run',return_value=(b'libc-bin: /sbin/ldconfig\n',{'exitCode':0})) as command:
            observed=m.validate_ownership(identities,Path('/inert-records'),time.monotonic()+1)
            self.assertEqual(command.call_args.args[0],['/usr/bin/dpkg-query','--search','--','/sbin/ldconfig'])
            self.assertEqual(observed['/usr/sbin/ldconfig']['observedOwners'],[['libc-bin','amd64']])
        for raw in [b'',b'libc-bin: /sbin/ldconfig-suffix\n',b'other: /sbin/ldconfig\n',b'libc-bin:i386: /sbin/ldconfig\n']:
            with mock.patch.object(m,'run',return_value=(raw,{'exitCode':0})),self.assertRaises(ValueError):
                m.validate_ownership(identities,Path('/inert-records'),time.monotonic()+1)

    def test_physical_generator_and_original_package_lists_are_both_pinned_before_ownership(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name).resolve();tool=root/'synthetic-tool';tool.write_bytes(b'Synthetic generator code');tool.chmod(0o755)
            package_list=root/'synthetic.list';package_list.write_text(str(tool)+'\n')
            list_path='/var/lib/dpkg/info/synthetic.list';list_pin={**m.file_pin(package_list),'path':list_path}
            expected={str(tool):m.file_pin(tool),list_path:list_pin}
            def mapped(value):return package_list if str(value)==list_path else REAL_PATH(value)
            original_pin=m.file_pin
            def physical(value):
                row=original_pin(value)
                if value==package_list:row['path']=list_path
                return row
            with mock.patch.object(m,'KNOWN_PROGRAMS',(str(tool),)),mock.patch.object(m,'Path',mapped),\
                 mock.patch.object(m,'file_pin',side_effect=physical),\
                 mock.patch.object(m,'expected_leaf',side_effect=lambda path,rows:(path,[rows[path]])):
                result=m.ownership_index(expected,{('synthetic','all'):'1'})
                self.assertEqual(result[str(tool)]['originalPackageOwners'][0]['version'],'1')
                self.assertEqual(result[str(tool)]['originalPackageOwners'][0]['registeredPaths'],[str(tool)])
                package_list.write_text('/other/synthetic-tool\n')
                with self.assertRaisesRegex(ValueError,'file list differs'):m.ownership_index(expected,{('synthetic','all'):'1'})
                expected[list_path]={**physical(package_list),'path':list_path}
                with self.assertRaisesRegex(ValueError,'lacks original package ownership'):m.ownership_index(expected,{('synthetic','all'):'1'})
                tool.write_bytes(b'Synthetic changed code')
                with self.assertRaisesRegex(ValueError,'code bytes/owner/mode/time'):m.ownership_index(expected,{('synthetic','all'):'1'})

    def test_actual_physical_pin_changes_bytes_mode_and_rejects_symlink_or_oversize(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name).resolve();file=root/'synthetic';file.write_bytes(b'first');file.chmod(0o640)
            before=m.file_pin(file);self.assertEqual(before['mode'],0o640);self.assertEqual(before['bytes'],5)
            file.write_bytes(b'second');self.assertNotEqual(m.file_pin(file)['sha256'],before['sha256'])
            (root/'link').symlink_to(file)
            with self.assertRaises(ValueError):m.file_pin(root/'link')
            file.write_bytes(b'')
            self.assertEqual(m.file_pin(file)['bytes'],0) # Empty ordinary package lists are valid near misses.
            with mock.patch.object(m.d,'MEMBER_LIMIT',0):
                file.write_bytes(b'large')
                with self.assertRaises(ValueError):m.file_pin(file)


class NativeBoundary(unittest.TestCase):
    def invoke(self,script,expect_error=None,stdout_limit=None,seconds=2,*,prestarted=False,signal_failure=False,eof_skew=None):
        self.wait_timeouts=[]
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);root=Path(temp.name).resolve();records=root/'commands'
        real_popen=subprocess.Popen;children=[]
        def cleanup_children():
            for child in children:
                if child.returncode is None:
                    try:os.killpg(child.pid,signal.SIGKILL)
                    except ProcessLookupError:pass
                    finally:child.wait(timeout=5)
        self.addCleanup(cleanup_children)
        if prestarted:
            # Bring the child to the state under test BEFORE the measured window,
            # so a slow interpreter start cannot spend the budget being measured.
            # True means an exited but unreaped leader whose descendant still holds
            # stdout; a callable is a custom readiness predicate over the work root.
            child=real_popen([sys.executable,'-I','-B','-c',script],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
            children.append(child);real_wait=child.wait
            def recorded_wait(*args,**kwargs):
                self.wait_timeouts.append(kwargs.get('timeout',args[0] if args else None));return real_wait(*args,**kwargs)
            child.wait=recorded_wait
            def leader_exited_unreaped(_root):
                observed=subprocess.run(['ps','-o','stat=','-p',str(child.pid)],capture_output=True,text=True,timeout=2)
                return observed.stdout.strip().startswith('Z')
            ready=prestarted if callable(prestarted) else leader_exited_unreaped
            ready_by=time.monotonic()+10
            while time.monotonic()<ready_by and not ready(root):time.sleep(0.01)
            self.assertTrue(ready(root),'Synthetic child did not reach its prestarted state')
            self.assertIsNone(child.returncode)
        def synthetic_popen(command,**kwargs):
            # Executes this test's own synthetic Python program, never the named SDK command.
            self.assertEqual(command,['/usr/bin/fc-list','synthetic-test'])
            if prestarted:return children[0]
            child=real_popen([sys.executable,'-I','-B','-c',script],cwd=root,stdout=kwargs['stdout'],stderr=kwargs['stderr'],start_new_session=True)
            children.append(child);return child
        stream=types.SimpleNamespace(buffer=io.BytesIO())
        with contextlib.ExitStack() as patches:
            if eof_skew is not None:
                # The module's clock jumps by eof_skew when its pipe read returns EOF,
                # charging a known span of the budget before the post-EOF wait.
                real_clock=time.monotonic;skew=[0.0]
                class EofClockedOS:
                    def __getattr__(self,name):return getattr(os,name)
                    def read(self,fd,size):
                        chunk=os.read(fd,size)
                        if not chunk:skew[0]=eof_skew
                        return chunk
                patches.enter_context(mock.patch.object(m,'time',types.SimpleNamespace(monotonic=lambda:real_clock()+skew[0])))
                patches.enter_context(mock.patch.object(m,'os',EofClockedOS()))
            for patch in (mock.patch.object(m.subprocess,'Popen',side_effect=synthetic_popen),mock.patch.object(m.sys,'stdout',stream),
                          mock.patch.object(m,'COMMAND_SECONDS',seconds),mock.patch.object(m,'STDOUT_BYTES',stdout_limit or m.STDOUT_BYTES)):
                patches.enter_context(patch)
            patches.enter_context(mock.patch.object(m.os,'killpg',side_effect=PermissionError(1,'Synthetic denied group signal') if signal_failure else m.os.killpg))
            if expect_error:
                with self.assertRaisesRegex(ValueError,expect_error):m.run(['/usr/bin/fc-list','synthetic-test'],'synthetic',records,time.monotonic()+3)
                value=None
            else:value=m.run(['/usr/bin/fc-list','synthetic-test'],'synthetic',records,time.monotonic()+3)
        rows=[json.loads(line) for line in records.read_bytes().splitlines()]
        self.assertEqual(len(rows),2);self.assertEqual(rows[0]['state'],'requested');self.assertEqual(rows[1]['state'],'terminal')
        self.assertTrue(rows[1]['terminalObserved']);self.assertGreater(rows[1]['elapsedSeconds'],0)
        self.assertTrue(all(child.poll() is not None for child in children))
        return root,value,rows[1],stream.buffer.getvalue()

    def test_real_firstparty_pipe_preserves_output_sha_exit_and_genuine_nonzero(self):
        _,value,row,raw=self.invoke("import sys;sys.stdout.buffer.write(b'Synthetic bytes\\n')")
        self.assertEqual(value[0],b'Synthetic bytes\n');self.assertEqual(raw,value[0]);self.assertEqual(row['exitCode'],0)
        self.assertEqual(row['stdoutSha256'],hashlib.sha256(raw).hexdigest());self.assertTrue(row['stdoutComplete'])
        _,_,row,_=self.invoke('import sys;sys.exit(3)','generator/validator failed')
        self.assertEqual(row['exitCode'],3);self.assertIsNone(row['signal']);self.assertTrue(row['stdoutComplete'])

    def test_stdout_overflow_and_timeout_are_charged_no_success(self):
        _,_,row,_=self.invoke("print('Synthetic overflowing output')",'stdout retention bound',stdout_limit=3)
        self.assertFalse(row['stdoutComplete']);self.assertIn('retention bound',row['error'])
        _,_,row,_=self.invoke('import time;time.sleep(10)','timeout',seconds=0.05)
        self.assertFalse(row['stdoutComplete']);self.assertEqual(row['signal'],signal.SIGKILL);self.assertIsNone(row['exitCode'])

    def test_signal_denial_keeps_original_overflow_and_genuine_terminal_in_receipt(self):
        _,_,row,_=self.invoke("print('Synthetic overflowing output')",'stdout retention bound',stdout_limit=3,signal_failure=True)
        self.assertEqual(row['exitCode'],0);self.assertTrue(row['terminalObserved']);self.assertFalse(row['stdoutComplete'])
        self.assertTrue(row['error'].startswith('SDK tool stdout retention bound; cleanup='))
        self.assertEqual(json.loads(row['error'].split('; cleanup=',1)[1]),[{'operation':'signal-group','kind':'PermissionError','errno':1}])

    def test_signal_and_wait_refusal_keep_original_failure_and_unknown_terminal(self):
        with tempfile.TemporaryDirectory() as name:
            records=Path(name)/'records';reader,writer=os.pipe()
            os.write(writer,b'Synthetic overflowing output');os.close(writer)
            stream=os.fdopen(reader,'rb',buffering=0)
            child=types.SimpleNamespace(pid=12345,returncode=None,stdout=stream,wait=mock.Mock(side_effect=subprocess.TimeoutExpired('synthetic',5)))
            try:
                with mock.patch.object(m.subprocess,'Popen',return_value=child),mock.patch.object(m.os,'killpg',side_effect=PermissionError(1,'Synthetic denied signal')),mock.patch.object(m,'STDOUT_BYTES',3):
                    with self.assertRaisesRegex(ValueError,'stdout retention bound'):m.run(['/usr/bin/fc-list'],'synthetic',records,time.monotonic()+3)
                row=json.loads(records.read_bytes().splitlines()[-1])
                self.assertFalse(row['terminalObserved']);self.assertIsNone(row['exitCode']);self.assertIsNone(row['signal']);self.assertFalse(row['stdoutComplete'])
                self.assertTrue(row['error'].startswith('SDK tool stdout retention bound; cleanup='))
                self.assertEqual(json.loads(row['error'].split('; cleanup=',1)[1]),[{'operation':'signal-group','kind':'PermissionError','errno':1},{'operation':'wait-child','kind':'TimeoutExpired','errno':None}])
                child.wait.assert_called_once_with(timeout=5)
            finally:stream.close()

    def test_late_zero_cannot_signal_a_reaped_leader_or_reused_group(self):
        with tempfile.TemporaryDirectory() as name:
            records=Path(name)/'records';reader,writer=os.pipe();os.close(writer)
            stream=os.fdopen(reader,'rb',buffering=0)
            child=types.SimpleNamespace(pid=12345,returncode=None,stdout=stream)
            def reaped(**kwargs):child.returncode=0;return 0
            child.wait=mock.Mock(side_effect=reaped)
            try:
                with mock.patch.object(m.subprocess,'Popen',return_value=child),mock.patch.object(m.os,'killpg') as kill,\
                     mock.patch.object(m.time,'monotonic',side_effect=[1000,1000,1000,1000,1000,1000,1003,1003]):
                    with self.assertRaisesRegex(ValueError,'SDK tool timeout'):m.run(['/usr/bin/fc-list'],'synthetic',records,1002)
                kill.assert_not_called();child.wait.assert_called_once_with(timeout=2)
                row=json.loads(records.read_bytes().splitlines()[-1])
                self.assertEqual(row['exitCode'],0);self.assertTrue(row['terminalObserved']);self.assertFalse(row['stdoutComplete'])
                self.assertEqual(json.loads(row['error'].split('; cleanup=',1)[1]),[{'operation':'signal-group','kind':'LeaderAlreadyReaped','errno':None}])
            finally:stream.close()

    def test_pipe_eof_does_not_reset_the_remaining_process_or_whole_operation_budget(self):
        # The marker is published atomically only after both pipe ends are closed,
        # so its presence proves the measured run starts from an already-EOF pipe
        # held by a live leader. With 0.7s of a 1s command budget charged at EOF,
        # the wait may receive only the 0.3s remainder; a fresh command budget
        # would be 1s and the whole-operation remainder about 2.3s.
        script="import os,time;os.close(1);os.close(2);open('eof-marker.tmp','w').write('Synthetic closed pipe');os.replace('eof-marker.tmp','eof-marker');time.sleep(30)"
        root,_,row,_=self.invoke(script,'timeout',seconds=1,prestarted=lambda root:(root/'eof-marker').exists(),eof_skew=0.7)
        self.assertEqual((root/'eof-marker').read_text(),'Synthetic closed pipe')
        granted=self.wait_timeouts[0]
        self.assertGreater(granted,0);self.assertLessEqual(granted,0.3+1e-9)
        self.assertFalse(row['stdoutComplete']);self.assertEqual(row['signal'],signal.SIGKILL)
        self.assertIsNone(row['exitCode']);self.assertGreaterEqual(row['elapsedSeconds'],0.7);self.assertLess(row['elapsedSeconds'],2)

    def test_zero_exited_wrapper_descendant_holding_pipe_is_killed_not_mistaken_for_success(self):
        script="import subprocess,sys;child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(20)']);print(child.pid,flush=True)"
        _,_,row,raw=self.invoke(script,'timeout',seconds=0.1,prestarted=True)
        self.assertEqual(row['exitCode'],0);self.assertFalse(row['stdoutComplete']);pid=int(raw.strip())
        deadline=time.monotonic()+2
        while time.monotonic()<deadline:
            result=subprocess.run(['ps','-o','stat=','-p',str(pid)],capture_output=True,text=True)
            if not result.stdout.strip() or result.stdout.strip().startswith('Z'):break
            time.sleep(0.02)
        self.assertTrue(not result.stdout.strip() or result.stdout.strip().startswith('Z'),'Owned synthetic descendant remains running')

    def test_expired_whole_operation_budget_refuses_before_process_or_receipt(self):
        with tempfile.TemporaryDirectory() as name:
            records=Path(name)/'records'
            with mock.patch.object(m.subprocess,'Popen') as spawn:
                with self.assertRaisesRegex(ValueError,'operation deadline'):
                    m.run(['/usr/bin/fc-list'],'synthetic',records,time.monotonic()-1)
                spawn.assert_not_called()
            self.assertFalse(records.exists())

    def test_spawn_failure_records_unknown_terminal_and_unknown_command_never_starts(self):
        with tempfile.TemporaryDirectory() as name:
            records=Path(name)/'records'
            with mock.patch.object(m.subprocess,'Popen',side_effect=OSError('Synthetic unavailable executable')):
                with self.assertRaises(OSError):m.run(['/usr/bin/fc-list'],'synthetic',records,time.monotonic()+1)
            terminal=json.loads(records.read_bytes().splitlines()[-1]);self.assertFalse(terminal['terminalObserved'])
            self.assertIsNone(terminal['exitCode']);self.assertFalse(terminal['stdoutComplete'])
            with mock.patch.object(m.subprocess,'Popen') as spawn:
                with self.assertRaisesRegex(ValueError,'Unknown fixed'):m.run(['/usr/bin/fc-list-extra'],'synthetic',records,time.monotonic()+1)
                spawn.assert_not_called()


class PhysicalWorld:
    """Translate fixed paths onto real synthetic files; root ownership is explicit DATA only."""
    def __init__(self,root):
        self.root=root;self.events=[];self.failure=None;self.mutate=None;self.generation_started=False
        self.observations=root/'controller/observations';self.observations.mkdir(parents=True)
        self.records=root/'records';self.font='/usr/share/fonts/synthetic.otf';self.loader='/etc/ld.so.cache'
        for path in [*m.d.KNOWN_MODES,self.font,self.loader]:self.write(path,b'Synthetic initial '+path.encode())
        self.original={path:self.pin(self.path(path)) for path in [*m.d.KNOWN_MODES,self.font,self.loader]}
    def path(self,value):
        text=str(value)
        if text.startswith(str(self.root)):return REAL_PATH(text)
        return self.root/text.lstrip('/') if text.startswith('/') else REAL_PATH(value)
    def logical(self,path):return '/'+str(path.relative_to(self.root))
    def write(self,path,raw):
        target=self.path(path);target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(raw)
        target.chmod(m.d.KNOWN_MODES.get(path,0o644))
    def pin(self,path):
        row=m_file_pin(path);row.update(path=self.logical(path),uid=0,gid=0);return row
    def inventory(self):return {'syntheticInventory':True}
    def run(self,command,label,records,deadline):
        self.events.append((label,command,deadline));raw=b''
        if label=='sdk-effective-format-mapping':raw=mapping_text()
        if label.startswith('sdk-regenerate-'):
            if not self.generation_started:
                # This assertion fails if ANY removal is omitted or occurs after the first generator.
                if any(self.path(path).exists() or self.path(path).is_symlink() for path in m.d.KNOWN_MODES):
                    raise ValueError('Synthetic generator observed an output that was not removed')
                self.generation_started=True
            if label=='sdk-regenerate-fontconfig':
                for path in m.d.KNOWN_MODES:
                    if path.startswith('/var/cache/fontconfig/'):self.write(path,b'Synthetic regenerated font cache')
            elif label=='sdk-regenerate-ldconfig':self.write('/var/cache/ldconfig/aux-cache',b'Synthetic regenerated auxiliary cache')
            elif label.startswith('sdk-regenerate-format-'):
                name=label[len('sdk-regenerate-format-'):];path=m.FORMAT_MAP[name]['outputPath']
                if self.failure!=name:self.write(path,b'Synthetic freshly generated format '+name.encode())
                self.write(str(REAL_PATH(path).with_suffix('.log')),b'Synthetic format log '+name.encode())
            elif label=='sdk-regenerate-fontmaps':self.write('/var/lib/texmf/web2c/updmap.log',b'Synthetic font map log')
            elif label=='sdk-regenerate-filename-index':self.write('/var/lib/texmf/ls-R',b'Synthetic filename index')
        elif label=='sdk-validate-font-inputs':
            raw=(self.font+'\n').encode()
            if self.mutate=='font-repair':
                path=next(path for path in m.d.KNOWN_MODES if path.startswith('/var/cache/fontconfig/'))
                self.write(path,b'Synthetic permitted font repair')
            if self.failure=='font':self.write(self.font,b'Synthetic changed font input')
        elif label=='sdk-validate-loader-cache':raw=b'Synthetic loader listing\n'
        elif label.startswith('sdk-validate-format-lookup-'):
            name=label[len('sdk-validate-format-lookup-'):];raw=(m.FORMAT_MAP[name]['outputPath']+'\n').encode()
            if self.failure=='lookup':raw=b'/different/synthetic.fmt\n'
        if self.mutate==label:
            path=next(iter(m.d.KNOWN_MODES));self.write(path,b'Synthetic unexpected validator mutation')
        return raw,{'state':'terminal','command':command,'exitCode':0,'signal':None,'terminalObserved':True,'elapsedSeconds':0.001}
    @contextlib.contextmanager
    def active(self):
        with contextlib.ExitStack() as stack:
            for owner,name,value in [(m,'Path',self.path),(m,'file_pin',self.pin),(m,'ownership_index',lambda *_:{}),
                                     (m,'validate_ownership',lambda *_:{}),(m,'parse_mapping',lambda *_:{'synthetic':True}),
                                     (m,'run',self.run),(m,'expected_leaf',lambda path,rows:(path,[rows[path]])),
                                     (m.d.material,'inventory',lambda value:self.original),
                                     (m.stage,'external_inventory',self.inventory),
                                     (m.d,'compare_software',lambda *_:{'materialProjectionMatches':True,'categories':{'timestampOnlyMaterial':[]}})]:
                stack.enter_context(mock.patch.object(owner,name,value))
            yield
    def generate(self):return m.generate({'synthetic':True},b'synthetic\t1\tall\n',self.observations,self.records)

m_file_pin=m.file_pin


class Lifecycle(unittest.TestCase):
    def world(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);return PhysicalWorld(Path(temp.name).resolve())

    def test_all51_physically_removed_then17_fixed_generators_then37_final_validators(self):
        world=self.world()
        with world.active():
            generation=world.generate();self.assertEqual(len(generation['removedOwnedFreshOutputs']),51)
            self.assertEqual(len(generation['generatorCommands']),17);self.assertEqual(len(generation['newlyGeneratedOutputs']),13)
            self.assertEqual(generation['state'],'derived-sdk-outputs-generated-not-yet-finally-validated')
            validation=m.validate({'synthetic':True},generation,world.observations,world.records)
        self.assertEqual(len(validation['validators']),37)
        self.assertEqual(validation['state'],'derived-sdk-outputs-finally-validated');self.assertFalse(validation['gateAComplete'])
        names=[label for label,_,_ in world.events];self.assertLess(names.index('sdk-validate-font-inputs'),names.index('sdk-validate-font-cache-0'))
        self.assertEqual(set(validation['finalGeneratedIdentities']),set(m.d.KNOWN_MODES))
        self.assertEqual(len({deadline for _,_,deadline in world.events}),1,'Generation/validation budget was reset')
        expected=[['/usr/bin/fc-cache','--force','--system-only'],['/usr/sbin/ldconfig','--ignore-aux-cache']]
        self.assertEqual([cmd for label,cmd,_ in world.events if label.startswith('sdk-regenerate-')][:2],expected)

    def test_missing_last_output_and_any_preflight_identity_failure_remove_nothing(self):
        for invalid in ['missing','symlink','empty','mode']:
            world=self.world();path=list(m.d.KNOWN_MODES)[-1];target=world.path(path)
            if invalid=='missing':target.unlink()
            if invalid=='symlink':target.unlink();target.symlink_to('synthetic-missing')
            if invalid=='empty':target.write_bytes(b'')
            if invalid=='mode':target.chmod(0o777)
            first=world.path(next(iter(m.d.KNOWN_MODES)));before=first.read_bytes()
            with world.active(),self.assertRaises((ValueError,FileNotFoundError)):world.generate()
            self.assertEqual(first.read_bytes(),before);self.assertFalse(world.generation_started)

    def test_metadata_query_input_drift_fails_before_any_removal(self):
        world=self.world()
        with world.active(),mock.patch.object(m.d,'compare_software',return_value={'materialProjectionMatches':True,'categories':{'timestampOnlyMaterial':[{'path':'/synthetic-input'}]}}):
            with self.assertRaisesRegex(ValueError,'before regeneration'):world.generate()
        self.assertTrue(all(world.path(path).exists() for path in m.d.KNOWN_MODES));self.assertFalse(world.generation_started)
        result=json.loads((world.observations/'SDK-DERIVED-GENERATION.json').read_bytes());self.assertIn('before regeneration',result['error'])

    def test_metadata_query_generated_output_drift_refuses_before_any_removal(self):
        world=self.world();original=world.run
        def query_changes_output(command,label,records,deadline):
            result=original(command,label,records,deadline)
            if label=='sdk-effective-format-mapping':world.write(list(m.d.KNOWN_MODES)[-1],b'Synthetic query mutation')
            return result
        with world.active(),mock.patch.object(m,'run',side_effect=query_changes_output):
            with self.assertRaisesRegex(ValueError,'changed before planned regeneration'):world.generate()
        self.assertTrue(all(world.path(path).exists() for path in m.d.KNOWN_MODES));self.assertFalse(world.generation_started)

    def test_zero_exit_without_one_exact_format_is_not_generation_success(self):
        world=self.world();world.failure='mf'
        with world.active(),self.assertRaises((ValueError,FileNotFoundError)):world.generate()
        result=json.loads((world.observations/'SDK-DERIVED-GENERATION.json').read_bytes())
        self.assertEqual(result['state'],'derived-sdk-generation-incomplete');self.assertIn('error',result)
        self.assertNotIn(m.FORMAT_MAP['mf']['outputPath'],result['newlyGeneratedOutputs'])

    def test_fc_list_repair_recorded_before_fc_cat_and_final_hashes_match_actual_state(self):
        world=self.world();world.mutate='font-repair'
        with world.active():
            generation=world.generate();validation=m.validate({},generation,world.observations,world.records)
            self.assertEqual(len(validation['validators'][0]['changedGeneratedPaths']),1)
            self.assertTrue(all(not row['changedGeneratedPaths'] for row in validation['validators'][1:]))
            actual=m.generated_pins();self.assertEqual(validation['finalGeneratedIdentities'],actual)
            with mock.patch.object(m.d.material,'inventory',return_value=actual):
                witness=m.verify_final_inventory({},validation);self.assertTrue(witness['exactFinalValidatorIdentitiesMatchRetainedInventory'])
                changed=copy.deepcopy(actual);next(iter(changed.values()))['mode']=0o777
                with mock.patch.object(m.d.material,'inventory',return_value=changed),self.assertRaisesRegex(ValueError,'validator hashes/modes'):
                    m.verify_final_inventory({},validation)

    def test_wrong_lookup_font_input_or_non_font_validator_mutation_cannot_pass(self):
        for kind in ['lookup','font','late-cache-mutation']:
            world=self.world()
            with world.active():
                generation=world.generate()
                if kind=='late-cache-mutation':world.mutate='sdk-validate-font-cache-0'
                else:world.failure=kind
                with self.assertRaises(ValueError):m.validate({},generation,world.observations,world.records)
            result=json.loads((world.observations/'SDK-DERIVED-VALIDATION.json').read_bytes())
            self.assertEqual(result['state'],'derived-sdk-final-validation-incomplete');self.assertIn('error',result)

    def test_all_timestamp_writes_precede_regeneration_and_final_validators_in_actual_body(self):
        # Execute the actual orchestration against synthetic boundary doubles.
        # This detects a moved normalization AFTER validate, rather than merely
        # checking the source text for the presence of the intended calls.
        events=[];output=Path('/controller/observations');predecessor=Path('/inputs/predecessor')
        root={'externalSdkSha256':hashlib.sha256(b.stage.canonical({'synthetic':True})).hexdigest(),
              'binding':{'packageInventorySha256':hashlib.sha256(b'synthetic\t1\tall\n').hexdigest()}}
        comparison={'materialProjectionMatches':True,'installedPackageInventoryMatches':True,'counts':{},'categories':{'timestampOnlyMaterial':[]}}
        package_sink=io.BytesIO()
        class Sink:
            def __enter__(self):return package_sink
            def __exit__(self,*_):return False
        def read(path):
            if path.name=='EXPECTED-PREDECESSOR-ROOT.json':return json.dumps(root).encode()
            if path.name=='installed-build-package-identities.txt' or path.name=='installed-package-identities.txt':return b'synthetic\t1\tall\n'
            return b'{"synthetic":true}'
        def normalize(*args):events.append('timestamp-write');return {},comparison
        def generation(*args):events.append('generate');return {}
        def validation(*args):events.append('validate');return {}
        with contextlib.ExitStack() as stack:
            for owner,name,value in [(b.sys,'argv',['synthetic','sdk-reconstruct']),(b.os,'getuid',lambda:0),
              (b.os,'environ',dict(b.stage.FIXED_ENVIRONMENT)),(Path,'is_dir',lambda _:True),(Path,'is_symlink',lambda _:False),
              (Path,'iterdir',lambda _:iter(())),(Path,'mkdir',lambda *_,**__:None),(Path,'read_bytes',read),
              (Path,'write_bytes',lambda *args:None),(Path,'open',lambda *args,**kwargs:Sink()),
              (b.codec,'snapshot',lambda *args:None),(b.material,'clone_scratch',lambda *args:{}),
              (b.stage,'command_record',lambda *args:{'exitCode':0}),(b.subprocess,'run',lambda *args,**kwargs:None),
              (b.stage,'external_inventory',lambda:{'synthetic':True}),(b.derived,'compare_software',lambda *args:copy.deepcopy(comparison)),
              (b,'compressed_json',lambda *args:{}),(b,'normalize_verified_timestamps',normalize),
              (b.derived_run,'generate',generation),(b.derived_run,'validate',validation),
              (b.derived_run,'verify_final_inventory',lambda *args:events.append('final-inventory') or {})]:
                stack.enter_context(mock.patch.object(owner,name,value))
            b.main()
        self.assertEqual(events,['timestamp-write','generate','timestamp-write','validate','final-inventory'])


if __name__=='__main__':
    result=unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromTestCase(case) for case in [Metadata,NativeBoundary,Lifecycle]))
    print(json.dumps({'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'skips':len(result.skipped),
                      'dockerCompilerOrUpstreamExecuted':False,'rootOwnershipIsSyntheticMetadataOnly':True}));raise SystemExit(not result.wasSuccessful())
