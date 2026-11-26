"""PROPOSAL: owned first-party Docker controls on Ubuntu26; no original SDK run.

The profile pins the existing helper image only. Original source/seed/native
entry/build/tests/keys/recovery/export are never invoked by this entry point.
"""
import argparse
import copy
import json
import os
import platform
from pathlib import Path
import re
import shutil
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parent))
from unittest.mock import patch
from common import bundle_bytes, context, digest, encoded, freeze, hash_file, need, owned_labels, read_json
from driver import Controller, HERE, manifest_check, prove_image
from owned_image import cleanup_image_inputs
from producer_adapter import ProducerAPI
import producer_pause as protocol
import live_resource

class ControlRefusal(RuntimeError): pass

def command_ok(row):
    need(protocol.complete_command(row), 'first-party target-control transport incomplete')

def counter_marker(api):
    expected = api.record['expectedProtectedBinding']
    role = expected.get('role')
    need(expected.get('purpose') == 'first-party-inert-control-only' and role in ['build', 'tests'], 'exact current inert counter role')
    need(api.binding['name'] == api.c.state['prefix'] + '-original-' + role, 'current role marker bound to exact producer name')
    return 'counter-' + role

def counter(api, deadline):
    marker = counter_marker(api)
    root = api.c.root / 'control'
    target = root / ('counter-' + str(time.monotonic_ns()))
    row, _ = api.command(['cp', api.binding['id'] + ':/work/' + marker, str(target)], deadline)
    command_ok(row)
    raw = target.read_bytes()
    need(len(raw) <= 32 and re.fullmatch(rb'[0-9]{19}\n', raw) and int(raw) > 0, 'finite inert counter')
    target.unlink()
    return int(raw)

class ObservedAPI(ProducerAPI):
    events = None
    def pause_id(self, container_id, deadline):
        row = super().pause_id(container_id, deadline)
        if protocol.complete_command(row):
            obj = self.inspect_id(container_id, deadline)
            need(obj is not None and obj['State']['Paused'] is True, 'actual pause state')
            first = counter(self, deadline)
            time.sleep(min(0.1, max(0, deadline - time.monotonic())))
            second = counter(self, deadline)
            need(first == second, 'actual inert counter stable while paused')
            self.events.append({'case': 'actual-pause-counter-stability', 'passed': True})
        return row
    def unpause_id(self, container_id, deadline):
        row = super().unpause_id(container_id, deadline)
        if protocol.complete_command(row):
            obj = self.inspect_id(container_id, deadline)
            if obj is not None and obj['State']['Running']:
                need(obj['State']['Paused'] is False, 'actual unpause state')
                first = counter(self, deadline)
                while time.monotonic() < deadline:
                    if counter(self, deadline) > first: break
                    time.sleep(0.01)
                else: raise ControlRefusal('inert-counter-resumption-unproven')
                self.events.append({'case': 'actual-unpause-counter-advances', 'passed': True})
        return row

def wait_counter(api, deadline):
    marker = counter_marker(api)
    while time.monotonic() < deadline:
        before = protocol.identity(api.inspect_id(api.binding['id'], deadline), api.binding)
        need(before is not None and before['Running'] is True and before['Paused'] is False, 'exact inert writer must be running before startup marker read')
        try:
            value = counter(api, deadline)
        except Exception:
            time.sleep(min(0.05, max(0, deadline - time.monotonic())))
            continue
        after = protocol.identity(api.inspect_id(api.binding['id'], deadline), api.binding)
        need(after is not None and after['Running'] is True and after['Paused'] is False, 'exact inert writer must still be running after startup marker read')
        need(time.monotonic() < deadline, 'inert writer startup readback deadline')
        return {'id': api.binding['id'], 'role': api.record['expectedProtectedBinding']['role'],
                'marker': marker, 'positiveCounter': value,
                'freshRunningBeforeAndAfterMarkerRead': True, 'originalSourceStartupOrBuildCredit': False}
    raise ControlRefusal('inert-writer-start-unproven')

def create_producer(c, role, deadline):
    need(role in ['build', 'tests'], 'exact inert producer role')
    name = c.state['prefix'] + '-original-' + role
    need(c.inspect('container', name) is None, 'fresh exact inert producer name')
    c.state['containers'].append(name); c.save()
    protected = c.root / 'protected' / name; protected.mkdir(mode=0o700)
    argv = c.observer_entry(['/observer/pause_control_worker.py', 'writer', '--role', role, '--deadline', str(deadline)])
    args = ['create', '--name', name, '--platform', 'linux/amd64', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--network', 'none', '--cpus', '1', '--memory', str(256 * 1024**2), '--memory-swap', str(256 * 1024**2), '--pids-limit', '32', '--user', '0:0', '--group-add', str(c.state['gid']), '--mount', 'type=volume,source=' + c.state['volume'] + ',target=/work,volume-nocopy', '--mount', 'type=bind,source=' + str(c.observer()) + ',target=/observer,readonly', '--mount', 'type=bind,source=' + str(c.root / 'evidence') + ',target=/coord', '--mount', 'type=bind,source=' + str(protected) + ',target=/native-control,readonly', '--entrypoint', argv[0]]
    for key, value in owned_labels(c.ctx).items(): args.extend(['--label', key + '=' + value])
    obj = c.create_owned(name, [*args, c.state['imageID'], *argv[1:]], seconds=30)
    expected = {'context': c.ctx, 'purpose': 'first-party-inert-control-only', 'role': role}
    binding = ProducerAPI.register(c, name, obj, expected, argv)
    h = obj['HostConfig']
    need(h['NetworkMode'] == 'none' and h['ReadonlyRootfs'] is True and h['Privileged'] is False and h['Memory'] == 256 * 1024**2 and h['CapDrop'] == ['ALL'] and h.get('GroupAdd') == [str(c.state['gid'])], 'actual finite first-party inert producer configuration')
    expected_mounts = {'/work': ('volume', c.state['volume'], True),
                       '/observer': ('bind', str(c.observer()), False),
                       '/coord': ('bind', str(c.root / 'evidence'), True),
                       '/native-control': ('bind', str(protected), False)}
    mounts = obj.get('Mounts')
    need(type(mounts) is list and len(mounts) == len(expected_mounts) and len({m.get('Destination') for m in mounts}) == len(mounts), 'complete unique inert canary mount set')
    for mount in mounts:
        destination = mount.get('Destination')
        need(destination in expected_mounts, 'no unselected inert canary mount')
        kind, source, rw = expected_mounts[destination]
        need(mount.get('Type') == kind and mount.get('Name' if kind == 'volume' else 'Source') == source and mount.get('RW') is rw, 'exact inert canary physical mount binding')
    # These are explicitly synthetic metadata, never original native receipts.
    freeze(protected / 'START.json', encoded({'schemaVersion': 2, 'binding': expected, 'originalArgv': argv, 'originalCommandStarted': False, 'syntheticControlOnly': True}))
    c.observer(); row, _ = c.docker(['start', binding['id']], seconds=10, check=False); command_ok(row)
    api = ProducerAPI(c, name); startup = wait_counter(api, min(deadline, time.monotonic() + 10))
    c.state.setdefault('inertWriterStarts', {})[name] = startup; c.save()
    return binding, api

def remove_control_volume(c, volume, deadline):
    # Synthetic controls have no original capture/recovery obligation. Do not
    # spoof source recovery flags to use the SDK's recovery-gated remover.
    need(volume in [c.state['volume'], c.state['tempVolume']], 'exact inert control volume')
    role = 'work' if volume == c.state['volume'] else 'temp'
    need(time.monotonic() < deadline, 'inert cleanup deadline before inspection')
    need(not any(os.path.lexists(c.root / 'control' / ('CONTROL-VOLUME-' + role + suffix)) for suffix in ['-ALREADY-ABSENT.json', '-DELETE.json', '-RESULT.json']), 'one controls cleanup already reserved')
    current = c.inspect('volume', volume)
    if current is None:
        freeze(c.root / 'control' / ('CONTROL-VOLUME-' + role + '-ALREADY-ABSENT.json'), encoded({'context': c.ctx, 'name': volume, 'deleteAttempted': False, 'positiveOwnedAbsenceObserved': True}))
        need(time.monotonic() < deadline, 'inert absence persistence deadline')
        return True
    obj = c.volume_owned(volume)
    need(current.get('Name') == obj.get('Name') and current.get('Labels') == obj.get('Labels'), 'same exact inert volume before one delete')
    marker = c.root / 'control' / ('CONTROL-VOLUME-' + role + '-DELETE.json')
    freeze(marker, encoded({'context': c.ctx, 'name': volume, 'originalOwnedIdentity': obj, 'oneDeleteReserved': True}))
    need(time.monotonic() < deadline, 'inert cleanup deadline')
    row, _ = c.docker(['volume', 'rm', volume], seconds=min(30, max(0.001, deadline - time.monotonic())), check=False)
    absent = False
    for number in range(16):
        if time.monotonic() >= deadline: break
        current = c.inspect('volume', volume)
        if current is None:
            absent = time.monotonic() < deadline
            break
        need(current.get('Name') == obj.get('Name') and current.get('Labels') == obj.get('Labels'), 'same inert volume after one delete')
        time.sleep(min(0.1, max(0, deadline - time.monotonic())))
    freeze(c.root / 'control' / ('CONTROL-VOLUME-' + role + '-RESULT.json'), encoded({'removeCommand': row, 'positiveOwnedAbsenceObserved': absent}))
    return absent

def prove_control_image(c, deadline):
    """Reuse the actual production config/raw-layer proof, never image-ID inference."""
    alias = c.state['imageAlias']
    expected_alias = 'checktrail-sdk10-controls-owned:' + str(c.ctx['run']) + '-' + c.ctx['nonce']
    need(alias == expected_alias and alias != c.profile['image']['reference'], 'fresh exact controls-owned image alias')
    need(shutil.disk_usage(c.root).free >= 9 * 1024**3, 'controls image export admission has nine GiB free')
    prove_image(c)  # Byte-identical production routine: raw config + all raw diffIDs.
    proof = read_json(c.root / 'evidence' / 'ORIGINAL-IMAGE-IDENTITY.json', 65536)
    selected = c.profile['image']
    need(proof['requestedOriginalManifest'] == selected['manifestSHA256'] and proof['originalConfig'] == selected['configSHA256'] and proof['staticNoticePackageHandoffSHA256'] == selected['staticNoticePackageHandoffSHA256'] and proof['historicalPublisherConsumptionAttested'] is False, 'physical selected image proof context')
    layers = proof['rawOriginalLayers']
    need(type(layers) is list and len(layers) == 4 and all(type(x) is dict and set(x) == {'bytes', 'sha256'} and type(x['bytes']) is int and x['bytes'] > 0 for x in layers) and [x['sha256'] for x in layers] == selected['diffIDs'] and sum(x['bytes'] for x in layers) == selected['rawLayerBytes'], 'physical selected image raw layer proof')
    image = c.inspect('image', alias)
    need(image is not None and type(proof['actualRuntimeImageID']) is str and re.fullmatch(r'sha256:[0-9a-f]{64}', proof['actualRuntimeImageID']) is not None and image['Id'] == proof['actualRuntimeImageID'] and image['Architecture'] == 'amd64' and image['Os'] == 'linux' and image['RootFS']['Layers'] == ['sha256:' + x for x in selected['diffIDs']], 'physical proof still binds the actual controls image')
    need(time.monotonic() < deadline, 'same controls deadline after image proof')
    return {'actualRuntimeImageID': image['Id'], 'originalConfigSHA256': proof['originalConfig'], 'imageLayerSHA256s': image['RootFS']['Layers'], 'imageConfigAndRawLayersPhysicallyVerified': True, 'imageProofOpaqueRawLayerBytes': sum(x['bytes'] for x in layers)}


def run(root, nonce, pin):
    profile = manifest_check(pin)
    need(sys.platform == 'linux' and os.environ.get('RUNNER_OS') == 'Linux' and os.environ.get('RUNNER_ARCH') == 'X64', 'standard Linux X64 first-party target controls')
    need(os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch' and os.environ.get('GITHUB_REPOSITORY') == profile['repository'] and os.environ.get('GITHUB_RUN_ATTEMPT') == '1', 'single selected manual diagnostic')
    ctx = context(nonce); need(not root.exists(), 'fresh owned target-control namespace'); root.mkdir(mode=0o700)
    for name in ['control', 'protected', 'evidence', 'inputs']: (root / name).mkdir(mode=0o700)
    # Only this inert-controls coordination directory permits the exact runner
    # group. Original SDK evidence directories retain their existing0700 mode.
    (root / 'evidence').chmod(0o770)
    started = time.monotonic(); native_end = started + 300; end = started + 480
    c = Controller(root, ctx, profile)
    prefix = 'ct-sdk10-' + str(ctx['run']) + '-' + nonce
    c.state = {'prefix': prefix, 'uid': os.getuid(), 'gid': os.getgid(), 'containers': [], 'volume': prefix + '-work', 'tempVolume': prefix + '-tmp', 'imageAlias': 'checktrail-sdk10-controls-owned:' + str(ctx['run']) + '-' + nonce, 'imageAliasCreated': False, 'preparationDeadline': native_end, 'phaseDeadline': native_end, 'nativeDeadline': native_end, 'cleanupDeadline': end}
    c.save(); events = []; failure = None; cleanup_errors = []; created_volumes = []; observations = {}
    try:
        c.publish_observer()
        need(Path('/etc/os-release').stat().st_size <= 4096, 'bounded target OS metadata file')
        os_release = Path('/etc/os-release').read_bytes()
        need(len(os_release) <= 4096, 'bounded target OS metadata')
        fields = dict(line.split('=', 1) for line in os_release.decode('utf8').splitlines() if '=' in line)
        observations['osID'] = fields.get('ID', '').strip(chr(34))[:32]; observations['osVersion'] = fields.get('VERSION_ID', '').strip(chr(34))[:32]; observations['machine'] = platform.machine()[:32]
        need(fields.get('ID', '').strip(chr(34)) == 'ubuntu' and fields.get('VERSION_ID', '').strip(chr(34)) == '26.04' and platform.machine() == 'x86_64', 'actual Ubuntu26 AMD64 target')
        capacity_row, capacity_path = c.docker(['info', '--format', '{{json .Architecture}} {{json .NCPU}} {{json .DockerRootDir}}'], seconds=10, check=False)
        command_ok(capacity_row)
        capacity_text = capacity_path.read_text().strip(); decoder = json.JSONDecoder(); fields = []
        while capacity_text:
            value, used = decoder.raw_decode(capacity_text); fields.append(value); need(len(fields) <= 3, 'only exact selected Docker capacity fields'); capacity_text = capacity_text[used:].lstrip()
        need(len(fields) == 3, 'only exact selected Docker capacity fields'); arch, cpus, docker_root = fields
        observations['dockerArchitecture'] = arch if type(arch) is str and len(arch) <= 32 else None; observations['dockerCPUs'] = cpus if type(cpus) is int else None
        need(arch in ['amd64', 'x86_64'] and type(cpus) is int and cpus >= 4, 'actual Docker AMD64 and four CPU helper binding')
        # The integrated sample observes physical free space against this root,
        # under the same state contract the original producer runner sets.
        need(type(docker_root) is str and os.path.isabs(docker_root) and os.path.isdir(docker_root) and os.stat(docker_root).st_dev == os.stat(root).st_dev, 'actual Docker root on the controls filesystem')
        c.state['capacityAdmission'] = {'architecture': arch, 'CPUs': cpus, 'DockerRootDir': docker_root}; c.save()
        events.append({'case': 'actual-Ubuntu26-AMD64-four-CPU-metadata', 'passed': True})
        # Same immutable input and byte-identical physical config/layer proof.
        observations.update(prove_control_image(c, native_end))
        events.append({'case': 'existing-selected-image-config-and-layers', 'passed': True})
        for volume in [c.state['volume'], c.state['tempVolume']]:
            need(c.inspect('volume', volume) is None, 'fresh exact owned control volume')
            labels = [part for key, value in owned_labels(ctx).items() for part in ['--label', key + '=' + value]]
            created_volumes.append(volume)  # Reserve cleanup BEFORE ambiguous create.
            c.docker(['volume', 'create', *labels, volume]); c.volume_owned(volume)
        binding, api = create_producer(c, 'build', native_end)
        # The byte-identical strict scanner must reject this deliberate actual
        # writer deletion. Only original first-party inert files are involved.
        c.helper('controlled-churn', ['/observer/pause_control_worker.py', 'strict-churn', '--uid', str(c.state['uid']), '--gid', str(c.state['gid'])], min(native_end, time.monotonic() + 35), True)
        churn = read_json(root / 'evidence/CONTROLLED-CHURN.json', 4096)
        need(churn == {'hookInvoked': True, 'samplingComplete': False, 'incompleteCode': 'entry-vanished-during-sample', 'sampledWorkOrQuotaCredit': False}, 'causal strict unchanged scanner churn refusal')
        events.append({'case': 'actual-controlled-churn-strict-refusal', 'passed': True})
        (root / 'evidence/continuous-churn.enabled').write_bytes(b'first-party inert churn only\n')
        ObservedAPI.events = events
        with patch.object(live_resource, 'ProducerAPI', ObservedAPI):
            observed = live_resource.observe(c, 'meter-1', native_end, producer_binding=binding)
        need(observed['complete'] is True and observed['producerLifecycle']['outcome'] == 'complete-sample-lifecycle', 'real integrated pause strict scan resume complete')
        events.append({'case': 'actual-integrated-strict-sample-and-lifecycle', 'passed': True})
        short = min(native_end, time.monotonic() + 20)
        refused = protocol.run(binding, api, lambda: (_ for _ in ()).throw(ControlRefusal('unreachable-short-budget-scan')), native_end, short)
        need(refused['outcome'] == 'refused' and refused['pauseAttempted'] is False and refused['samplingComplete'] is False, 'actual reserve refuses before pause')
        events.append({'case': 'actual-reserve-before-pause', 'passed': True})
        # Real pause followed by a first-party measurement exception must resume.
        failed = protocol.run(binding, api, lambda: (_ for _ in ()).throw(ControlRefusal('deliberate-inert-measurement-failure')), native_end, min(native_end, time.monotonic() + 90))
        need(failed['outcome'] == 'refused' and failed['lifecycleVerified'] and not api.inspect_id(binding['id'], min(native_end, time.monotonic() + 5))['State']['Paused'], 'measurement refusal independently resumed')
        events.append({'case': 'actual-resume-after-measurement-refusal', 'passed': True})
        class PreservationRefusal(ProducerAPI):
            def unpause_id(self, container_id, deadline): return {'exitCode': 1, 'reason': None, 'ownedChildStarted': True, 'ownedChildReaped': True}
            def preserve_protected_metadata(self, binding, deadline): return False
            def force_remove_id(self, container_id, deadline): raise ControlRefusal('destructive-removal-must-not-be-reached')
        refused_api = PreservationRefusal(c, binding['name'])
        protected = protocol.run(binding, refused_api, lambda: {'samplingComplete': True}, native_end, min(native_end, time.monotonic() + 90))
        need(protected['outcome'] == 'producer-cleanup-unproven' and protected['forcedRemovalAttempted'] is False and api.inspect_id(binding['id'], min(native_end, time.monotonic() + 5))['State']['Paused'], 'failed preservation blocks destructive removal')
        # Independent exact-ID inverse, not a repeat of any destructive request.
        command_ok(api.unpause_id(binding['id'], min(native_end, time.monotonic() + 5)))
        need(api.inspect_id(binding['id'], min(native_end, time.monotonic() + 5))['State']['Paused'] is False, 'independent inverse after preservation refusal')
        events.append({'case': 'actual-preservation-failure-blocks-removal-and-inverse-settles', 'passed': True})
        c.stop_owned(binding['name'])
        terminal_binding, terminal_api = create_producer(c, 'tests', native_end)
        row, _ = c.docker(['stop', '--time', '1', terminal_binding['id']], seconds=10, check=False); command_ok(row)
        terminal = protocol.run(terminal_binding, terminal_api, lambda: (_ for _ in ()).throw(ControlRefusal('terminal-producer-must-not-be-sampled')), native_end, min(native_end, time.monotonic() + 90))
        need(terminal['outcome'] == 'producer-terminal-no-sample' and terminal['pauseAttempted'] is False and terminal['samplingComplete'] is False, 'actual terminal race no sample credit')
        events.append({'case': 'actual-terminal-before-pause-no-sample', 'passed': True})
        c.observer()  # Every control ran from this snapshot; a changed one fails the controls.
    except BaseException as error:
        failure = type(error).__name__  # No arbitrary exception/path/source output.
    finally:
        c.state['phaseDeadline'] = end
        for name in c.state['containers']:
            try: c.stop_owned(name)
            except BaseException as error: cleanup_errors.append({'kind': 'container', 'errorType': type(error).__name__})
        for volume in created_volumes:
            try:
                absent = remove_control_volume(c, volume, end)
                need(absent is True, 'exact owned controls volume final absence')
            except BaseException as error: cleanup_errors.append({'kind': 'volume', 'errorType': type(error).__name__})
        if (c.root / 'control' / 'IMAGE-INPUT-OWNERSHIP.json').is_file():
            try: cleanup_image_inputs(c, end)
            except BaseException as error: cleanup_errors.append({'kind': 'image-inputs', 'errorType': type(error).__name__})
        success = failure is None and not cleanup_errors and time.monotonic() < end
        result = {'schemaVersion': 1, 'context': ctx, 'firstPartyControlsOnly': True, 'manifestSHA256': pin, 'observations': observations, 'complete': success, 'failureType': failure, 'cases': events, 'cleanupErrors': cleanup_errors, 'elapsedSeconds': time.monotonic() - started, 'nativeSecondsMaximum': 300, 'wholeSecondsMaximum': 480, 'originalSdkSourceSeedBuildTestsKeysOrPayloadExportExecuted': False, 'originalSdkBuildTestQuotaOrGateAQualified': False, 'strictMeterSHA256': digest(bundle_bytes(HERE / 'meter.py'))}
        need(len(encoded(result)) <= 65536, 'finite controls-only result metadata bound')
        freeze(root / 'RESULT.json', encoded(result))
        # This result alone is the finite first-party metadata export candidate.
        print(json.dumps(result, sort_keys=True), flush=True)
    return 0 if success else 1

if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--nonce', required=True); parser.add_argument('--manifest-sha256', required=True); args = parser.parse_args()
    raise SystemExit(run(Path(os.environ['RUNNER_TEMP']) / ('ct-sdk10-controls-' + args.nonce), args.nonce, args.manifest_sha256))
