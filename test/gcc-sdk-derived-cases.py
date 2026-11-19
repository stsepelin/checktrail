"""Synthetic metadata only. Fake root ownership is explicit; no native authority."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parent.parent

def load(path):
    spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


m=load(ROOT/'scripts/producer-qualification/gcc-sdk-derived.py')
stage=load(ROOT/'scripts/producer-qualification/gcc-hosted-stage.py')


def fixture(root):
    for relative,body in [('usr/bin/compiler',b'Synthetic compiler'),('usr/bin/fc-cache',b'Synthetic generator'),('usr/include/api.h',b'Synthetic header'),
                          ('usr/lib/libsynthetic.so',b'Synthetic library'),('etc/fonts/config',b'Synthetic font config'),
                          ('usr/share/fonts/synthetic.otf',b'Synthetic font'),('var/log/apt/history.log',b'Synthetic old log')]:
        path=root/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(body)
    for path in m.KNOWN_MODES:
        target=root/path.lstrip('/');target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(b'Synthetic generated state')
        target.chmod(m.KNOWN_MODES[path])
    expected=stage.external_inventory(root)
    # These are DATA fixtures, not an assertion that a Mac temp file is root
    # owned or that a native SDK was rebuilt. The policy's fixed root contract
    # is exercised by synthetic metadata independent of current test UID.
    for row in expected['entries']:
        if row['path'] in m.KNOWN_MODES:row.update(uid=0,gid=0)
    observed=copy.deepcopy(expected)
    for row in observed['entries']:
        if row['path'] in m.KNOWN_MODES:row.update(sha256=hashlib.sha256(b'Synthetic fresh generated state').hexdigest(),bytes=len(b'Synthetic fresh generated state'),mtimeNs=row['mtimeNs']+1000000000)
        if row['path']=='/var/log/apt/history.log':row['sha256']=hashlib.sha256(b'Synthetic fresh log').hexdigest()
    observed['logicalBytes']=sum(row['bytes'] for row in observed['entries'] if row['kind']=='file')
    return expected,observed


class Derived(unittest.TestCase):
    def data(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        return fixture(Path(temporary.name).resolve())

    def compare(self,expected,observed,**kw):return m.compare_software(expected,observed,kw.get('expected_pkg','a'*64),kw.get('observed_pkg','a'*64))

    def test_exact51_files_allow_only_a_data_projection_never_sdk_or_execution_credit(self):
        before,after=self.data();result=self.compare(before,after)
        self.assertTrue(result['materialProjectionMatches']);self.assertTrue(result['completeGeneratedInventory'])
        self.assertEqual(result['counts']['generatedState'],51);self.assertEqual(result['counts']['unresolvedMaterial'],0)
        self.assertEqual(sum(result['counts'].values()),result['entries'])
        self.assertFalse(result['requiredGeneratorWitnessesComplete']);self.assertFalse(result['actualPhysicalGeneratorWitnessAssessed'])
        self.assertFalse(result['externalSdkReconstructionQualified']);self.assertFalse(result['gateAComplete'])
        self.assertFalse(result['historicalGeneratedBodyIdentityClaimed'])
        self.assertEqual(m.software_projection(before,'a'*64),m.software_projection(after,'a'*64))

    def test_compiler_header_library_config_font_and_generator_bytes_remain_material(self):
        for path in ['/usr/bin/compiler','/usr/bin/fc-cache','/usr/include/api.h','/usr/lib/libsynthetic.so','/etc/fonts/config','/usr/share/fonts/synthetic.otf']:
            before,after=self.data();row=next(row for row in after['entries'] if row['path']==path);row['sha256']='f'*64
            result=self.compare(before,after)
            with self.subTest(path=path):
                self.assertFalse(result['materialProjectionMatches']);self.assertEqual(result['counts']['unresolvedMaterial'],1)
                self.assertNotEqual(m.software_projection(before,'a'*64)['sha256'],m.software_projection(after,'a'*64)['sha256'])

    def test_actual_file_type_owner_mode_zero_and_oversized_boundaries(self):
        path=next(iter(m.KNOWN_MODES));before,after=self.data()
        for changes in [{'uid':1},{'gid':1},{'mode':0o755},{'bytes':0},{'bytes':m.MEMBER_LIMIT+1}]:
            changed=copy.deepcopy(after);row=next(row for row in changed['entries'] if row['path']==path);row.update(changes)
            changed['logicalBytes']=sum(row['bytes'] for row in changed['entries'] if row['kind']=='file')
            result=self.compare(before,changed)
            with self.subTest(changes=changes):self.assertFalse(result['materialProjectionMatches']);self.assertEqual(result['counts']['unresolvedMaterial'],1)
        a=next(row for row in before['entries'] if row['path']==path)
        for changes in [{'uid':False},{'mode':True},{'bytes':True},{'kind':'symlink','target':'/usr/bin/compiler'}]:
            self.assertFalse(m.typed_pair(path,a,{**a,**changes}))

    def test_nearby_paths_unknown_cache_names_and_extra_files_are_not_waived(self):
        candidates=['/var/cache/fontconfig/'+'0'*32+'-le64.cache-8','/var/lib/texmf/web2c/pdftex/latex.fmt.backup',
                    '/var/lib/texmf/web2c/pdftex/unknown.fmt','/var/cache/ldconfig/aux-cache.py']
        before,after=self.data();template=next(row for row in after['entries'] if row['path'] in m.KNOWN_MODES)
        for path in candidates:
            self.assertNotIn(path,m.KNOWN_MODES);changed=copy.deepcopy(after);changed['entries'].append({**template,'path':path})
            changed['logicalBytes']+=template['bytes'];result=self.compare(before,changed)
            with self.subTest(path=path):self.assertFalse(result['materialProjectionMatches']);self.assertEqual(result['counts']['unresolvedMaterial'],1)

    def test_missing_both_and_partial_output_cannot_turn_into_empty_success(self):
        before,after=self.data();path=next(iter(m.KNOWN_MODES))
        for both in [False,True]:
            a,b=copy.deepcopy(before),copy.deepcopy(after)
            b['entries']=[row for row in b['entries'] if row['path']!=path]
            if both:a['entries']=[row for row in a['entries'] if row['path']!=path]
            for value in [a,b]:value['logicalBytes']=sum(row['bytes'] for row in value['entries'] if row['kind']=='file')
            result=self.compare(a,b)
            with self.subTest(both=both):
                self.assertFalse(result['materialProjectionMatches']);self.assertFalse(result['completeGeneratedInventory'])
                self.assertEqual(result['counts']['generatedState'],50);self.assertEqual(sum(result['counts'].values()),result['entries'])

    def test_package_change_and_cumulative_growth_refuse(self):
        before,after=self.data();self.assertFalse(self.compare(before,after,observed_pkg='b'*64)['materialProjectionMatches'])
        changed=copy.deepcopy(after)
        for row in changed['entries']:
            if row['path'] in m.KNOWN_MODES:row['bytes']=m.MEMBER_LIMIT
        changed['logicalBytes']=sum(row['bytes'] for row in changed['entries'] if row['kind']=='file')
        result=self.compare(before,changed);self.assertFalse(result['materialProjectionMatches'])
        self.assertGreater(result['generatedBytes']['observed'],m.AGGREGATE_LIMIT)

    def test_unchanged_generated_hash_still_requires_physical_generation_witness(self):
        before,_=self.data();result=self.compare(before,before)
        self.assertTrue(result['materialProjectionMatches']);self.assertEqual(result['counts']['generatedState'],51)
        self.assertFalse(result['requiredGeneratorWitnessesComplete']);self.assertFalse(result['externalSdkReconstructionQualified'])


if __name__=='__main__':
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Derived))
    print(json.dumps({'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'skips':len(result.skipped),'dockerCompilerOrUpstreamExecuted':False}));raise SystemExit(not result.wasSuccessful())
