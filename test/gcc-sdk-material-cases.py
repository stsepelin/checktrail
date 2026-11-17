"""Synthetic SDK material/difference/scratch controls; no Docker or upstream."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent

def load(path):
    spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

s=load(ROOT/'scripts/producer-qualification/gcc-hosted-stage.py')
m=load(ROOT/'scripts/producer-qualification/gcc-sdk-material.py')
c=load(ROOT/'scripts/producer-qualification/gcc-staged-checkpoint.py')

class Material(unittest.TestCase):
    def fixture(self, root):
        for path in ['usr/bin','usr/include','var/log/apt','var/login','etc']:(root/path).mkdir(parents=True,exist_ok=True)
        for path in ['usr/bin/compiler','usr/include/header.h','var/log/apt/history.log','var/login/material','etc/hosts']:(root/path).write_bytes(b'Synthetic metadata-only file')
        os.symlink('/usr/bin/compiler',root/'usr/bin/compiler-alias')
        return s.external_inventory(root)

    def test_complete_categories_reconcile_without_claiming_root_or_native_identity(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name).resolve();before=self.fixture(root);result=m.compare(before,copy.deepcopy(before),'a'*64,'a'*64)
            self.assertTrue(result['materialProjectionMatches']);self.assertFalse(result['externalSdkReconstructionQualified'])
            self.assertFalse(result['wholeRootIdentityClaimed']);self.assertEqual(result['entries'],sum(result['counts'].values()))
            for path in ['var/log/apt/history.log','etc/hosts']:(root/path).write_bytes(b'Visible incidental difference')
            after=s.external_inventory(root);result=m.compare(before,after,'a'*64,'a'*64)
            self.assertTrue(result['materialProjectionMatches']);self.assertEqual(result['counts']['incidentalDifferences'],2)
            row=next(r for r in after['entries'] if r['path']=='/usr/bin/compiler');row['mtimeNs']+=1
            result=m.compare(before,after,'a'*64,'a'*64);self.assertEqual(result['counts']['timestampOnlyMaterial'],1)
            self.assertFalse(result['timestampNormalizationPerformed'])

    def test_compiler_header_mode_owner_link_unknown_paths_and_package_changes_refuse_projection(self):
        with tempfile.TemporaryDirectory() as name:
            before=self.fixture(Path(name).resolve())
            changes=[('/usr/bin/compiler',{'sha256':'b'*64}),('/usr/include/header.h',{'mode':0o777}),
                     ('/usr/bin/compiler',{'uid':42}),('/usr/bin/compiler-alias',{'target':'/different/SDK'}),
                     ('/var/login/material',{'sha256':'c'*64})]
            for path,fields in changes:
                after=copy.deepcopy(before);next(r for r in after['entries'] if r['path']==path).update(fields)
                result=m.compare(before,after,'a'*64,'a'*64);self.assertFalse(result['materialProjectionMatches'])
                self.assertEqual([r['path'] for r in result['categories']['unresolvedMaterial']],[path])
            self.assertFalse(m.compare(before,before,'a'*64,'b'*64)['materialProjectionMatches'])
            for mutate in [lambda v:v['entries'].append(v['entries'][-1]),lambda v:v['entries'][-1].update(path='/usr/../escape'),
                           lambda v:v.update(logicalBytes=v['logicalBytes']+1),lambda v:v['entries'][-1].update(path='//'),lambda v:v.update(schemaVersion=True),lambda v:v['entries'][0].update(path='/tmp')]:
                changed=copy.deepcopy(before);mutate(changed)
                with self.assertRaises(ValueError):m.compare(before,changed,'a'*64,'a'*64)

    def test_apt_scratch_clone_preserves_bytes_owner_mode_links_ns_times_and_immutable_source(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name).resolve();src=root/'source';dst=root/'scratch';src.mkdir();dst.mkdir();(src/'nested').mkdir()
            (src/'nested/one').write_bytes(b'Synthetic package');os.link(src/'nested/one',src/'nested/two');os.symlink('/inert/missing',src/'link')
            for path in [src/'nested/one',src/'nested',src]:os.utime(path,ns=(1234567890123456789,1234567890123456789))
            (src/'nested/one').chmod(0o640);before=c.snapshot(src,c.Budget())
            result=m.clone_scratch(src,dst,c);self.assertTrue(result['physicalScratchCloneVerified']);self.assertFalse(result['sourceModified'])
            self.assertEqual(before,c.snapshot(src,c.Budget()));self.assertEqual(before,c.snapshot(dst,c.Budget()))
            self.assertEqual((dst/'nested/one').stat().st_ino,(dst/'nested/two').stat().st_ino)
            self.assertEqual(os.readlink(dst/'link'),'/inert/missing')
            with self.assertRaisesRegex(ValueError,'Fresh empty'):m.clone_scratch(src,dst,c)

    def test_special_or_externally_linked_apt_source_cannot_become_scratch(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name).resolve();src=root/'source';dst=root/'scratch';src.mkdir();dst.mkdir();(src/'one').write_bytes(b'Synthetic package')
            os.link(src/'one',root/'outside')
            with self.assertRaisesRegex(ValueError,'External hardlink'):m.clone_scratch(src,dst,c)
            (root/'outside').unlink();os.mkfifo(src/'pipe')
            with self.assertRaisesRegex(ValueError,'special'):m.clone_scratch(src,dst,c)
            self.assertEqual(list(dst.iterdir()),[])

if __name__=='__main__':
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Material))
    print(json.dumps({'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'skips':len(result.skipped),'dockerCompilerOrUpstreamExecuted':False}));raise SystemExit(not result.wasSuccessful())
