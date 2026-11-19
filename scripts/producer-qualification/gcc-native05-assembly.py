"""Fixed constructor -> physical SDK reader -> baseline path, before GCC start.

Import is inert. The actual operator retains execution trust separately. No
caller-selected SDK command/phase, legacy fallback or public raw output exists.
"""
import importlib.util,os
from pathlib import Path

def load(name):
 path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

prepare=load('gcc-main05-prepare.py')
local=load('gcc-native05-sdk-local.py')
profile=load('gcc-native05-checkpoint-profile.py')
h=prepare.h
require=h.require


def reconstruct_verified(repository,inputs,sdk_frame,output):
 profile.require_selected_policy()
 require(local.POLICY_SHA256==profile.SDK_POLICY_SHA256,'Frozen native05-v3 SDK source-policy binding differs')
 private=Path(output)/'sdk-private';private.mkdir(mode=0o700)
 actual={}
 def fixed_work():
  actual['prepared']=prepare.reconstruct_for_main(repository,inputs,sdk_frame)
  actual['verified']=local.verify_prepared(repository,sdk_frame,private)
  actual['baseline']=profile.scope.historical_baseline(actual['prepared']['predecessor'])
  return actual['verified']['sdkFactsForClosedReceipt']
 sdk_receipt=local.receipt.guarded(fixed_work,private,os.environ['GITHUB_SHA'])
 # This record is an SDK-only subaction before any original GCC start. The
 # native05Invoked=false field retains precisely that historical meaning.
 (Path(output)/'SDK-ONHOST-RECEIPT.json').write_bytes(local.receipt.canonical(sdk_receipt))
 require(sdk_receipt['sdkVerifiedOnHost'] is True,'Fixed SDK reconstruction/independent verification failed before GCC start')
 require(set(actual)=={'prepared','verified','baseline'},'Missing actual SDK constructor/reader/baseline result')
 sdk_scope={'privateRoot':private,'preparedControls':Path(actual['verified']['preparedSdkControls']),
  'historicalConfigureBaseline':actual['baseline'],'historicalSdkReceipt':sdk_receipt}
 profile.reserve_before_native(sdk_frame,sdk_scope,os.environ['GITHUB_SHA'])
 return {**actual['prepared'],'native05SdkScope':sdk_scope}
