"""Finite source-owned phase binding; no CLI, execution trust or SDK/cache grant.

Before execution, verify the complete physical predecessor with the sealed body.
After execution, revalidate source-frozen configuration/history without pretending
that the now legitimately changed state still equals its predecessor manifest.
"""
import importlib.util
import json
from pathlib import Path


def load(name):
    path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


body=load('gcc-staged-selected-body.py')
family=body.family
planner=body.planner
codec=body.codec
require=codec.require
KEYS={'schemaVersion','configuration','phaseLedger','predecessorRoot','contract',
      'operatorPolicySha256','operatorHistorySha256','operatorExecutionTrustGranted','gateAComplete'}


def clone(value):return json.loads(codec.canonical(value))


def verify(context):
    """Recompute the exact source-selected contract; caller JSON is not authority."""
    require(type(context) is dict and set(context)==KEYS and type(context['schemaVersion']) is int and
            context['schemaVersion']==1 and context['operatorExecutionTrustGranted'] is False and
            context['gateAComplete'] is False,'Wrong finite host context shape')
    history=body.history;policy,_=history.read_policy()
    require(context['operatorPolicySha256']==history.POLICY_SHA256 and
            context['operatorHistorySha256']==history.HISTORY_SHA256,
            'Host context no longer matches independently frozen operator source')
    root=context['predecessorRoot'];ledger=context['phaseLedger'];configuration=context['configuration']
    require(all(root.get(key)==value for key,value in policy['predecessorRoot'].items()),
            'Host context immediate predecessor differs from frozen complete history')
    selected=history.verify_selected_history(configuration,ledger)
    require(selected['phase']==history.ALLOWED_ORIGINAL_PHASE and
            codec.canonical(selected)==codec.canonical(context['contract']),
            'Host context phase/command/label/output contract differs from source')
    body.legacy.stage.selected_configuration(configuration,planner)
    return clone(selected)


def before(state,root,ledger,controls):
    configuration,contract=body.selected(Path(state),root,ledger,Path(controls))
    context={'schemaVersion':1,'configuration':configuration,'phaseLedger':ledger,
             'predecessorRoot':root,'contract':contract,'operatorPolicySha256':body.history.POLICY_SHA256,
             'operatorHistorySha256':body.history.HISTORY_SHA256,'operatorExecutionTrustGranted':False,'gateAComplete':False}
    context=clone(context);verify(context)
    return context


def after(state,context):
    contract=verify(context);state=codec.physical(Path(state))
    configuration=planner.read_configuration(state/'__carrier_work/gcc-staged-configuration',state/'source')
    require(codec.canonical(configuration)==codec.canonical(context['configuration']),
            'Original selected configuration changed during the phase')
    return contract


def stage_evidence(frame,context,stage_record,observation):
    """Bind actual generic body output and re-read its physical report/package data."""
    frame=codec.physical(Path(frame));state=frame/'state';contract=after(state,context)
    for name,expected in [('PHASE-ATTEMPT.json',observation),('observations/SELECTED-PHASE-STAGE.json',stage_record)]:
        path=codec.physical(frame/name)
        require(path.is_file() and path.stat().st_size<=1024**2 and
                codec.canonical(json.loads(path.read_bytes()))==codec.canonical(expected),
                'Exact physical original observer/body receipt required')
    actual_terminal=body.terminal(frame/'observations/original-commands.jsonl',Path('/build/source'),contract)
    require(codec.canonical(actual_terminal)==codec.canonical(observation['originalCommandTerminal']),
            'Observer terminal differs from physical original command records')
    require(stage_record['state']=='original-selected-phase-zero-terminal-and-material-observed-not-retained' and
            stage_record['phase']==contract['phase'] and stage_record['originalCommand']==contract['command'] and
            stage_record['contractSha256']==contract['contractSha256'] and
            stage_record['configurationSha256']==planner.sha(planner.canonical(context['configuration'])) and
            stage_record['originalCommandAttempted'] is True and stage_record['originalCommandTerminalObserved'] is True and
            type(stage_record['originalCommandExitCode']) is int and stage_record['originalCommandExitCode']==0 and
            stage_record['originalCommandSignal'] is None and
            codec.canonical(stage_record['native'])==codec.canonical(observation['originalCommandTerminal']),
            'Actual original phase zero/body/terminal postcondition differs')
    require(all(stage_record[key]['materialProjectionMatches'] is True and
                type(stage_record[key]['timestampOnlyMaterialPaths']) is int and stage_record[key]['timestampOnlyMaterialPaths']==0
                for key in ['sdkBefore','sdkAfter']),'Current reconstructed SDK changed during original phase')
    outputs=family.physical_outputs(state,contract)
    require(codec.canonical(outputs)==codec.canonical(stage_record['requiredOutputs']),
            'Complete physical original stamp observations differ from body')
    enriched={**observation,'sdkBeforeMaterialProjectionMatches':True,'sdkAfterMaterialProjectionMatches':True}
    proofs={'physicalOutputs':outputs,'originalReportsPhysicallyReplayed':False,
            'packageOutputFormatOrLicenseClosureVerified':False,'gateAComplete':False}
    if contract['originalTestReportInventoryRequired']:
        manifest_path=frame/'observations/test-reports.json';pin=body.evidence.ordinary_pin(manifest_path,body.evidence.METADATA_BYTES)
        manifest=json.loads(manifest_path.read_bytes())
        require(manifest['profile']=='gcc-12' and manifest['allOriginalTestsPassRequired'] is False and
                manifest['completeConfigurationInventoryAssessed'] is False,'Wrong complete original report scope')
        replay=body.evidence.replay_reports(manifest,frame/'observations/original-test-reports')
        nonempty=[row for row in manifest['reports'] if row['bytes']>0]
        report={'reports':len(nonempty),'logicalBytes':sum(row['bytes'] for row in manifest['reports']),
                'inventorySha256':pin['sha256'],'allOriginalTestsPassRequired':False}
        require(report['reports']>0 and report['logicalBytes']>0 and
                codec.canonical(report)==codec.canonical(stage_record['originalTestReportEvidence']),
                'Body report evidence does not match complete physical reports/logs')
        enriched['originalTestReportEvidence']=report
        proofs.update(originalReportsPhysicallyReplayed=True,reportReplay=replay)
    if contract['packageOutputClosureAdditionallyRequired']:
        packages=body.evidence.package_outputs(state)
        require(codec.canonical(packages)==codec.canonical(stage_record['packageOutputs']) and
                packages['packageOutputKinds']==stage_record['packageOutputKinds'],
                'Body package identities do not match complete observed output files')
        enriched['packageOutputKinds']=packages['packageOutputKinds'];proofs['packageOutputs']=packages
    return outputs,enriched,proofs
