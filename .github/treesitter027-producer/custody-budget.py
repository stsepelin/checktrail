"""Exact reviewed Cargo Budget primitive; explicit per-action limits required."""
import threading,time
LIMITS={"crate":512*1024**2,"index":64*1024**2,"decoded":8*1024**3}
class Budget:
    def __init__(self, limits=None, deadline=None):
        self.limits = limits or LIMITS
        self.used = {k: 0 for k in self.limits}
        self.reserved = {k: 0 for k in self.limits}
        self.lock = threading.Lock()
        self.deadline = deadline or time.monotonic() + 1800

    def read(self, stream, kind, maximum):
        if time.monotonic() > self.deadline:
            raise ValueError('Batch deadline')
        with self.lock:
            grant = min(maximum, 65536, self.limits[kind] - self.used[kind] - self.reserved[kind])
            if grant <= 0:
                raise ValueError(kind + ' aggregate byte bound')
            self.reserved[kind] += grant
        body = b''
        try:
            body = stream.read(grant)
            if len(body) > grant:
                raise ValueError('Reader exceeded granted bytes')
            return body
        finally:
            with self.lock:
                self.reserved[kind] -= grant
                self.used[kind] += len(body)

