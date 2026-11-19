"""Reconcile one actual original main05 observation without inventing exits.

Data only: no native command, checkpoint publication or phase save is performed.
A locally completed row stays provisional until exact service restore/replay.
"""
import importlib.util
import math
from pathlib import Path


def load(name):
    path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


body=load('gcc-main05-stage.py')
family=load('gcc-staged-phase-contract.py')
planner=body.planner
require=body.require


def finite(value):return type(value) in [int,float] and math.isfinite(value) and value>=0


def base_row(ledger,configuration,observation):
    selected,previous,spent,complete,last=planner.validate_ledger(ledger,configuration)
    require(complete==1 and selected['phases'][complete]['phase']=='native' and
            observation['phase']=='native' and observation['originalCommand']==body.COMMAND,
            'Only the next complete original main05 command is eligible')
    sdk=observation['sdkPreparationSecondsCharged'];elapsed=observation['observerElapsedSeconds'];charged=observation['combinedSdkAndMainObservedSeconds']
    require(all(finite(value) for value in [sdk,elapsed,charged]) and charged==sdk+elapsed and charged<=14440,
            'All actual SDK/main observer time must be charged exactly')
    require(type(observation['originalCommandTerminalObserved']) is bool and type(observation['quiescenceObserved']) is bool,
            'Actual original terminal/family observations required')
    code=observation['originalCommandExitCode'];native_signal=observation['originalCommandSignal']
    if observation['originalCommandTerminalObserved']:
        terminal=observation['originalCommandTerminal']
        require(terminal['command']==body.COMMAND and terminal['cwd']=='/build/source' and terminal['label']=='original-main05' and
                terminal['state']=='terminal' and terminal['terminalObserved'] is True and
                terminal['exitCode']==code and type(terminal['exitCode']) is type(code) and
                terminal['signal']==native_signal and type(terminal['signal']) is type(native_signal) and
                finite(terminal['elapsedSeconds']) and terminal['elapsedSeconds']<=elapsed,
                'Original command terminal differs from the retained observer')
        require((type(code) is int and 0<=code<=255 and native_signal is None) or
                (code is None and type(native_signal) is int and 0<native_signal<128),
                'Actual original exit/signal shape differs')
    else:
        require(code is None and native_signal is None and observation['originalCommandTerminal'] is None,
                'An absent original terminal cannot inherit a wrapper/runc exit')
    phase=selected['phases'][complete]
    return {'phase':'native','command':phase['command'],'attempt':len(ledger['attempts']),'sequence':complete,
            'predecessorSha256':previous,'nativeSeconds':charged,'exitCode':code,'signal':native_signal,
            'terminalObserved':observation['originalCommandTerminalObserved'],'quiescenceObserved':observation['quiescenceObserved'],
            'checkpointSha256':None,'requiredStamps':phase['requiredStamps'],'stampIdentities':[]}


def failed(ledger,configuration,observation,error,*,retention_stage='capture'):
    row=base_row(ledger,configuration,observation)
    return family.append_failure(configuration,ledger,row,error,retention_stage=retention_stage)


def native_success(ledger,configuration,observation,stage_record):
    row=base_row(ledger,configuration,observation)
    require(row['exitCode']==0 and row['signal'] is None and row['terminalObserved'] is True and row['quiescenceObserved'] is True and
            observation['cutoffOrRetentionError'] is None and type(observation['attachExitCode']) is int and observation['attachExitCode']==0 and
            observation['containerState']['Running'] is False and type(observation['containerState']['Pid']) is int and observation['containerState']['Pid']==0 and
            observation['containerState']['Status']=='exited' and type(observation['containerState']['ExitCode']) is int and observation['containerState']['ExitCode']==0 and
            observation['containerState']['OOMKilled'] is False,'Complete genuine original main05 process family required')
    require(stage_record['state']=='original-main05-zero-terminal-and-material-observed-not-retained' and
            stage_record['physicalStamp']=='stamps/05-build-stamp' and stage_record['originalCommand']==body.COMMAND and
            stage_record['originalCommandAttempted'] is True and stage_record['originalCommandTerminalObserved'] is True and
            type(stage_record['originalCommandExitCode']) is int and stage_record['originalCommandExitCode']==0 and
            all(stage_record[key]['materialProjectionMatches'] is True and type(stage_record[key]['timestampOnlyMaterialPaths']) is int and stage_record[key]['timestampOnlyMaterialPaths']==0
                for key in ['sdkBefore','sdkAfter']),'Actual original stamp/current SDK postconditions missing')
    return row


def completed(ledger,configuration,observation,checkpoint,physical_restore,stage_record):
    row=native_success(ledger,configuration,observation,stage_record)
    binding=checkpoint['binding']
    require(physical_restore['physicalTreeVerified'] is True and physical_restore['archiveSha256']==checkpoint['archiveSha256'] and
            physical_restore['binding']==binding and binding['phase']=='native' and binding['sequence']==1 and
            binding['predecessorSha256']==row['predecessorSha256'] and
            binding['configurationSha256']==planner.plan(configuration)['configurationSha256'] and
            checkpoint['checkpointValidated'] is True and type(checkpoint['archiveBytes']) is int and
            0<checkpoint['archiveBytes']<=4*1024**3 and isinstance(checkpoint['archiveSha256'],str),
            'Complete bounded captured and independently restored original tree required')
    row.update(outcome='completed',checkpointSha256=checkpoint['archiveSha256'],stampIdentities=row['requiredStamps'])
    return planner.append_attempt(ledger,configuration,row)
