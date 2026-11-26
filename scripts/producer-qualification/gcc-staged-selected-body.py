"""One inert-on-import body for a source-frozen ORIGINAL GCC phase contract.

This separate proposal is not wired into the native05 workflow. The executable
entry has one fixed token and fixed read-only control paths, never a phase,
command, input root or trust argument. The independently reviewed operator
history selects the only eligible phase. Later-phase hosted capacity and native
qualification remain separate requirements.
"""
import importlib.util
import json
import math
import os
from pathlib import Path
import stat
import sys


def load(name):
    path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


legacy=load('gcc-main05-stage.py')
family=load('gcc-staged-phase-contract.py')
history=load('gcc-staged-operator-history.py')
evidence=load('gcc-staged-phase-evidence.py')
planner=family.planner
codec=family.codec
require=codec.require


def selected(state,root,ledger,controls):
    policy,_=history.read_policy()
    require(all(root.get(key)==value for key,value in policy['predecessorRoot'].items()),
            'Immediate predecessor differs from the independently frozen operator source')
    source=state/'source';configuration=planner.read_configuration(state/'__carrier_work/gcc-staged-configuration',source)
    legacy.stage.selected_configuration(configuration,planner)
    contract=history.verify_selected_history(configuration,ledger)
    require(contract['phase']==history.ALLOWED_ORIGINAL_PHASE,'This source-frozen body cannot automatically advance to another original phase')
    path=codec.physical(controls/'SELECTED-PHASE-CONTRACT.json')
    require(path.is_file() and path.stat().st_size<=1024**2 and json.loads(path.read_bytes())==contract,
            'Read-only exact source-frozen phase contract differs')
    tree=codec.snapshot(state,codec.Budget({'treeBytes':32*1024**3,'memberBytes':32*1024**3,'entries':1000000,'seconds':180}))
    require(codec.sha(codec.canonical({'schemaVersion':1,'binding':root['binding'],'tree':tree}))==root['manifestSha256'],
            'Complete physical predecessor source/HOME/APT/report tree differs')
    return configuration,contract


def terminal(records,source,contract):
    require(records.is_file() and not records.is_symlink() and records.stat().st_size<=65536,
            'Bounded original selected command record required')
    rows=[json.loads(raw) for raw in records.read_bytes().splitlines()]
    require(len(rows)==2 and rows[0]['state']=='requested' and rows[1]['state']=='terminal' and
            all(row['command']==contract['command'] and row['label']==contract['terminalLabel'] and row['cwd']==str(source) for row in rows),
            'Exact original selected request/terminal pair required')
    row=rows[1];code=row['exitCode'];native_signal=row['signal'];elapsed=row['elapsedSeconds']
    require(row['terminalObserved'] is True and type(elapsed) in [int,float] and math.isfinite(elapsed) and elapsed>=0 and
            ((type(code) is int and 0<=code<=255 and native_signal is None) or
             (code is None and type(native_signal) is int and 0<native_signal<128)),
            'Original selected command terminal differs')
    return row


def run_stage(state,root,ledger,controls,output):
    # This function is only called by the fixed operator-owned native entry.
    # Its tests replace the original command/SDK seam with synthetic stand-ins.
    result={'schemaVersion':1,'state':'original-selected-phase-preparation-unqualified',
            'originalCommandAttempted':False,'originalCommandTerminalObserved':False,'originalCommandExitCode':None,
            'phaseCompletionAssessed':False,'fullCompilerSdkBootstrapClosureVerified':False,'gateAComplete':False}
    contract=None;records=output/'original-commands.jsonl'
    try:
        configuration,contract=selected(state,root,ledger,controls)
        result.update(phase=contract['phase'],originalCommand=contract['command'],contractSha256=contract['contractSha256'],
                      configurationSha256=planner.sha(planner.canonical(configuration)),
                      sdkBefore=legacy.sdk_projection(state,root,output,'before'))
        result['originalCommandAttempted']=True
        (output/'SELECTED-PHASE-ATTEMPT.json').write_bytes(codec.canonical(result))
        try:
            native=legacy.stage.command_record(contract['command'],state/'source',records,contract['terminalLabel'])
        except BaseException:
            try:
                observed=terminal(records,state/'source',contract)
                result.update(state='original-selected-phase-terminal-not-retained',native=observed,
                              originalCommandTerminalObserved=True,originalCommandExitCode=observed['exitCode'],originalCommandSignal=observed['signal'])
            except BaseException as error:result['originalTerminalEvidenceError']=str(error)[:1000]
            raise
        observed=terminal(records,state/'source',contract)
        require(type(observed['exitCode']) is int and observed['exitCode']==0 and observed['signal'] is None and native==observed,
                'Exact genuine selected zero terminal required')
        result.update(state='original-selected-phase-zero-terminal-not-retained',native=observed,
                      originalCommandTerminalObserved=True,originalCommandExitCode=0,originalCommandSignal=None)
        result['requiredOutputs']=family.physical_outputs(state,contract)
        if contract['originalTestReportInventoryRequired']:result.update(evidence.collect_reports(state,output))
        if contract['packageOutputClosureAdditionallyRequired']:result['packageOutputs']=evidence.package_outputs(state)
        result['sdkAfter']=legacy.sdk_projection(state,root,output,'after')
        result.update(state='original-selected-phase-zero-terminal-and-material-observed-not-retained',
                      packageOutputKinds=result.get('packageOutputs',{}).get('packageOutputKinds'),
                      requiredStampFreshnessClaimed=False,laterPhaseCapacityQualified=False)
        return result
    except BaseException as error:result['error']=str(error)[:2000];raise
    finally:(output/'SELECTED-PHASE-STAGE.json').write_bytes(codec.canonical(result))


def main():
    require(sys.argv==[sys.argv[0],'selected-original-phase'],'No caller-selected phase or command is permitted')
    require(os.getuid()==0 and all(os.environ.get(key)==value for key,value in legacy.stage.FIXED_ENVIRONMENT.items()) and
            set(os.environ)<=set(legacy.stage.FIXED_ENVIRONMENT)|{'PWD','SHLVL','_'},'Original selected environment differs')
    controls=Path(__file__).parent;output=Path('/controller/observations')
    require(output.is_dir() and not output.is_symlink() and not any(output.iterdir()),'Fresh fixed selected-phase observation mount required')
    root=json.loads((controls/'EXPECTED-PREDECESSOR-ROOT.json').read_bytes());ledger=json.loads((controls/'EXPECTED-PHASE-LEDGER.json').read_bytes())
    run_stage(Path('/build'),root,ledger,controls,output)


if __name__=='__main__':main()
