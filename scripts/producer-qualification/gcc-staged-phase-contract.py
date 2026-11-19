"""Finite original GCC phase contracts and data-only attempt reconciliation.

No command, SDK tool, source activation, container or service operation runs.
A native carrier must separately authenticate source/configuration origin,
review the exact descriptor and admit current resources and operator trust.
A caller-supplied phase, JSON receipt or hash cannot grant execution authority.
"""
import importlib.util
import math
from pathlib import Path
import re
import stat


def load(name):
    path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


planner=load('gcc-staged-plan.py')
codec=planner.checkpoint
require=codec.require
PHASES=('native','jit','nvptx','gcn','hppa64','check','default-build','packages')
LABELS={phase:'original-'+('main05' if phase=='native' else phase) for phase in PHASES}


def digest(value):return isinstance(value,str) and re.fullmatch('[a-f0-9]{64}',value) is not None

def finite(value):return type(value) in [int,float] and math.isfinite(value) and value>=0


def next_contract(configuration,ledger,predecessor,*,frozen_configuration_sha256):
    selected,previous,spent,index,last=planner.validate_ledger(ledger,configuration)
    require(digest(frozen_configuration_sha256) and selected['configurationSha256']==frozen_configuration_sha256,
            'Exact independently frozen original configuration required')
    require(not ledger['attempts'] or ledger['attempts'][-1]['quiescenceObserved'] is True,
            'Unresolved original process family inhibits every continuation')
    require(spent<43200,'Aggregate native allowance exhausted before continuation')
    require(1<=index<len(selected['phases']),'Only a remaining selected phase after configure is eligible')
    phase=selected['phases'][index];require(phase['phase'] in PHASES,'Not a finite original remaining phase')
    binding=codec.validate_binding(predecessor['binding'])
    completed=[row for row in ledger['attempts'] if row['outcome']=='completed'];prior=completed[-1]
    require(digest(predecessor['archiveSha256']) and predecessor['archiveSha256']==last and
            binding['configurationSha256']==frozen_configuration_sha256 and binding['sequence']==index-1 and
            binding['phase']==selected['phases'][index-1]['phase'] and binding['predecessorSha256']==prior['predecessorSha256'],
            'Exact immediate completed predecessor/ledger binding required')
    require(digest(predecessor['externalSdkSha256']),'Original software SDK baseline missing')
    earlier={stamp for entry in selected['phases'][:index] for stamp in entry['requiredStamps']}
    result={'schemaVersion':1,'profile':planner.PROFILE,'phase':phase['phase'],'sequence':index,'attempt':len(ledger['attempts']),
            'command':phase['command'],'requiredStamps':phase['requiredStamps'],'terminalLabel':LABELS[phase['phase']],
            'configurationSha256':frozen_configuration_sha256,'ledgerSha256':codec.sha(codec.canonical(ledger)),
            'predecessorSha256':previous,'restoreArchiveSha256':last,'predecessorBindingSha256':codec.sha(codec.canonical(binding)),
            'externalSdkSoftwareBaselineSha256':predecessor['externalSdkSha256'],
            'requiredStampsAlsoRequiredEarlier':sorted(set(phase['requiredStamps'])&earlier),
            'additionalRequiredStamps':sorted(set(phase['requiredStamps'])-earlier),
            'requiredStampFreshnessAloneIsNotCommandCompletion':True,
            'remainingSelectedPhasesIncludingThis':len(selected['phases'])-index,
            'selectedPhases':[entry['phase'] for entry in selected['phases']],
            'allAttemptNativeSecondsAlreadyCharged':spent,
            'packageOutputClosureAdditionallyRequired':phase['phase']=='packages',
            'originalTestReportInventoryRequired':phase['phase'] in ['jit','check'],
            'newSdkReconstructionAndCurrentGeneratedStateWitnessRequired':True,
            'allHistoricalSourceReportsAndSdkWitnessesMustBeRetained':True,
            'phaseResourceCapacityQualified':False,'operatorExecutionTrustGranted':False,
            'configurationNativeOriginAssessed':False,'nativeEvidenceOriginAssessed':False,'gateAComplete':False}
    return {**result,'contractSha256':codec.sha(codec.canonical(result))}


def select_frozen_history(configuration,configure_ledger,history,*,frozen_history_sha256):
    """Data integrity only; native operators must pin the full reviewed history.

    This prevents a phase0-only replay from silently resetting later failed
    charges. No trust in an arbitrary caller's hash or reconciliation Boolean
    is asserted. There is intentionally no unresolved-family clearance API.
    """
    require(digest(frozen_history_sha256) and codec.sha(codec.canonical(history))==frozen_history_sha256,
            'Exact independently frozen complete attempt history required; phase0 reset refused')
    _,_,_,base_count,_=planner.validate_ledger(configure_ledger,configuration)
    require(base_count==1 and len(configure_ledger['attempts'])==1 and
            history['attempts'][:1]==configure_ledger['attempts'],'Original configure history prefix changed')
    _,_,spent,index,_=planner.validate_ledger(history,configuration)
    return {'phaseLedger':history,'allAttemptNativeSeconds':spent,'reportedCompletedPhases':index,
            'continuationInhibitedByUnresolvedFamily':planner.completion(history,configuration)['continuationInhibitedByUnresolvedFamily'],
            'frozenHistoryMustBePinnedInOperatorSource':True,'nativeEvidenceOriginAssessed':False,'operatorExecutionTrustGranted':False}


def verify_contract(contract,configuration,ledger,predecessor,frozen_configuration_sha256):
    expected=next_contract(configuration,ledger,predecessor,frozen_configuration_sha256=frozen_configuration_sha256)
    require(contract==expected,'Changed, stale or caller-selected phase contract')
    return expected


def physical_outputs(state,contract):
    """Observe exact required stamp bytes/types as data; no makefile is evaluated."""
    state=codec.physical(Path(state));source=codec.physical(state/'source');rows=[]
    allowed={name for paths in planner.STAMPS.values() for name in paths}|{
        'stamps/05-build-html-stamp','stamps/05-build-doxygen-stamp','stamps/05-build-gnatdoc-stamp',
        'stamps/07-install-stamp','stamps/07-install-jit-stamp'}
    require(contract['phase'] in PHASES and contract['requiredStamps'] and
            len(contract['requiredStamps'])==len(set(contract['requiredStamps'])) and
            set(contract['requiredStamps'])<=allowed,'Finite original required stamp inventory only')
    for name in contract['requiredStamps']:
        path=codec.physical(source/name);info=path.lstat()
        require(stat.S_ISREG(info.st_mode),'Physical ordinary original phase stamp required')
        sha,size=codec.identify(path,codec.Budget({'memberBytes':1024**2,'seconds':30}))
        rows.append({'path':name,'bytes':size,'sha256':sha,**codec.metadata(info)})
    return {'phase':contract['phase'],'requiredStampIdentities':rows,'newlyGeneratedStampsClaimed':False,
            'sourceOrCompilerExecuted':False,'nativeCompletionAssessed':False}


def attempt_row(configuration,ledger,predecessor,contract,observation,*,frozen_configuration_sha256):
    verify_contract(contract,configuration,ledger,predecessor,frozen_configuration_sha256)
    sdk=observation['sdkPreparationSecondsCharged'];elapsed=observation['observerElapsedSeconds'];total=observation['combinedSdkAndPhaseObservedSeconds']
    require(all(finite(v) for v in [sdk,elapsed,total]) and total==sdk+elapsed,'Exact full SDK/phase observed charge required')
    require(observation['phase']==contract['phase'] and observation['originalCommand']==contract['command'] and
            type(observation['originalCommandTerminalObserved']) is bool and type(observation['quiescenceObserved']) is bool,
            'Exact original next command and terminal/family observations required')
    code=observation['originalCommandExitCode'];signal=observation['originalCommandSignal'];terminal=observation['originalCommandTerminal']
    if observation['originalCommandTerminalObserved']:
        require(terminal['command']==contract['command'] and terminal['label']==contract['terminalLabel'] and terminal['cwd']=='/build/source' and
                terminal['state']=='terminal' and terminal['terminalObserved'] is True and
                type(code) is type(terminal['exitCode']) and code==terminal['exitCode'] and
                type(signal) is type(terminal['signal']) and signal==terminal['signal'] and
                finite(terminal['elapsedSeconds']) and terminal['elapsedSeconds']<=elapsed,
                'Original phase terminal differs from actual observer')
        require((type(code) is int and 0<=code<=255 and signal is None) or
                (code is None and type(signal) is int and 0<signal<128),'Original phase exit/signal shape invalid')
    else:require(code is None and signal is None and terminal is None,'Missing original terminal cannot inherit a wrapper exit')
    return {'phase':contract['phase'],'command':contract['command'],'attempt':contract['attempt'],'sequence':contract['sequence'],
            'predecessorSha256':contract['predecessorSha256'],'nativeSeconds':total,'exitCode':code,'signal':signal,
            'terminalObserved':observation['originalCommandTerminalObserved'],'quiescenceObserved':observation['quiescenceObserved'],
            'requiredStamps':contract['requiredStamps'],'stampIdentities':[],'checkpointSha256':None}


def append_failure(configuration,ledger,row,error,*,retention_stage='capture'):
    # The caller must derive/validate the original terminal before this shared
    # data step. append_attempt revalidates exact next phase, chain and charges.
    if row['terminalObserved'] and row['exitCode']==0:
        reason=str(error).encode()[:2048].decode(errors='ignore');require(reason,'Actual bounded incomplete/retention failure required')
        if row['quiescenceObserved']:
            row.update(outcome='retention-failed',retentionStage=retention_stage,retentionFailure=reason)
        else:
            row.update(outcome=planner.TERMINAL_INCOMPLETE,incompleteStage=retention_stage,incompleteReason=reason)
    else:row['outcome']='failed' if row['terminalObserved'] else 'timeout-incomplete'
    return planner.append_attempt(ledger,configuration,row)


def failed(configuration,ledger,predecessor,contract,observation,error,*,frozen_configuration_sha256,retention_stage='capture'):
    row=attempt_row(configuration,ledger,predecessor,contract,observation,frozen_configuration_sha256=frozen_configuration_sha256)
    return append_failure(configuration,ledger,row,error,retention_stage=retention_stage)


def completed(configuration,ledger,predecessor,contract,observation,checkpoint,restore,outputs,*,frozen_configuration_sha256):
    row=attempt_row(configuration,ledger,predecessor,contract,observation,frozen_configuration_sha256=frozen_configuration_sha256)
    state=observation['containerState']
    require(row['terminalObserved'] and row['exitCode']==0 and row['signal'] is None and row['quiescenceObserved'] and
            observation['cutoffOrRetentionError'] is None and type(observation['attachExitCode']) is int and observation['attachExitCode']==0 and
            state['Running'] is False and type(state['Pid']) is int and state['Pid']==0 and state['Status']=='exited' and
            type(state['ExitCode']) is int and state['ExitCode']==0 and state['OOMKilled'] is False and
            observation['sdkBeforeMaterialProjectionMatches'] is True and observation['sdkAfterMaterialProjectionMatches'] is True,
            'Complete original command family and current reconstructed SDK required')
    expected_binding={**predecessor['binding'],'phase':contract['phase'],'sequence':contract['sequence'],'predecessorSha256':contract['predecessorSha256']}
    require(checkpoint['binding']==expected_binding and checkpoint['checkpointValidated'] is True and digest(checkpoint['archiveSha256']) and
            restore['physicalTreeVerified'] is True and restore['binding']==expected_binding and restore['archiveSha256']==checkpoint['archiveSha256'],
            'Exact complete captured/independently restored successor binding required')
    stamps=outputs['requiredStampIdentities']
    require(outputs['phase']==contract['phase'] and [row['path'] for row in stamps]==contract['requiredStamps'] and
            all(digest(row['sha256']) and type(row['bytes']) is int and row['bytes']>=0 and
                all(type(row[key]) is int and row[key]>=0 for key in ['mode','uid','gid','mtimeNs']) for row in stamps),
            'Complete exact typed original phase stamp observations required')
    if contract['originalTestReportInventoryRequired']:
        report=observation['originalTestReportEvidence']
        require(set(report)=={'reports','logicalBytes','inventorySha256','allOriginalTestsPassRequired'} and
                type(report['reports']) is int and report['reports']>0 and type(report['logicalBytes']) is int and report['logicalBytes']>0 and
                digest(report['inventorySha256']) and report['allOriginalTestsPassRequired'] is False,
                'Complete original test report inventory required without inventing an all-green upstream result')
        row['originalTestReportEvidence']=dict(report)
    if contract['phase']=='packages':
        kinds=observation['packageOutputKinds']
        require(isinstance(kinds,list) and all(isinstance(value,str) for value in kinds) and len(kinds)==len(set(kinds)) and
                {'deb','changes','buildinfo'}<=set(kinds)<= {'deb','changes','buildinfo','ddeb','udeb'},
                'Complete exact original binary package output families required')
        row['packageOutputKinds']=sorted(kinds)
    # Package command/stamps are not the complete package-output/license proof.
    # This data reconciler never grants that proof or any source-origin credit.
    row.update(outcome='completed',checkpointSha256=checkpoint['archiveSha256'],stampIdentities=contract['requiredStamps'])
    after=planner.append_attempt(ledger,configuration,row)
    return {'phaseLedger':after,'localLedgerIsProvisionalUntilServiceReplay':True,
            'packageOutputClosureVerified':False,'nativeEvidenceOriginAssessed':False,
            'fullCompilerSdkBootstrapClosureVerified':False,'gateAComplete':False}
