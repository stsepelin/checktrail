"""Pinned first-party operator history for the next concrete native phase.

Read/derive data only. This fixed source cohort permits selection of native only;
no caller phase, history file, Boolean or MCP argument grants execution trust.
A subsequent native attempt requires reviewed source pins for its complete prior
attempt history; the known configure row is not a retry-history factory.
"""
import importlib.util
import json
from pathlib import Path


def load(name):
    path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


family=load('gcc-staged-phase-contract.py')
codec=family.codec
require=codec.require
POLICY_PATH=Path(__file__).with_name('gcc-staged-operator-history.v1.json')
POLICY_SHA256='9e890cc7b8d09e6a90666a59e62dd314c396bfdeefbd042e3db2352b19419243'
HISTORY_SHA256='72b4bad5b000796bd91fab7e81a657b48ce9cb468a4fe06967dd2e7c9d8fba3b'
CONFIGURATION_SHA256='0c08604bb36390d97a8697dda36f8468f6a7cd90b3fd3ed00c9ee285325b9a35'
ALLOWED_ORIGINAL_PHASE='native'


def read_policy():
    path=codec.physical(POLICY_PATH)
    require(path.is_file() and path.stat().st_size<=65536,'Bounded ordinary operator history source required')
    raw=path.read_bytes();require(codec.sha(raw)==POLICY_SHA256,'Operator history source changed; independent review/reseal required')
    policy=json.loads(raw)
    require(policy['schemaVersion']==1 and policy['profile']==family.planner.PROFILE and
            policy['allowedOriginalPhase']==ALLOWED_ORIGINAL_PHASE and policy['historySourceIsOperatorFrozenNotToolArguments'] is True and
            policy['operatorExecutionTrustGranted'] is False and policy['gateAComplete'] is False,
            'Wrong fixed operator phase/history policy')
    require(codec.sha(codec.canonical(policy['configuration']))==CONFIGURATION_SHA256,'Original operator configuration identity changed')
    selected=family.select_frozen_history(policy['configuration'],policy['configureLedger'],policy['phaseLedger'],frozen_history_sha256=HISTORY_SHA256)
    return policy,selected


def inspect(output=None):
    policy,selected=read_policy()
    record={'schemaVersion':1,'operatorPolicySha256':POLICY_SHA256,'operatorHistorySha256':HISTORY_SHA256,
            'configurationSha256':CONFIGURATION_SHA256,'allowedOriginalPhase':ALLOWED_ORIGINAL_PHASE,**selected,
            'operatorExecutionTrustGranted':False,'gateAComplete':False}
    # Retain the charged prior history before refusing an unresolved family.
    # This is not a clearance, SDK attempt or new original-command terminal.
    if output is not None:(output/'OPERATOR-HISTORY.json').write_bytes(codec.canonical(record))
    require(not selected['continuationInhibitedByUnresolvedFamily'],'Unresolved original process family inhibits every source/native start')
    contract=family.next_contract(policy['configuration'],selected['phaseLedger'],policy['predecessorRoot'],
                                  frozen_configuration_sha256=CONFIGURATION_SHA256)
    require(contract['phase']==ALLOWED_ORIGINAL_PHASE,'This reviewed source cohort authorizes selection of native only')
    return {**record,'contract':contract}


def verify_selected_history(configuration,ledger):
    policy,selected=read_policy()
    require(configuration==policy['configuration'] and ledger==selected['phaseLedger'],
            'Actual restored configuration or complete operator-frozen history differs')
    return family.next_contract(configuration,ledger,policy['predecessorRoot'],frozen_configuration_sha256=CONFIGURATION_SHA256)
