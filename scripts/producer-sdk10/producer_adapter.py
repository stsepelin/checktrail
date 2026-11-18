"""Exact owned SDK producer lifecycle bridge. No effects occur on import.

Only registered original-build/tests containers qualify. Immutable IDs are used
for lifecycle commands; failed inspect is corroborated by an exact-ID listing,
never the Controller's name-based absence helper.
"""
import errno
import json
import os
import re
import stat
import time
from common import encoded, freeze, hash_file, owned_labels, read_json, syncdir
from producer_pause import Refusal, identity, need, complete_command, absent_inverse_observation

class MetadataUnavailable(RuntimeError):
    """Transport/state observation failed; captured-ID inverse remains possible."""

class ProducerAPI:
    def __init__(self, controller, name):
        self.c = controller
        need(name in controller.state['containers'], 'unregistered-native-producer')
        need(name in [controller.state['prefix'] + '-original-build', controller.state['prefix'] + '-original-tests'], 'exact-current-native-role')
        record = controller.state.get('nativeProducers', {}).get(name)
        need(type(record) is dict, 'captured-native-producer-required')
        self.record = record
        self.binding = record['binding']
        need(self.binding.get('name') == name and re.fullmatch('[0-9a-f]{64}', self.binding.get('id', '')) is not None and self.binding.get('labels') == owned_labels(controller.ctx), 'captured-current-context-producer')
        self.preservation = None

    @staticmethod
    def register(controller, name, obj, expected, argv):
        binding = {'id': obj.get('Id'), 'name': name, 'labels': owned_labels(controller.ctx)}
        need(re.fullmatch('[0-9a-f]{64}', binding['id'] or '') is not None, 'captured-full-producer-id')
        identity(obj, binding)
        need(name in controller.state['containers'] and name in [controller.state['prefix'] + '-original-build', controller.state['prefix'] + '-original-tests'], 'registered-current-native-role')
        registry = controller.state.setdefault('nativeProducers', {})
        need(name not in registry, 'producer-binding-is-once-only')
        registry[name] = {'binding': binding, 'expectedProtectedBinding': expected, 'originalArgv': list(argv)}
        controller.save()
        return binding

    def command(self, args, deadline):
        c = self.c
        previous = c.state['phaseDeadline']
        try:
            c.state['phaseDeadline'] = min(c.state['cleanupDeadline'], deadline)
            return c.cmd(['docker', *args], max(0.001, deadline - time.monotonic()), check=False, cap=65536)
        finally:
            c.state['phaseDeadline'] = previous

    def inspect_id(self, container_id, deadline):
        need(container_id == self.binding['id'], 'foreign-lifecycle-id')
        row, body = self.command(['container', 'inspect', container_id], deadline)
        if type(row.get('exitCode')) is not int or row.get('reason') is not None or row.get('ownedChildStarted') is not True or row.get('ownedChildReaped') is not True:
            raise MetadataUnavailable('inspect-transport-incomplete')
        if row.get('exitCode') != 0:
            listing, path = self.command(['container', 'ls', '-aq', '--no-trunc', '--filter', 'id=' + container_id], deadline)
            if not complete_command(listing): raise MetadataUnavailable('exact-id-listing-incomplete')
            value = path.read_bytes()
            if value == b'': return None
            if value != (container_id + '\n').encode(): raise MetadataUnavailable('exact-id-listing-unexpected')
            raise MetadataUnavailable('inspect-conflicts-with-existing-id')
        try:
            values = json.loads(body.read_bytes())
            if type(values) is not list or len(values) != 1: raise ValueError()
        except (ValueError, OSError) as error:
            raise MetadataUnavailable('inspect-body-unassessed') from error
        if time.monotonic() >= deadline: raise MetadataUnavailable('inspect-deadline')
        identity(values[0], self.binding)  # Positive foreign identity refuses all writes.
        return values[0]

    def effect(self, operation, container_id, deadline):
        need(container_id == self.binding['id'], 'foreign-lifecycle-id')
        obj = self.inspect_id(container_id, deadline)
        need(obj is not None, 'producer-absent-before-lifecycle-write')
        if operation == 'force_remove': need(not obj['State']['Running'] or obj['State']['Paused'], 'stable-producer-before-owned-removal')
        row, _ = self.command([operation, container_id] if operation in ['pause', 'unpause'] else ['rm', '-f', container_id], deadline)
        return row

    def pause_id(self, container_id, deadline):
        return self.effect('pause', container_id, deadline)

    def unpause_id(self, container_id, deadline):
        # This inverse may be necessary after an ambiguous own pause transport.
        # A fresh unavailable metadata read must not suppress it; a positive
        # foreign identity always does. The immutable captured ID cannot retarget.
        need(container_id == self.binding['id'], 'foreign-lifecycle-id')
        try:
            obj = self.inspect_id(container_id, deadline)
            if obj is None: return absent_inverse_observation(container_id)
        except MetadataUnavailable:
            pass
        except Refusal as error:
            if error.code != 'producer-state-unassessed': raise
        row, _ = self.command(['unpause', container_id], deadline)
        return row

    def preserve_protected_metadata(self, binding, deadline):
        need(binding == self.binding, 'foreign-protected-binding')
        obj = self.inspect_id(binding['id'], deadline)
        need(obj is not None and (not obj['State']['Running'] or obj['State']['Paused']), 'stable-producer-before-protected-preservation')
        c = self.c
        folder = c.root / 'evidence' / (binding['name'].removeprefix(c.state['prefix'] + '-') + '-PRESERVED-' + str(time.monotonic_ns()))
        folder.mkdir(mode=0o700)
        os.chmod(folder, 0o700)
        report = {'binding': binding, 'members': {}, 'existingProtectedBodiesPreserved': False, 'originalExitOrBuildCredit': False}
        try:
            source = c.root / 'protected' / binding['name']
            need(stat.S_ISDIR(source.lstat().st_mode) and not source.is_symlink(), 'physical-protected-source-parent')
            for member in ['START', 'RESULT']:
                need(time.monotonic() < deadline, 'protected-preservation-deadline')
                path = source / (member + '.json')
                try:
                    before = path.lstat()
                except OSError as error:
                    if error.errno != errno.ENOENT: raise
                    report['members'][member] = {'state': 'POSITIVELY_ABSENT'}
                    continue
                need(stat.S_ISREG(before.st_mode) and before.st_size <= 65536, 'physical-bounded-protected-member')
                target = folder / (member + '.json')
                command, _ = self.command(['cp', binding['id'] + ':/native-control/' + member + '.json', str(target)], deadline)
                need(complete_command(command), 'protected-copy-transport-incomplete')
                after = path.lstat()
                need((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), 'protected-source-changed-during-preservation')
                physical = target.lstat()
                need(stat.S_ISREG(physical.st_mode) and physical.st_size <= 65536, 'physical-bounded-preserved-member')
                value = read_json(target, 65536)
                need(value.get('schemaVersion') == 2 and value.get('binding') == self.record['expectedProtectedBinding'] and value.get('originalArgv') == self.record['originalArgv'], 'protected-command-context-binding')
                need(type(value.get('originalCommandStarted')) is bool, 'protected-start-state')
                durable_fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(durable_fd, 'rb') as durable:
                    copied = os.fstat(durable.fileno())
                    need((copied.st_dev, copied.st_ino, copied.st_size) == (physical.st_dev, physical.st_ino, physical.st_size), 'same physical protected copy before durability')
                    os.fchmod(durable.fileno(), 0o400)
                    os.fsync(durable.fileno())
                syncdir(folder)
                syncdir(folder.parent)
                need(time.monotonic() < deadline, 'protected-body-durability-deadline')
                report['members'][member] = {'state': 'PRESERVED', 'bytes': hash_file(target)[0], 'sha256': hash_file(target)[1]}
            current = self.inspect_id(binding['id'], deadline)
            need(current is not None and (not current['State']['Running'] or current['State']['Paused']), 'stable-producer-after-protected-preservation')
            need(time.monotonic() < deadline, 'protected-preservation-deadline')
            report['existingProtectedBodiesPreserved'] = True
        except BaseException as error:
            report['failureType'] = type(error).__name__
            raise
        finally:
            freeze(folder / 'PRESERVATION.json', encoded(report))
        need(time.monotonic() < deadline, 'protected-preservation-receipt-deadline')
        self.preservation = report
        return True

    def force_remove_id(self, container_id, deadline):
        need(self.preservation is not None and self.preservation.get('existingProtectedBodiesPreserved') is True and self.preservation['binding'] == self.binding, 'protected-preservation-before-removal')
        row = self.effect('force_remove', container_id, deadline)
        self.c.state.setdefault('nativeRemovalAttempts', {})[self.binding['name']] = {'binding': self.binding, 'protectedPreservation': self.preservation, 'command': row, 'originalExitOrBuildCredit': False}
        self.c.save()
        return row
