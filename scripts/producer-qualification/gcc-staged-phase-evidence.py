"""Inert data adapters for exact original GCC report/package evidence.

No producer, SDK command, container, network or source target is executed.
Original report bodies are retained/round-tripped by the existing first-party
codec; package filename/hash observations do not prove binary/license closure.
This proposal is separate from the frozen native05 executable cohort.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat


def load(name):
    path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


family=load('gcc-staged-phase-contract.py')
codec=family.codec
reports=load('c-producer-test-reports.py')
require=codec.require
PACKAGE_KINDS={'.deb':'deb','.udeb':'udeb','.ddeb':'ddeb','.changes':'changes','.buildinfo':'buildinfo'}
STATE_BYTES=32*1024**3
METADATA_BYTES=32*1024**2


def ordinary_pin(path,maximum):
    path=codec.physical(Path(path));info=path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_size<=maximum,'Bounded ordinary original evidence file required')
    digest,size=codec.identify(path,codec.Budget({'memberBytes':maximum,'seconds':180}))
    return {'bytes':size,'sha256':digest}


def replay_reports(manifest,retained):
    """Physically decode every retained original report AND associated log."""
    retained=codec.physical(Path(retained));encoding=reports.report_codec()
    inventory=encoding.validate_transport(manifest);observed=[]
    def read_chunk(name,maximum):
        path=retained/name;pin=ordinary_pin(path,maximum)
        require(pin['bytes']==maximum,'Retained original report chunk size changed')
        return path.read_bytes()
    for row in inventory['files']:
        digest=hashlib.sha256();total=0
        for raw in encoding.iter_report_bytes(row,read_chunk):digest.update(raw);total+=len(raw)
        require(total==row['bytes'] and digest.hexdigest()==row['sha256'],'Retained complete original report/log differs')
        observed.append({'file':row['file'],'bytes':total,'sha256':digest.hexdigest()})
    return {'logicalFiles':observed,'decodedBytes':inventory['decodedBytes'],'storedBytes':inventory['storedBytes'],
            'allRetainedOriginalReportsAndAssociatedLogsPhysicallyReplayed':True,'testExecutionOrAllGreenAssessed':False}


def collect_reports(state,output):
    state=codec.physical(Path(state));source=codec.physical(state/'source');output=codec.physical(Path(output))
    require(source.is_dir() and output.is_dir(),'Physical source and owned observation directories required')
    target=output/'test-reports.json';require(not os.path.lexists(target),'Fresh original report manifest required')
    caller=reports.parse_caller_identity(str(os.geteuid()),str(os.getegid()))
    reports.collect('gcc-12',source,target,caller)
    pin=ordinary_pin(target,METADATA_BYTES);manifest=json.loads(target.read_bytes())
    require(manifest['profile']=='gcc-12' and manifest['allOriginalTestsPassRequired'] is False and
            manifest['completeConfigurationInventoryAssessed'] is False,'Original report scope changed')
    replay=replay_reports(manifest,output/'original-test-reports')
    # Empty .sum/.trs files and nonempty associated logs cannot masquerade as
    # nonempty test-report bodies. Every file, including empties, stays retained.
    nonempty=[row for row in manifest['reports'] if row['bytes']>0]
    logical=sum(row['bytes'] for row in manifest['reports'])
    require(nonempty and logical>0,'Original nonempty report bodies unavailable; logs alone cannot qualify')
    return {'originalTestReportEvidence':{'reports':len(nonempty),'logicalBytes':logical,
                'inventorySha256':pin['sha256'],'allOriginalTestsPassRequired':False},
            'completeOriginalManifest':pin,'replay':replay,'buildRootStates':manifest['buildRootStates'],
            'reportBodiesCreatedByThisPhaseAssessed':False,'allOriginalTestsPassedAssessed':False,
            'fullCompilerSdkBootstrapClosureVerified':False,'gateAComplete':False}


def package_outputs(state):
    """Observe whole recognized output files as data; never execute/extract one."""
    state=codec.physical(Path(state));require(state.is_dir(),'Physical original package output root required')
    rows=[];total=0;entries=0
    for path in sorted(state.iterdir()):
        entries+=1;require(entries<=1000000,'Original package-root entry bound')
        kind=PACKAGE_KINDS.get(path.suffix)
        if kind is None:continue
        pin=ordinary_pin(path,STATE_BYTES);require(pin['bytes']>0,'Empty original package output unavailable')
        total+=pin['bytes'];require(total<=STATE_BYTES,'Original package-family byte bound reached')
        rows.append({'file':path.name,'kind':kind,**pin})
    kinds=sorted({row['kind'] for row in rows})
    require({'deb','changes','buildinfo'}<=set(kinds),'Original deb/changes/buildinfo output families unavailable')
    result={'schemaVersion':1,'files':rows,'packageOutputKinds':kinds,'observedPackageOutputBytes':total,
            'allOriginalMutableStateMustStillBeCheckpointed':True,'filenameSuffixIsNotBinaryValidation':True,
            'packageFormatVerified':False,'packageOutputSetCompletenessVerified':False,
            'originalNoticeOrLicenseClosureVerified':False,'producerOrPackageExecuted':False,
            'laterPhaseResourceCapacityQualified':False,'fullCompilerSdkBootstrapClosureVerified':False,'gateAComplete':False}
    return {**result,'inventorySha256':codec.sha(codec.canonical(result))}
