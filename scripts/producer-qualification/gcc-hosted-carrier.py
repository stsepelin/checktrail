"""Review-only fixed stock-GitHub carrier for the true GCC configure checkpoint.

The native path requires the operator flag AND the exact manual diagnostic
service context. No argument can select source commands, a repository, image,
remote destination, flags, a larger quota or a different producer.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import stat
import subprocess
import time
import uuid

GIB = 1024 ** 3
STATE_CEILING = 8 * GIB
LOG_CEILING = 512 * 1024 ** 2
HOST_ENV = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            'DOCKER_HOST': 'unix:///var/run/docker.sock'}
MUTABLE_MOUNTS = {
    '__carrier_work': '/work', '__carrier_tmp': '/tmp', '__carrier_var_tmp': '/var/tmp',
    '__carrier_run': '/run', '__carrier_apt_lists': '/var/lib/apt/lists',
    '__carrier_apt_archives': '/var/cache/apt/archives'}
SOURCE_CONTROLS = ['gcc-staged-checkpoint.py', 'gcc-staged-plan.py', 'gcc-staged-rules2.sh',
                   'gcc-staged-configuration.mk']


def load(path):
    spec = importlib.util.spec_from_file_location(path.stem.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


capacity = load(Path(__file__).with_name('gcc-hosted-phase0-capacity.py'))
transport = load(Path(__file__).with_name('gcc-phase0-transport.py'))
require, canonical = capacity.require, capacity.canonical


def physical(path):
    path = Path(path)
    require(path.is_absolute() and path.resolve() == path and not path.is_symlink(), 'Physical absolute path required')
    return path


def verify_repository(repository, selected):
    git = ['/usr/bin/git', '-c', 'core.fsmonitor=false', '-c', 'safe.directory=' + str(repository), '--no-optional-locks']
    head = subprocess.run([*git, 'rev-parse', 'HEAD'], cwd=repository, env=HOST_ENV,
                          capture_output=True, timeout=10, check=True).stdout.decode().strip()
    require(head == selected['GITHUB_SHA'], 'Actual first-party checkout differs from service source head')
    result = subprocess.run([*git, 'diff', '--no-ext-diff', '--quiet', 'HEAD', '--'], cwd=repository,
                            env=HOST_ENV, capture_output=True, timeout=10)
    require(result.returncode == 0, 'Tracked native carrier source is dirty/unavailable')
    return {'headSha': head, 'trackedSourceUnchanged': True, 'projectCodeExecutedByGitRead': False}


def digest_file(path, maximum=2 * GIB):
    path = physical(path)
    before = path.stat()
    require(stat.S_ISREG(before.st_mode) and before.st_size <= maximum, 'Bounded ordinary file required')
    observed = hashlib.sha256()
    with path.open('rb') as source:
        while True:
            raw = source.read(1024 ** 2)
            if not raw:
                break
            observed.update(raw)
    after = path.stat()
    require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), 'Input changed while hashing')
    return {'bytes': before.st_size, 'sha256': observed.hexdigest()}


def copy_pinned(source, output, pin):
    require(not output.exists() and not output.is_symlink(), 'Stale pinned-copy destination')
    require(digest_file(source) == {key: pin[key] for key in ['bytes', 'sha256']}, 'Pinned input differs')
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    shutil.copyfile(source, output)
    output.chmod(0o600)
    require(digest_file(output) == {key: pin[key] for key in ['bytes', 'sha256']}, 'Physical copied input differs')


def docker(arguments, *, timeout=30, maximum=2 * 1024 ** 2):
    result = subprocess.run(['/usr/bin/docker', *arguments], env=HOST_ENV, capture_output=True, timeout=timeout)
    require(len(result.stdout) + len(result.stderr) <= maximum, 'Docker metadata response bound')
    require(result.returncode == 0, 'Fixed Docker operation failed: ' + arguments[0])
    return result.stdout


def validate_daemon(daemon, resources, output):
    require(daemon['OSType'] == 'linux' and daemon['Architecture'] in ['x86_64', 'amd64'] and
            daemon['NCPU'] >= 4 and daemon['MemTotal'] >= 12 * GIB,
            'Wrong native Docker daemon CPU/architecture/memory')
    require(daemon['Name'] == os.uname().nodename and not any('rootless' in x for x in daemon.get('SecurityOptions', [])),
            'Remote/rootless daemon cannot use measured local capacity')
    require(daemon.get('MemoryLimit') is True and daemon.get('CpuCfsQuota') is True and daemon.get('PidsLimit') is True,
            'Actual Docker memory/CPU/PID enforcement unavailable')
    root = physical(Path(daemon['DockerRootDir']))
    disk = shutil.disk_usage(root)
    # Both filesystems must fit independently when Docker and binds differ.
    return {**resources, 'freeDiskBytes': min(resources['freeDiskBytes'], disk.free),
            'dockerRootFilesystemFreeBytes': disk.free,
            'dockerAndStateShareFilesystem': root.stat().st_dev == output.stat().st_dev}


def validate_image(image, selected_image, registry):
    require(registry['selectedImage'] == selected_image, 'Wrong original image metadata')
    config = registry['config']
    import base64
    raw = base64.b64decode(config['base64'], validate=True)
    require(len(raw) == config['bytes'] and hashlib.sha256(raw).hexdigest() == config['sha256'],
            'Pinned registry config bytes differ')
    parsed = json.loads(raw)
    require(image['Id'] == 'sha256:' + config['sha256'] and image['Architecture'] == 'amd64' and image['Os'] == 'linux' and
            image['RootFS']['Layers'] == parsed['rootfs']['diff_ids'], 'Observed original image/config/layers differ')
    require(selected_image in image['RepoDigests'] or selected_image.removeprefix('docker.io/') in image['RepoDigests'],
            'Original digest absent from Docker image identities')
    return {'image': selected_image, 'configSha256': config['sha256'], 'nativeAmd64': True}


def create_arguments(catalog, output, name):
    state = output / 'state'
    args = ['create', '--init', '--pull=never', '--platform', 'linux/amd64', '--user', '0:0',
            '--name', name, '--hostname', 'checktrail-gcc-staged', '--network', 'none',
            '--cpus', '4', '--memory', '6g', '--pids-limit', '1024',
            '--label', 'io.checktrail.gcc-staged-owner=' + name,
            '--entrypoint', '/usr/bin/env', '--workdir', '/work']
    mounts = [(state, '/build', False), (output / 'inputs/source', '/inputs', True),
              (output / 'controls', '/controller', True),
              (output / 'inputs/keyrings/debian-keyring.gpg', '/usr/share/keyrings/debian-keyring.gpg', True)]
    mounts.extend((state / relative, target, False) for relative, target in MUTABLE_MOUNTS.items())
    for source, target, readonly in mounts:
        require(not any(x in str(source) for x in [',', '\r', '\n']), 'Ambiguous owned Docker mount')
        args += ['--mount', 'type=bind,src=' + str(source) + ',target=' + target + (',readonly' if readonly else '')]
    args += [catalog['image'], '-i', *[key + '=' + value for key, value in catalog['environment'].items()],
             '/usr/bin/python3', '-I', '-B', '/controller/gcc-hosted-stage.py', 'configure']
    return args


def validate_container(owner, identifier, name, catalog, output):
    require(owner['Id'] == identifier and owner['Config']['Labels']['io.checktrail.gcc-staged-owner'] == name,
            'Owned container identity changed')
    config, host, state = owner['Config'], owner['HostConfig'], owner['State']
    require(config['User'] == '0:0' and config['WorkingDir'] == '/work' and
            config['Entrypoint'] == ['/usr/bin/env'] and config['Image'] == catalog['image'] and
            config['Cmd'] == ['-i', *[key + '=' + value for key, value in catalog['environment'].items()],
                              '/usr/bin/python3', '-I', '-B', '/controller/gcc-hosted-stage.py', 'configure'],
            'Actual selected producer entrypoint/environment/goal changed')
    require(host['NetworkMode'] == 'none' and host['Privileged'] is False and host['Init'] is True and
            host['NanoCpus'] == 4000000000 and host['Memory'] == 6 * GIB and host['PidsLimit'] == 1024,
            'Actual selected native resource/network configuration differs')
    require(state['Status'] == 'created' and state['Running'] is False and state['Pid'] == 0,
            'Native source ran before admission')
    expected = {'/build': (output / 'state', True), '/inputs': (output / 'inputs/source', False),
                '/controller': (output / 'controls', False),
                '/usr/share/keyrings/debian-keyring.gpg': (output / 'inputs/keyrings/debian-keyring.gpg', False)}
    expected.update({target: (output / 'state' / relative, True) for relative, target in MUTABLE_MOUNTS.items()})
    require(len(owner['Mounts']) == len(expected), 'Unexpected or missing producer mount')
    observed = {}
    for mount in owner['Mounts']:
        require(mount['Type'] == 'bind' and mount['Destination'] not in observed, 'Ambiguous actual producer mount')
        observed[mount['Destination']] = (Path(mount['Source']), mount['RW'])
    require(observed == expected, 'Actual mutable state/immutable input mount map changed')
    return {'ownedContainer': identifier, 'selectedEnvironmentAndGoalsObserved': True,
            'actualLimitsObserved': True, 'mountMapObserved': True, 'nativeSourceInvoked': False}


def allocated_state(root, maximum_seconds=30):
    started = time.monotonic()
    entries = 0
    logical = 0
    allocated = 0
    known = set()
    stack = [root]
    while stack:
        require(time.monotonic() - started < maximum_seconds, 'Native capacity sample deadline')
        path = stack.pop()
        info = path.lstat()
        entries += 1
        require(entries <= 1000000, 'Actual native state entry ceiling')
        identity = (info.st_dev, info.st_ino)
        if identity not in known:
            allocated += info.st_blocks * 512
            known.add(identity)
        if stat.S_ISDIR(info.st_mode):
            stack.extend(path.iterdir())
        elif stat.S_ISREG(info.st_mode):
            logical += info.st_size
        elif stat.S_ISLNK(info.st_mode):
            logical += len(os.readlink(path).encode())
        else:
            raise ValueError('Native state contains an unrestorable special node')
    return {'entries': entries, 'logicalBytes': logical, 'allocatedBytes': allocated,
            'quotaEnforced': False, 'samplingIsPhysicalHighWater': False}


def admit_state(resources, service, measured):
    require(measured['logicalBytes'] <= STATE_CEILING and measured['allocatedBytes'] <= STATE_CEILING,
            'Actual logical/physical phase-0 state exceeds its closed bound')
    return capacity.admit(resources, service, state_bytes=measured['allocatedBytes'], state_ceiling_bytes=STATE_CEILING)


def native_observation(output, name, maximum_seconds, service_clock):
    start = time.monotonic()
    process = subprocess.Popen(['/usr/bin/docker', 'start', '--attach', name], env=HOST_ENV,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    observed_bytes = 0
    next_sample = 0
    samples = []
    failure = None
    try:
        with (output / 'native.log').open('xb') as log:
            while selector.get_map():
                elapsed = time.monotonic() - start
                remaining_service = service_clock['remainingSeconds'] - (time.monotonic() - service_clock['capturedMonotonic'])
                require(elapsed <= maximum_seconds and remaining_service >= capacity.FINALIZE_SECONDS,
                        'Native attempt reached source-job/native cutoff; terminal remains unobserved')
                if elapsed >= next_sample:
                    state = allocated_state(output / 'state')
                    free = shutil.disk_usage(output).free
                    samples.append({**state, 'elapsedSeconds': elapsed, 'availableDiskBytes': free})
                    require(state['logicalBytes'] <= STATE_CEILING and state['allocatedBytes'] <= STATE_CEILING and
                            free >= 8 * GIB + capacity.CHECKPOINT_BYTES, 'Native state/scratch guard reached')
                    next_sample = elapsed + 30
                for key, _ in selector.select(timeout=1):
                    raw = os.read(key.fileobj.fileno(), 65536)
                    if not raw:
                        selector.unregister(key.fileobj)
                        continue
                    observed_bytes += len(raw)
                    require(observed_bytes <= LOG_CEILING, 'Native log retention ceiling reached')
                    log.write(raw)
            status = process.wait(timeout=10)
            require(status == 0, 'Original first-stage controller exited nonzero')
            require(time.monotonic() - start <= maximum_seconds and service_clock['remainingSeconds'] -
                    (time.monotonic() - service_clock['capturedMonotonic']) >= capacity.FINALIZE_SECONDS,
                    'Late native wrapper terminal cannot bypass the source-job/native cutoff')
    except BaseException as error:
        failure = error
        # Whole owned container, not only its attach process, is stopped.
        try:
            docker(['kill', '--signal', 'TERM', name])
        except BaseException:
            pass
        time.sleep(1)
        try:
            docker(['kill', '--signal', 'KILL', name])
        except BaseException:
            pass
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=15)
    finally:
        selector.close()
        process.stdout.close()
        (output / 'resource-samples.json').write_bytes(canonical({'samples': samples, 'quotaEnforced': False,
                                                                 'physicalHighWaterProven': False}) + b'\n')
    state = json.loads(docker(['inspect', name]))[0]['State']
    attempt = {'schemaVersion': 1, 'elapsedSeconds': time.monotonic() - start,
               'nativePhase': 'configure', 'sourceJobSecondsRemaining': service_clock['remainingSeconds'] -
                    (time.monotonic() - service_clock['capturedMonotonic']),
               'nativeOriginalCommandExitCode': None, 'originalCommandTerminalAssessed': False,
               'containerState': state, 'cutoffOrRetentionError': str(failure)[:1000] if failure else None,
               'checkpointCompleted': False, 'allElapsedTimeMustBeChargedOnRetry': True}
    (output / 'ATTEMPT.json').write_bytes(canonical(attempt) + b'\n')
    require(state['Running'] is False and state['Pid'] == 0 and state['Status'] == 'exited',
            'Owned native process family is not quiescent')
    if failure:
        raise failure
    require(state['ExitCode'] == 0 and state['OOMKilled'] is False and not state['Error'],
            'Native container did not reach a clean genuine terminal')
    return {'nativeSeconds': attempt['elapsedSeconds'], 'attachExitCode': status,
            'containerState': state, 'quiescenceObserved': True, 'logBytes': observed_bytes}


def failed_retention_ledger(output, planner, configuration, body, observed, stage, failure):
    require(body['configure']['exitCode'] == 0 and observed['quiescenceObserved'] is True,
            'Retention failure cannot invent a genuine zero native terminal')
    ledger = planner.new_ledger(configuration)
    selected = planner.plan(configuration)['phases'][0]
    ledger = planner.append_attempt(ledger, configuration, {'phase': 'configure', 'command': selected['command'],
        'attempt': 0, 'sequence': 0, 'predecessorSha256': None, 'nativeSeconds': observed['nativeSeconds'],
        'outcome': 'retention-failed', 'exitCode': 0, 'terminalObserved': True, 'quiescenceObserved': True,
        'checkpointSha256': None, 'retentionStage': stage, 'retentionFailure': str(failure)[:2048] or 'Unavailable retention'})
    (output / 'FAILED-PHASE-LEDGER.json').write_bytes(planner.canonical(ledger))
    return ledger


def post_capture(args, repository, output):
    selected = capacity.context(os.environ)
    verify_repository(repository, selected)
    codec = load(repository / 'scripts/producer-qualification/gcc-staged-checkpoint.py')
    planner = load(repository / 'scripts/producer-qualification/gcc-staged-plan.py')
    require(getattr(planner, 'RETENTION_FAILED', None) == 'retention-failed', 'Reviewed v2 retention ledger required')
    work = output / 'state/__carrier_work'
    configuration = planner.read_configuration(work / 'gcc-staged-configuration', output / 'state/source')
    body = json.loads((work / 'FIRST-STAGE.json').read_bytes())
    carrier = json.loads((output / 'CARRIER.json').read_bytes())
    require(carrier['state'] == 'first-stage-checkpoint-captured-and-physically-restored' and
            carrier['ownedContainerCleanup'] == 'removed', 'Captured phase-0 frame unavailable')
    service_directory = output / ('service-' + args.mode)
    service_directory.mkdir(mode=0o700, exist_ok=False)
    api = capacity.GitHub(os.environ.get('CHECKTRAIL_GITHUB_JOB_TOKEN'), service_directory) if args.mode != 'prepare-restore' else None
    try:
        if args.mode == 'pre-save':
            expected = transport.expected_record(output, selected, capacity)
            service = capacity.capture_service(api, selected)
            require(service['cache']['headroomAdmitted'] and service['clock']['remainingSeconds'] >= 2400,
                    'Immediate phase-0 save headroom/source-job reserve unavailable')
            (output / 'IMMEDIATE-SAVE-ADMISSION.json').write_bytes(canonical({
                'service': service, 'expected': expected, 'reservationGuaranteed': False,
                'saveRequiredAsNextWorkflowStep': True, 'laterPhaseCapacityQualified': False}) + b'\n')
        elif args.mode == 'prepare-restore':
            transport.prepare_restore(output, selected, capacity, codec, os.environ)
        elif args.mode == 'verify-restore':
            replay = transport.verify(output, selected, capacity, codec, planner, api, os.environ)
            carrier.update(state=replay['state'], serviceCacheRestoredAndReplayed=True,
                           localLedgerIsProvisionalUntilServiceReplay=False, phaseAdvancedTo='native',
                           allSelectedOriginalPhasesCompleted=False)
            (output / 'CARRIER.json').write_bytes(canonical(carrier) + b'\n')
        else:
            raise ValueError('Unknown closed post-capture mode')
    except BaseException as error:
        failed_retention_ledger(output, planner, configuration, body, carrier['observed'], 'transport', error)
        carrier.update(state='retention-failed', phaseAdvanced=False, error=str(error)[:2000])
        (output / 'CARRIER.json').write_bytes(canonical(carrier) + b'\n')
        (output / ('FAILURE-' + args.mode + '.json')).write_bytes(canonical({
            'error': str(error)[:2000], 'genuineNativeExitCode': 0, 'phaseAdvanced': False,
            'sourceOrCompilerExecutedByReplay': False, 'gateAComplete': False}) + b'\n')
        raise


def export_diagnostics(repository, output):
    destination = Path(os.environ['RUNNER_TEMP']) / 'gcc-phase0-diagnostics'
    require(not destination.exists() and not destination.is_symlink(), 'Fresh diagnostic publication required')
    runner_uid, runner_gid = int(os.environ['SUDO_UID']), int(os.environ['SUDO_GID'])
    require(runner_uid > 0 and runner_gid > 0, 'Exact nonroot artifact-reader identity required')
    # An action-level cache failure may skip the verifier. Charge that genuine
    # native-zero attempt without advancing the phase in the final diagnostics.
    if (output / 'CARRIER.json').is_file() and not (output / 'TRANSPORT-REPLAY.json').exists() and not (output / 'FAILED-PHASE-LEDGER.json').exists():
        carrier = json.loads((output / 'CARRIER.json').read_bytes())
        if carrier['state'] == 'first-stage-checkpoint-captured-and-physically-restored':
            planner = load(repository / 'scripts/producer-qualification/gcc-staged-plan.py')
            work = output / 'state/__carrier_work'
            config = planner.read_configuration(work / 'gcc-staged-configuration', output / 'state/source')
            body = json.loads((work / 'FIRST-STAGE.json').read_bytes())
            failed_retention_ledger(output, planner, config, body, carrier['observed'], 'transport',
                                    'Workflow cache save/restore/independent replay did not complete')
            carrier.update(state='retention-failed', phaseAdvanced=False)
            (output / 'CARRIER.json').write_bytes(canonical(carrier) + b'\n')
    candidates = []
    if output.is_dir() and not output.is_symlink():
        candidates += list(output.glob('*.json'))
        for service in output.glob('service-*'):
            if service.is_dir() and not service.is_symlink():
                candidates += list(service.glob('*.json'))
        work = output / 'state/__carrier_work'
        for name in ['FIRST-STAGE.json', 'configured-values.json', 'selected-default-graph.json', 'native-commands.jsonl']:
            if (work / name).is_file() and not (work / name).is_symlink():
                candidates.append(work / name)
    require(len(candidates) <= 200, 'Diagnostic member count bound')
    total = 0
    rows = []
    for source in sorted(candidates):
        pin = digest_file(source, maximum=2 * 1024 ** 2)
        total += pin['bytes']
        require(total <= 64 * 1024 ** 2, 'Complete diagnostic metadata exceeds artifact budget')
        rows.append((source, pin))
    stage = Path(os.environ['RUNNER_TEMP']) / '.gcc-phase0-diagnostics-staging'
    stage.mkdir(mode=0o700, exist_ok=False)
    try:
        for source, pin in rows:
            relative = source.relative_to(output)
            target = stage / relative
            copy_pinned(source, target, pin)
            os.chown(target, runner_uid, runner_gid)
        (stage / 'SUMMARY.json').write_bytes(canonical({
            'schemaVersion': 1, 'metadataBytes': total, 'metadataMembers': len(rows),
            'nativeOutputDirectoryExists': output.is_dir(), 'serviceReplayCompleted': (output / 'TRANSPORT-REPLAY.json').is_file(),
            'fullOriginalStdoutInsideCheckpointWhenCaptured': (output / 'checkpoint/receipt.json').is_file(),
            'completeFailedAttemptNativeLogExportAssessed': False,
            'originalUninterruptedDpkgCommandCompleted': False, 'fullCompilerSdkBootstrapClosureVerified': False,
            'gateAComplete': False}) + b'\n')
        for directory in [stage, *[path for path in stage.rglob('*') if path.is_dir()]]:
            os.chown(directory, runner_uid, runner_gid)
        os.chown(stage / 'SUMMARY.json', runner_uid, runner_gid)
        codec = load(repository / 'scripts/producer-qualification/gcc-staged-checkpoint.py')
        codec.rename_no_replace(stage, destination)
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--inputs', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--mode', choices=['capture', 'pre-save', 'prepare-restore', 'verify-restore', 'export-diagnostics'], default='capture')
    parser.add_argument('--operator-trust-execution', action='store_true')
    args = parser.parse_args()
    require(args.mode != 'capture' or args.operator_trust_execution, 'Operator-level native execution trust required')
    require(os.getuid() == 0, 'Host root is required to retain original numeric producer ownership')
    repository = physical(Path(args.repository))
    require(Path(args.output) == Path(os.environ['RUNNER_TEMP']).resolve() / 'gcc-phase0',
            'Exact owned phase-0 output path required')
    if args.mode == 'export-diagnostics':
        return export_diagnostics(repository, Path(args.output))
    if args.mode != 'capture':
        return post_capture(args, repository, physical(Path(args.output)))
    inputs = physical(Path(args.inputs))
    output = physical(Path(args.output).parent) / Path(args.output).name
    require(not output.exists() and not output.is_symlink() and output.parent == Path(os.environ['RUNNER_TEMP']).resolve(),
            'Fresh exact runner-temp output required')
    output.mkdir(mode=0o700)
    name = 'checktrail-gcc-staged-' + str(uuid.uuid4())
    created = False
    identifier = None
    config = body = observed = None
    retention_stage = None
    outcome = {'schemaVersion': 1, 'state': 'incomplete', 'checkpointPublished': False,
               'originalUninterruptedDpkgCommandCompleted': False,
               'fullCompilerSdkBootstrapClosureVerified': False, 'gateAComplete': False}
    try:
        resources = capacity.stock_resources(output)
        source_witness = verify_repository(repository, resources['context'])
        api = capacity.GitHub(os.environ.get('CHECKTRAIL_GITHUB_JOB_TOKEN'), output)
        service = capacity.capture_service(api, resources['context'])
        controls = repository / 'scripts/producer-qualification'
        codec = load(controls / 'gcc-staged-checkpoint.py')
        planner = load(controls / 'gcc-staged-plan.py')
        require(getattr(planner, 'RETENTION_FAILED', None) == 'retention-failed', 'Reviewed v2 retention ledger required')
        catalog_raw = (controls / 'c-producer-profiles.v1.json').read_bytes()
        require(hashlib.sha256(catalog_raw).hexdigest() == codec.CATALOG, 'Frozen original producer catalog differs')
        catalog = json.loads(catalog_raw)
        profile = catalog['profiles']['gcc-12']
        require(catalog['image'] == codec.IMAGE and catalog['platform'] == 'linux/amd64', 'Selected original image changed')
        stage = load(Path(__file__).with_name('gcc-hosted-stage.py'))
        require(catalog['environment'] == stage.FIXED_ENVIRONMENT and profile['command'] == planner.DPKG,
                'Original source environment/command changed')
        preparation_bytes = 2 * sum(row['bytes'] for row in profile['files']) + 4 * GIB
        capacity.admit(resources, service, state_bytes=0, state_ceiling_bytes=STATE_CEILING,
                       preparation_bytes=preparation_bytes)
        for row in profile['files']:
            require(not row['file'].startswith('/') and all(part not in ['', '.', '..'] for part in row['file'].split('/')),
                    'Unsafe catalog input path')
            copy_pinned(inputs / row['file'], output / 'inputs' / row['file'], row)
        state = output / 'state'
        state.mkdir(mode=0o700)
        for relative in ['__carrier_work', '__carrier_apt_lists', '__carrier_apt_archives']:
            (state / relative).mkdir(mode=0o700)
        shutil.copytree(output / 'inputs/apt-lists', state / '__carrier_apt_lists', dirs_exist_ok=True)
        shutil.copytree(output / 'inputs/apt-archives', state / '__carrier_apt_archives', dirs_exist_ok=True)
        (state / '__carrier_work/home').mkdir(mode=0o700)
        target_controls = output / 'controls'
        target_controls.mkdir(mode=0o700)
        control_pins = []
        for name in SOURCE_CONTROLS:
            pin = digest_file(controls / name)
            copy_pinned(controls / name, target_controls / name, pin)
            if name.endswith('.sh'):
                (target_controls / name).chmod(0o755)
            control_pins.append({'file': name, **pin})
        stage_path = Path(__file__).with_name('gcc-hosted-stage.py').resolve()
        pin = digest_file(stage_path)
        copy_pinned(stage_path, target_controls / stage_path.name, pin)
        control_pins.append({'file': stage_path.name, **pin})
        docker(['pull', '--platform', 'linux/amd64', codec.IMAGE], timeout=900)
        image = json.loads(docker(['image', 'inspect', codec.IMAGE]))[0]
        registry = json.loads((controls / 'binutils-image-identity.v1.json').read_bytes())
        image_witness = validate_image(image, codec.IMAGE, registry)
        daemon = json.loads(docker(['info', '--format', '{{json .}}']))
        resources = validate_daemon(daemon, capacity.stock_resources(output), output)
        service = capacity.capture_service(api, resources['context'])
        measured = allocated_state(state)
        admitted = admit_state(resources, service, measured)
        # Preserve original image contents at the mutable temporary/run paths
        # before their mounted replacements are admitted. A pristine sibling
        # is data-only: docker cp reads it without executing its entrypoint.
        seed = name + '-seed'
        try:
            docker(['create', '--pull=never', '--network', 'none', '--name', seed,
                    '--label', 'io.checktrail.gcc-staged-seed-owner=' + name, '--entrypoint', '/bin/true', codec.IMAGE])
            for relative in ['__carrier_tmp', '__carrier_var_tmp', '__carrier_run']:
                docker(['cp', '-a', seed + ':' + MUTABLE_MOUNTS[relative], str(state / relative)], timeout=120)
        finally:
            try:
                seed_owner = json.loads(docker(['inspect', seed]))[0]
                require(seed_owner['Config']['Labels']['io.checktrail.gcc-staged-seed-owner'] == name,
                        'Seed cleanup ownership unavailable')
                docker(['rm', seed])
                outcome['ownedSeedCleanup'] = 'removed'
            except BaseException as error:
                outcome.update(ownedSeedCleanup='unavailable', seedCleanupError=str(error)[:1000])
                raise
        # Re-admit the actual seeded mount state, not the pre-seed estimate.
        resources = validate_daemon(daemon, capacity.stock_resources(output), output)
        service = capacity.capture_service(api, resources['context'])
        measured = allocated_state(state)
        admitted = admit_state(resources, service, measured)
        arguments = create_arguments(catalog, output, name)
        # Track the owned request before invoking Docker: an interrupted create
        # may have provisioned the namespace before its response was retained.
        created = True
        response_identifier = docker(arguments).decode().strip()
        require(len(response_identifier) == 64 and all(ch in '0123456789abcdef' for ch in response_identifier), 'Invalid owned container identity')
        identifier = response_identifier
        owner = json.loads(docker(['inspect', name]))[0]
        container_witness = validate_container(owner, identifier, name, catalog, output)
        (output / 'ADMISSION.json').write_bytes(canonical({'resources': resources, 'service': service,
            'admitted': admitted, 'image': image_witness, 'containerWitness': container_witness,
            'firstPartySourceWitness': source_witness, 'controls': control_pins,
            'command': arguments, 'mounts': {'/build': '.', **{target: relative for relative, target in MUTABLE_MOUNTS.items()}},
            'nativeSourceTrustedAtOperatorLevel': True, 'projectCodeSandboxed': False,
            'quotaEnforced': False, 'cacheReservationGuaranteed': False}) + b'\n')
        observed = native_observation(output, name, admitted['maximumNativeSeconds'], service['clock'])
        work = state / '__carrier_work'
        body = json.loads((work / 'FIRST-STAGE.json').read_bytes())
        require(body['state'] == 'native-configure-terminal-and-selected-configuration-observed' and
                body['configure']['exitCode'] == 0 and body['externalSdkUnchanged'] is True,
                'Missing genuine first-stage body evidence')
        config = planner.read_configuration(work / 'gcc-staged-configuration', state / 'source')
        require(config == json.loads((work / 'configured-values.json').read_bytes()), 'Physical configured-variable data differs')
        selected = stage.selected_configuration(config, planner)
        require(selected == body['selectedConfiguration'], 'Selected original default graph changed')
        attempt = json.loads((output / 'ATTEMPT.json').read_bytes())
        attempt.update(nativeOriginalCommandExitCode=0, originalCommandTerminalAssessed=True,
                       originalCommand=body['configure']['command'])
        (output / 'ATTEMPT.json').write_bytes(canonical(attempt) + b'\n')
        for stamp in ['04-configure-stamp']:
            require((state / 'source/stamps' / stamp).is_file() and not (state / 'source/stamps' / stamp).is_symlink(),
                    'Physical original stamp missing')
        # Close the entire native namespace before physical capture. The bind
        # state remains owned; no source process can mutate it during hashing.
        owner = json.loads(docker(['inspect', name]))[0]
        require(owner['Id'] == identifier and owner['Config']['Labels']['io.checktrail.gcc-staged-owner'] == name and
                owner['State']['Running'] is False and owner['State']['Pid'] == 0, 'Native cleanup ownership changed')
        docker(['rm', name], timeout=60)
        created = False
        outcome['ownedContainerCleanup'] = 'removed'
        # Preserve the COMPLETE original stdout and resource/terminal records
        # inside the physical replay. No source/report/log is dropped to fit.
        for filename in ['native.log', 'resource-samples.json', 'ATTEMPT.json']:
            pin = digest_file(output / filename)
            copy_pinned(output / filename, work / ('carrier-' + filename), pin)
        source_epoch = hashlib.sha256(canonical({'catalogSha256': codec.CATALOG, 'files': [
            {key: row[key] for key in ['file', 'bytes', 'sha256']} for row in profile['files'] if row['file'].startswith('source/')]})).hexdigest()
        binding = {'profile': codec.PROFILE, 'catalogSha256': codec.CATALOG, 'image': codec.IMAGE,
                   'platform': 'linux/amd64', 'sourceVersion': profile['sourceVersion'],
                   'configurationSha256': selected['configurationSha256'],
                   'packageInventorySha256': body['packageInventorySha256'], 'sourceEpochSha256': source_epoch,
                   'phase': 'configure', 'sequence': 0, 'predecessorSha256': None}
        service_after = capacity.capture_service(api, resources['context'])
        remaining = service_after['clock']['remainingSeconds']
        require(remaining >= capacity.FINALIZE_SECONDS, 'No finalization reserve after real native terminal')
        admit_state(validate_daemon(daemon, capacity.stock_resources(output), output), service_after, allocated_state(state))
        retention_stage = 'capture'
        checkpoint = codec.capture(state, output / 'checkpoint', binding,
                                   limits={'treeBytes': STATE_CEILING, 'archiveBytes': capacity.CHECKPOINT_BYTES,
                                           'expandedBytes': 12 * GIB, 'seconds': 900})
        # Independent physical readback uses the just-observed archive identity,
        # never a self-authenticating cache receipt. This requires actual room.
        needed = allocated_state(state)['logicalBytes'] + 8 * GIB
        require(shutil.disk_usage(output).free >= needed, 'Actual checkpoint restore readback capacity unavailable')
        retention_stage = 'physical-restore'
        restore = codec.restore(output / 'checkpoint', output / 'readback', binding, checkpoint['archiveSha256'],
                                limits={'treeBytes': STATE_CEILING, 'archiveBytes': capacity.CHECKPOINT_BYTES,
                                        'expandedBytes': 12 * GIB, 'seconds': 900})
        require(restore['physicalTreeVerified'] is True, 'First-stage physical restore unavailable')
        shutil.rmtree(output / 'readback')
        ledger = planner.new_ledger(config)
        phase = planner.plan(config)['phases'][0]
        ledger = planner.append_attempt(ledger, config, {'phase': 'configure', 'command': phase['command'],
            'attempt': 0, 'sequence': 0, 'predecessorSha256': None, 'nativeSeconds': observed['nativeSeconds'],
            'outcome': 'completed', 'exitCode': body['configure']['exitCode'], 'terminalObserved': True,
            'quiescenceObserved': True, 'checkpointSha256': checkpoint['archiveSha256'],
            'requiredStamps': phase['requiredStamps'], 'stampIdentities': phase['requiredStamps']})
        (output / 'PHASE-LEDGER.json').write_bytes(planner.canonical(ledger))
        retention_stage = 'transport-admission'
        service_upload = capacity.capture_service(api, resources['context'])
        require(service_upload['cache']['headroomAdmitted'] and service_upload['clock']['remainingSeconds'] >= 900,
                'Actual unpaid upload/finalization reserve unavailable')
        outcome.update(state='first-stage-checkpoint-captured-and-physically-restored',
                       checkpointPublished=True, checkpoint=checkpoint, restore=restore,
                       originalCommands=body, observed=observed, image=image_witness,
                       uploadAdmission=service_upload, cacheSaveCompleted=False, cacheRestoreReplayQualified=False,
                       localLedgerIsProvisionalUntilServiceReplay=True, allSelectedOriginalPhasesCompleted=False)
        (output / 'CHECKPOINT-ROOT.json').write_bytes(canonical({'binding': binding,
            'archiveSha256': checkpoint['archiveSha256'], 'archiveBytes': checkpoint['archiveBytes'],
            'manifestSha256': checkpoint['manifestSha256'], 'mounts': {'/build': '.',
                **{target: relative for relative, target in MUTABLE_MOUNTS.items()}},
            'externalSdkSha256': body['externalSdkSha256'], 'controls': control_pins,
            'operatorPhase0Policy': admitted,
            'immutableOriginalInputsRequireExactCatalogReacquisition': True,
            'externalSdkReconstructionQualified': False,
            'sourceServiceContext': resources['context'], 'sourceJobId': service['clock']['jobId'],
            'fullCompilerSdkBootstrapClosureVerified': False, 'gateAComplete': False}) + b'\n')
        outcome['transport'] = transport.prepare(output, capacity, resources['context'], os.environ, codec)
    except BaseException as error:
        outcome.update(state='failed-or-incomplete', error=str(error)[:2000], phaseAdvanced=False)
        if config is not None and body is not None and observed is not None and retention_stage is not None:
            outcome['failedPhaseLedger'] = failed_retention_ledger(output, planner, config, body, observed, retention_stage, error)
        if (output / 'ATTEMPT.json').exists():
            outcome['attempt'] = json.loads((output / 'ATTEMPT.json').read_bytes())
        raise
    finally:
        if created:
            try:
                owner = json.loads(docker(['inspect', name]))[0]
                require(owner['Config']['Labels']['io.checktrail.gcc-staged-owner'] == name and
                        (identifier is None or owner['Id'] == identifier), 'Cleanup ownership changed')
                docker(['rm', '--force', name], timeout=60)
                outcome['ownedContainerCleanup'] = 'removed'
            except BaseException as error:
                outcome['ownedContainerCleanup'] = 'unavailable'
                outcome['cleanupError'] = str(error)[:1000]
                outcome['checkpointPublished'] = False
        (output / 'CARRIER.json').write_bytes(canonical(outcome) + b'\n')
        require(not created or outcome.get('ownedContainerCleanup') == 'removed', 'Owned container cleanup incomplete')


if __name__ == '__main__':
    main()
