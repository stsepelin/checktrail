"""Synthetic metadata/physical atomic handoff only; no native producer execution."""
import copy
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('main05_sdk',ROOT/'scripts/producer-qualification/gcc-main05-sdk.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
fixture_spec=importlib.util.spec_from_file_location('derived_fixtures',ROOT/'test/gcc-sdk-derived-cases.py')
fixtures=importlib.util.module_from_spec(fixture_spec);fixture_spec.loader.exec_module(fixtures)


def fixture(root):
    original,current=fixtures.fixture(root/'synthetic-sdk')
    for program in m.r.KNOWN_PROGRAMS:
        path=root/'synthetic-sdk'/program.lstrip('/');path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'Synthetic generator');path.chmod(0o755)
    # Rerender ordinary metadata with all18 synthetic programs, preserving the
    # explicit fake root ownership of generated DATA (not actual native files).
    original=m.stage.external_inventory(root/'synthetic-sdk')
    for row in original['entries']:
        if row['path'] in m.d.KNOWN_MODES:row.update(uid=0,gid=0)
    current=copy.deepcopy(original)
    for row in current['entries']:
        if row['path'] in m.d.KNOWN_MODES:row.update(sha256=hashlib.sha256(b'Synthetic fresh output').hexdigest(),bytes=22,mtimeNs=row['mtimeNs']+1)
    current['logicalBytes']=sum(row['bytes'] for row in current['entries'] if row['kind']=='file')
    before=m.d.material.inventory(original);after=m.d.material.inventory(current)
    root_binding={'externalSdkSha256':hashlib.sha256(m.stage.canonical(original)).hexdigest(),'binding':{'packageInventorySha256':'a'*64}}
    def terminal(command):return {'command':command,'exitCode':0,'signal':None,'terminalObserved':True,'stdoutComplete':True}
    generators=[['/usr/bin/fc-cache','--force','--system-only'],['/usr/sbin/ldconfig','--ignore-aux-cache']]
    generators += [['/usr/bin/fmtutil-sys','--byfmt',name] for name in sorted(m.r.FORMAT_MAP)]
    generators += [['/usr/bin/updmap-sys'],['/usr/bin/mktexlsr','/var/lib/texmf']]
    validators=[['/usr/bin/fc-list','--format=%{file}\\n']]
    validators += [['/usr/bin/fc-cat',path] for path in m.d.KNOWN_MODES if path.startswith('/var/cache/fontconfig/')]
    validators += [['/usr/sbin/ldconfig','--print-cache']]
    validators += [['/usr/bin/kpsewhich','--engine='+entry['lookupEngine'],'--format='+('base' if entry['extension']=='.base' else 'fmt'),
                    Path(entry['outputPath']).name] for _,entry in sorted(m.r.FORMAT_MAP.items())]
    validation={'state':'derived-sdk-outputs-finally-validated','actualAll13FreshFormatsValidated':True,
                'finalGeneratedIdentities':{path:after[path] for path in m.d.KNOWN_MODES},
                'validators':[{'command':terminal(command)} for command in validators],
                'timestampWritesAfterValidation':False,'historicalCacheBodyEqualityClaimed':False}
    generation={'state':'derived-sdk-outputs-generated-not-yet-finally-validated','originalPackageManifestSha256':'a'*64,
                'historicalCacheBodiesCopiedOrExamined':False,'removedOwnedFreshOutputs':list(m.d.KNOWN_MODES),
                'newlyGeneratedOutputs':{entry['outputPath']:after[entry['outputPath']] for entry in m.r.FORMAT_MAP.values()},
                'toolIdentities':{path:{'physicalCode':before[path],'originalPackageOwners':[{'package':'synthetic'}],
                                      'observedOwners':[['synthetic','all']]} for path in m.r.KNOWN_PROGRAMS},
                'effectiveMapping':{name:{'engine':entry['configuredEngine'],'hyphen':entry['hyphenInput'],
                                         'arguments':' '.join(entry['generatorArguments']),'outputPath':entry['outputPath']}
                                    for name,entry in m.r.FORMAT_MAP.items()},'generatorCommands':[terminal(command) for command in generators]}
    raw=m.stage.canonical(current);compressed=gzip.compress(raw,mtime=0)
    inventory_pin={'bytes':len(compressed),'sha256':hashlib.sha256(compressed).hexdigest(),'expandedBytes':len(raw),'expandedSha256':hashlib.sha256(raw).hexdigest()}
    proof={'state':'sdk-material-reconstructed-and-physically-verified','packageInventoryMatches':True,'generatedStatePhysicallyValidated':True,
           'allTimestampWritesPrecededFinalValidators':True,'softwareAndGeneratedStateContract':m.d.POLICY,'historicalCacheBodyEqualityClaimed':False,
           'originalGccTargetInvoked':False,'originalPhaseAdvanced':False,'finalValidatedStateWitness':m.r.verify_final_inventory(current,validation),
           'observedAfter':inventory_pin}
    return original,current,root_binding,proof,generation,validation,compressed


class SdkHandoff(unittest.TestCase):
    def data(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);root=Path(temp.name).resolve();return root,fixture(root)

    def test_original_software_and_current_validated_generated_state_are_distinct_exact_bindings(self):
        _,values=self.data();result=m.inspect(*values[:6]);self.assertEqual(result['inventory'],values[1])
        self.assertEqual(result['softwareProjection'],m.d.software_projection(values[0],'a'*64))
        self.assertFalse(result['historicalCacheBodyEqualityClaimed']);self.assertFalse(result['originalGccTargetInvoked']);self.assertFalse(result['gateAComplete'])
        self.assertNotEqual(values[0],values[1]);self.assertTrue(m.d.compare_software(values[0],values[1],'a'*64,'a'*64)['materialProjectionMatches'])

    def test_missing_partial_wrong_engine_nonzero_or_late_write_witnesses_refuse(self):
        _,values=self.data()
        for kind in ['missing-format','missing-tool','wrong-engine','nonzero','false-terminal','missing-validator','late-write','old-body-claim','wrong-mode']:
            args=copy.deepcopy(values[:6]);generation,validation=args[4:6]
            if kind=='missing-format':generation['newlyGeneratedOutputs'].pop(next(iter(generation['newlyGeneratedOutputs'])))
            if kind=='missing-tool':generation['toolIdentities'].pop('/usr/bin/fc-list')
            if kind=='wrong-engine':generation['effectiveMapping']['mf']['engine']='mf'
            if kind=='nonzero':generation['generatorCommands'][0]['exitCode']=1
            if kind=='false-terminal':generation['generatorCommands'][0]['exitCode']=False
            if kind=='missing-validator':validation['validators'].pop()
            if kind=='late-write':validation['timestampWritesAfterValidation']=True
            if kind=='old-body-claim':args[3]['historicalCacheBodyEqualityClaimed']=True
            if kind=='wrong-mode':next(iter(validation['finalGeneratedIdentities'].values()))['mode']=0o777
            with self.subTest(kind=kind),self.assertRaises(ValueError):m.inspect(*args)

    def test_original_compiler_header_font_script_and_dependency_times_cannot_be_waived(self):
        _,values=self.data()
        for path in ['/usr/bin/compiler','/usr/include/api.h','/usr/share/fonts/synthetic.otf','/usr/bin/fc-list']:
            args=copy.deepcopy(values[:6]);next(row for row in args[1]['entries'] if row['path']==path)['sha256']='f'*64
            with self.subTest(path=path),self.assertRaisesRegex(ValueError,'identities differ'):m.inspect(*args)
        args=copy.deepcopy(values[:6]);next(row for row in args[1]['entries'] if row['path']=='/usr/include/api.h')['mtimeNs']+=1
        with self.assertRaisesRegex(ValueError,'identities differ'):m.inspect(*args)

    def write_source(self,root,values):
        sdk=root/'sdk-frame';observations=sdk/'observations';observations.mkdir(parents=True)
        (sdk/'predecessor/__carrier_work').mkdir(parents=True);(sdk/'predecessor/__carrier_work/external-sdk-before.json').write_bytes(m.stage.canonical(values[0]))
        for name,value in [('SDK-RECONSTRUCTION.json',values[3]),('SDK-DERIVED-GENERATION.json',values[4]),('SDK-DERIVED-VALIDATION.json',values[5])]:
            (observations/name).write_text(json.dumps(value))
        (observations/'sdk-observed-after.json.gz').write_bytes(values[6]);controls=root/'controls';controls.mkdir()
        return sdk,controls

    def test_atomic_closed_metadata_family_roundtrips_and_modified_member_refuses(self):
        root,values=self.data();sdk,controls=self.write_source(root,values)
        manifest=m.stage_metadata(sdk,controls,values[2]);self.assertEqual(set(manifest['members']),set(m.FILES))
        result=m.read_prepared(controls,values[0],values[2]);self.assertEqual(result['inventory'],values[1])
        self.assertEqual(sorted(path.name for path in controls.iterdir()),['prepared-sdk'])
        (controls/'prepared-sdk/PREPARED-SDK-GENERATION.json').write_bytes(b'Synthetic altered witness')
        with self.assertRaisesRegex(ValueError,'control bytes differ'):m.read_prepared(controls,values[0],values[2])
        with self.assertRaisesRegex(ValueError,'Fresh complete'):m.stage_metadata(sdk,controls,values[2])

    def test_interrupted_copy_never_publishes_partial_family_or_overwrites_existing_data(self):
        root,values=self.data();sdk,controls=self.write_source(root,values);actual=m.h.copy_pinned;calls=[0]
        def copy(source,target,pin):
            calls[0]+=1
            if calls[0]==3:raise OSError('Synthetic failed third metadata copy')
            return actual(source,target,pin)
        with mock.patch.object(m.h,'copy_pinned',side_effect=copy):
            with self.assertRaisesRegex(OSError,'third metadata copy'):m.stage_metadata(sdk,controls,values[2])
        self.assertEqual(list(controls.iterdir()),[])
        m.stage_metadata(sdk,controls,values[2]);before=(controls/'prepared-sdk/PREPARED-SDK-MANIFEST.json').read_bytes()
        with self.assertRaisesRegex(ValueError,'Fresh complete'):m.stage_metadata(sdk,controls,values[2])
        self.assertEqual((controls/'prepared-sdk/PREPARED-SDK-MANIFEST.json').read_bytes(),before)

    def test_gzip_roundtrip_hash_size_corruption_and_reached_expansion_bound_refuse(self):
        root,values=self.data();path=root/'metadata.gz';path.write_bytes(values[6]);pin=values[3]['observedAfter']
        self.assertEqual(m.inventory(path,pin),values[1])
        with mock.patch.object(m,'MAX_EXPANDED',pin['expandedBytes']):self.assertEqual(m.inventory(path,pin),values[1])
        with mock.patch.object(m,'MAX_EXPANDED',pin['expandedBytes']-1):
            with self.assertRaisesRegex(ValueError,'expanded inventory bound'):m.inventory(path,pin)
        for change in [{'expandedSha256':'f'*64},{'expandedBytes':pin['expandedBytes']+1},{'sha256':'f'*64}]:
            with self.subTest(change=change),self.assertRaises(ValueError):m.inventory(path,{**pin,**change})
        path.write_bytes(values[6][:-2]);changed={**pin,'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
        with self.assertRaises((EOFError,OSError,ValueError)):m.inventory(path,changed)


if __name__=='__main__':unittest.main(verbosity=2)
