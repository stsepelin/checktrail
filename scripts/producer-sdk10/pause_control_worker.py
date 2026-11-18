"""First-party inert files/counters only; never imports an SDK/project."""
import argparse
import json
import os
import stat
from pathlib import Path
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parent))

def writer(deadline, role):
    if role not in ['build', 'tests']: raise ValueError('exact-inert-writer-role')
    root = Path('/work')
    (root / 'tmp').mkdir(exist_ok=True)
    for i in range(1024): (root / ('inert-' + str(i))).write_bytes(b'first-party inert control\n')
    (root / 'churn-probe').write_bytes(b'first-party inert race leaf\n')
    counter = 0
    counter_fd = os.open(root / ('counter-' + role), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    os.write(counter_fd, b'0000000000000000000\n')
    while time.monotonic() < deadline:
        request = Path('/coord/churn-delete.request')
        if request.is_file() and not Path('/coord/churn-delete.ack').exists():
            (root / 'churn-probe').unlink()
            Path('/coord/churn-delete.ack').write_bytes(b'owned deletion complete\n')
        counter += 1
        os.pwrite(counter_fd, (str(counter).zfill(19) + '\n').encode(), 0)
        if Path('/coord/continuous-churn.enabled').exists():
            target = root / ('changing-' + str(counter % 16))
            target.write_bytes(b'owned inert churn\n')
            if counter > 16:
                try: (root / ('changing-' + str((counter + 8) % 16))).unlink()
                except FileNotFoundError: pass
        time.sleep(0.005)
    os.close(counter_fd)
    return 0

def strict_churn(uid, gid):
    from meter import sample_once
    evidence = Path('/evidence')
    before = evidence.lstat()
    if not stat.S_ISDIR(before.st_mode) or (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) != (uid, gid, 0o770):
        raise RuntimeError('exact-inert-evidence-ownership-required')
    end = time.monotonic() + 20
    invoked = False
    def hook(stage, descriptor, name, value):
        nonlocal invoked
        if stage == 'after-stat' and name == 'churn-probe' and not invoked:
            invoked = True
            (evidence / 'churn-delete.request').write_bytes(b'exact first-party leaf\n')
            wait = min(end, time.monotonic() + 2)
            while time.monotonic() < wait and not (evidence / 'churn-delete.ack').exists(): time.sleep(0.005)
            if not (evidence / 'churn-delete.ack').exists(): raise RuntimeError('synthetic-writer-ack-unavailable')
    try:
        # The same finite metadata-folder ownership operation used by the
        # production meter runner; this never touches SDK/tools/source files.
        os.chown(evidence, 0, gid)
        result = sample_once('/work', end, hook)
        row = {'hookInvoked': invoked, 'samplingComplete': result['samplingComplete'], 'incompleteCode': result['incompleteCode'], 'sampledWorkOrQuotaCredit': False}
        target = evidence / 'CONTROLLED-CHURN.json'
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), 0o400)
            stream.write((json.dumps(row, sort_keys=True) + '\n').encode()); stream.flush(); os.fsync(stream.fileno())
        os.chown(target, uid, gid)
    finally:
        os.chown(evidence, uid, gid)
        directory = os.open(evidence, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(directory)
        finally: os.close(directory)
    return 0 if invoked and not result['samplingComplete'] and result['incompleteCode'] == 'entry-vanished-during-sample' else 2

if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('mode', choices=['writer', 'strict-churn']); p.add_argument('--deadline', type=float); p.add_argument('--role', choices=['build', 'tests']); p.add_argument('--uid', type=int); p.add_argument('--gid', type=int)
    a = p.parse_args()
    raise SystemExit(writer(a.deadline, a.role) if a.mode == 'writer' and a.deadline is not None and a.role is not None else strict_churn(a.uid, a.gid) if a.mode == 'strict-churn' and type(a.uid) is int and a.uid > 0 and type(a.gid) is int and a.gid >= 0 else 2)
