"""First-party inert protected-supervisor canaries; no SDK/source/seed command."""
import argparse
import errno
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import encoded, freeze, need
import native_entry

CASES = {'natural-build': ('build', 0), 'natural-tests': ('test', 7),
         'interrupt-build': ('build', None), 'denied-kill-tests': ('test', None)}

def selected(case):
    need(case in CASES, 'exact-inert-protected-canary-case')
    return CASES[case]

def child_argv(case, binding, deadline):
    selected(case)
    return ['/usr/bin/python3', '-I', '-S', '-B', '/observer/protected_control_worker.py',
            'child', '--case', case, '--binding-json', json.dumps(binding, sort_keys=True),
            '--deadline', str(deadline)]

def prepare(case, uid, gid):
    selected(case)
    need(os.geteuid() == 0 and type(uid) is int and uid > 0 and type(gid) is int and gid >= 0,
         'root-only-inert-data-preparation-for-nonroot-child')
    source = Path('/work/source')
    source.mkdir(mode=0o755, exist_ok=True)
    need(stat.S_ISDIR(source.lstat().st_mode) and source.stat().st_uid == 0 and not list(source.iterdir()),
         'only-empty-first-party-inert-working-directory')
    os.chmod(source, 0o755)
    parent = Path('/work/control-reports')
    parent.mkdir(mode=0o755, exist_ok=True)
    need(stat.S_ISDIR(parent.lstat().st_mode) and parent.stat().st_uid == 0,
         'physical-inert-report-parent')
    os.chmod(parent, 0o755)
    target = parent / case
    need(not os.path.lexists(target), 'fresh-per-canary-report-directory')
    target.mkdir(mode=0o700)
    os.chmod(target, 0o700)
    os.chown(target, uid, gid)

def child(case, binding, deadline):
    _, natural_code = selected(case)
    need(type(binding) is dict and binding.get('syntheticControlOnly') is True and
         binding.get('originalSDKCommandStarted') is False and binding.get('case') == case,
         'explicit-first-party-only-canary-binding')
    status = Path('/proc/self/status').read_text()
    caps = {key: int(value, 16) for key, value in re.findall(
        r'^(CapEff|CapPrm|CapInh|CapAmb):[ \t]*([0-9a-f]+)$', status, re.M)}
    nnp = re.search(r'^NoNewPrivs:[ \t]*([0-9]+)$', status, re.M)
    errors = {}
    try:
        fd = os.open('/native-control/START.json', os.O_RDONLY | os.O_NOFOLLOW)
        os.close(fd)
        errors['protectedOpenErrno'] = None
    except OSError as error:
        errors['protectedOpenErrno'] = error.errno
    try:
        os.kill(1, 0)  # Permission probe only: never sends a real signal.
        errors['rootParentSignalProbeErrno'] = None
    except OSError as error:
        errors['rootParentSignalProbeErrno'] = error.errno
    try:
        os.setuid(0)
        errors['rootSetuidProbeErrno'] = None
    except OSError as error:
        errors['rootSetuidProbeErrno'] = error.errno
    report = {'binding': binding, 'childPID': os.getpid(), 'parentPID': os.getppid(),
              'uid': os.getuid(), 'euid': os.geteuid(), 'gid': os.getgid(),
              'supplementaryGroups': os.getgroups(), 'capabilities': caps,
              'NoNewPrivs': int(nnp[1]) if nnp is not None else None, **errors,
              'originalSDKSourceSeedBuildTestsOrKeysExecuted': False}
    freeze(Path('/work/control-reports') / case / 'READY.json', encoded(report))
    if natural_code is not None:
        return natural_code
    while time.monotonic() < deadline:
        time.sleep(0.1)
    return 97  # Waiting past the target driver's stop deadline is never success.

def supervisor(case, binding, deadline, uid, gid):
    selected(case)
    need(os.geteuid() == 0 and uid > 0 and gid >= 0, 'root-supervisor-nonroot-canary')
    control = native_entry.protect_control('/native-control')
    argv = child_argv(case, binding, deadline)
    result = native_entry.supervise(argv, deadline, '/work/source', os.environ,
                                    control, binding, uid, gid)
    return result['supervisorExitCode']

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('mode', choices=['prepare', 'child', 'supervisor'])
    p.add_argument('--case', choices=sorted(CASES), required=True)
    p.add_argument('--uid', type=int)
    p.add_argument('--gid', type=int)
    p.add_argument('--binding-json')
    p.add_argument('--deadline', type=float)
    a = p.parse_args()
    if a.mode == 'prepare':
        prepare(a.case, a.uid, a.gid)
        raise SystemExit(0)
    binding = json.loads(a.binding_json)
    need(type(a.deadline) is float and time.monotonic() < a.deadline,
         'original-canary-deadline-before-first-party-process')
    raise SystemExit(child(a.case, binding, a.deadline) if a.mode == 'child'
                     else supervisor(a.case, binding, a.deadline, a.uid, a.gid))
