"""Exact Debian GCC12 phase selection and append-only continuation evidence.

Planning and ledger reconciliation consume data only. The source-authenticating
hosted execution/transport carrier must be reviewed separately; this module
does not grant execution or evidence authority and is not exposed through MCP.
"""
import argparse
import importlib.util
import json
from pathlib import Path

_spec = importlib.util.spec_from_file_location('gcc_checkpoint', Path(__file__).with_name('gcc-staged-checkpoint.py'))
checkpoint = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(checkpoint)
require, canonical, sha = checkpoint.require, checkpoint.canonical, checkpoint.sha
PROFILE = checkpoint.PROFILE
RETENTION_FAILED = 'retention-failed'
RULES = {
 'debian/rules': 'e99bd407df7ea7d0b26428416c048c482a30e55aa581781f842292b7182fdaf9',
 'debian/rules.defs': 'deb0936094dbb29e48ce0b35828abc91ebaec50eadef8440306e12896c581a84',
 'debian/rules.conf': 'bd3f27b8a03e471ba176706f6a13ea9826c6fbf3a66ad4c218e64c31d8b66822',
 'debian/rules2': '4ff468f979ae27278dcda93188f9dcf1c5de24d451d5e2050b454908854164ad',
}
DPKG = ['dpkg-buildpackage', '-b', '-us', '-uc', '--jobs=4']
PROXY = '--rules-file=/controller/gcc-staged-rules2.sh'
STAMPS = {'configure': ['stamps/04-configure-stamp'], 'native': ['stamps/05-build-stamp'],
          'jit': ['stamps/05-build-jit-stamp'],
          'nvptx': ['stamps/05-build-nvptx-stamp', 'stamps/06-install-nvptx-stamp'],
          'gcn': ['stamps/05-build-gcn-stamp', 'stamps/06-install-gcn-stamp'],
          'hppa64': ['stamps/05-build-hppa64-stamp', 'stamps/07-install-hppa64-stamp'],
          'check': ['stamps/06-check-stamp'], 'default-build': [], 'packages': []}
VARIABLES = ['build_type', 'distribution', 'distrelease', 'DEB_HOST_ARCH', 'DEB_TARGET_ARCH',
 'DEB_BUILD_OPTIONS', 'DEB_BUILD_PROFILES', 'DEB_STAGE', 'single_package', 'with_base_only',
 'with_check', 'with_jit', 'with_offload_nvptx', 'with_offload_gcn', 'with_hppa64',
 'with_cxx', 'with_ada', 'bootstrap_target', 'CONFARGS', 'flags_to_pass',
 'configure_dependencies', 'build_dependencies', 'build_arch_dependencies',
 'build_indep_dependencies', 'install_dependencies', 'check_dependencies',
 'SET_PATH', 'SET_SHELL', 'SET_LOCPATH', 'CC', 'CXX', 'STAGE1_CFLAGS', 'STAGE1_LDFLAGS',
 'BOOT_CFLAGS', 'BOOT_LDFLAGS', 'CFLAGS_FOR_BUILD', 'CXXFLAGS_FOR_BUILD', 'LDFLAGS_FOR_BUILD',
 'CFLAGS_FOR_TARGET', 'CXXFLAGS_FOR_TARGET', 'LDFLAGS_FOR_TARGET', 'NJOBS', 'NJOBS_TESTS']

def command(phase):
    require(phase in STAMPS, 'Unknown phase')
    if phase == 'packages': return [*DPKG, '-nc']
    if phase == 'default-build': return [*DPKG, '--rules-target=build']
    if phase == 'configure': return [*DPKG, '--rules-target=configure']
    return [*DPKG, PROXY, '--rules-target=' + ','.join(STAMPS[phase])]

def validate_configuration(configuration):
    require(configuration['schemaVersion'] == 1 and configuration['profile'] == PROFILE, 'Wrong phase configuration profile')
    require(configuration['originalRulePins'] == RULES, 'Original Debian rules changed')
    values = configuration['variables']; require(set(values) == set(VARIABLES), 'Incomplete original variable inventory')
    require(all(isinstance(value, str) and len(value.encode()) <= 65536 and '\0' not in value for value in values.values()), 'Variable value bound')
    require(values['build_type'] == 'build-native' and values['distribution'] == 'Debian' and values['distrelease'] == 'bookworm', 'Wrong original build selection')
    require(values['DEB_HOST_ARCH'] == values['DEB_TARGET_ARCH'] == 'amd64', 'Wrong native architecture')
    require(values['DEB_BUILD_OPTIONS'].split() == ['parallel=4'] and not values['DEB_BUILD_PROFILES'].strip() and not values['DEB_STAGE'].strip(), 'Original build options narrowed')
    require(values['single_package'] != 'yes' and values['with_base_only'] != 'yes' and values['with_check'] == 'yes', 'Original package/check scope narrowed')
    require(values['bootstrap_target'] in ['bootstrap', 'profiledbootstrap-lean'], 'Original bootstrap target unavailable')
    require(values['with_cxx'] == 'yes', 'Original native C++ scope missing')
    passed=configuration['passedVariableValues']
    names=values['flags_to_pass'].split()
    require(names and len(names)==len(set(names)) and all(checkpoint.re.fullmatch('[A-Za-z_][A-Za-z0-9_]*',name) for name in names),'Invalid original passed-variable inventory')
    require(set(passed)==set(names) and all(isinstance(value,str) and len(value.encode())<=65536 and '\0' not in value for value in passed.values()),'Missing original passed-variable values')
    require(checkpoint.re.fullmatch('[a-f0-9]{64}',configuration['generatedParametersSha256']),'Missing generated parameter identity')
    phases = ['configure', 'native']
    for variable, phase in [('with_jit', 'jit'), ('with_offload_nvptx', 'nvptx'), ('with_offload_gcn', 'gcn'), ('with_hppa64', 'hppa64')]:
        if values[variable] == 'yes': phases.append(phase)
    build = [STAMPS[phase][0] for phase in phases if phase != 'configure'] + STAMPS['check']
    require(set(values['build_dependencies'].split()) == set(build), 'Default build dependency graph changed')
    require(set(values['build_arch_dependencies'].split()) == set(build), 'Architecture build graph changed')
    independent = build + ['stamps/05-build-html-stamp', 'stamps/05-build-doxygen-stamp']
    if values['with_ada'] == 'yes': independent += ['stamps/05-build-gnatdoc-stamp']
    require(set(values['build_indep_dependencies'].split()) == set(independent), 'Independent/documentation graph changed')
    require(values['configure_dependencies'].split() == STAMPS['configure'] and values['check_dependencies'].split() == STAMPS['check'], 'Configure/check dependency changed')
    install = ['stamps/07-install-stamp']
    for phase, stamp in [('jit','stamps/07-install-jit-stamp'),('nvptx','stamps/06-install-nvptx-stamp'),('gcn','stamps/06-install-gcn-stamp'),('hppa64','stamps/07-install-hppa64-stamp')]:
        if phase in phases: install.append(stamp)
    require(set(values['install_dependencies'].split()) == set(install), 'Install dependency graph changed')
    # Preserve expanded flags verbatim in the bound configuration. No flag or
    # language string is supplied by this controller to the original make call.
    require('--enable-languages=' in values['CONFARGS'] and values['NJOBS'].split() == ['-j', '4'], 'Missing original flags/parallel expansion')
    return [*phases, 'check', 'default-build', 'packages']

def read_configuration(directory, source, expected_rules=None):
    # Read fixed first-party GNU make output as data; this call never evaluates
    # the upstream Makefile. The carrier must separately prove its execution.
    directory=checkpoint.physical(directory);source=checkpoint.physical(source)
    pins=RULES if expected_rules is None else expected_rules
    require(set(pins)==set(RULES),'Wrong original rule inventory')
    for name,pin in pins.items():
        path=checkpoint.physical(source/name)
        require(path.is_file() and path.stat().st_size<=1048576 and sha(path.read_bytes())==pin,'Original rule bytes differ: '+name)
    variables={}
    for name in VARIABLES:
        path=checkpoint.physical(directory/name)
        require(path.is_file() and path.stat().st_size<=65536,'Missing bounded rendered configuration')
        body=path.read_bytes();require(body.endswith(b'\n') and not body.endswith(b'\n\n'),'Ambiguous rendered configuration newline')
        variables[name]=body[:-1].decode('utf-8')
    names=variables['flags_to_pass'].split()
    require(names and len(names)==len(set(names)) and all(checkpoint.re.fullmatch('[A-Za-z_][A-Za-z0-9_]*',name) for name in names),'Invalid original passed-variable inventory')
    passed={}
    for name in names:
        path=checkpoint.physical(directory/('flag-'+name))
        require(path.is_file() and path.stat().st_size<=65536,'Missing bounded passed-variable value')
        body=path.read_bytes();require(body.endswith(b'\n') and not body.endswith(b'\n\n'),'Ambiguous passed-variable newline')
        passed[name]=body[:-1].decode('utf-8')
    generated=checkpoint.physical(source/'debian/rules.parameters')
    require(generated.is_file() and generated.stat().st_size<=1048576,'Generated parameter bound')
    value={'schemaVersion':1,'profile':PROFILE,'originalRulePins':dict(pins),'variables':variables,'passedVariableValues':passed,'generatedParametersSha256':sha(generated.read_bytes())}
    # Production pins remain closed. Synthetic expected_rules is a test-only
    # data fixture; it cannot grant native authority through this reader.
    if expected_rules is None:validate_configuration(value)
    return value

def plan(configuration):
    phases = validate_configuration(configuration)
    return {'schemaVersion': 1, 'profile': PROFILE, 'configurationSha256': sha(canonical(configuration)),
            'phases': [{'phase': phase, 'command': command(phase), 'requiredStamps': (sorted(set(configuration['variables']['build_arch_dependencies'].split() + configuration['variables']['build_indep_dependencies'].split())) if phase == 'default-build' else sorted(set(configuration['variables']['install_dependencies'].split())) if phase == 'packages' else STAMPS[phase])} for phase in phases],
            'configurationNativeOriginAssessed': False, 'originalUninterruptedCommand': DPKG,
            'originalCommandCompleted': False, 'fullCompilerSdkBootstrapClosureVerified': False, 'gateAComplete': False}

def new_ledger(configuration):
    selected = plan(configuration)
    return {'schemaVersion': 1, 'profile': PROFILE, 'configurationSha256': selected['configurationSha256'], 'attempts': []}

def validate_ledger(ledger, configuration):
    selected = plan(configuration)
    require(set(ledger) == {'schemaVersion','profile','configurationSha256','attempts'} and ledger['schemaVersion'] == 1 and ledger['profile'] == PROFILE and ledger['configurationSha256'] == selected['configurationSha256'], 'Wrong phase ledger/configuration')
    rows = ledger['attempts']; require(isinstance(rows, list) and len(rows) <= 64, 'Invalid attempt history')
    previous = None; native_seconds = 0; completed = 0; last_checkpoint = None
    for index, row in enumerate(rows):
        require(completed < len(selected['phases']), 'Unexpected attempt after package completion')
        expected = selected['phases'][completed]
        require(row['phase'] == expected['phase'] and row['command'] == expected['command'] and row['attempt'] == index and row['sequence'] == completed, 'Skipped/reordered/changed original phase')
        require(row['predecessorSha256'] == previous, 'Wrong phase predecessor')
        require(type(row['nativeSeconds']) in [int, float] and 0 <= row['nativeSeconds'] <= 14440, 'Invalid phase duration')
        require(row['outcome'] in ['completed','failed','timeout-incomplete','retention-failed'], 'Unknown phase outcome')
        if row['outcome'] == 'completed':
            require(type(row['exitCode']) is int and row['exitCode'] == 0 and row['terminalObserved'] is True and row['quiescenceObserved'] is True, 'Incomplete original phase terminal/process family')
            require(isinstance(row['checkpointSha256'], str) and checkpoint.re.fullmatch('[a-f0-9]{64}',row['checkpointSha256']), 'Missing validated checkpoint')
            require(row['requiredStamps'] == expected['requiredStamps'], 'Wrong required phase stamp inventory')
            require(row['stampIdentities'] == expected['requiredStamps'], 'Missing physical original phase stamps')
            if row['phase'] in ['jit','check']:
                report=row['originalTestReportEvidence']
                require(report['reports'] > 0 and report['logicalBytes'] > 0 and checkpoint.re.fullmatch('[a-f0-9]{64}',report['inventorySha256']), 'Missing original test evidence')
                require(report['allOriginalTestsPassRequired'] is False, 'Upstream failure accounting changed')
            if row['phase'] == 'packages':
                require(set(row['packageOutputKinds']) >= {'deb','changes','buildinfo'}, 'Missing final package output family')
            last_checkpoint = row['checkpointSha256']; completed += 1
        else:
            require(row['checkpointSha256'] is None, 'Failed or interrupted native tree cannot become a completed checkpoint')
            if row['outcome'] == 'retention-failed':
                require(type(row['exitCode']) is int and row['exitCode'] == 0 and row['terminalObserved'] is True and row['quiescenceObserved'] is True, 'Retention failure changed genuine native terminal/process family')
                require(row['retentionStage'] in ['capture','archive-verification','physical-restore','transport-admission','transport','cleanup'], 'Unknown retention failure stage')
                require(isinstance(row['retentionFailure'],str) and 0 < len(row['retentionFailure'].encode()) <= 2048, 'Missing bounded retention failure evidence')
            elif row['outcome'] == 'timeout-incomplete':
                require(row['exitCode'] is None and row['terminalObserved'] is False, 'Timeout invented a native original terminal')
            else: require(type(row['exitCode']) is int and row['exitCode'] != 0 and row['terminalObserved'] is True, 'Failed phase lacks a real nonzero terminal')
        native_seconds += row['nativeSeconds']; previous = sha(canonical(row))
    require(native_seconds <= 43200, 'Aggregate native allowance exhausted')
    return selected, previous, native_seconds, completed, last_checkpoint

def next_phase(ledger, configuration, job):
    selected, previous, spent, completed, last_checkpoint = validate_ledger(ledger, configuration)
    require(len(ledger['attempts']) < 64 and completed < len(selected['phases']), 'No continuation attempt remains')
    require(job['runnerLabel'] == 'ubuntu-26.04' and job['architecture'] == 'x86_64' and job['cpus'] >= 4 and job['memoryBytes'] >= 12 * 1024**3, 'Insufficient standard hosted runtime')
    require(job['sourceAndImagePinsVerified'] is True and job['packageInventoryUnchanged'] is True and job['restoredPhysicalTreeVerified'] is True, 'Unverified restored producer inputs')
    require(job['restoredCheckpointSha256'] == last_checkpoint, 'Wrong predecessor checkpoint restored')
    require(type(job['remainingSeconds']) in [int, float] and 0 < job['remainingSeconds'] <= 21300, 'Invalid observed hosted job remainder')
    # Charge failed/timeout attempts too; keep kill/reap grace in the aggregate.
    maximum = min(14400, 43200 - spent - 40, int(job['remainingSeconds']) - 3300)
    require(maximum > 0, 'No native time remains after checkpoint/cleanup reserves')
    for key in ['freeDiskBytes','activeTreeBytes','repositoryCacheLimitBytes','availableCacheBytes']:
        require(type(job[key]) is int and job[key] >= 0, 'Invalid observed capacity')
    require(job['activeTreeBytes'] <= checkpoint.LIMITS['treeBytes'], 'Current work tree exceeds policy')
    required_scratch = checkpoint.LIMITS['treeBytes'] - job['activeTreeBytes'] + checkpoint.LIMITS['archiveBytes'] + 8 * 1024**3
    require(job['freeDiskBytes'] >= required_scratch, 'Checkpoint/scratch capacity unavailable')
    require(8000000000 <= job['availableCacheBytes'] <= job['repositoryCacheLimitBytes'] <= 10000000000, 'No unpaid predecessor/successor checkpoint capacity')
    phase = selected['phases'][completed]
    return {**phase, 'sequence': completed, 'attempt': len(ledger['attempts']), 'predecessorSha256': previous,
            'restoreCheckpointSha256': last_checkpoint, 'maximumNativeSeconds': maximum,
            'requiredScratchBytes': required_scratch, 'configurationSha256': selected['configurationSha256'],
            'sourceOriginAndServiceClockAssessed': False, 'gateAComplete': False}

def append_attempt(ledger, configuration, observed):
    # This is a data reconciliation step. Native authority, source origin,
    # physical stamps/checkpoint and service-clock verification belong to the
    # reviewed carrier; supplying JSON here cannot grant those capabilities.
    candidate=json.loads(json.dumps(ledger));candidate['attempts'].append(observed)
    validate_ledger(candidate,configuration)
    return candidate

def completion(ledger, configuration):
    selected, _, spent, completed, last = validate_ledger(ledger, configuration)
    return {'allSelectedPhasesReported':completed == len(selected['phases']),
            'reportedCompletedPhases':completed,'requiredPhases':len(selected['phases']),
            'allAttemptNativeSeconds':spent,'lastCheckpointSha256':last,
            'nativeEvidenceOriginAssessed':False,'uninterruptedOriginalCommandCompleted':False,
            'fullCompilerSdkBootstrapClosureVerified':False,'gateAComplete':False}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation',choices=['plan','new-ledger','next','append','completion','read-configuration'])
    parser.add_argument('--configuration');parser.add_argument('--ledger');parser.add_argument('--job');parser.add_argument('--observation');parser.add_argument('--directory');parser.add_argument('--source')
    args=parser.parse_args()
    def read(name):
        path=Path(name);require(path.is_file() and not path.is_symlink() and path.stat().st_size<=1048576,'Bounded metadata required')
        return json.loads(path.read_bytes())
    if args.operation=='read-configuration':
        print(json.dumps(read_configuration(Path(args.directory),Path(args.source)),sort_keys=True));return
    configuration=read(args.configuration)
    if args.operation=='plan':value=plan(configuration)
    elif args.operation=='new-ledger':value=new_ledger(configuration)
    elif args.operation=='next':value=next_phase(read(args.ledger),configuration,read(args.job))
    elif args.operation=='append':value=append_attempt(read(args.ledger),configuration,read(args.observation))
    else:value=completion(read(args.ledger),configuration)
    print(json.dumps(value,sort_keys=True))

if __name__=='__main__':main()
