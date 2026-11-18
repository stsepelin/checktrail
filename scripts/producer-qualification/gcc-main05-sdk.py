"""Fixed data handoff from actual original-SDK regeneration to main05.

No SDK tool, source target, image action or cache operation is executed. Original
software identities remain bound to the configure checkpoint; freshly generated
cache/format bodies are separately bound to the actual final native validators.
"""
import gzip
import hashlib
import importlib.util
import json
import shutil
import tempfile
from pathlib import Path


def load(name):
    path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


h=load('gcc-hosted-carrier.py')
stage=load('gcc-hosted-stage.py')
codec=load('gcc-staged-checkpoint.py')
d=load('gcc-sdk-derived.py')
r=load('gcc-sdk-derived-run.py')
require=h.require
MAX_EXPANDED=256*1024**2
MAX_COMPRESSED=32*1024**2
FILES={'PREPARED-SDK-INVENTORY.json.gz':'sdk-observed-after.json.gz',
       'PREPARED-SDK-RECONSTRUCTION.json':'SDK-RECONSTRUCTION.json',
       'PREPARED-SDK-GENERATION.json':'SDK-DERIVED-GENERATION.json',
       'PREPARED-SDK-VALIDATION.json':'SDK-DERIVED-VALIDATION.json'}


def bounded_json(path,maximum=1024**2):
    h.digest_file(path,maximum=maximum)
    return json.loads(path.read_bytes())


def inventory(path,pin):
    require(h.digest_file(path,maximum=MAX_COMPRESSED)=={key:pin[key] for key in ['bytes','sha256']},
            'Prepared SDK compressed inventory differs')
    raw=bytearray()
    with gzip.open(path,'rb') as stream:
        while True:
            chunk=stream.read(65536)
            if not chunk:break
            require(len(raw)+len(chunk)<=MAX_EXPANDED,'Prepared SDK expanded inventory bound')
            raw.extend(chunk)
    require(len(raw)==pin['expandedBytes'] and hashlib.sha256(raw).hexdigest()==pin['expandedSha256'],
            'Prepared SDK expanded inventory differs')
    return json.loads(raw)


def zero_commands(rows,commands):
    require(len(rows)==len(commands) and [row['command'] for row in rows]==commands and
            all(type(row['exitCode']) is int and row['exitCode']==0 and row['signal'] is None and
                row['terminalObserved'] is True and row['stdoutComplete'] is True for row in rows),
            'Complete exact native SDK command terminal witnesses required')


def inspect(original,current,root,proof,generation,validation):
    require(hashlib.sha256(stage.canonical(original)).hexdigest()==root['externalSdkSha256'],
            'Original configure SDK baseline differs')
    packages=root['binding']['packageInventorySha256']
    require(proof['state']=='sdk-material-reconstructed-and-physically-verified' and proof['packageInventoryMatches'] is True and
            proof['generatedStatePhysicallyValidated'] is True and proof['allTimestampWritesPrecededFinalValidators'] is True and
            proof['softwareAndGeneratedStateContract']==d.POLICY and proof['historicalCacheBodyEqualityClaimed'] is False and
            proof['originalGccTargetInvoked'] is False and proof['originalPhaseAdvanced'] is False,
            'Actual full original SDK software/generated-state reconstruction missing')
    comparison=d.compare_software(original,current,packages,packages)
    require(comparison['materialProjectionMatches'] and not comparison['categories']['timestampOnlyMaterial'],
            'Prepared compiler/header/library/font/script/configuration identities differ from the original SDK')
    require(generation['state']=='derived-sdk-outputs-generated-not-yet-finally-validated' and
            generation['originalPackageManifestSha256']==packages and generation['historicalCacheBodiesCopiedOrExamined'] is False and
            len(generation['removedOwnedFreshOutputs'])==51 and set(generation['removedOwnedFreshOutputs'])==set(d.KNOWN_MODES) and
            set(generation['newlyGeneratedOutputs'])=={entry['outputPath'] for entry in r.FORMAT_MAP.values()} and
            all(d.typed_pair(path,row,row) for path,row in generation['newlyGeneratedOutputs'].items()),
            'Complete51-output absence and fresh13-format witnesses missing')
    require(set(generation['toolIdentities'])==set(r.KNOWN_PROGRAMS) and set(generation['effectiveMapping'])==set(r.FORMAT_MAP),
            'All original generator/validator and effective-format identities required')
    original_rows=d.material.inventory(original)
    for requested,identity in generation['toolIdentities'].items():
        leaf,_=r.expected_leaf(requested,original_rows)
        require(identity['physicalCode']==original_rows[leaf] and identity['originalPackageOwners'] and identity['observedOwners'],
                'Original physical generator code/package witness differs')
    for name,entry in r.FORMAT_MAP.items():
        actual=generation['effectiveMapping'][name]
        require(actual['engine']==entry['configuredEngine'] and actual['hyphen']==entry['hyphenInput'] and
                actual['arguments'].split()==entry['generatorArguments'] and actual['outputPath']==entry['outputPath'],
                'Original effective format-to-engine mapping differs')
    generators=[['/usr/bin/fc-cache','--force','--system-only'],['/usr/sbin/ldconfig','--ignore-aux-cache']]
    generators += [['/usr/bin/fmtutil-sys','--byfmt',name] for name in sorted(r.FORMAT_MAP)]
    generators += [['/usr/bin/updmap-sys'],['/usr/bin/mktexlsr','/var/lib/texmf']]
    zero_commands(generation['generatorCommands'],generators)
    validators=[['/usr/bin/fc-list','--format=%{file}\\n']]
    validators += [['/usr/bin/fc-cat',path] for path in d.KNOWN_MODES if path.startswith('/var/cache/fontconfig/')]
    validators += [['/usr/sbin/ldconfig','--print-cache']]
    validators += [['/usr/bin/kpsewhich','--engine='+entry['lookupEngine'],'--format='+('base' if entry['extension']=='.base' else 'fmt'),
                    Path(entry['outputPath']).name] for _,entry in sorted(r.FORMAT_MAP.items())]
    zero_commands([row['command'] for row in validation['validators']],validators)
    require(validation['timestampWritesAfterValidation'] is False and validation['historicalCacheBodyEqualityClaimed'] is False,
            'Final SDK validation ordering/scope differs')
    final=r.verify_final_inventory(current,validation)
    require(proof['finalValidatedStateWitness']==final,'Retained SDK reconstruction witness differs from the actual validator identities')
    original_projection=d.software_projection(original,packages);current_projection=d.software_projection(current,packages)
    require(original_projection==current_projection,'Prepared original software/time projection differs')
    return {'inventory':current,'softwareProjection':current_projection,'finalGeneratedWitness':final,
            'originalSdkBaselineSha256':root['externalSdkSha256'],'packageInventorySha256':packages,
            'historicalCacheBodyEqualityClaimed':False,'originalGccTargetInvoked':False,'gateAComplete':False}


def stage_metadata(sdk_frame,controls,root):
    h.physical(sdk_frame);h.physical(controls)
    require(sdk_frame.is_dir() and controls.is_dir(),'Physical owned SDK/native control directories required')
    observation=sdk_frame/'observations';proof=bounded_json(observation/'SDK-RECONSTRUCTION.json')
    generation=bounded_json(observation/'SDK-DERIVED-GENERATION.json');validation=bounded_json(observation/'SDK-DERIVED-VALIDATION.json')
    current=inventory(observation/'sdk-observed-after.json.gz',proof['observedAfter'])
    original=bounded_json(sdk_frame/'predecessor/__carrier_work/external-sdk-before.json',256*1024**2)
    verified=inspect(original,current,root,proof,generation,validation)
    members={name:h.digest_file(observation/source,maximum=32*1024**2) for name,source in FILES.items()}
    destination=controls/'prepared-sdk'
    require(not destination.exists() and not destination.is_symlink(),'Fresh complete prepared SDK metadata directory required')
    manifest={'schemaVersion':1,'originalSdkBaselineSha256':root['externalSdkSha256'],
              'packageInventorySha256':root['binding']['packageInventorySha256'],'members':members,
              'softwareProjection':verified['softwareProjection'],'historicalCacheBodyEqualityClaimed':False,'gateAComplete':False}
    staging=Path(tempfile.mkdtemp(prefix='.prepared-sdk-',dir=controls))
    try:
        for name,source in FILES.items():h.copy_pinned(observation/source,staging/name,members[name])
        (staging/'PREPARED-SDK-MANIFEST.json').write_bytes(codec.canonical(manifest))
        # No incomplete family of source/validation metadata becomes a valid
        # native input. Publish the closed directory in one no-replace rename.
        codec.rename_no_replace(staging,destination)
    finally:
        if staging.exists():shutil.rmtree(staging)
    return manifest


def read_prepared(controls,original,root):
    controls=controls/'prepared-sdk'
    h.physical(controls)
    require(controls.is_dir() and set(path.name for path in controls.iterdir())=={*FILES,'PREPARED-SDK-MANIFEST.json'},
            'Closed complete prepared SDK metadata directory required')
    manifest=bounded_json(controls/'PREPARED-SDK-MANIFEST.json')
    require(manifest['originalSdkBaselineSha256']==root['externalSdkSha256'] and
            manifest['packageInventorySha256']==root['binding']['packageInventorySha256'] and set(manifest['members'])==set(FILES),
            'Prepared SDK metadata source binding differs')
    for name,pin in manifest['members'].items():
        require(h.digest_file(controls/name,maximum=32*1024**2)==pin,'Prepared SDK control bytes differ')
    proof=bounded_json(controls/'PREPARED-SDK-RECONSTRUCTION.json')
    generation=bounded_json(controls/'PREPARED-SDK-GENERATION.json');validation=bounded_json(controls/'PREPARED-SDK-VALIDATION.json')
    current=inventory(controls/'PREPARED-SDK-INVENTORY.json.gz',proof['observedAfter'])
    verified=inspect(original,current,root,proof,generation,validation)
    require(verified['softwareProjection']==manifest['softwareProjection'],'Prepared SDK software projection handoff differs')
    return verified
