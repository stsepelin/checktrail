"""Independent bounded ZIP replay. Never executes archive members or case code."""
import argparse
import base64
import hashlib
import json
import math
from pathlib import Path
import re
import stat
import subprocess
import zipfile

MIB = 1024 ** 2
CATALOG_SHA256 = '0309dcd61b505020cc19bb67beeca7b6a62103c8194784c9eb224bb75466dbc6'
KEYS = ['PASS','FAIL','XFAIL','XPASS','UNSUPPORTED','UNRESOLVED','UNTESTED','ERROR','SKIP']
SOURCE_FILES = [
    'scripts/qualify-c-producer.mjs', 'scripts/qualify-binutils-producer.mjs',
    'scripts/producer-qualification/c-producer-profile.mjs', 'scripts/producer-qualification/c-producer-profiles.v1.json',
    'scripts/producer-qualification/c-producer-build.sh', 'scripts/producer-qualification/c-producer-test-reports.py',
    'scripts/producer-qualification/binutils-retention-observer.mjs', 'scripts/producer-qualification/binutils-retention-observer.py',
    'scripts/producer-qualification/binutils-image-identity.mjs', 'scripts/producer-qualification/binutils-image-identity.v1.json',
    'scripts/verify-c-producer-observation.mjs', 'scripts/producer-qualification/c-producer-export-evidence.py',
    'scripts/producer-qualification/c-producer-replay-evidence.py', '.github/workflows/upstream-glibc.yml',
  'scripts/verify-binutils-retention-observer.mjs', 'scripts/acquire-binutils-inputs.mjs', 'scripts/acquire-c-producer-inputs.mjs', 'scripts/producer-qualification/binutils.v1.json', 'scripts/producer-qualification/binutils-acquisition-plan.mjs', 'scripts/producer-qualification/binutils-prepare-inputs.py', 'scripts/producer-qualification/binutils-apt-index-preparation.v1.json', 'scripts/producer-qualification/binutils-input-reacquisition.v1.json',
]
GLIBC_POLICY_FILES = [
    'glibc-seccomp.mjs', 'glibc-seccomp.v1.json', 'glibc-seccomp-probe.py',
    'moby-28.0.4/default.json', 'moby-28.0.4/LICENSE', 'moby-28.0.4/NOTICE', 'moby-28.0.4/AUTHORS',
]
SOURCE_FILES += ['scripts/producer-qualification/' + name for name in GLIBC_POLICY_FILES]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def integer(value, minimum=0, maximum=2**53-1):
    return type(value) is int and minimum <= value <= maximum


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def pin(raw):
    return {'bytes': len(raw), 'sha256': sha(raw)}


def relative(name):
    return isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9._+~/-]|%3a)*', name) and all(part not in ['', '.', '..'] for part in name.split('/'))


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'Duplicate JSON field refused')
            if key == 'schemaVersion':
                require(type(value) is int and value > 0, 'Malformed schemaVersion integer')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs)


def exact_json(left, right, depth=0):
    """Compare bounded decoded JSON without Python's bool/int coercion."""
    if depth > 64 or type(left) is not type(right):
        return False
    if type(left) is dict:
        return (all(type(key) is str for key in left) and
                all(type(key) is str for key in right) and
                left.keys() == right.keys() and
                all(exact_json(left[key], right[key], depth+1) for key in left))
    if type(left) is list:
        return len(left) == len(right) and all(exact_json(a,b,depth+1) for a,b in zip(left,right))
    if type(left) is float:
        return math.isfinite(left) and math.isfinite(right) and left == right
    return type(left) in [str,int,bool,type(None)] and left == right


def terminal(value, limit=512*MIB):
    require(isinstance(value, dict) and set(value) == {'exitCode','signal','error','reason','retainedBytes','stopError'}, 'Incomplete foreground terminal schema')
    require(value['exitCode'] == 0 and type(value['exitCode']) is int and all(value[key] is None for key in ['signal','error','reason','stopError']), 'Original foreground terminal failed or incomplete')
    require(integer(value['retainedBytes'], 0, limit), 'Foreground log byte observation invalid')


def retention(raw, receipt):
    require(0 < len(raw) <= 16*MIB and raw.endswith(b'\n') and integer(receipt['retainedLogBytes'],1,16*MIB) and integer(receipt['samples'],1,1000000) and len(raw) == receipt['retainedLogBytes'], 'Incomplete observer raw transport')
    require(pin(raw) == receipt['log'], 'Observer raw transport hash differs')
    ready, waiting, sequence, samples, buffer, last = False, False, 0, 0, b'', None
    for line in raw[:-1].split(b'\n'):
        row = strict_json(line)
        require(set(row) == {'stream','base64'} and row['stream'] in ['stdin','stdout','stderr'], 'Unknown observer transport row')
        chunk = base64.b64decode(row['base64'], validate=True)
        require(base64.b64encode(chunk).decode() == row['base64'], 'Noncanonical observer transport')
        if row['stream'] == 'stderr':
            continue
        if row['stream'] == 'stdin':
            require(ready and not waiting and not buffer, 'Observer request ordering differs')
            sequence += 1
            expected = json.dumps({'schemaVersion':1,'kind':'sample','sequence':sequence}, separators=(',',':')).encode()+b'\n'
            require(chunk == expected, 'Observer request sequence differs')
            waiting = True
            continue
        buffer += chunk
        require(len(buffer) <= 8192, 'Observer message bound exceeded')
        while b'\n' in buffer:
            message, buffer = buffer.split(b'\n',1)
            value = strict_json(message)
            if not ready:
                require(value == {'schemaVersion':1,'kind':'ready','roots':['/observed/bundle','/observed/controls','/observed/work']}, 'Observer startup differs')
                ready = True
            else:
                require(waiting and set(value) == {'schemaVersion','kind','sequence','bytes','files','directories'}, 'Unsolicited or incomplete observer response')
                require(type(value['schemaVersion']) is int and value['schemaVersion'] == 1 and value['kind']=='sample' and type(value['sequence']) is int and value['sequence']==sequence, 'Observer sample identity differs')
                require(all(integer(value[key]) for key in ['bytes','files','directories']) and value['directories']>=3 and value['directories']+value['files']<=1000000, 'Invalid observer counters')
                last, samples, waiting = value, samples+1, False
    require(ready and samples>0 and not waiting and not buffer and samples==receipt['samples'] and last==receipt['lastSample'], 'Incomplete observer request/response lifecycle')
    return last


def syscall_probe(value, mode):
    require(type(mode) is str and mode in ['baseline','derived'] and exact_json([value['schemaVersion'],value['mode'],value['machine']],[1,mode,'x86_64']), 'Wrong native syscall probe frame')
    caps=value['capabilities']
    require(set(caps)=={'effective','permitted','bounding'},'Incomplete native capabilities')
    for bits in caps.values():
        require(isinstance(bits,str) and re.fullmatch(r'[a-f0-9]{16}',bits) and int(bits,16)&((1<<25)|(1<<21))==0,'Clock/admin capability forbidden')
    sentinel=0xdefaced
    persona=value['personality'];saved=persona['saved']['result']
    require(type(saved) is int and saved!=-1 and exact_json(persona['saved'],{'result':saved,'errno':sentinel}),'Original personality query failed')
    require(exact_json(persona['near'],{'result':-1,'errno':1}) and exact_json(persona['linuxQuery'],{'result':0,'errno':sentinel}),'Personality near/default predicate changed')
    if mode=='baseline':
        expected=[{'result':-1,'errno':1},{'result':saved,'errno':sentinel},{'result':saved,'errno':sentinel}]
        clock_errno=1
    else:
        expected=[{'result':saved,'errno':sentinel},{'result':-22,'errno':sentinel},{'result':-22,'errno':sentinel}]
        clock_errno=22
    require(exact_json([persona[key] for key in ['negativeSet','negativeQuery','linuxSet']],expected),'BZ19408 personality/errno semantics changed')
    require(exact_json(value['clock'],{'monotonicRead':0,'monotonicSet':{'result':-1,'errno':clock_errno},'realtimeInvalidSet':{'result':-1,'errno':1}}),'Clock exact/near predicate differs')
    require(value['restored'] is True and value['projectOrCompilerExecuted'] is False and value['clockChangeAttemptedWithValidRealtimeArgument'] is False,'Probe body/restoration scope changed')


def syscall_preflight(packet, receipt):
    metadata_raw=packet.read('source/scripts/producer-qualification/glibc-seccomp.v1.json',65536)
    require(sha(metadata_raw)=='1dd74d0956dd3a06837a43afd61c3b1150d3bfc43c9b7d6b40c3acb3e9f202ac','Unknown policy provenance metadata')
    metadata=strict_json(metadata_raw)
    for row in metadata['inputs']:
        require(exact_json(pin(packet.read('source/scripts/producer-qualification/'+row['file'],2*MIB)),{key:row[key] for key in ['bytes','sha256']}),'Original Moby policy/notice bytes differ')
    base=packet.json('source/scripts/producer-qualification/moby-28.0.4/default.json',65536)
    additions=[{'names':['clock_settime'],'action':'SCMP_ACT_ALLOW','args':[{'index':0,'value':1,'op':'SCMP_CMP_EQ'}]}, {'names':['personality'],'action':'SCMP_ACT_ALLOW','args':[{'index':0,'value':4294967274,'op':'SCMP_CMP_EQ'}]}]
    require(exact_json([base['defaultAction'],base['defaultErrnoRet'],metadata['additions']],['SCMP_ACT_ERRNO',1,additions]),'Default policy or exact predicates changed')
    derived=packet.read('result/controls/glibc-native-seccomp.json',65536)
    expected={**base,'syscalls':base['syscalls']+additions}
    require(exact_json(strict_json(derived),expected),'GLIBC carrier must retain default profile plus exactly two argument predicates')
    policy={'file':'glibc-native-seccomp.json',**pin(derived)}
    require(exact_json(receipt['generatedControlPins'],[policy]),'Generated policy pin changed')
    proof=receipt['syscallPreflight']
    require(exact_json(proof['schemaVersion'],1) and proof['state']=='exact-kernel-predicates-observed-original-body-not-invoked' and exact_json(proof['policy'],policy) and set(proof['modes'])=={'baseline','derived'},'Incomplete native syscall preflight')
    for key in ['originalBodyInvoked','fullCompilerSdkBootstrapClosureVerified','historicalPublisherConsumptionVerified','gateAComplete']:
        require(proof[key] is False,'Syscall probe overclaims qualification')
    runtime=receipt['syscallRuntime'];commit=runtime['serverGitCommit']
    require(commit in ['6430e49','6430e49a55babd9b8f4d08e70ecb2b68900770fe'] and exact_json(runtime,{'serverVersion':'28.0.4','serverGitCommit':commit,'sourceCommit':'6430e49a55babd9b8f4d08e70ecb2b68900770fe','platform':'linux/amd64','defaultProfile':'builtin','reportedMetadataOnly':True,'defaultProfileBytesIndependentlyAttestedFromDaemon':False,'historicalPublisherConsumptionVerified':False}),'Unknown Docker default profile/build')
    require(type(receipt['image']['id']) is str and re.fullmatch(r'sha256:[a-f0-9]{64}',receipt['image']['id']),'Invalid native syscall image identity')
    for mode in ['baseline','derived']:
        row=proof['modes'][mode]
        terminal(row['observer'],65536)
        raw=packet.read('result/seccomp-'+mode+'.log',65536)
        require(len(raw)>0 and exact_json(pin(raw),row['log']) and exact_json(len(raw),row['observer']['retainedBytes']) and exact_json(strict_json(raw),row['record']),'Syscall raw terminal/log binding differs')
        syscall_probe(row['record'],mode)
        require(exact_json(row['predicates'],{'mode':mode,'exactPredicatesObserved':True,'originalBodyInvoked':False}) and exact_json(row['imageId'],receipt['image']['id']) and row['cleanup']['state'] in ['absent','removed'],'Syscall probe identity/cleanup incomplete')
    require(exact_json(proof['modes']['baseline']['record']['capabilities'],proof['modes']['derived']['record']['capabilities']),'Derived policy increased observed capabilities')


class Packet:
    def __init__(self, archive):
        archive = Path(archive).absolute()
        require(archive.resolve(strict=True)==archive and archive.is_file() and archive.stat().st_size<=1536*MIB, 'Physical archive path/size refused')
        self.archive = zipfile.ZipFile(archive)
        try:
            self.admit()
        except BaseException:
            self.archive.close()
            raise

    def admit(self):
        infos = self.archive.infolist()
        names = [item.filename for item in infos]
        require(len(infos)<=25001 and len(names)==len(set(names)) and all(relative(name) for name in names), 'Unsafe or duplicate ZIP member')
        for item in infos:
            require(not item.is_dir() and not item.flag_bits&1 and stat.S_IFMT(item.external_attr>>16) in [0,stat.S_IFREG], 'Linked/encrypted/nonregular ZIP member refused')
        require('manifest.json' in names and self.archive.getinfo('manifest.json').file_size<=16*MIB, 'Missing bounded export manifest')
        self.manifest = strict_json(self.archive.read('manifest.json'))
        require(self.manifest['schemaVersion']==1 and self.manifest['qualificationComplete'] is False and self.manifest['gateAComplete'] is False, 'Unproven export qualification')
        require(self.manifest['originalReportMemberByteLimit']==64*MIB and self.manifest['originalReportAggregateByteLimit']==512*MIB, 'Wrong C report export contract')
        for key in ['binaryPackagePayloadsUploaded','nativeWorktreeArchiveUploaded','originalInputPayloadsUploaded']:
            require(self.manifest[key] is False, 'Unrequested large payload export')
        self.files = {}
        total = reports = 0
        for row in self.manifest['rawFiles']:
            name = row['file']
            require(relative(name) and name not in self.files and integer(row['bytes'],0,512*MIB) and re.fullmatch(r'[a-f0-9]{64}',row['sha256']), 'Invalid exported byte identity')
            require(not re.search(r'\.(deb|udeb|tar|xz|gz|wasm)$',name) and not '/bundle/' in name, 'Excluded payload entered evidence archive')
            require(integer(row['nativeUid'],0,4294967294) and integer(row['nativeGid'],0,4294967294) and integer(row['nativeMode'],0,0o7777), 'Malformed native physical owner observation')
            require(self.archive.getinfo(name).file_size==row['bytes'], 'ZIP length differs from physical export')
            digest, size = hashlib.sha256(), 0
            with self.archive.open(name) as source:
                while chunk:=source.read(MIB):
                    size += len(chunk)
                    require(size<=row['bytes'], 'ZIP member grew beyond exact pin')
                    digest.update(chunk)
            require(size==row['bytes'] and digest.hexdigest()==row['sha256'], 'Corrupt exported C raw bytes')
            if name.startswith('result/work/original-test-reports/'):
                require(row['bytes']<=64*MIB, 'Original C report member exceeds64MiB')
                reports += row['bytes']
            self.files[name] = row
            total += row['bytes']
        require(sorted(names)==sorted([*self.files,'manifest.json']) and total==self.manifest['uncompressedBytes'] and total<=2*1024**3, 'Export inventory/aggregate differs')
        require(reports==self.manifest['originalReportLogBytes'] and reports<=512*MIB, 'Original C report aggregate differs')
        self.directories = {}
        for row in self.manifest['nativeDirectories']:
            require(relative(row['file']) and row['file'] not in self.directories and integer(row['nativeUid'],0,4294967294) and integer(row['nativeGid'],0,4294967294) and integer(row['nativeMode'],0,0o7777), 'Malformed native directory observation')
            self.directories[row['file']] = row

    def close(self):
        self.archive.close()

    def read(self, name, maximum):
        require(name in self.files and self.files[name]['bytes']<=maximum, 'Missing or over-bound required original evidence: '+name)
        with self.archive.open(name) as source:
            raw = source.read(maximum+1)
        require(len(raw)<=maximum and pin(raw)=={key:self.files[name][key] for key in ['bytes','sha256']}, 'Raw replay bytes differ')
        return raw

    def json(self,name,maximum=16*MIB):
        return strict_json(self.read(name,maximum))

    def custody(self,name,caller,directory=False):
        row=(self.directories if directory else self.files).get(name)
        require(row is not None and (row['nativeUid'],row['nativeGid'],row['nativeMode'])==(caller['uid'],caller['gid'],0o700 if directory else 0o600), 'Wrong original native export owner/group/mode')


def outcome_availability(rows):
    positive=lambda row,key:integer(row['counts'].get(key),1)
    resolved=any(any(positive(row,key) for key in ['PASS','FAIL','XFAIL','XPASS']) for row in rows)
    failed=any(any(positive(row,key) for key in ['FAIL','XPASS','ERROR','UNRESOLVED']) for row in rows)
    return {'resolvedTestOutcomesObserved':resolved,'testEvidenceState':'unavailable' if not resolved else 'failed' if failed else 'reported'}


def nonempty_package_outputs(rows, maximum):
    return any(isinstance(row,dict) and isinstance(row.get('file'),str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.+_~-]*\.(deb|udeb)',row['file']) and integer(row.get('bytes'),1,maximum) and isinstance(row.get('sha256'),str) and re.fullmatch(r'[a-f0-9]{64}',row['sha256']) for row in rows)


def reports(packet, prefix, value, caller, expected_producer_uid):
    require(value['schemaVersion']==1 and value['profile']=='glibc' and value['generatedBuildRoots']==['build-tree'], 'Wrong original report profile')
    for key in ['completeConfigurationInventoryAssessed','duplicateReportsAreIndependentEvidence','allOriginalTestsPassRequired','fullCompilerSdkBootstrapClosureVerified','gateAComplete']:
        require(value[key] is False, 'Unproven original report promotion')
    custody=value['exportCustody']
    require(custody['schemaVersion']==1 and custody['requestedCaller']==caller and custody['producerEffectiveUid']==expected_producer_uid and custody['newCopyOwnersVerified'] is True, 'Wrong original producer copy custody')
    for key in ['recursiveOwnershipChangeUsed','sourceTreePermissionsChanged','nativeLinuxCrossUidAcceptanceVerified']:
        require(custody[key] is False,'Producer custody relabeled as broader acceptance')
    claimed_files={row['file']:row for row in custody['files']}
    claimed_dirs={row['directory']:row for row in custody['directories']}
    require(len(claimed_files)==len(custody['files']) and len(claimed_dirs)==len(custody['directories']) and '.' in claimed_dirs,'Duplicate/incomplete producer custody inventory')
    for name,row in claimed_dirs.items():
        require(name=='.' or relative(name),'Foreign producer copy directory')
        require((row['ownership']['uid'],row['ownership']['gid'],row['ownership']['mode'])==(caller['uid'],caller['gid'],0o700),'Wrong producer directory owner')
        packet.custody(prefix+('/'+name if name!='.' else ''),caller,True)
    observed=set();total=0;outcome_count=0
    def verify(row):
        nonlocal total
        name=row['file'];require(relative(name) and name.startswith('build-tree/') and name not in observed and name in claimed_files,'Foreign/duplicate original report custody')
        observed.add(name)
        owner=claimed_files[name]['ownership']
        require((owner['uid'],owner['gid'],owner['mode'])==(caller['uid'],caller['gid'],0o600),'Wrong producer report owner')
        pieces=name.split('/')
        require(all('/'.join(pieces[:n]) in claimed_dirs for n in range(1,len(pieces))),'Missing original copy ancestor custody')
        packet.custody(prefix+'/'+name,caller)
        raw=packet.read(prefix+'/'+name,64*MIB)
        require(pin(raw)=={key:row[key] for key in ['bytes','sha256']},'Corrupt original report pin')
        total+=len(raw);require(total<=512*MIB,'Original report aggregate exceeded')
        return raw
    for row in value['reports']:
        raw=verify(row);require(row['configuration']=='build-tree' and row['format'] in ['original-sum','original-trs'],'Wrong original configuration/format')
        require(row['file'].endswith('.sum' if row['format']=='original-sum' else '.trs'),'Wrong original report extension')
        lines=re.split(rb'\r\n|\n|\r',raw) if raw else []
        if raw.endswith((b'\r',b'\n')):lines.pop()
        counts={key:0 for key in KEYS}
        for line in lines:
            match=re.match(rb'^(PASS|FAIL|XFAIL|XPASS|UNSUPPORTED|UNRESOLVED|UNTESTED|ERROR|SKIP):(?:[ \t\f\v]|$)',line)
            if match:counts[match[1].decode()]+=1
        require(isinstance(row['counts'],dict) and set(row['counts'])==set(KEYS) and all(integer(n) for n in row['counts'].values()) and counts==row['counts'] and len(lines)==row['totalLines'] and len(lines)-sum(counts.values())==row['otherLines'],'Physical original outcome counts differ')
        if row['format']=='original-trs':require(row['outcomesInterpreted'] is False,'Unknown Automake result promoted')
        outcome_count+=sum(counts.values())
        if 'log' in row:verify(row['log'])
    require(total==value['retainedBytes'] and observed==set(claimed_files),'Original report inventory/retained bytes differ')
    archive_reports={name[len(prefix)+1:] for name in packet.files if name.startswith(prefix+'/')}
    require(archive_reports==observed,'Unreplayed original report/log member')
    return {'reports':len(value['reports']),'observedOutcomeLines':outcome_count,**outcome_availability(value['reports']),'originalOutcomesPreserved':True,'reportsPooledAsIndependentEvidence':False}


def source_frame(packet, repository, startup):
    require([row['file'] for row in startup['sourcePins']]==SOURCE_FILES,'Incomplete source/harness inventory')
    git_args=['git','--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null']
    git=subprocess.run(git_args+['rev-parse','HEAD'],cwd=repository,capture_output=True,timeout=5)
    require(git.returncode==0 and re.fullmatch(r'[a-f0-9]{40}',startup['gitHead']) and git.stdout.decode().strip()==startup['gitHead'],'Replay checkout does not match original source revision')
    for row in startup['sourcePins']:
        raw=packet.read('source/'+row['file'],2*MIB)
        file=repository/row['file'];require(file.resolve(strict=True)==file and file.is_file() and file.stat().st_size<=2*MIB,'Nonphysical current harness')
        require(pin(raw)=={key:row[key] for key in ['bytes','sha256']} and file.read_bytes()==raw,'Stale or changed original source/harness bytes')
        object_name=startup['gitHead']+':'+row['file']
        size=subprocess.run(git_args+['cat-file','-s',object_name],cwd=repository,capture_output=True,timeout=5)
        require(size.returncode==0 and size.stdout.strip().isdigit() and int(size.stdout)<=2*MIB and int(size.stdout)==len(raw),'Original source object is absent or over bound')
        committed=subprocess.run(git_args+['cat-file','blob',object_name],cwd=repository,capture_output=True,timeout=5)
        require(committed.returncode==0 and committed.stdout==raw,'Source/harness bytes are not the original committed object')
    return {'exactOriginalGitSourcePins':len(startup['sourcePins']),'archiveCodeExecuted':False}


def replay(archive,repository):
    repository=Path(repository).absolute()
    packet=Packet(archive)
    try:
        require(not packet.manifest['unavailable'],'Incomplete raw C export')
        startup=packet.json('operator-startup.json',MIB)
        require(startup['schemaVersion']==1 and startup['state']=='operator-source-and-caller-frame','Missing original operator startup')
        caller=startup['caller'];require(integer(caller['uid'],1,4294967294) and integer(caller['gid'],0,4294967294),'Nonroot original caller is required')
        packet.custody('operator-startup.json',caller)
        require(startup['host']=={'platform':'linux','architecture':'x64','kernelMachine':'x86_64'} and startup['hardwareHostAttestationPerformed'] is False and startup['gateAComplete'] is False,'Wrong startup host observation')
        require(startup['sourceOrCompilerExecuted'] is False,'Startup frame unexpectedly includes producer execution')
        source_frame(packet,repository,startup)
        catalog_raw=packet.read('source/scripts/producer-qualification/c-producer-profiles.v1.json',MIB)
        require(sha(catalog_raw)==CATALOG_SHA256,'Frozen C catalog changed')
        catalog=strict_json(catalog_raw);profile=catalog['profiles']['glibc']
        admission=packet.json('inputs/receipt.json',8*MIB)
        require(admission['state']=='complete-pinned-input-bundle' and admission['profile']==profile['profile'] and admission['catalogSha256']==CATALOG_SHA256,'Original C input admission incomplete')
        for key in ['buildExecuted','inputAuthenticationAndFreshnessDisabled','fullCompilerSdkBootstrapClosureVerified','completeOriginalNoticeClosureVerified','gateAComplete']:
            require(admission[key] is False,'C data-only admission changed scope or authentication')
        require([{key:row[key] for key in ['file','bytes','sha256']} for row in admission['acquired']]==[{key:row[key] for key in ['file','bytes','sha256']} for row in profile['files']] and len(admission['acquired'])==161,'Original161 input admission identities differ')
        common=packet.json('common-inputs/receipt.json',8*MIB)
        require(common['state']=='complete-original-input-bundle' and common['completeInputBundleReacquisitionVerified'] is True and common['physicalPinnedInputs']==350,'Common350 input reacquisition incomplete')
        for key in ['compilationExecuted','originalPackageBuildExecuted','fullCompilerSdkBootstrapClosureVerified','gateAComplete','inferenceInvoked','fieldEvaluationExecuted']:
            require(common[key] is False,'Common data-only acquisition changed scope')
        require(common['cleanup']['state']=='absent','Common acquisition cleanup incomplete')
        prepared=packet.json('common-inputs/transform/preparation.json',MIB)
        require(prepared==common['preparation'] and prepared['complete'] is True and len(prepared['releaseSignatures'])==3 and prepared['sourceSignatureVerified'] is True and prepared['allSourceArchivesBoundBySignedDescriptor'] is True,'Original signed APT/source preparation differs')
        for key in ['sourceSignatureFaultControl','releaseSignatureFaultControl']:
            require(integer(prepared[key]['changedExitCode'],1,255) and prepared[key]['restoredExitCode']==0,'Original signature fault/restoration control missing')
        require(prepared['compilerExecuted'] is False and prepared['packageInstalled'] is False,'Data-only common preparation changed scope')
        receipt_raw=packet.read('result/receipt.json',16*MIB);receipt=strict_json(receipt_raw)
        observed=packet.json('result/build-observation.json',2*MIB)
        require(observed['schemaVersion']==1 and observed['state']=='original-glibc-command-observed-qualification-incomplete' and observed['controllerExit']==2,'No complete live original observation')
        require(observed['originalCommandExitCode']==0 and observed['originalTestOutcomesPreserved'] is True and observed['completeConfigurationInventoryAssessed'] is False and observed['packagePayloadAndNativeArchiveTransported'] is False,'Live original observation scope differs')
        require(observed['originalReceipt']==pin(receipt_raw) and observed['startup']==pin(packet.read('operator-startup.json',MIB)),'Live original receipt/startup binding changed')
        require(receipt['profile']==profile['profile'] and receipt['sourceVersion']==profile['sourceVersion'] and receipt['limits']==profile['limits'] and receipt['catalogSha256']==CATALOG_SHA256,'Wrong original frozen profile')
        require(receipt['state']=='original-command-completed-qualification-incomplete' and receipt['buildExecuted'] is True and receipt['originalExecutionInvoked'] is True,'Original command was not completed')
        for key in ['originalBuildChecksDisabled','originalDefaultTargetsDisabled','inputAuthenticationAndFreshnessDisabled','nativeFilesystemQuotaEnforced']:
            require(receipt[key] is False,'Original command defaults/authentication/quota scope changed')
        require(receipt['host']['capturedCaller']==caller and receipt['host']['platform']=='linux' and receipt['host']['architecture']=='x64' and receipt['host']['kernelMachine']=='x86_64','Original host/caller observation changed')
        image_record=packet.json('source/scripts/producer-qualification/binutils-image-identity.v1.json',MIB)
        manifest_bytes=base64.b64decode(image_record['manifest']['base64'],validate=True)
        config_bytes=base64.b64decode(image_record['config']['base64'],validate=True)
        require(pin(manifest_bytes)=={key:image_record['manifest'][key] for key in ['bytes','sha256']} and pin(config_bytes)=={key:image_record['config'][key] for key in ['bytes','sha256']},'Pinned raw image manifest/config differs')
        image_manifest=strict_json(manifest_bytes);image_config=strict_json(config_bytes)
        require(image_record['selectedImage']==catalog['image'] and 'sha256:'+sha(manifest_bytes)==catalog['image'].split('@')[1] and image_manifest['config']['digest']=='sha256:'+sha(config_bytes) and image_manifest['config']['size']==len(config_bytes),'Image source digest binding differs')
        require(receipt['image']['id'] in ['sha256:'+sha(manifest_bytes),'sha256:'+sha(config_bytes)] and receipt['image']=={'id':receipt['image']['id'],'os':'linux','architecture':'amd64','manifestDigest':'sha256:'+sha(manifest_bytes),'configDigest':'sha256:'+sha(config_bytes),'rootfsDiffIds':image_config['rootfs']['diff_ids']},'Actual selected image observation differs')
        terminal(receipt['executionObserver'])
        command=packet.json('result/work/original-command.json',4096)
        require(command==receipt['originalBuild'] and command=={'schemaVersion':1,'command':profile['command'],'invoked':True,'exitCode':0,'wrapperExitCode':0},'Original default command terminal unavailable')
        require(packet.files['result/build.log']['bytes']==receipt['executionObserver']['retainedBytes'] and {key:packet.files['result/build.log'][key] for key in ['bytes','sha256']}==receipt['log'],'Original process log binding differs')
        require([row['file'] for row in receipt['sourcePins']]==['c-producer-profiles.v1.json','c-producer-profile.mjs','c-producer-build.sh','c-producer-test-reports.py','binutils-retention-observer.py','binutils-retention-observer.mjs','binutils-image-identity.mjs','binutils-image-identity.v1.json',*GLIBC_POLICY_FILES] and [row['file'] for row in receipt['harnessPins']]==['qualify-c-producer.mjs','qualify-binutils-producer.mjs'],'Incomplete original source/harness pin inventory')
        for row in receipt['sourcePins']:
            require(pin(packet.read('source/scripts/producer-qualification/'+row['file'],2*MIB))=={key:row[key] for key in ['bytes','sha256']},'Original source pin differs')
        for row in receipt['harnessPins']:
            require(pin(packet.read('source/scripts/'+row['file'],2*MIB))=={key:row[key] for key in ['bytes','sha256']},'Original harness pin differs')
        syscall_preflight(packet,receipt)
        observer=receipt['retentionObserver'];require(observer['state']=='completed' and observer['independentImage']==catalog['image'] and observer['readOnly'] is True and observer['network']=='none' and observer['capability']=='DAC_READ_SEARCH' and observer['terminal']=={'exitCode':0,'signal':None},'Independent observer unavailable or altered')
        require(observer['nativeFilesystemQuotaEnforced'] is False,'Unproven native quota')
        last=retention(packet.read('result/retention-observer.jsonl',16*MIB),observer)
        require(last==receipt['finalRetention'],'Final observer sample differs')
        allowance=sum(row['bytes'] for row in profile['files'])+sum(row['bytes'] for row in receipt['sourcePins'] if row['file'] in ['c-producer-build.sh','c-producer-test-reports.py','binutils-retention-observer.py','glibc-seccomp-probe.py'])+sum(row['bytes'] for row in receipt['generatedControlPins'])
        require(last['bytes']<=profile['limits']['workByteLimit']+allowance,'Retained work allowance exceeded')
        for key in ['cleanup','retentionObserverCleanup']:require(receipt[key]['state'] in ['absent','removed'],'Incomplete original owned cleanup')
        preflight=receipt['custodyPreflight'];require(preflight['capturedCaller']==caller and preflight['state']=='selected-nonroot-caller-export-verified' and preflight['nativeLinuxCrossUidAcceptanceVerified'] is True and preflight['sourceOrCompilerInvoked'] is False and preflight['cleanup']['state'] in ['absent','removed'],'Native caller custody preflight incomplete')
        terminal(preflight['observer'],65536)
        require(pin(packet.read('result/custody-preflight.log',65536))==preflight['log'],'Custody preflight log differs')
        preflight_manifest=packet.read('result/custody-preflight/test-reports.json',65536)
        require(pin(preflight_manifest)==preflight['manifest'],'Custody preflight manifest differs')
        packet.custody('result/custody-preflight/test-reports.json',caller)
        preflight_summary=reports(packet,'result/custody-preflight/original-test-reports',strict_json(preflight_manifest),caller,0)
        require(preflight_summary['reports']==1 and packet.read('result/custody-preflight/original-test-reports/build-tree/amd64-libc/tests.sum',1024)==b'PASS: synthetic custody preflight\n' and packet.read('result/custody-preflight/original-test-reports/build-tree/amd64-libc/tests.log',1024)==b'Original synthetic custody bytes\n','Custody preflight physical source bytes differ')
        packet.custody('result/work/test-reports.json',caller)
        original_reports=packet.json('result/work/test-reports.json',8*MIB)
        summary=reports(packet,'result/work/original-test-reports',original_reports,caller,0)
        require(summary['reports']>0 and summary['resolvedTestOutcomesObserved'],'No original resolved test outcome inventory')
        require(observed['originalTestEvidenceState']==summary['testEvidenceState'],'Live original test outcome state differs')
        require(all(receipt['testEvidence'][key]==value for key,value in original_reports.items()),'Original report manifest differs from live observation')
        require(pin(packet.read('result/work/installed-build-package-identities.txt',MIB))==receipt['installedPackageIdentities'],'Original installed package manifest differs')
        require(observed['physicallyRecheckedPackageOutputs']==receipt['outputs'] and nonempty_package_outputs(receipt['outputs'],profile['limits']['workByteLimit']),'Nonempty physically observed package output is required')
        require(observed['physicallyRecheckedNativeArchive']==receipt['nativeBuildWorktree'],'Retained native archive observation differs')
        require(receipt['buildCompletion']=={'originalCommandCompleted':True,'testEvidenceState':summary['testEvidenceState'],'state':'original-command-completed-qualification-incomplete','fullCompilerSdkBootstrapClosureVerified':False,'completeOriginalNoticeClosureVerified':False,'historicalPublisherConsumptionVerified':False,'gateAComplete':False},'Live completion scope differs')
        for row in receipt['outputs']:
            require(relative(row['file']) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.+_~-]*\.(deb|udeb|changes|buildinfo)',row['file']) and integer(row['bytes'],0,profile['limits']['workByteLimit']) and re.fullmatch(r'[a-f0-9]{64}',row['sha256']),'Malformed physical output observation')
            if row['file'].endswith(('.changes','.buildinfo')):
                require(pin(packet.read('result/work/output/'+row['file'],4*MIB))=={key:row[key] for key in ['bytes','sha256']},'Original package metadata bytes differ')
        for source in [receipt,observed]:
            for key in ['fullCompilerSdkBootstrapClosureVerified','completeOriginalNoticeClosureVerified','historicalPublisherConsumptionVerified','gateAComplete']:
                require(source[key] is False,'Unproven upstream qualification promotion')
        return {'schemaVersion':1,'state':'retained-original-glibc-observation-replayed','originalCommandExitCode':0,**summary,'nativeCustodyObservationsReconciled':True,'transportedFileOwnersRelabeledAsNative':False,'binaryPackagePayloadsIndependentlyReplayed':False,'nativeArchivePayloadIndependentlyReplayed':False,'completeConfigurationInventoryAssessed':False,'fullCompilerSdkBootstrapClosureVerified':False,'completeOriginalNoticeClosureVerified':False,'historicalPublisherConsumptionVerified':False,'gateAComplete':False}
    finally:
        packet.close()


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--archive',required=True)
    parser.add_argument('--repository',required=True)
    args=parser.parse_args()
    try:
        print(json.dumps(replay(args.archive,args.repository)))
    except (ValueError,KeyError,TypeError,AttributeError,OSError,subprocess.SubprocessError,zipfile.BadZipFile) as error:
        print(json.dumps({'state':'original-observation-replay-incomplete','reason':str(error),'qualificationComplete':False,'gateAComplete':False}))
        raise SystemExit(2)
