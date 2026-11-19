"""First-party synthetic controls. No original files or operational keys."""
from pathlib import Path
from contextlib import redirect_stdout
import hashlib
import io
import json
import os
import plistlib
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import notice_custody as N
from common import Refusal

CONTEXT = {'run': 7, 'attempt': 1, 'head': 'a' * 40, 'nonce': N.NONCE}
SMALL = tuple((name, size) for (name, _), size in zip(N.FILES, [11, 17, 23]))


class Fixture(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.root.chmod(0o700)
        self.app = self.root / 'Xcode_26.2.app'
        self.app.mkdir()
        (self.app / 'Contents/Resources/en.lproj').mkdir(parents=True)
        (self.app / 'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleShortVersionString': '26.2'}))
        (self.app / 'Contents/version.plist').write_bytes(plistlib.dumps({'ProductBuildVersion': '17C52'}))
        for index, (name, size) in enumerate(SMALL):
            (self.app / name).write_bytes(bytes([65 + index]) * size)
        for path in self.app.rglob('*'):
            if path.is_file():
                path.chmod(0o644)
        ancestors = {}
        for path in [Path('/'), *self.app.parents, self.app, self.app / 'Contents',
                     self.app / 'Contents/Resources', self.app / 'Contents/Resources/en.lproj']:
            value = path.stat()
            ancestors[str(path)] = (value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode))
        self.patches = [mock.patch.object(N, 'APP', self.app), mock.patch.object(N, 'FILES', SMALL),
                        mock.patch.object(N, 'ANCESTORS', ancestors),
                        mock.patch.object(N, 'FILE_IDENTITY', ((self.app / 'Contents/Info.plist').stat().st_uid, (self.app / 'Contents/Info.plist').stat().st_gid, 0o644))]
        for patch in self.patches:
            patch.start()
            self.addCleanup(patch.stop)

    def original(self):
        return N.original_members(N.Budget(5))

    def payload(self):
        bodies, rows, version = self.original()
        raw, identity = N.make_container(bodies, rows, version, CONTEXT)
        return raw, identity

    def alter_manifest(self, raw, change):
        prefix = len(N.MAGIC) + 4
        length = struct.unpack('>I', raw[len(N.MAGIC):prefix])[0]
        manifest = json.loads(raw[prefix:prefix + length])
        change(manifest)
        replacement = N.encoded(manifest)
        return N.MAGIC + struct.pack('>I', len(replacement)) + replacement + raw[prefix + length:]


class DataControls(Fixture):
    def test_three_distinct_members_version_proof_and_contiguous_whole_container(self):
        raw, identity = self.payload()
        manifest = N.parse_container(raw, CONTEXT)
        self.assertEqual([name for name, _ in SMALL], [r['name'] for r in manifest['members']])
        self.assertEqual([0, 11, 28], [r['offset'] for r in manifest['members']])
        self.assertEqual(3, len({r['sha256'] for r in manifest['members']}))
        self.assertEqual(hashlib.sha256(N.encoded(manifest['members'])).hexdigest(), identity['internalMemberMapSHA256'])
        self.assertEqual(len(raw), identity['bytes'])
        self.assertEqual(hashlib.sha256(raw).hexdigest(), identity['sha256'])

    def test_n2_n1_n4_and_permutation_do_not_count_as_complete_three(self):
        raw, _ = self.payload()
        for count in [1, 2, 4]:
            with self.subTest(count=count):
                changed = self.alter_manifest(raw, lambda m: m.update(members=(m['members'] * 2)[:count]))
                with self.assertRaisesRegex(Refusal, 'exact-three'):
                    N.parse_container(changed, CONTEXT)
        changed = self.alter_manifest(raw, lambda m: m['members'].reverse())
        with self.assertRaisesRegex(Refusal, 'ordered-contiguous'):
            N.parse_container(changed, CONTEXT)

    def test_offsets_size_hash_name_and_extra_schema_near_misses(self):
        raw, _ = self.payload()
        for field, value in [('offset', 1), ('bytes', 12), ('sha256', '0' * 64),
                             ('name', SMALL[0][0] + '.other')]:
            with self.subTest(field=field):
                changed = self.alter_manifest(raw, lambda m: m['members'][0].update({field: value}))
                with self.assertRaises(Refusal):
                    N.parse_container(changed, CONTEXT)
        changed = self.alter_manifest(raw, lambda m: m.update(unselected='extra'))
        with self.assertRaisesRegex(Refusal, 'schema-selection'):
            N.parse_container(changed, CONTEXT)

    def test_context_nonce_attempt_and_boolean_near_misses(self):
        raw, _ = self.payload()
        for field, value in [('nonce', N.NONCE + 'x'), ('head', 'b' * 40), ('attempt', True), ('run', True)]:
            with self.subTest(field=field):
                wrong = {**CONTEXT, field: value}
                with self.assertRaises(Refusal):
                    N.parse_container(raw, wrong)
        changed = self.alter_manifest(raw, lambda m: m.update(schemaVersion=True))
        with self.assertRaises(Refusal):
            N.parse_container(changed, CONTEXT)

    def test_truncated_trailing_header_manifest_and_duplicate_json_refuse(self):
        raw, _ = self.payload()
        for bad in [raw[:-1], raw + b'x', b'wrong' + raw, N.MAGIC + struct.pack('>I', N.MAX_MANIFEST + 1) + raw]:
            with self.subTest(size=len(bad)), self.assertRaises(Refusal):
                N.parse_container(bad, CONTEXT)
        prefix = len(N.MAGIC) + 4
        length = struct.unpack('>I', raw[len(N.MAGIC):prefix])[0]
        meta = b'{"schemaVersion":1,' + raw[prefix:prefix + length][1:]
        bad = N.MAGIC + struct.pack('>I', len(meta)) + meta + raw[prefix + length:]
        with self.assertRaisesRegex(Refusal, 'duplicate-notice'):
            N.parse_container(bad, CONTEXT)

    def test_wrong_version_build_missing_and_bad_plist_refuse_before_notice_read(self):
        for relative, field, wrong in [('Contents/Info.plist', 'CFBundleShortVersionString', '26.3'),
                                       ('Contents/version.plist', 'ProductBuildVersion', '17C53')]:
            file = self.app / relative
            saved = file.read_bytes()
            try:
                file.write_bytes(plistlib.dumps({field: wrong}))
                with mock.patch.object(N, 'physical_read', wraps=N.physical_read) as called:
                    with self.assertRaisesRegex(Refusal, 'selected-xcode-version-build'):
                        self.original()
                    self.assertEqual(2, called.call_count)
            finally:
                file.write_bytes(saved)
        file = self.app / 'Contents/Info.plist'
        file.write_bytes(b'bad-plist')
        with self.assertRaises(Exception):
            self.original()

    def test_physical_file_type_link_mode_size_owner_and_nlink_family(self):
        name, size = SMALL[0]
        file = self.app / name
        saved = file.read_bytes()
        for kind in ['missing', 'directory', 'symlink', 'mode', 'empty', 'short', 'long', 'owner']:
            with self.subTest(kind=kind):
                file.unlink()
                extra = self.root / 'extra'
                try:
                    if kind == 'directory':
                        file.mkdir()
                    elif kind == 'symlink':
                        extra.write_bytes(saved); file.symlink_to(extra)
                    elif kind != 'missing':
                        file.write_bytes(b'' if kind == 'empty' else saved[:-1] if kind == 'short' else saved + b'x' if kind == 'long' else saved)
                        file.chmod(0o600 if kind == 'mode' else 0o644)
                    identity = (os.getuid() + 1, N.FILE_IDENTITY[1], 0o644) if kind == 'owner' else N.FILE_IDENTITY
                    with mock.patch.object(N, 'FILE_IDENTITY', identity), self.assertRaises((Refusal, OSError)):
                        N.physical_read(file, size, N.Budget(5), size)
                finally:
                    if file.is_dir() and not file.is_symlink():
                        file.rmdir()
                    elif os.path.lexists(file):
                        file.unlink()
                    if os.path.lexists(extra):
                        extra.unlink()
                    file.write_bytes(saved); file.chmod(0o644)

    def test_reported_second_link_count_guard_refuses_before_leaf_open(self):
        # Actual owned hardlink construction returned EPERM in the preserved
        # initial batch. This explicit metadata shim tests the guard condition;
        # it is not a claim that a physical second link was created here.
        file = self.app / SMALL[0][0]
        self.assertEqual(1, file.stat().st_nlink)
        original_stat, original_open = os.stat, os.open
        leaf_opens = []
        def inspecting(path, *args, **kwargs):
            actual = original_stat(path, *args, **kwargs)
            if path == file.name and kwargs.get('follow_symlinks') is False:
                values = list(actual); values[3] = 2
                return os.stat_result(values)
            return actual
        def opening(path, flags, *args, **kwargs):
            if path == file.name and not flags & os.O_DIRECTORY:
                leaf_opens.append(path)
            return original_open(path, flags, *args, **kwargs)
        with mock.patch.object(N.os, 'stat', side_effect=inspecting), mock.patch.object(N.os, 'open', side_effect=opening):
            with self.assertRaisesRegex(Refusal, 'selected-regular-notice-identity-mode-size'):
                N.physical_read(file, SMALL[0][1], N.Budget(5), SMALL[0][1])
        self.assertEqual([], leaf_opens)

    def test_wrong_ancestor_mode_and_symlink_refuse_without_following(self):
        resources = self.app / 'Contents/Resources'
        resources.chmod(0o777)
        try:
            with self.assertRaisesRegex(Refusal, 'ancestor-identity-mode'):
                self.original()
        finally:
            resources.chmod(0o755)
        moved = self.app / 'Contents/Resources-real'
        resources.rename(moved)
        resources.symlink_to(moved)
        try:
            with self.assertRaisesRegex(Refusal, 'ancestor-identity-mode'):
                self.original()
        finally:
            resources.unlink(); moved.rename(resources)

    def test_gap_replacement_before_open_is_causal_and_closes_every_fd(self):
        file = self.app / SMALL[0][0]
        original_open, original_close = os.open, os.close
        opened, closed = [], []
        def opening(path, flags, *args, **kwargs):
            if path == file.name and not flags & os.O_DIRECTORY:
                replacement = self.root / 'replacement'
                replacement.write_bytes(b'Z' * SMALL[0][1]); replacement.chmod(0o644)
                replacement.replace(file)
            fd = original_open(path, flags, *args, **kwargs); opened.append(fd); return fd
        def closing(fd):
            closed.append(fd); return original_close(fd)
        with mock.patch.object(N.os, 'open', side_effect=opening), mock.patch.object(N.os, 'close', side_effect=closing):
            with self.assertRaisesRegex(Refusal, 'file-open-changed'):
                N.physical_read(file, SMALL[0][1], N.Budget(5), SMALL[0][1])
        self.assertGreater(len(opened), 2)
        self.assertEqual(list(reversed(opened)), closed)
        for fd in opened:
            with self.assertRaises(OSError):
                os.fstat(fd)

    def test_unrelated_system_tmp_churn_preserves_owned_fixture_read(self):
        # The public test wrapper supplies an isolated, repository-owned TMPDIR.
        # /tmp is shared by unrelated workers, unlike the selected stock tree.
        shared = Path('/tmp').resolve()
        self.assertNotIn(shared, self.app.parents)
        file = self.app / SMALL[0][0]
        original = os.read
        changed = []
        def reading(fd, size):
            body = original(fd, size)
            if body and not changed:
                changed.append(tempfile.TemporaryDirectory(dir=shared))
            return body
        try:
            with mock.patch.object(N.os, 'read', side_effect=reading):
                body, row = N.physical_read(file, SMALL[0][1], N.Budget(5), SMALL[0][1])
            self.assertEqual(1, len(changed))
            self.assertEqual(b'A' * SMALL[0][1], body)
            self.assertEqual({'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}, row)
        finally:
            for directory in changed:
                directory.cleanup()

    def test_selected_ancestor_sibling_churn_still_refuses(self):
        file = self.app / SMALL[0][0]
        original = os.read
        sibling = file.parent / 'unselected-sibling'
        changed = []
        def reading(fd, size):
            body = original(fd, size)
            if body and not changed:
                sibling.mkdir(); changed.append(True)
            return body
        try:
            with mock.patch.object(N.os, 'read', side_effect=reading):
                with self.assertRaisesRegex(Refusal, '^notice-ancestor-read-changed$'):
                    N.physical_read(file, SMALL[0][1], N.Budget(5), SMALL[0][1])
            self.assertEqual([True], changed)
        finally:
            if sibling.exists():
                sibling.rmdir()

    def test_same_size_body_change_during_read_is_not_accepted(self):
        file = self.app / SMALL[0][0]
        original = os.read
        mutated = []
        def reading(fd, size):
            body = original(fd, size)
            if body and not mutated:
                file.write_bytes(b'Y' * SMALL[0][1]); mutated.append(True)
            return body
        with mock.patch.object(N.os, 'read', side_effect=reading):
            with self.assertRaisesRegex(Refusal, 'file-read-changed'):
                N.physical_read(file, SMALL[0][1], N.Budget(5), SMALL[0][1])
        self.assertEqual([True], mutated)

    def test_parent_name_substitution_during_read_cannot_bind_old_open_tree(self):
        file = self.app / SMALL[0][0]
        original = os.read
        changed = []
        def reading(fd, size):
            body = original(fd, size)
            if body and not changed:
                self.app.rename(self.root / 'old-app'); self.app.mkdir(); changed.append(True)
            return body
        with mock.patch.object(N.os, 'read', side_effect=reading):
            with self.assertRaisesRegex(Refusal, 'ancestor-(read|name)-changed'):
                N.physical_read(file, SMALL[0][1], N.Budget(5), SMALL[0][1])

    def test_expired_admission_never_opens_and_hard_phase_interrupts(self):
        now = [0.0]
        budget = N.Budget(1, lambda: now[0]); now[0] = 1
        with mock.patch.object(N.os, 'open', side_effect=AssertionError('expired must not open')):
            with self.assertRaisesRegex(Refusal, 'deadline-exhausted'):
                N.physical_read(self.app / SMALL[0][0], SMALL[0][1], budget)
        previous = signal.getsignal(signal.SIGALRM)
        with self.assertRaisesRegex(TimeoutError, 'hard-phase-expired'):
            with N.hard_phase(.01):
                time.sleep(.05)
        self.assertEqual((0.0, 0.0), signal.getitimer(signal.ITIMER_REAL))
        self.assertEqual(previous, signal.getsignal(signal.SIGALRM))

    def test_missing_third_never_publishes_partial_container_or_ready(self):
        (self.app / SMALL[2][0]).unlink()
        out = self.root / 'custody'
        with mock.patch.object(N, 'preflight_recipient', return_value=None), self.assertRaises(OSError):
            N.collect_and_seal(out, self.root / 'unused-public', 'a' * 64, CONTEXT)
        self.assertFalse((out / 'ORIGINAL-NOTICES.bin').exists())
        self.assertFalse((out / 'cipher/READY.json').exists())
        refusal = json.loads((out / 'REFUSAL.json').read_bytes())
        self.assertTrue(refusal['noPositivePartialCustody'])
        self.assertNotIn(str(self.app), json.dumps(refusal))

    def test_preflight_failure_never_reads_any_original_member(self):
        out = self.root / 'custody'
        with mock.patch.object(N, 'preflight_recipient', side_effect=ValueError('synthetic-key-refusal')), \
             mock.patch.object(N, 'original_members', side_effect=AssertionError('must not read')):
            with self.assertRaisesRegex(ValueError, 'synthetic-key-refusal'):
                N.collect_and_seal(out, self.root / 'unused', 'a' * 64, CONTEXT)
        self.assertFalse((out / 'ORIGINAL-NOTICES.bin').exists())
        self.assertTrue((out / 'REFUSAL.json').is_file())

    def test_private_public_input_modes_links_and_endpoint_identity(self):
        file = self.root / 'public.json'; file.write_bytes(b'{}'); file.chmod(0o444)
        self.assertEqual(b'{}', N.private_read(file, 2, public=True))
        with self.assertRaisesRegex(Refusal, 'private-notice-input-identity'):
            N.private_read(file, 2)
        file.chmod(0o400)
        self.assertEqual(b'{}', N.private_read(file, 2))
        with self.assertRaises(Refusal):
            N.private_read(file, 1)

    def test_closed_host_context_requires_repo_event_arch_operator(self):
        env = {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted',
               'GITHUB_REPOSITORY': 'stsepelin/checktrail', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
               'RUNNER_ARCH': 'ARM64', 'GITHUB_RUN_ID': '7', 'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_SHA': 'a' * 40}
        with mock.patch.dict(os.environ, env), mock.patch.object(N.os, 'getuid', return_value=0), \
             mock.patch.object(N.platform, 'system', return_value='Darwin'), mock.patch.object(N.platform, 'machine', return_value='arm64'):
            self.assertEqual(CONTEXT, N.host_context())
            for key, wrong in [('GITHUB_REPOSITORY', 'other/checktrail'), ('GITHUB_EVENT_NAME', 'push'), ('RUNNER_ARCH', 'X64')]:
                with mock.patch.dict(os.environ, {key: wrong}), self.assertRaises(Refusal):
                    N.host_context()

    def test_main_context_refusal_is_closed_and_never_reads_originals(self):
        output = io.StringIO()
        with mock.patch.object(sys, 'argv', ['notice', str(self.root / 'output'), '--public-recipient',
             str(self.root / 'not-read'), '--recipient-sha256', 'a' * 64]), \
             mock.patch.object(N, 'host_context', side_effect=Refusal('synthetic-context-refusal')), \
             mock.patch.object(N, 'original_members', side_effect=AssertionError('original body must not be read')), \
             redirect_stdout(output):
            code = N.main()
        self.assertEqual(1, code)
        summary = json.loads(output.getvalue())
        self.assertFalse(summary['originalNoticeCustodyComplete'])
        self.assertFalse(summary['rawOriginalBodyOrDynamicPathEmitted'])
        self.assertNotIn('Traceback', output.getvalue())
        self.assertNotIn(str(self.app), output.getvalue())
        self.assertFalse((self.root / 'output').exists())

    def test_real_isolated_cli_help_is_zero_without_body_or_sdk_execution(self):
        result = subprocess.run([sys.executable, '-I', '-B', str(HERE / 'notice_custody.py'), '--help'],
                                capture_output=True, timeout=5)
        self.assertEqual(0, result.returncode)
        self.assertEqual(b'', result.stderr)
        self.assertIn(b'public-recipient', result.stdout)
        self.assertNotIn(b'Traceback', result.stdout)

    def test_exact_current_nonce_interoperates_with_unchanged_codec_before_any_key_setup(self):
        script = """import {encrypt} from './envelope.mjs';
const context=JSON.parse(process.argv[1]);
try { await encrypt({seconds:1,plaintext:{bytes:1,sha256:'a'.repeat(64),internalMemberMapSHA256:'b'.repeat(64)},context,publicJWK:null});process.exitCode=3; }
catch(error){process.stdout.write(JSON.stringify({reason:error.message})+'\\n');}
"""
        for nonce, expected in [(N.NONCE, 'public RSA JWK only; no private fields'),
                                ('rust198-xcode262-original-notices-1118-v1', 'exact original context')]:
            context = {**CONTEXT, 'nonce': nonce}
            result = subprocess.run(['node', '--input-type=module', '-e', script, json.dumps(context)],
                cwd=HERE / 'reused-crypto', capture_output=True, timeout=5)
            self.assertEqual(0, result.returncode)
            self.assertEqual(b'', result.stderr)
            self.assertEqual({'reason': expected}, json.loads(result.stdout))
        self.assertLessEqual(len(N.NONCE), 40)
        N.validate_context(CONTEXT)

    def test_version_metadata_cap_exact_and_over_boundary(self):
        file = self.app / 'Contents/Info.plist'
        body = plistlib.dumps({'CFBundleShortVersionString': '26.2'})
        file.write_bytes(body + b' ' * (N.MAX_VERSION_METADATA - len(body)))
        raw, proof = N.physical_read(file, N.MAX_VERSION_METADATA, N.Budget(5))
        self.assertEqual(N.MAX_VERSION_METADATA, len(raw))
        file.write_bytes(raw + b' ')
        with self.assertRaisesRegex(Refusal, 'regular-notice-identity-mode-size'):
            N.physical_read(file, N.MAX_VERSION_METADATA, N.Budget(5))

    def test_private_read_checks_held_descriptor_after_read_before_pathname(self):
        file = self.root / 'private'; file.write_bytes(b'synthetic'); file.chmod(0o400)
        original = os.fstat
        calls = []
        def changed_after_read(fd):
            value = original(fd); calls.append(fd)
            if len(calls) == 2:
                values = list(value); values[6] += 1
                return os.stat_result(values)
            return value
        with mock.patch.object(N.os, 'fstat', side_effect=changed_after_read):
            with self.assertRaisesRegex(Refusal, 'held-fd-changed'):
                N.private_read(file, 64)
        self.assertEqual(2, len(calls))

    def fake_seal_inputs(self):
        body, _ = self.payload()
        source = self.root / 'notices.bin'; N.freeze(source, body)
        public = self.root / 'public.json'; N.freeze(public, N.encoded({'kty': 'RSA', 'e': 'AQAB', 'n': 'synthetic'}))
        return source, public, hashlib.sha256(public.read_bytes()).hexdigest()

    def fake_encrypt(self, folder, mode, request, deadline):
        # Explicit transport/receipt seam; no claim this is real encryption.
        self.assertEqual('encrypt', mode)
        folder.mkdir(mode=0o700)
        data = b'SYNTHETIC-CIPHERTEXT-SEAM'
        N.freeze(Path(request['out']), data)
        return {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                'plaintext': request['plaintext'], 'context': request['context'], 'publicRecipientJWK': request['publicJWK']}

    def test_mocked_late_zero_after_cipher_creation_has_no_ready_credit(self):
        source, public, digest = self.fake_seal_inputs()
        now = [100.0]
        def late(folder, mode, request, deadline):
            result = self.fake_encrypt(folder, mode, request, deadline)
            now[0] = 200.0
            return result
        output = self.root / 'late-cipher'
        with mock.patch.object(N.time, 'monotonic', side_effect=lambda: now[0]), mock.patch.object(N, 'operation', side_effect=late):
            with self.assertRaises(Refusal):
                N.seal_container(source, output, public, digest, CONTEXT, 150.0)
        self.assertTrue((output / 'notices.ctenc').exists())
        self.assertFalse((output / 'READY.json').exists())

    def test_late_during_ready_persistence_revokes_apparently_complete_credit(self):
        import common
        source, public, digest = self.fake_seal_inputs()
        now = [100.0]
        original = common.freeze
        def persisting(path, body):
            original(path, body)
            if Path(path).name == 'READY.json':
                now[0] = 200.0
        output = self.root / 'late-receipt'
        with mock.patch.object(N.time, 'monotonic', side_effect=lambda: now[0]), \
             mock.patch.object(N, 'operation', side_effect=self.fake_encrypt), \
             mock.patch.object(common, 'freeze', side_effect=persisting):
            with self.assertRaisesRegex(Refusal, 'late-notice-custody-is-incomplete'):
                N.seal_container(source, output, public, digest, CONTEXT, 150.0)
        ready = json.loads((output / 'READY.json').read_bytes())
        self.assertFalse(ready['allThreeOriginalNoticesEncrypted'])
        self.assertTrue(ready['completionBudgetExhausted'])
        self.assertEqual(0o400, (output / 'notices.ctenc').stat().st_mode & 0o777)

    def test_partial_crypto_failure_cannot_publish_ready_or_grant_upload(self):
        source, public, digest = self.fake_seal_inputs()
        def partial(folder, mode, request, deadline):
            self.fake_encrypt(folder, mode, request, deadline)
            raise Refusal('synthetic-partial-crypto-failure')
        output = self.root / 'partial-cipher'
        with mock.patch.object(N, 'operation', side_effect=partial), self.assertRaisesRegex(Refusal, 'partial-crypto-failure'):
            N.seal_container(source, output, public, digest, CONTEXT, time.monotonic() + 5)
        self.assertFalse((output / 'READY.json').exists())
        self.assertEqual(0o700, output.stat().st_mode & 0o777)

    def test_only_complete_exact_cipher_members_become_readable_plaintext_stays_private(self):
        source, public, digest = self.fake_seal_inputs()
        output = self.root / 'cipher'
        with mock.patch.object(N, 'operation', side_effect=self.fake_encrypt):
            ready = N.seal_container(source, output, public, digest, CONTEXT, time.monotonic() + 5)
        with self.assertRaisesRegex(Refusal, 'incomplete-notice-upload'):
            N.grant_cipher_upload(self.root, output, {**ready, 'allThreeOriginalNoticesEncrypted': False})
        self.assertEqual(0o700, self.root.stat().st_mode & 0o777)
        N.grant_cipher_upload(self.root, output, ready)
        self.assertEqual(0o711, self.root.stat().st_mode & 0o777)
        self.assertEqual(0o555, output.stat().st_mode & 0o777)
        self.assertEqual({0o444}, {(output / name).stat().st_mode & 0o777 for name in N.MEMBERS})
        self.assertEqual(0o400, source.stat().st_mode & 0o777)
        self.assertEqual(0o700, (output / 'private-crypto').stat().st_mode & 0o777)

    def test_same_size_cipher_mutation_refuses_upload_before_any_mode_changes(self):
        source, public, digest = self.fake_seal_inputs()
        output = self.root / 'cipher'
        with mock.patch.object(N, 'operation', side_effect=self.fake_encrypt):
            ready = N.seal_container(source, output, public, digest, CONTEXT, time.monotonic() + 5)
        file = output / 'notices.ctenc'; raw = file.read_bytes(); file.chmod(0o600); file.write_bytes(b'Z' + raw[1:]); file.chmod(0o400)
        with self.assertRaisesRegex(Refusal, 'whole-notice-upload-cipher'):
            N.grant_cipher_upload(self.root, output, ready)
        self.assertEqual(0o700, self.root.stat().st_mode & 0o777)
        self.assertEqual(0o400, file.stat().st_mode & 0o777)

    def test_main_only_fixed_own_namespace_then_closed_success_projection(self):
        ready = {'allThreeOriginalNoticesEncrypted': True, 'bytes': 3, 'sha256': 'b' * 64,
                 'originalMemberCount': 3, 'originalSelectedBytes': 51, 'completionCreditFinalized': True,
                 'completionBudgetExhausted': False, 'licenseSDKBuildNativeOrGateACredit': False}
        with mock.patch.object(N, 'OWN_BASE', self.root):
            namespace = N.namespace(CONTEXT); namespace.mkdir(mode=0o700)
            output = io.StringIO()
            argv = ['notice', str(namespace / 'custody'), '--public-recipient', str(self.root / 'synthetic-public'),
                    '--recipient-sha256', 'a' * 64]
            with mock.patch.object(sys, 'argv', argv), mock.patch.object(N, 'host_context', return_value=CONTEXT), \
                 mock.patch.object(N, 'collect_and_seal', return_value=ready) as collected, redirect_stdout(output):
                self.assertEqual(0, N.main())
            # This is a command wiring seam, not an actual custody qualification.
            collected.assert_called_once_with(namespace / 'custody', self.root / 'synthetic-public', 'a' * 64, CONTEXT)
            self.assertEqual(0o711, namespace.stat().st_mode & 0o777)
            self.assertNotIn(str(namespace), output.getvalue())
            self.assertFalse(json.loads(output.getvalue())['licenseSDKBuildNativeOrGateACredit'])

    def test_main_wrong_output_or_namespace_mode_refuses_before_original_body_work(self):
        with mock.patch.object(N, 'OWN_BASE', self.root):
            namespace = N.namespace(CONTEXT); namespace.mkdir(mode=0o755)
            for output_path in [self.root / 'unselected', namespace / 'custody']:
                output = io.StringIO()
                with mock.patch.object(sys, 'argv', ['notice', str(output_path), '--public-recipient', 'unused', '--recipient-sha256', 'a' * 64]), \
                     mock.patch.object(N, 'host_context', return_value=CONTEXT), \
                     mock.patch.object(N, 'collect_and_seal', side_effect=AssertionError('must not perform body work')), redirect_stdout(output):
                    self.assertEqual(1, N.main())
                self.assertFalse(json.loads(output.getvalue())['originalNoticeCustodyComplete'])
                self.assertNotIn(str(output_path), output.getvalue())


if __name__ == '__main__':
    unittest.main()
