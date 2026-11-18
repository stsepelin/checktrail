"""PROPOSAL: original SDK execution, local-only bodies, closed public receipt.

No action grant is included. This new source must receive fresh approval review,
including its <=16KiB public SDK-derived counts/hashes/status output. It does not
partially execute the rejected artifact operator. There is no exporter, artifact
client, summary/output-file writer, cache writer or caller-selected command.
"""
import contextlib
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import traceback

POLICY_SHA256='6f4b1a0d3ec3b509be871938118371d5a4d4a7a3b43ffb89f8221c799d02079b'
PREFIX=b'CHECKTRAIL_SDK_RECEIPT_V1 '
MAX_RECEIPT=16384
MAX_OPAQUE=16*1024**2
COUNTS={'packages','originalEntries','currentEntries','generatedOutputs','formats','generators','validators'}
HASHES={'sdkInventory','softwareProjection','generatedWitness','metadataFamily','sdkStdout','wrapperOutput'}
ERRORS={'none','operator-required','runtime-refused','source-refused','input-refused','sdk-incomplete','sdk-proof-refused',
        'cleanup-unconfirmed','local-output-limit','unexpected-failure'}
LIMITATIONS={'offHostRawCustody':False,'artifactUploads':0,'cacheWrites':0,'native05Invoked':False,
             'hostCapacityQualifiedForNative05':False,'fullServiceClockAccountingQualifiedForNative05':False,'gateAComplete':False}


class Refusal(Exception):
    def __init__(self,identifier):
        if identifier not in ERRORS or identifier=='none':raise ValueError('Unknown fixed refusal identifier')
        self.identifier=identifier


def require(value,identifier):
    if not value:raise Refusal(identifier)


def canonical(value):return (json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode()


def load(name):
    path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def file_pin(path,maximum):
    path=Path(path);before=path.lstat()
    require(stat.S_ISREG(before.st_mode) and not path.is_symlink() and before.st_size<=maximum,'sdk-proof-refused')
    digest=hashlib.sha256();size=0
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW),'rb') as source:
        require((os.fstat(source.fileno()).st_dev,os.fstat(source.fileno()).st_ino)==(before.st_dev,before.st_ino),'sdk-proof-refused')
        while True:
            block=source.read(65536)
            if not block:break
            size+=len(block);require(size<=maximum,'local-output-limit');digest.update(block)
    after=path.lstat()
    require((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==
            (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) and size==before.st_size,'sdk-proof-refused')
    return {'bytes':size,'sha256':digest.hexdigest()}


def read_json(path,maximum=2*1024**2):
    expected=file_pin(path,maximum);body=Path(path).read_bytes()
    require(len(body)<=maximum and hashlib.sha256(body).hexdigest()==expected['sha256'],'sdk-proof-refused')
    return json.loads(body)


def validate_receipt(value):
    keys={'schemaVersion','kind','sourceHead','sourcePolicySha256','errorId','sdkVerifiedOnHost','sdkContainerExitCode',
          'sdkContainerQuiescent','ownedSdkCleanupObserved','sdkContainerSeconds','helperSeconds','counts','hashes',*LIMITATIONS}
    require(type(value) is dict and set(value)==keys and type(value['schemaVersion']) is int and value['schemaVersion']==1 and value['kind']=='gcc-sdk-onhost-receipt-v1','sdk-proof-refused')
    require(type(value['sourceHead']) is str and re.fullmatch('[a-f0-9]{40}',value['sourceHead']) and
            value['sourcePolicySha256']==POLICY_SHA256 and value['errorId'] in ERRORS,'sdk-proof-refused')
    require(all(type(value[k]) is bool for k in ['sdkVerifiedOnHost','sdkContainerQuiescent','ownedSdkCleanupObserved']) and
            all(type(value[k]) is type(v) and value[k]==v for k,v in LIMITATIONS.items()),'sdk-proof-refused')
    require(value['sdkContainerExitCode'] is None or type(value['sdkContainerExitCode']) is int and 0<=value['sdkContainerExitCode']<=255,'sdk-proof-refused')
    require(type(value['helperSeconds']) in [int,float] and math.isfinite(value['helperSeconds']) and 0<=value['helperSeconds']<=21600,'sdk-proof-refused')
    require(value['sdkContainerSeconds'] is None or type(value['sdkContainerSeconds']) in [int,float] and
            math.isfinite(value['sdkContainerSeconds']) and 0<=value['sdkContainerSeconds']<=21600,'sdk-proof-refused')
    require(type(value['counts']) is dict and set(value['counts'])==COUNTS and
            all(type(v) is int and 0<=v<=10000000 for v in value['counts'].values()),'sdk-proof-refused')
    require(type(value['hashes']) is dict and set(value['hashes'])==HASHES and
            all(v is None or type(v) is str and re.fullmatch('[a-f0-9]{64}',v) for v in value['hashes'].values()),'sdk-proof-refused')
    if value['sdkVerifiedOnHost']:
        require(value['errorId']=='none' and value['sdkContainerExitCode']==0 and value['sdkContainerQuiescent'] and
                value['ownedSdkCleanupObserved'] and value['sdkContainerSeconds'] is not None and all(value['hashes'].values()) and value['counts']['packages']>0 and
                value['counts']['generatedOutputs']==51 and value['counts']['formats']==13,'sdk-proof-refused')
    else:require(value['errorId']!='none','sdk-proof-refused')
    require(len(PREFIX)+len(canonical(value))<=MAX_RECEIPT,'local-output-limit')
    return value


def empty_receipt(head):
    return {'schemaVersion':1,'kind':'gcc-sdk-onhost-receipt-v1','sourceHead':head if type(head) is str and re.fullmatch('[a-f0-9]{40}',head) else '0'*40,
            'sourcePolicySha256':POLICY_SHA256,'errorId':'unexpected-failure','sdkVerifiedOnHost':False,
            'sdkContainerExitCode':None,'sdkContainerQuiescent':False,'ownedSdkCleanupObserved':False,
            'sdkContainerSeconds':None,'helperSeconds':0,'counts':{k:0 for k in sorted(COUNTS)},
            'hashes':{k:None for k in sorted(HASHES)},**LIMITATIONS}


def failed_receipt(previous,identifier,elapsed):
    value=empty_receipt(previous['sourceHead']);value.update(errorId=identifier,helperSeconds=elapsed)
    observed={k:previous[k] for k in ['sdkContainerExitCode','sdkContainerQuiescent','ownedSdkCleanupObserved','sdkContainerSeconds']}
    try:return validate_receipt({**value,**observed})
    except BaseException:return validate_receipt(value)


@contextlib.contextmanager
def local_only_output(path):
    """Capture Python, OS writes and inherited child FDs; never tee any body."""
    saved=[os.dup(1),os.dup(2)];streams=[sys.stdout,sys.stderr]
    descriptor=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        for stream in streams:stream.flush()
        os.dup2(descriptor,1);os.dup2(descriptor,2)
        yield
    finally:
        # Flush raw text BEFORE restoring its public file descriptors, including
        # exceptional/SystemExit paths. The caller catches inside this boundary.
        for stream in streams:
            try:stream.flush()
            except BaseException:pass
        sys.stdout,sys.stderr=streams
        os.dup2(saved[0],1);os.dup2(saved[1],2)
        for fd in [*saved,descriptor]:os.close(fd)


def guarded(work,private,head):
    """Internal synthetic seam; production main supplies only fixed_work()."""
    started=time.monotonic();value=empty_receipt(head);log=private/'opaque-wrapper-output.log'
    with local_only_output(log):
        try:
            facts=work();require(type(facts) is dict and set(facts)=={'counts','hashes','sdkContainerExitCode','sdkContainerQuiescent','ownedSdkCleanupObserved','sdkContainerSeconds'},'sdk-proof-refused')
            require(time.monotonic()-started<=6600,'runtime-refused')
            value.update(facts,sdkVerifiedOnHost=True,errorId='none')
        except BaseException as error:
            traceback.print_exc()  # original exception and traceback stay LOCAL
            value=empty_receipt(head)
            value['errorId']=error.identifier if isinstance(error,Refusal) else 'input-refused' if isinstance(error,subprocess.TimeoutExpired) else 'unexpected-failure'
            attempt=private/'OWNED-SDK-ATTEMPT.json'
            if attempt.exists():
                try:
                    observed=read_json(attempt,65536)
                    require(set(observed)=={'sdkContainerExitCode','sdkContainerQuiescent','ownedSdkCleanupObserved','sdkContainerSeconds'},'sdk-proof-refused')
                    candidate={**value,**observed};validate_receipt(candidate);value=candidate
                except BaseException:traceback.print_exc()
    value['helperSeconds']=time.monotonic()-started
    try:value['hashes']['wrapperOutput']=file_pin(log,MAX_OPAQUE)['sha256']
    except BaseException:
        value=failed_receipt(value,'local-output-limit',time.monotonic()-started)
    # No exception, repr, pathname, child output or generic dictionary is emitted.
    try:return validate_receipt(value)
    except BaseException:
        with log.open('a') as sink:traceback.print_exc(file=sink)
        return failed_receipt(value,'sdk-proof-refused',time.monotonic()-started)


def fixed_work(private):
    policy_path=Path(__file__).with_name('gcc-sdk-receipt-policy.v1.json')
    require(file_pin(policy_path,65536)['sha256']==POLICY_SHA256,'source-refused');policy=read_json(policy_path)
    repository=Path(os.environ['GITHUB_WORKSPACE']);temporary=Path(os.environ['RUNNER_TEMP'])
    legacy=load('gcc-hosted-sdk.py');independent=load('gcc-main05-sdk.py')
    require(os.getuid()==0 and repository.is_absolute() and repository==repository.resolve() and
            temporary.is_absolute() and temporary==temporary.resolve(),'runtime-refused')
    legacy.h.verify_repository(repository,{'GITHUB_SHA':os.environ['GITHUB_SHA']})
    for row in policy['runtimeFiles']:
        path=repository/row['path'];require(file_pin(path,row['bytes'])=={k:row[k] for k in ['bytes','sha256']} and
                                            stat.S_IMODE(path.lstat().st_mode)==row['mode'],'source-refused')
    runtime=legacy.h.admit_host_node(json.loads(os.environ['CHECKTRAIL_HOST_NODE']),private)
    node=runtime['path'] if 'path' in runtime else json.loads(os.environ['CHECKTRAIL_HOST_NODE'])['path']
    commands=[['/usr/bin/docker','pull','--platform','linux/amd64',legacy.codec.IMAGE],
              [node,str(repository/'scripts/acquire-binutils-inputs.mjs'),'--output',str(temporary/'gcc-common-inputs'),'--operator-trust-execution'],
              [node,str(repository/'scripts/acquire-c-producer-inputs.mjs'),'--profile','gcc-12','--common-inputs',str(temporary/'gcc-common-inputs/bundle'),'--output',str(temporary/'gcc-inputs')]]
    input_start=time.monotonic()
    for command in commands:
        remaining=policy['inputPreparationSeconds']-(time.monotonic()-input_start);require(remaining>0,'input-refused')
        # Output inherits the already-private FDs. Original fixed acquisition
        # programs/commands remain unchanged; no exception is printed publicly.
        completed=subprocess.run(command,cwd=repository,timeout=remaining,stdin=subprocess.DEVNULL,check=False)
        require(completed.returncode==0,'input-refused')
        require((private/'opaque-wrapper-output.log').stat().st_size<=MAX_OPAQUE,'local-output-limit')
    output=temporary/'gcc-sdk-reconstruction';require(not os.path.lexists(output),'runtime-refused');saved=sys.argv
    try:
        sys.argv=[str(Path(legacy.__file__)), '--repository',str(repository),'--inputs',str(temporary/'gcc-inputs/bundle'),
                  '--output',str(output),'--operator-trust-execution']
        legacy.main()  # capture ONLY. Never invoke the rejected export mode.
    except BaseException as error:raise Refusal('sdk-incomplete') from error
    finally:
        sys.argv=saved
        # Read only this freshly entered R3 call's actual container observation.
        # A later metadata/cleanup failure cannot reset observed elapsed time or
        # replace a genuine container exit with the outer helper's exit code.
        retain_attempt(output,private)
    return verify_on_host(output,private,policy,independent)


def retain_attempt(output,private):
    facts={'sdkContainerExitCode':None,'sdkContainerQuiescent':False,'ownedSdkCleanupObserved':False,'sdkContainerSeconds':None}
    carrier=read_json(output/'SDK-CARRIER.json') if (output/'SDK-CARRIER.json').is_file() else {}
    attempt=read_json(output/'ATTEMPT.json') if (output/'ATTEMPT.json').is_file() else {}
    observed=carrier.get('observed',{});state=observed.get('containerState',attempt.get('containerState'))
    elapsed=observed.get('nativeSeconds',attempt.get('elapsedSeconds'))
    if type(elapsed) in [int,float] and math.isfinite(elapsed) and 0<=elapsed<=21600:facts['sdkContainerSeconds']=elapsed
    if type(state) is dict and state.get('Running') is False and type(state.get('Pid')) is int and state['Pid']==0 and state.get('Status')=='exited':
        facts['sdkContainerQuiescent']=True
        if type(state.get('ExitCode')) is int and 0<=state['ExitCode']<=255:facts['sdkContainerExitCode']=state['ExitCode']
    facts['ownedSdkCleanupObserved']=carrier.get('ownedContainerCleanup')=='removed' and carrier.get('ownedSeedCleanup')=='removed'
    target=private/'OWNED-SDK-ATTEMPT.json'
    with target.open('xb') as sink:sink.write(canonical(facts))


def verify_on_host(output,private,policy,independent):
    carrier=read_json(output/'SDK-CARRIER.json');root=read_json(output/'checkpoint/CHECKPOINT-ROOT.json')
    require(carrier['state']=='sdk-material-reconstruction-observed-no-gcc-target-run' and
            carrier['ownedContainerCleanup']=='removed' and carrier['ownedSeedCleanup']=='removed' and
            carrier['originalGccTargetInvoked'] is False and carrier['originalPhaseAdvanced'] is False,'cleanup-unconfirmed')
    observed=carrier['observed'];state=observed['containerState']
    require(observed['quiescenceObserved'] is True and state['Running'] is False and state['Pid']==0 and
            state['Status']=='exited' and state['ExitCode']==0 and state['OOMKilled'] is False and not state['Error'],'sdk-proof-refused')
    controls=private/'independent-sdk-controls';controls.mkdir(mode=0o700)
    independent.stage_metadata(output,controls,root)
    original=read_json(output/'predecessor/__carrier_work/external-sdk-before.json',256*1024**2)
    verified=independent.read_prepared(controls,original,root)
    proof=read_json(output/'observations/SDK-RECONSTRUCTION.json');apt=proof['preparation']
    require(apt['command']==policy['originalOfflineAptCommand'] and apt['state']=='terminal' and apt['exitCode']==0 and
            apt['signal'] is None and apt['terminalObserved'] is True,'sdk-proof-refused')
    packages=output/'observations/installed-package-identities.txt';pin=file_pin(packages,1024**2)
    require(pin['sha256']==root['binding']['packageInventorySha256'],'sdk-proof-refused')
    generation=read_json(output/'observations/SDK-DERIVED-GENERATION.json');validation=read_json(output/'observations/SDK-DERIVED-VALIDATION.json')
    family={name:file_pin(path,32*1024**2) for name,path in
            sorted((p.name,p) for p in (controls/'prepared-sdk').iterdir())}
    hashes={'sdkInventory':hashlib.sha256(independent.stage.canonical(verified['inventory'])).hexdigest(),
            'softwareProjection':hashlib.sha256(canonical(verified['softwareProjection'])).hexdigest(),
            'generatedWitness':hashlib.sha256(canonical(verified['finalGeneratedWitness'])).hexdigest(),
            'metadataFamily':hashlib.sha256(canonical(family)).hexdigest(),
            'sdkStdout':file_pin(output/'native.log',policy['originalSdkStdoutBytes'])['sha256'],'wrapperOutput':None}
    return {'counts':{'packages':len(packages.read_bytes().splitlines()),'originalEntries':len(original['entries']),
                      'currentEntries':len(verified['inventory']['entries']),'generatedOutputs':len(validation['finalGeneratedIdentities']),
                      'formats':len(generation['newlyGeneratedOutputs']),'generators':len(generation['generatorCommands']),
                      'validators':len(validation['validators'])},'hashes':hashes,'sdkContainerExitCode':state['ExitCode'],
            'sdkContainerQuiescent':True,'ownedSdkCleanupObserved':True,'sdkContainerSeconds':observed['nativeSeconds']}


def main():
    # Only a separately reviewed operator may run this fixed process entry. No
    # MCP/tool argument selects the command, phase, SDK policy or disclosure.
    head=os.environ.get('GITHUB_SHA');value=empty_receipt(head)
    try:
        require(sys.argv==[sys.argv[0],'qualify-on-host','--operator-trust-execution'],'operator-required')
        root=Path(os.environ['RUNNER_TEMP']);require(root.is_absolute() and root==root.resolve(),'runtime-refused')
        private=root/'gcc-sdk-receipt-private';private.mkdir(mode=0o700)
        value=guarded(lambda:fixed_work(private),private,head)
    except BaseException as error:
        # Even entry/admission failures have no raw exception or traceback channel.
        value=empty_receipt(head);value['errorId']=error.identifier if isinstance(error,Refusal) else 'runtime-refused'
    os.write(1,PREFIX+canonical(validate_receipt(value)))
    return 0 if value['sdkVerifiedOnHost'] else 1


def entry():
    # A broken output sink or an unforeseen error in admission/emission may
    # withhold the receipt, but must not open Python's public traceback channel.
    try:return main()
    except BaseException:return 1


if __name__=='__main__':raise SystemExit(entry())
