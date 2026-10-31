"""Fixed operator probe of the original GLIBC test's kernel admission predicates.
No project/compiler code runs. CLOCK_REALTIME is supplied an invalid nanosecond
value and SYS_TIME/SYS_ADMIN must be absent from permitted/effective/bounding
sets before either clock/personality setter can be reached.
"""
import ctypes
import json
import os
import sys

assert sys.argv[1:] in [["baseline"], ["derived"]]
mode = sys.argv[1]
assert sys.platform == 'linux' and os.uname().machine == 'x86_64'
assert ctypes.sizeof(ctypes.c_long) == 8 and ctypes.sizeof(ctypes.c_void_p) == 8
status = {}
with open("/proc/self/status", "r", encoding="ascii") as handle:
    for line in handle:
        if line.startswith(("CapEff:", "CapPrm:", "CapBnd:")):
            key, value = line.split()
            status[key[:-1]] = value.lower()
for value in status.values():
    assert int(value, 16) & ((1 << 25) | (1 << 21)) == 0
assert set(status) == {"CapEff", "CapPrm", "CapBnd"}
libc = ctypes.CDLL(None, use_errno=True)
libc.personality.argtypes = [ctypes.c_ulong]
libc.personality.restype = ctypes.c_int


class Timespec(ctypes.Structure):
    _fields_ = [("tv_sec", ctypes.c_long), ("tv_nsec", ctypes.c_long)]


assert ctypes.sizeof(Timespec) == 16
libc.syscall.argtypes = [ctypes.c_long, ctypes.c_long, ctypes.POINTER(Timespec)]
libc.syscall.restype = ctypes.c_long

libc.clock_gettime.argtypes = [ctypes.c_int, ctypes.POINTER(Timespec)]
libc.clock_gettime.restype = ctypes.c_int
libc.clock_settime.argtypes = [ctypes.c_int, ctypes.POINTER(Timespec)]
libc.clock_settime.restype = ctypes.c_int
sentinel = 0xdefaced


def persona(value):
    ctypes.set_errno(sentinel)
    result = libc.personality(value)
    return {"result": result, "errno": ctypes.get_errno()}


personality = {"saved": persona(0xffffffff)}
saved = personality["saved"]["result"]
assert saved != -1
restored = False
try:
    personality["negativeSet"] = persona(0xffffffea)
    personality["negativeQuery"] = persona(0xffffffff)
    personality["linuxSet"] = persona(0)
    personality["linuxQuery"] = persona(0xffffffff)
    personality["near"] = persona(0xffffffeb)
finally:
    result = persona(ctypes.c_uint(saved).value)
    restored = result["result"] != -1 and persona(0xffffffff)["result"] == saved
now = Timespec()
read = libc.clock_gettime(1, ctypes.byref(now))
ctypes.set_errno(sentinel)
result = libc.clock_settime(1, ctypes.byref(now))
monotonic = {"result": result, "errno": ctypes.get_errno()}
invalid = Timespec(0, -1)
ctypes.set_errno(sentinel)
# Linux v6.14 arch/x86/entry/syscalls/syscall_64.tbl: clock_settime is 227.
# The libc clock_settime wrapper rejects -1 before the kernel seccomp check.
result = libc.syscall(227, 0, ctypes.byref(invalid))
realtime = {"result": result, "errno": ctypes.get_errno()}
print(json.dumps({
    "schemaVersion": 1,
    "mode": mode,
    "machine": os.uname().machine,
    "capabilities": {"effective": status["CapEff"], "permitted": status["CapPrm"], "bounding": status["CapBnd"]},
    "personality": personality,
    "clock": {"monotonicRead": read, "monotonicSet": monotonic, "realtimeInvalidSet": realtime},
    "restored": restored,
    "projectOrCompilerExecuted": False,
    "clockChangeAttemptedWithValidRealtimeArgument": False,
}, sort_keys=True))
