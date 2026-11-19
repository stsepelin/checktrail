"""Fixed original main-bootstrap body for a separately reviewed prepared SDK.

Import is inert. This body has no image acquisition, SDK installer, cache action,
phase-success authority or caller-selected target. The hosted carrier must first
physically reconstruct the original SDK and restore the independent predecessor.
"""
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import stat
import subprocess
import sys


def load(name):
    path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


stage=load('gcc-hosted-stage.py')
codec=load('gcc-staged-checkpoint.py')
planner=load('gcc-staged-plan.py')
material=load('gcc-sdk-material.py')
sdk=load('gcc-sdk-reconstruct.py')
prepared_sdk=load('gcc-main05-sdk.py')
require=stage.require
COMMAND=['dpkg-buildpackage','-b','-us','-uc','--jobs=4','--rules-file=/controller/gcc-staged-rules2.sh',
         '--rules-target=stamps/05-build-stamp']
PREDECESSOR_SHA='3eff87d27334ddc28ea76b49cd59f0bc6e7d02b108d4a66bb8c7194e8e32dbbf'
PREDECESSOR_MANIFEST_SHA='aeacd92ddbfed4c327fdbbf2faf95459f77fb7f9fdef3d10c2680e20659d3390'


def command_terminal(records,source):
    require(records.is_file() and not records.is_symlink() and records.stat().st_size<=65536,
            'Bounded original main05 command record required')
    rows=[json.loads(raw) for raw in records.read_bytes().splitlines()]
    require(len(rows)==2 and rows[0]['state']=='requested' and rows[1]['state']=='terminal' and
            all(row['command']==COMMAND and row['label']=='original-main05' and row['cwd']==str(source) for row in rows),
            'Exact original main05 request/terminal pair required')
    row=rows[1];elapsed=row['elapsedSeconds'];code=row['exitCode'];signal=row['signal']
    require(row['terminalObserved'] is True and type(elapsed) in [int,float] and math.isfinite(elapsed) and elapsed>=0 and
            ((type(code) is int and 0<=code<=255 and signal is None) or
             (code is None and type(signal) is int and 0<signal<128)),
            'Original main05 terminal exit/signal/duration differs')
    return row


def predecessor(state,root,ledger):
    require(root['binding']['phase']=='configure' and root['binding']['sequence']==0 and
            root['archiveSha256']==PREDECESSOR_SHA and root['manifestSha256']==PREDECESSOR_MANIFEST_SHA,
            'Fixed independently witnessed configure predecessor required')
    tree=codec.snapshot(state,codec.Budget({'treeBytes':8*1024**3,'seconds':180}))
    manifest={'schemaVersion':1,'binding':root['binding'],'tree':tree}
    require(codec.sha(codec.canonical(manifest))==PREDECESSOR_MANIFEST_SHA,
            'Complete physical native05 source/HOME/APT/report state differs')
    source=state/'source';work=state/'__carrier_work'
    configuration=planner.read_configuration(work/'gcc-staged-configuration',source)
    stage.selected_configuration(configuration,planner)
    require(planner.sha(planner.canonical(configuration))==root['binding']['configurationSha256'],
            'Configured original flags changed before main05')
    selected,_,spent,complete,last=planner.validate_ledger(ledger,configuration)
    require(complete==1 and last==PREDECESSOR_SHA and selected['phases'][1]['phase']=='native' and
            selected['phases'][1]['command']==COMMAND,'Wrong original main05 phase/command')
    configure=source/'stamps/04-configure-stamp';main=source/'stamps/05-build-stamp'
    require(stat.S_ISREG(configure.lstat().st_mode) and not main.exists() and not main.is_symlink(),
            'Original configure stamp missing or stale main05 stamp present')
    return configuration,tree,spent


def sdk_projection(state,root,output,label):
    expected=json.loads((state/'__carrier_work/external-sdk-before.json').read_bytes())
    require(hashlib.sha256(stage.canonical(expected)).hexdigest()==root['externalSdkSha256'],
            'Captured original SDK projection differs')
    verified=prepared_sdk.read_prepared(Path(__file__).parent,expected,root)
    # The original software remains exact; compare generated cache/format state
    # to THIS actually validated SDK, never to unretained historical cache bodies.
    expected=verified['inventory']
    expected_packages=root['binding']['packageInventorySha256']
    path=output/('installed-package-identities-'+label+'.txt')
    with path.open('xb') as sink:
        subprocess.run(['dpkg-query','-W','-f=${Package}\t${Version}\t${Architecture}\n'],stdout=sink,check=True)
    observed_packages=hashlib.sha256(path.read_bytes()).hexdigest()
    observed=stage.external_inventory();comparison=material.compare(expected,observed,expected_packages,observed_packages)
    observation=sdk.compressed_json(output/('sdk-observed-'+label+'.json.gz'),observed)
    compared=sdk.compressed_json(output/('sdk-comparison-'+label+'.json.gz'),comparison)
    witness={'observedInventory':observation,'comparison':compared,'counts':comparison['counts'],
             'packageInventorySha256':observed_packages,'materialProjectionMatches':comparison['materialProjectionMatches'],
             'timestampOnlyMaterialPaths':len(comparison['categories']['timestampOnlyMaterial']),
             'wholeRootIdentityClaimed':False,'originalSoftwareProjection':verified['softwareProjection'],
             'preparedGeneratedStateWitness':verified['finalGeneratedWitness'],'historicalCacheBodyEqualityClaimed':False}
    # Preserve the actual complete observation before refusing an unknown change.
    (output/('SDK-PROJECTION-'+label+'.json')).write_bytes(codec.canonical(witness))
    require(comparison['materialProjectionMatches'] and not comparison['categories']['timestampOnlyMaterial'],
            'Original SDK material/mtime mismatch before or after main05')
    return witness


def main():
    require(sys.argv==[sys.argv[0],'main05'],'Unknown original main05 action')
    require(os.getuid()==0 and all(os.environ.get(k)==v for k,v in stage.FIXED_ENVIRONMENT.items()) and
            set(os.environ)<=set(stage.FIXED_ENVIRONMENT)|{'PWD','SHLVL','_'},'Original main05 environment differs')
    output=Path('/controller/observations');require(output.is_dir() and not output.is_symlink() and
            not any(output.iterdir()),'Fresh fixed main05 observation mount required')
    state=Path('/build');root=json.loads((Path(__file__).parent/'EXPECTED-PREDECESSOR-ROOT.json').read_bytes())
    ledger=json.loads((Path(__file__).parent/'EXPECTED-PHASE-LEDGER.json').read_bytes())
    result={'schemaVersion':1,'state':'main05-preparation-unqualified','originalCommand':COMMAND,
            'originalCommandAttempted':False,'originalCommandTerminalObserved':False,'originalCommandExitCode':None,
            'phaseCompletionAssessed':False,'fullCompilerSdkBootstrapClosureVerified':False,'gateAComplete':False}
    try:
        configuration,tree,spent=predecessor(state,root,ledger)
        result.update(configurationSha256=planner.sha(planner.canonical(configuration)),
                      completePredecessorManifestSha256=PREDECESSOR_MANIFEST_SHA,priorChargedNativeSeconds=spent,
                      sdkBefore=sdk_projection(state,root,output,'before'))
        result['originalCommandAttempted']=True
        (output/'MAIN05-ATTEMPT.json').write_bytes(codec.canonical(result))
        try:
            native=stage.command_record(COMMAND,state/'source',output/'original-commands.jsonl','original-main05')
        except BaseException:
            # The retained original helper raises ValueError after recording a
            # nonzero return; its wrapper exception is NOT the dpkg exit code.
            try:
                terminal=command_terminal(output/'original-commands.jsonl',state/'source')
                result.update(state='original-main05-observed-terminal-not-retained',native=terminal,
                              originalCommandTerminalObserved=True,originalCommandExitCode=terminal['exitCode'],
                              originalCommandSignal=terminal['signal'])
            except BaseException as evidence_error:
                result['originalCommandTerminalEvidenceError']=str(evidence_error)[:1000]
            raise
        result.update(state='original-main05-zero-terminal-not-retained',native=native,
                      originalCommandTerminalObserved=True,originalCommandExitCode=0)
        stamp=state/'source/stamps/05-build-stamp'
        require(stat.S_ISREG(stamp.lstat().st_mode),'Physical original main05 stamp missing')
        result['sdkAfter']=sdk_projection(state,root,output,'after')
        result.update(state='original-main05-zero-terminal-and-material-observed-not-retained',physicalStamp='stamps/05-build-stamp')
    except BaseException as error:
        result['error']=str(error)[:2000];raise
    finally:
        (output/'MAIN05-STAGE.json').write_bytes(codec.canonical(result))


if __name__=='__main__':main()
