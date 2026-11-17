"""Fixed original offline SDK reprovision; no GCC source target is executed.

The hosted controller supplies only physically authenticated predecessor state
read-only and the pinned original input catalog. Importing this module is inert.
"""
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys


def load(path):
    spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


HERE=Path(__file__).resolve().parent
stage=load(HERE/'gcc-hosted-stage.py')
material=load(HERE/'gcc-sdk-material.py')
codec=load(HERE/'gcc-staged-checkpoint.py')


def compressed_json(path, value):
    raw=stage.canonical(value)
    stage.require(len(raw)<=256*1024**2, 'SDK metadata uncompressed bound')
    with path.open('xb') as sink:
        with gzip.GzipFile(fileobj=sink, mode='wb', compresslevel=1, mtime=0) as stream:
            stream.write(raw)
    stage.require(path.stat().st_size<=32*1024**2, 'SDK metadata compressed bound')
    return {'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
            'expandedBytes':len(raw),'expandedSha256':hashlib.sha256(raw).hexdigest()}


def normalize_verified_timestamps(expected, observed, comparison):
    stage.require(comparison['materialProjectionMatches'], 'Unresolved SDK material cannot be normalized')
    expected_rows=material.inventory(expected)
    # Match a fresh physical inventory immediately before any timestamp write.
    stage.require(stage.external_inventory()==observed, 'SDK state changed before timestamp normalization')
    rows=comparison['categories']['timestampOnlyMaterial']
    for row in sorted(rows,key=lambda item:len(Path(item['path']).parts),reverse=True):
        codec.set_metadata(Path(row['path']),expected_rows[row['path']])
    after=stage.external_inventory()
    final=material.compare(expected,after,comparison['expectedPackageInventorySha256'],
                           comparison['observedPackageInventorySha256'])
    stage.require(final['materialProjectionMatches'] and not final['categories']['timestampOnlyMaterial'],
                  'SDK material did not physically match after timestamp normalization')
    return after,final


def main():
    stage.require(sys.argv==[sys.argv[0],'sdk-reconstruct'], 'Unknown fixed SDK reconstruction goal')
    stage.require(os.getuid()==0 and all(os.environ.get(k)==v for k,v in stage.FIXED_ENVIRONMENT.items()) and
                  set(os.environ)<=set(stage.FIXED_ENVIRONMENT)|{'PWD','SHLVL','_'}, 'Original SDK operator environment changed')
    output=Path('/controller/observations');stage.require(output.is_dir() and not output.is_symlink(), 'SDK observation mount missing')
    predecessor=Path('/inputs/predecessor');expected_root=json.loads((HERE/'EXPECTED-PREDECESSOR-ROOT.json').read_bytes())
    expected=json.loads((predecessor/'__carrier_work/external-sdk-before.json').read_bytes())
    stage.require(hashlib.sha256(stage.canonical(expected)).hexdigest()==expected_root['externalSdkSha256'],
                  'Predecessor SDK inventory binding differs')
    packages=(predecessor/'__carrier_work/installed-build-package-identities.txt').read_bytes()
    expected_packages=hashlib.sha256(packages).hexdigest()
    stage.require(expected_packages==expected_root['binding']['packageInventorySha256'], 'Predecessor package inventory differs')
    stores=[(predecessor/relative,Path(target)) for relative,target in
            [('__carrier_apt_lists','/var/lib/apt/lists'),('__carrier_apt_archives','/var/cache/apt/archives')]]
    # Resolve both read and write targets before populating either store.
    for source,target in stores:
        stage.require(target.is_dir() and not target.is_symlink() and not any(target.iterdir()),
                      'Both SDK scratch stores must be fresh before either copy')
        codec.snapshot(source,codec.Budget({'treeBytes':1024**3,'entries':10000,'seconds':180,'memberBytes':1024**3}))
    clones=[material.clone_scratch(source,target,codec) for source,target in stores]
    work=Path('/work');(work/'home').mkdir(mode=0o700,exist_ok=True)
    records=output/'sdk-commands.jsonl'
    apt=['apt-get','-o','APT::Get::AllowUnauthenticated=false','-o',
         'Acquire::AllowInsecureRepositories=false','-o','Acquire::AllowDowngradeToInsecureRepositories=false',
         '-o','Acquire::Check-Valid-Until=true','-o','Dir::Cache::archives=/var/cache/apt/archives/gcc-12',
         '--yes','--no-download','--no-install-recommends','build-dep',
         '/inputs/gcc-12/gcc-12_12.2.0-14+deb12u1.dsc']
    terminal=stage.command_record(apt,work,records,'original-offline-sdk-build-dep')
    package_path=output/'installed-package-identities.txt'
    with package_path.open('xb') as sink:
        subprocess.run(['dpkg-query','-W','-f=${Package}\t${Version}\t${Architecture}\n'],stdout=sink,check=True)
    observed_packages=hashlib.sha256(package_path.read_bytes()).hexdigest()
    observed=stage.external_inventory()
    comparison=material.compare(expected,observed,expected_packages,observed_packages)
    comparison.update(expectedPackageInventorySha256=expected_packages,observedPackageInventorySha256=observed_packages)
    before_pin=compressed_json(output/'sdk-observed-before.json.gz',observed)
    comparison_pin=compressed_json(output/'sdk-comparison-before.json.gz',comparison)
    result={'schemaVersion':1,'state':'sdk-material-reconstruction-unqualified','scratchClones':clones,
            'preparation':terminal,'observedInventory':before_pin,'comparison':comparison_pin,
            'comparisonCounts':comparison['counts'],'packageInventoryMatches':comparison['installedPackageInventoryMatches'],
            'sourceCheckpointMountedReadOnly':True,'originalGccTargetInvoked':False,'originalPhaseAdvanced':False,
            'wholeRootIdentityClaimed':False,'fullCompilerSdkBootstrapClosureVerified':False,'gateAComplete':False}
    (output/'SDK-RECONSTRUCTION.json').write_bytes(stage.canonical(result)+b'\n')
    stage.require(comparison['materialProjectionMatches'], 'SDK material differences require explicit review; no GCC target allowed')
    after,final=normalize_verified_timestamps(expected,observed,comparison)
    after_pin=compressed_json(output/'sdk-observed-after.json.gz',after)
    final_pin=compressed_json(output/'sdk-comparison-after.json.gz',final)
    result.update(state='sdk-material-reconstructed-and-physically-verified',observedAfter=after_pin,comparisonAfter=final_pin,
                  normalizedTimestampPaths=[r['path'] for r in comparison['categories']['timestampOnlyMaterial']],
                  sdkMaterialReconstructionObserved=True)
    (output/'SDK-RECONSTRUCTION.json').write_bytes(stage.canonical(result)+b'\n')


if __name__=='__main__':main()
