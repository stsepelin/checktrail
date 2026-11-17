"""Synthetic SDK installation controls; no downloaded interpreter is executed."""
import hashlib,importlib.util,io,json,os,subprocess,tarfile,tempfile,types,unittest
from pathlib import Path
HERE=Path(__file__).parent
spec=importlib.util.spec_from_file_location('sdk',HERE/'install-python-host-sdk.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class Controls(unittest.TestCase):
    def setUp(self):self.temporary=tempfile.TemporaryDirectory();self.root=Path(self.temporary.name).resolve()
    def tearDown(self):self.temporary.cleanup()
    def fixture(self,extra=None):
        archive=self.root/'sdk.tar.gz';binary=b'original inert interpreter';library=b'original inert shared library'
        with tarfile.open(archive,'w:gz') as stream:
            for name in ['bin','lib']:
                item=tarfile.TarInfo(name);item.type=tarfile.DIRTYPE;item.mode=0o755;stream.addfile(item)
            for name,body in [('bin/python3.13',binary),('lib/libpython3.13.so.1.0',library),('setup.sh',b'exit 99 # never execute')]:
                item=tarfile.TarInfo(name);item.mode=0o755;item.size=len(body);stream.addfile(item,io.BytesIO(body))
            item=tarfile.TarInfo('bin/python3');item.type=tarfile.SYMTYPE;item.linkname='python3.13';stream.addfile(item)
            if extra:
                item,body=extra;stream.addfile(item,io.BytesIO(body) if item.isfile() else None)
        manifest={'version':'3.13.5','architecture':'arm64','hostOS':'Ubuntu26.04','producerOS':'Ubuntu24.04','asset':'https://example.invalid/inert','bytes':archive.stat().st_size,'sha256':m.digest(archive),'interpreterSHA256':hashlib.sha256(binary).hexdigest(),'maximumExpandedBytes':1024,'maximumMembers':20}
        return archive,manifest
    def runner(self,calls,change=None,code=0):
        def run(argv,**options):
            target=Path(argv[-1]);calls.append((argv,options))
            self.assertFalse((target.parent/'arm64.complete').exists())
            self.assertEqual(argv[1:4],['-I','-B','-c']);self.assertEqual(argv[4],m.PROBE)
            self.assertEqual(options['env']['LD_LIBRARY_PATH'],str(target/'lib'))
            self.assertNotIn('PYTHONPATH',options['env']);self.assertEqual(options['timeout'],30)
            value={'version':'3.13.5','machine':'aarch64','prefix':str(target),'executable':str(target/'bin/python3.13'),'stdlibControlsPassed':True}
            if change:value.update(change)
            return subprocess.CompletedProcess(argv,code,json.dumps(value),'synthetic linker error' if code else '')
        return run
    def test_original_bytes_and_links_are_published_only_after_valid_native_probe(self):
        archive,manifest=self.fixture();calls=[];cache=self.root/'cache'
        result=m.prepare(archive,cache,manifest,self.runner(calls))
        target=cache/'Python/3.13.5/arm64'
        self.assertEqual((target/'bin/python3.13').read_bytes(),b'original inert interpreter')
        self.assertFalse((target/'setup.sh').exists())
        self.assertEqual((target/'python').resolve(),target/'bin/python3.13')
        self.assertEqual((target/'bin/python313').resolve(),target/'bin/python3.13')
        self.assertTrue((target.parent/'arm64.complete').is_file());self.assertEqual(len(calls),1)
        self.assertFalse(result['upstreamInstallerExecuted']);self.assertFalse(result['pipUpgradeInvoked'])
        self.assertFalse(result['publisherUbuntu26SupportClaimed']);self.assertEqual(result['SDK']['producerOS'],'Ubuntu24.04')
    def test_wrong_digest_refuses_before_install_or_execution(self):
        archive,manifest=self.fixture();calls=[];cache=self.root/'cache';manifest['sha256']='0'*64
        with self.assertRaisesRegex(ValueError,'archive differs'):m.prepare(archive,cache,manifest,self.runner(calls))
        self.assertFalse(cache.exists());self.assertEqual(calls,[])
    def test_traversal_duplicate_link_escape_and_missing_parent_refuse_before_writes(self):
        cases=[]
        item=tarfile.TarInfo('../outside');item.size=1;cases.append((item,b'x'))
        item=tarfile.TarInfo('bin/python3.13');item.size=1;cases.append((item,b'x'))
        item=tarfile.TarInfo('bin/link');item.type=tarfile.SYMTYPE;item.linkname='../../outside';cases.append((item,b''))
        item=tarfile.TarInfo('missing/child');item.size=1;cases.append((item,b'x'))
        for extra in cases:
            archive,manifest=self.fixture(extra);cache=self.root/'cache'
            with self.subTest(name=extra[0].name),self.assertRaises(ValueError):m.prepare(archive,cache,manifest,self.runner([]))
            self.assertFalse(cache.exists())
    def test_member_and_expanded_byte_limits_fail_without_a_complete_marker(self):
        for key,value in [('maximumMembers',2),('maximumExpandedBytes',1)]:
            archive,manifest=self.fixture();manifest[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):m.prepare(archive,self.root/'cache',manifest,self.runner([]))
            self.assertFalse((self.root/'cache').exists())
    def test_native_failure_or_wrong_runtime_rolls_back_owned_install_without_completion(self):
        for change,code in [({},1),({'version':'3.14.0'},0),({'machine':'x86_64'},0),({'prefix':'/another/SDK'},0),({'stdlibControlsPassed':False},0)]:
            archive,manifest=self.fixture();calls=[]
            with self.subTest(change=change),self.assertRaisesRegex(ValueError,'compatibility probe failed|runtime identity'):m.prepare(archive,self.root/'cache',manifest,self.runner(calls,change,code))
            self.assertEqual(len(calls),1)
            self.assertFalse((self.root/'cache/Python/3.13.5/arm64.complete').exists())
            self.assertFalse((self.root/'cache/Python/3.13.5/arm64').exists())
    def test_existing_SDK_or_even_broken_marker_is_never_overwritten(self):
        archive,manifest=self.fixture();parent=self.root/'cache/Python/3.13.5';parent.mkdir(parents=True);marker=parent/'arm64.complete';marker.symlink_to('missing')
        with self.assertRaisesRegex(ValueError,'overwrite'):m.prepare(archive,self.root/'cache',manifest,self.runner([]))
        self.assertTrue(marker.is_symlink())

if __name__=='__main__':unittest.main(verbosity=2)
