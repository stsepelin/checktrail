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
import shutil
import subprocess
import sys
import tempfile
import time
import traceback

POLICY_SHA256='891d71bc936bdccf0875a2385abedcfdf22b365cb51345836b8d7f628e5f9242'
PREFIX=b'CHECKTRAIL_SDK_RECEIPT_V1 '
MAX_RECEIPT=16384
MAX_OPAQUE=16*1024**2
COUNTS={'packages','originalEntries','currentEntries','generatedOutputs','formats','generators','validators'}
HASHES={'sdkInventory','softwareProjection','generatedWitness','metadataFamily','sdkStdout','wrapperOutput'}
ERRORS={'none','operator-required','runtime-refused','source-refused','input-refused','sdk-incomplete','sdk-proof-refused',
        'cleanup-unconfirmed','local-output-limit','unexpected-failure'}
LIMITATIONS={'offHostRawCustody':False,'artifactUploads':0,'cacheWrites':0,'native05Invoked':False,
             'hostCapacityQualifiedForNative05':False,'fullServiceClockAccountingQualifiedForNative05':False,'gateAComplete':False}

# Only fixed first-party milestones and exact whole refusal literals leave the
# runner. A last recorded milestone does not identify the failing instruction,
# prove a native command began, or prove an unobserved command never began.
STAGES={'entry','runtime-source-validation','image-acquisition','common-input-acquisition','gcc-input-acquisition',
        'legacy-sdk-capture','independent-verification','complete','unavailable'}
MILESTONES={'not-observed','source-recorded','predecessor-cache-recorded','keyring-recorded','image-recorded',
            'seed-cleanup-recorded','material-reconstruction-recorded','unavailable'}
EXCEPTION_TYPES={ValueError:'value-error',KeyError:'key-error',TypeError:'type-error',FileNotFoundError:'file-not-found',
                 PermissionError:'permission-error',OSError:'os-error',RuntimeError:'runtime-error',
                 subprocess.TimeoutExpired:'timeout-expired',subprocess.CalledProcessError:'called-process-error',
                 json.JSONDecodeError:'json-decode-error',SystemExit:'system-exit',KeyboardInterrupt:'keyboard-interrupt'}
REFUSALS={
 'Wrong fixed carrier job':'service-job-context',
 'Ambiguous carrier job identity':'service-job-identity',
 'Wrong fixed public hosted context':'service-context',
 'Service run differs from reviewed manual diagnostic checkout':'service-run-context',
 'Incomplete service job inventory':'service-job-inventory',
 'SDK reconstruction host/scratch capacity unavailable':'sdk-host-capacity',
 'SDK source clock/free-included storage unavailable':'sdk-service-capacity',
 'Predecessor cache requires the same diagnostic branch':'predecessor-ref',
 'Exact predecessor cache action did not hit':'predecessor-cache-miss',
 'Bounded predecessor cache inventory missing':'predecessor-cache-inventory',
 'Original predecessor cache identity differs':'predecessor-cache-identity',
 'Exact predecessor transport members required':'predecessor-members',
 'Predecessor typed root/source binding differs':'predecessor-binding',
 'Physical original configure stamp missing':'predecessor-stamp',
 'Predecessor cannot skip or replace an original phase':'predecessor-ledger',
 'Physical predecessor configuration differs':'predecessor-configuration',
 'Original producer catalog differs':'producer-catalog',
 'Original SDK image/environment differs':'sdk-image-environment',
 'Authenticated old SDK inventory missing before read-only input preparation':'predecessor-sdk-inventory',
 'Original read-only keyring bytes differ':'keyring-bytes',
 'Read-only keyring preparation changed bytes/ownership/mode':'keyring-replay',
 'Wrong native Docker daemon CPU/architecture/memory':'docker-host-capacity',
 'Remote/rootless daemon cannot use measured local capacity':'docker-locality',
 'Actual Docker memory/CPU/PID enforcement unavailable':'docker-enforcement',
 'Unknown seed ownership':'seed-ownership',
 'SDK container ownership differs':'sdk-container-ownership',
 'Fixed SDK command/environment differs':'sdk-command-environment',
 'SDK limits or pre-start lifecycle differs':'sdk-container-admission',
 'Unknown/duplicate SDK mount':'sdk-duplicate-mount',
 'SDK read-only predecessor/scratch mount map differs':'sdk-mounts',
 'SDK provisioning modified the immutable predecessor':'predecessor-modified',
 'SDK source body did not prove material reconstruction':'sdk-material-proof',
 'Unknown SDK cleanup ownership':'sdk-cleanup-ownership',
 'Native Linux AMD64 host required':'stock-host-architecture',
 'Wrong stock Linux release':'stock-host-release',
 'Missing bounded operator GitHub token':'service-token-missing',
 'Unexpected GitHub service response':'service-response',
 'Oversized service response':'service-response-bound',
 'Unpaid repository cache ceiling is absent or exceeds 10 GB':'service-cache-policy',
 'Complete cache inventory unavailable':'service-cache-inventory',
 'Unknown stock Ubuntu 26.04 service job':'service-job-runner',
 'Source hosted job deadline exhausted or in future':'service-job-clock'}
DIAGNOSTIC_KEYS={'stage','lastLegacyMilestone','exceptionType','refusalId','errorSha256'}


def empty_diagnostics():
    return {'stage':'entry','lastLegacyMilestone':'not-observed','exceptionType':'none','refusalId':'none','errorSha256':None}


def record_stage(private,stage):
    require(stage in STAGES and stage not in {'unavailable','complete'},'sdk-proof-refused')
    (private/'CLOSED-STAGE.json').write_bytes(canonical({'stage':stage}))


def failure_diagnostics(private,error):
    value=empty_diagnostics()
    try:
        if private is not None and (private/'CLOSED-STAGE.json').exists():
            stage=read_json(private/'CLOSED-STAGE.json',4096)
            require(type(stage) is dict and set(stage)=={'stage'} and stage['stage'] in STAGES,'sdk-proof-refused')
            value['stage']=stage['stage']
    except BaseException:value['stage']='unavailable'
    # This freshly fixed legacy output path is never read from a caller value.
    # Inspect only fixed key presence/value; never project any raw nested row.
    if value['stage']=='legacy-sdk-capture':
        try:
            path=Path(os.environ['RUNNER_TEMP'])/'gcc-sdk-reconstruction/SDK-CARRIER.json'
            carrier=read_json(path) if path.is_file() else {}
            require(type(carrier) is dict,'sdk-proof-refused')
            for key,label in [('source','source-recorded'),('predecessorCache','predecessor-cache-recorded'),
                              ('readOnlyKeyring','keyring-recorded'),('image','image-recorded')]:
                if type(carrier.get(key)) is dict:value['lastLegacyMilestone']=label
            if carrier.get('ownedSeedCleanup')=='removed':value['lastLegacyMilestone']='seed-cleanup-recorded'
            if carrier.get('state')=='sdk-material-reconstruction-observed-no-gcc-target-run':
                value['lastLegacyMilestone']='material-reconstruction-recorded'
        except BaseException:value['lastLegacyMilestone']='unavailable'
    underlying=error.__cause__ if type(error) is Refusal and error.identifier=='sdk-incomplete' and error.__cause__ is not None else error
    value['exceptionType']='wrapper-refusal' if type(underlying) is Refusal else EXCEPTION_TYPES.get(type(underlying),'other')
    value['refusalId']='unclassified'
    try:
        message=str(underlying)
        if type(message) is str and len(message)<=65536:
            value['errorSha256']=hashlib.sha256(message.encode('utf-8',errors='replace')).hexdigest()
            # h.require raises EXACT ValueError. Subclasses and decorated or
            # partial strings cannot borrow a first-party refusal identity.
            if type(underlying) is ValueError:value['refusalId']=REFUSALS.get(message,'unclassified')
    except BaseException:pass
    return value


class Refusal(Exception):
    def __init__(self,identifier):
        if identifier not in ERRORS or identifier=='none':raise ValueError('Unknown fixed refusal identifier')
        self.identifier=identifier


def require(value,identifier):
    if not value:raise Refusal(identifier)


def canonical(value):return (json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode()


# The operator entry loads no sibling until fixed_work() has pinned the policy,
# the checkout and every policy runtimeFiles byte. Startup verification is
# therefore stdlib-only: a stale sibling's module code never runs as root
# before its mismatch is refused. Offline readers that import this module
# without main() keep the ordinary lazy load.
ADMISSION={'entry':False,'runtimeFilesVerified':False}
# Every first-party file the fixed work loads or executes, transitively. Each
# must be a policy runtimeFiles row before ADMISSION allows the first load.
RUNTIME_SIBLINGS=['scripts/producer-qualification/'+name for name in [
 'gcc-sdk-structured-diagnostics.py','gcc-hosted-sdk.py','gcc-main05-sdk.py','gcc-hosted-carrier.py',
 'gcc-hosted-phase0-capacity.py','gcc-hosted-capacity.py','gcc-phase0-transport.py','gcc-hosted-stage.py',
 'gcc-staged-checkpoint.py','gcc-staged-plan.py','gcc-sdk-material.py','gcc-sdk-derived.py','gcc-sdk-derived-run.py',
 'binutils-image-identity.mjs','binutils-acquisition-plan.mjs','binutils-retention-observer.mjs','c-producer-profile.mjs']]+[
 'scripts/acquire-binutils-inputs.mjs','scripts/acquire-c-producer-inputs.mjs','scripts/qualify-binutils-producer.mjs']
SIBLINGS={}
# After admission every first-party file runs from a private copy of the
# verified bytes, never from the runner-owned checkout, which can change
# while this root process runs. The copy lives in a fresh root directory
# under a sticky parent, so the runner user can neither edit nor rename it.
STAGING_PARENT='/tmp'
VERIFIED={}


def sibling(name):
    require(not ADMISSION['entry'] or ADMISSION['runtimeFilesVerified'] and 'root' in VERIFIED,'source-refused')
    folder=VERIFIED['root']/'scripts/producer-qualification' if 'root' in VERIFIED else Path(__file__).parent
    path=folder/name;spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def load(name):return sibling(name)


def structured_diagnostics():
    if 'structured' not in SIBLINGS:SIBLINGS['structured']=sibling('gcc-sdk-structured-diagnostics.py')
    return SIBLINGS['structured']


# Byte-for-byte canonical twin of structured_diagnostics().empty(), so a receipt
# emitted before any sibling may load still carries the closed unobserved value.
UNOBSERVED_STRUCTURED_SDK={
 'schemaVersion':1,'state':'unobserved','errorId':'none','cause':'unestablished',
 'sdkQualifiedByProjection':False,'underlyingRootCauseAssessed':False,
 'unjournaledCollectionAndNormalizationTerminals':'unobserved',
 'hashes':{'journal':None,'sdk':None,'generation':None,'validation':None,'comparison':None},
 'journal':{'state':'unobserved','expectedSlots':74,'requested':None,'terminals':None,'terminalZero':None,
            'terminalNonzero':None,'terminalUnknown':None,'lastRequested':None,'lastTerminal':None},
 'mapping':{'state':'unobserved','layout':'unobserved','separatorScope':'document-and-complete-record-boundaries',
            'sourceBound':False,'stdoutSha256':None,'layoutCompatible':None,'totalLines':None,'blankLines':None,
            'headerLines':None,'prefixLines':None,'bodyLines':None,'recognizedRecords':None,'unknownRecords':None,
            'duplicateRecords':None,'missingRecords':None,'semanticMismatchRecords':None,'boundaryBlankLines':None,
            'documentBlankLines':None,'misplacedBlankLines':None,'unknownLines':None,'status0TrailerLines':None,
            'misplacedStatus0TrailerLines':None,'separatorBoundaries':None},
 'nonRecordMappingRows':{'state':'unobserved','sourceBound':False,'stdoutSha256':None,'totalRows':None,
                         'retainedRows':None,'omittedRows':None,'categoryCounts':None,'rows':[]},
 'sdk':{'state':'unobserved','packagesMatch':None,'entries':None,'counts':None,'materialProjectionMatches':None,'generatedComplete':None},
 'generation':{'state':'unobserved','toolIdentities':None,'removedOutputs':None,'completedGenerators':None,'freshFormats':None,'errorSha256':None},
 'validation':{'state':'unobserved','completedValidators':None,'finalGeneratedOutputs':None,'errorSha256':None}}


def unobserved_structured():
    return json.loads(canonical(UNOBSERVED_STRUCTURED_SDK))


def validate_structured(value):
    # Canonical bytes, not ==: 0 and False compare equal in Python, so only the
    # exact JSON-typed unobserved value skips the full closed decoder.
    if canonical(value)==canonical(UNOBSERVED_STRUCTURED_SDK):return value
    return structured_diagnostics().validate(value)


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
    return _validate_receipt(value,POLICY_SHA256)


def validate_historical_v5_receipt(value):
    return _validate_receipt(value,'53e78d4937950c42fdddbcccacbb37b49b84d881ebd16e0f6397b69bad5232e9')


def validate_historical_v4_receipt(value):
    return _validate_receipt(value,'d3d3df6c5ab0a92b99cd847444750e80f50c5959a42ed4462cce73d9f58d1c58')


def _validate_receipt(value,expected_policy):
    keys={'schemaVersion','kind','sourceHead','sourcePolicySha256','errorId','sdkVerifiedOnHost','sdkContainerExitCode',
          'sdkContainerQuiescent','ownedSdkCleanupObserved','sdkContainerSeconds','helperSeconds','counts','hashes','diagnostics','structuredSdk',*LIMITATIONS}
    require(type(value) is dict and set(value)==keys and type(value['schemaVersion']) is int and value['schemaVersion']==1 and value['kind']=='gcc-sdk-onhost-receipt-v1','sdk-proof-refused')
    require(type(value['sourceHead']) is str and re.fullmatch('[a-f0-9]{40}',value['sourceHead']) and
            value['sourcePolicySha256']==expected_policy and value['errorId'] in ERRORS,'sdk-proof-refused')
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
    try:validate_structured(value['structuredSdk'])
    except BaseException:require(False,'sdk-proof-refused')
    diagnostics=value['diagnostics']
    require(type(diagnostics) is dict and set(diagnostics)==DIAGNOSTIC_KEYS and diagnostics['stage'] in STAGES and
            diagnostics['lastLegacyMilestone'] in MILESTONES and
            diagnostics['exceptionType'] in {'none','other','wrapper-refusal',*EXCEPTION_TYPES.values()} and
            diagnostics['refusalId'] in {'none','unclassified',*REFUSALS.values()} and
            (diagnostics['errorSha256'] is None or type(diagnostics['errorSha256']) is str and
             re.fullmatch('[a-f0-9]{64}',diagnostics['errorSha256'])),'sdk-proof-refused')
    if value['sdkVerifiedOnHost']:
        require(value['errorId']=='none' and value['sdkContainerExitCode']==0 and value['sdkContainerQuiescent'] and
                value['ownedSdkCleanupObserved'] and value['sdkContainerSeconds'] is not None and
                diagnostics=={**empty_diagnostics(),'stage':'complete'} and all(value['hashes'].values()) and value['counts']['packages']>0 and
                value['counts']['generatedOutputs']==51 and value['counts']['formats']==13,'sdk-proof-refused')
    else:require(value['errorId']!='none','sdk-proof-refused')
    require(len(PREFIX)+len(canonical(value))<=MAX_RECEIPT,'local-output-limit')
    return value


def empty_receipt(head):
    return {'schemaVersion':1,'kind':'gcc-sdk-onhost-receipt-v1','sourceHead':head if type(head) is str and re.fullmatch('[a-f0-9]{40}',head) else '0'*40,
            'sourcePolicySha256':POLICY_SHA256,'errorId':'unexpected-failure','sdkVerifiedOnHost':False,
            'sdkContainerExitCode':None,'sdkContainerQuiescent':False,'ownedSdkCleanupObserved':False,
            'sdkContainerSeconds':None,'helperSeconds':0,'counts':{k:0 for k in sorted(COUNTS)},
            'hashes':{k:None for k in sorted(HASHES)},'diagnostics':empty_diagnostics(),'structuredSdk':unobserved_structured(),**LIMITATIONS}


def failed_receipt(previous,identifier,elapsed):
    value=empty_receipt(previous['sourceHead']);value.update(errorId=identifier,helperSeconds=elapsed)
    value['diagnostics']=previous['diagnostics'];value['structuredSdk']=previous['structuredSdk']
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
            value.update(facts,sdkVerifiedOnHost=True,errorId='none',diagnostics={**empty_diagnostics(),'stage':'complete'})
        except BaseException as error:
            traceback.print_exc()  # original exception and traceback stay LOCAL
            value=empty_receipt(head)
            value['errorId']=error.identifier if isinstance(error,Refusal) else 'input-refused' if isinstance(error,subprocess.TimeoutExpired) else 'unexpected-failure'
            value['diagnostics']=failure_diagnostics(private,error)
            attempt=private/'OWNED-SDK-ATTEMPT.json'
            if attempt.exists():
                try:
                    observed=read_json(attempt,65536)
                    require(set(observed)=={'sdkContainerExitCode','sdkContainerQuiescent','ownedSdkCleanupObserved','sdkContainerSeconds'},'sdk-proof-refused')
                    candidate={**value,**observed};validate_receipt(candidate);value=candidate
                except BaseException:traceback.print_exc()
        projection=private/'OWNED-STRUCTURED-SDK.json'
        if projection.exists():
            try:value['structuredSdk']=validate_structured(read_json(projection,8192))
            except BaseException:
                value['structuredSdk']=unobserved_structured();value['structuredSdk'].update(state='invalid',errorId='record-unavailable')
    value['helperSeconds']=time.monotonic()-started
    try:value['hashes']['wrapperOutput']=file_pin(log,MAX_OPAQUE)['sha256']
    except BaseException:
        value=failed_receipt(value,'local-output-limit',time.monotonic()-started)
    # No exception, repr, pathname, child output or generic dictionary is emitted.
    try:return validate_receipt(value)
    except BaseException:
        with log.open('a') as sink:traceback.print_exc(file=sink)
        return failed_receipt(value,'sdk-proof-refused',time.monotonic()-started)


# Git runs as root here: no system or global configuration, no attribute
# files outside the checkout, no fetch of a missing promised object, and a
# repository whose own configuration names a program git could run while
# reading the tree is refused before git starts.
CHECKOUT_ENV={'PATH':'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
              'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_ATTR_NOSYSTEM':'1','GIT_OPTIONAL_LOCKS':'0',
              'GIT_TERMINAL_PROMPT':'0','GIT_NO_LAZY_FETCH':'1','GIT_NO_REPLACE_OBJECTS':'1','GIT_ALLOW_PROTOCOL':''}
GIT_CONFIG_BYTES=1024**2
GIT_EXECUTABLE_KEYS={('filter','clean'),('filter','smudge'),('filter','process'),('diff','textconv'),('diff','command'),
                     ('diff','external'),('core','fsmonitor'),('core','hookspath'),('include','path'),('includeif','path')}


def git_config_keys(raw):
    """(section, name) of every variable in a git config, read as data in git's
    own syntax; same-line variables after a header, quoting and backslash
    continuations included. Anything unparseable is refused, never guessed."""
    try:text=raw.decode('utf-8')
    except UnicodeDecodeError:raise Refusal('source-refused')
    keys=[];section=None;index=0;size=len(text)
    while index<size:
        char=text[index]
        if char in ' \t\r\n':index+=1
        elif char in '#;':
            while index<size and text[index]!='\n':index+=1
        elif char=='[':
            index+=1;start=index
            while index<size and (text[index].isalnum() or text[index] in '-.'):index+=1
            name=text[start:index];require(name,'source-refused')
            if index<size and text[index] in ' \t':
                while index<size and text[index] in ' \t':index+=1
                require(index<size and text[index]=='"','source-refused');index+=1
                while True:
                    require(index<size and text[index]!='\n','source-refused')
                    if text[index]=='\\':
                        require(index+1<size and text[index+1]!='\n','source-refused');index+=2
                    elif text[index]=='"':index+=1;break
                    else:index+=1
            require(index<size and text[index]==']','source-refused');index+=1
            # Git keys split at the first dot: [filter.x] and [filter.x "y"] are both the filter section.
            section=name.split('.',1)[0].lower()
        elif char.isalpha():
            start=index
            while index<size and (text[index].isalnum() or text[index]=='-'):index+=1
            require(section is not None,'source-refused');keys.append((section,text[start:index].lower()))
            while index<size and text[index] in ' \t':index+=1
            if index<size and text[index]=='=':
                index+=1;quoted=False
                while index<size and text[index]!='\n':
                    if text[index]=='\\':
                        require(index+1<size,'source-refused')
                        if text[index+1]=='\r' and text[index+2:index+3]=='\n':index+=3
                        else:require(text[index+1]=='\n' or text[index+1] in 'ntb"\\','source-refused');index+=2
                    elif text[index]=='"':quoted=not quoted;index+=1
                    elif text[index] in '#;' and not quoted:
                        while index<size and text[index]!='\n':index+=1
                    else:index+=1
                require(not quoted,'source-refused')
            else:require(index>=size or text[index] in '\r\n#;','source-refused')
        else:raise Refusal('source-refused')
    return keys


def read_git_metadata(path):
    # Nonblocking, so a FIFO is refused by the type check instead of waiting.
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|getattr(os,'O_CLOEXEC',0)),'rb') as stream:
        require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode),'source-refused');raw=stream.read(GIT_CONFIG_BYTES+1)
    require(len(raw)<=GIT_CONFIG_BYTES,'source-refused');return raw


def git_config_files(repository):
    """Configuration files git would read for this checkout, found without git."""
    dotgit=repository/'.git';kind=os.lstat(dotgit).st_mode
    if stat.S_ISDIR(kind):gitdir=dotgit
    else:
        require(stat.S_ISREG(kind),'source-refused');line=git_metadata_line(read_git_metadata(dotgit))
        require(line.startswith('gitdir: '),'source-refused');gitdir=repository/line[len('gitdir: '):]
    common=gitdir
    if os.path.lexists(gitdir/'commondir'):common=gitdir/git_metadata_line(read_git_metadata(gitdir/'commondir'))
    # A linked worktree's own config.worktree is in its gitdir; the common one belongs to the main worktree.
    return [common/'config',*([gitdir/'config.worktree'] if os.path.lexists(gitdir/'config.worktree') else [])]


def git_metadata_line(raw):
    # Git trims only line terminators here; spaces are part of the path.
    line=raw.decode('utf-8').rstrip('\r\n')
    require(line and not any(char in line for char in '\r\n\0'),'source-refused');return line


def refuse_executable_git_config(repository):
    try:files=[read_git_metadata(path) for path in git_config_files(repository)]
    except (OSError,UnicodeDecodeError):raise Refusal('source-refused')
    for raw in files:
        require(all(key not in GIT_EXECUTABLE_KEYS for key in git_config_keys(raw)),'source-refused')


def verify_checkout(repository,head):
    """Stdlib-only checkout identity: only /usr/bin/git runs, never project code."""
    require(type(head) is str and re.fullmatch('[a-f0-9]{40}',head),'source-refused')
    refuse_executable_git_config(repository)
    git=['/usr/bin/git','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','core.attributesFile=/dev/null',
         '-c','safe.directory='+str(repository),'--no-optional-locks']
    observed=subprocess.run([*git,'rev-parse','HEAD'],cwd=repository,env=CHECKOUT_ENV,stdin=subprocess.DEVNULL,
                            capture_output=True,timeout=10,check=False)
    require(observed.returncode==0 and observed.stdout.decode(errors='replace').strip()==head,'source-refused')
    clean=subprocess.run([*git,'diff','--no-ext-diff','--no-textconv','--quiet','HEAD','--'],cwd=repository,env=CHECKOUT_ENV,
                         stdin=subprocess.DEVNULL,capture_output=True,timeout=10,check=False)
    require(clean.returncode==0,'source-refused')


def pinned_bytes(path,maximum):
    """(bytes, mode) of one bounded regular file, read once through a no-follow descriptor."""
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|getattr(os,'O_CLOEXEC',0)),'rb') as source:
        opened=os.fstat(source.fileno());require(stat.S_ISREG(opened.st_mode) and opened.st_size<=maximum,'source-refused')
        body=source.read(maximum+1)
    require(len(body)==opened.st_size,'source-refused');return body,stat.S_IMODE(opened.st_mode)


def verify_runtime_files(repository,policy):
    """The pinned bytes and mode of every runtimeFiles row, keyed by relative path."""
    rows=policy['runtimeFiles'];require(type(rows) is list and rows,'source-refused');verified={}
    for row in rows:
        require(type(row) is dict and type(row.get('path')) is str and not row['path'].startswith('/') and
                all(part not in ['','.','..'] for part in row['path'].split('/')) and row['path'] not in verified,'source-refused')
        # A grown, shrunk or special file is the same source refusal as a changed one.
        try:body,mode=pinned_bytes(repository/row['path'],row['bytes'])
        except (Refusal,OSError):body,mode=None,None
        require(body is not None and len(body)==row['bytes'] and hashlib.sha256(body).hexdigest()==row['sha256'] and mode==row['mode'],'source-refused')
        verified[row['path']]=(body,mode)
    return verified


def stage_verified(files):
    """Write the verified files into a fresh private tree: files 0444 (0555 when
    pinned executable), directories 0555, the root itself 0700."""
    parent=Path(os.path.realpath(STAGING_PARENT));info=parent.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid in (0,os.geteuid()) and
            (info.st_mode&stat.S_ISVTX or not info.st_mode&0o022),'runtime-refused')
    root=Path(tempfile.mkdtemp(prefix='checktrail-gcc-sdk-verified-',dir=parent));VERIFIED['root']=root
    # -B stops bytecode writes, not reads. A cache prefix inside this private
    # root names a directory that never exists and nobody else can create.
    sys.pycache_prefix=str(root/'no-bytecode-cache')
    for relative,(body,mode) in sorted(files.items()):
        target=root/relative;target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        with os.fdopen(os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb') as sink:sink.write(body)
        os.chmod(target,0o555 if mode&0o111 else 0o444)
    for directory in sorted({folder for relative in files for folder in (root/relative).parents if root in folder.parents},
                            key=lambda folder:len(folder.parts),reverse=True):os.chmod(directory,0o555)
    return root


def remove_staged():
    """Remove the staged files but keep the empty private root: the bytecode
    cache prefix still names a path inside it, which nobody else can create."""
    root=VERIFIED.pop('root',None)
    if root is None:return
    for folder,_,_ in os.walk(root):os.chmod(folder,0o700)
    for child in list(root.iterdir()):shutil.rmtree(child) if child.is_dir() and not child.is_symlink() else child.unlink()


def fixed_work(private):
    record_stage(private,'runtime-source-validation')
    policy_relative='scripts/producer-qualification/gcc-sdk-receipt-policy.v1.json'
    # The policy is read once; these bytes are both checked and parsed.
    policy_raw,policy_mode=pinned_bytes(Path(__file__).with_name('gcc-sdk-receipt-policy.v1.json'),65536)
    require(hashlib.sha256(policy_raw).hexdigest()==POLICY_SHA256,'source-refused');policy=json.loads(policy_raw)
    repository=Path(os.environ['GITHUB_WORKSPACE']);temporary=Path(os.environ['RUNNER_TEMP'])
    require(os.getuid()==0 and repository.is_absolute() and repository==repository.resolve() and
            temporary.is_absolute() and temporary==temporary.resolve(),'runtime-refused')
    # Siblings load from this file's own directory, so it must be the exact
    # checkout location whose bytes the policy rows pin.
    require(Path(__file__).resolve().parent==repository/'scripts/producer-qualification','source-refused')
    verify_checkout(repository,os.environ['GITHUB_SHA'])
    verified=verify_runtime_files(repository,policy)
    require(set(RUNTIME_SIBLINGS)<=set(verified) and policy_relative not in verified,'source-refused')
    staged=stage_verified({**verified,policy_relative:(policy_raw,policy_mode)})
    ADMISSION['runtimeFilesVerified']=True
    legacy=load('gcc-hosted-sdk.py');legacy.VERIFIED_COPY=True;independent=load('gcc-main05-sdk.py');structured_diagnostics()
    runtime=legacy.h.admit_host_node(json.loads(os.environ['CHECKTRAIL_HOST_NODE']),private)
    node=runtime['path'] if 'path' in runtime else json.loads(os.environ['CHECKTRAIL_HOST_NODE'])['path']
    commands=[['/usr/bin/docker','pull','--platform','linux/amd64',legacy.codec.IMAGE],
              [node,str(staged/'scripts/acquire-binutils-inputs.mjs'),'--output',str(temporary/'gcc-common-inputs'),'--operator-trust-execution'],
              [node,str(staged/'scripts/acquire-c-producer-inputs.mjs'),'--profile','gcc-12','--common-inputs',str(temporary/'gcc-common-inputs/bundle'),'--output',str(temporary/'gcc-inputs')]]
    input_start=time.monotonic()
    for stage,command in zip(['image-acquisition','common-input-acquisition','gcc-input-acquisition'],commands):
        record_stage(private,stage)
        remaining=policy['inputPreparationSeconds']-(time.monotonic()-input_start);require(remaining>0,'input-refused')
        # Output inherits the already-private FDs. Original fixed acquisition
        # programs/commands remain unchanged; no exception is printed publicly.
        completed=subprocess.run(command,cwd=staged,timeout=remaining,stdin=subprocess.DEVNULL,check=False)
        require(completed.returncode==0,'input-refused')
        require((private/'opaque-wrapper-output.log').stat().st_size<=MAX_OPAQUE,'local-output-limit')
    output=temporary/'gcc-sdk-reconstruction';require(not os.path.lexists(output),'runtime-refused');saved=sys.argv
    try:
        record_stage(private,'legacy-sdk-capture')
        sys.argv=[str(Path(legacy.__file__)), '--repository',str(repository),'--inputs',str(temporary/'gcc-inputs/bundle'),
                  '--output',str(output),'--operator-trust-execution']
        legacy.main()  # capture ONLY. Never invoke the rejected export mode.
    except BaseException as error:raise Refusal('sdk-incomplete') from error
    finally:
        sys.argv=saved
        # Read only this freshly entered R3 call's actual container observation.
        # A later metadata/cleanup failure cannot reset observed elapsed time or
        # replace a genuine container exit with the outer helper's exit code.
        try:retain_attempt(output,private)
        finally:retain_structured(output,private)
    record_stage(private,'independent-verification')
    return verify_on_host(output,private,policy,independent)


def retain_structured(output,private):
    # Independent diagnostics cannot overwrite the genuine SDK error/terminal.
    try:
        value=structured_diagnostics().collect(output,os.environ,read_json,file_pin)
        with (private/'OWNED-STRUCTURED-SDK.json').open('xb') as sink:sink.write(canonical(value))
    except BaseException:traceback.print_exc()  # opaque local FD boundary only


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
        ADMISSION['entry']=True
        require(sys.argv==[sys.argv[0],'qualify-on-host','--operator-trust-execution'],'operator-required')
        root=Path(os.environ['RUNNER_TEMP']);require(root.is_absolute() and root==root.resolve(),'runtime-refused')
        private=root/'gcc-sdk-receipt-private';private.mkdir(mode=0o700)
        # -B stops bytecode writes, not reads: an adjacent __pycache__ entry whose
        # header matches a pinned source would run instead of the verified bytes.
        # A prefix inside this run's fresh private namespace holds no cache at all.
        sys.pycache_prefix=str(private/'no-bytecode-cache')
        value=guarded(lambda:fixed_work(private),private,head)
    except BaseException as error:
        # Even entry/admission failures have no raw exception or traceback channel.
        value=empty_receipt(head);value['errorId']=error.identifier if isinstance(error,Refusal) else 'runtime-refused'
        value['diagnostics']=failure_diagnostics(None,error)
    try:remove_staged()
    except BaseException:
        # The receipt is emitted only after cleanup, so it never reports success
        # beside a failed exit; the observed SDK terminal facts are kept.
        value=failed_receipt(value,'cleanup-unconfirmed',value['helperSeconds'])
    os.write(1,PREFIX+canonical(validate_receipt(value)))
    return 0 if value['sdkVerifiedOnHost'] else 1


def entry():
    # A broken output sink or an unforeseen error in admission/emission may
    # withhold the receipt, but must not open Python's public traceback channel.
    try:return main()
    except BaseException:return 1


if __name__=='__main__':raise SystemExit(entry())
