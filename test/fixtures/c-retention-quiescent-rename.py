"""Synthetic real-rename race; never invokes upstream source or a native service."""
from pathlib import Path
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import types

repo = Path(sys.argv[1]).resolve()
assert sys.argv[2] in ['running', 'paused']
file = repo / 'scripts/producer-qualification/binutils-retention-observer.py'
module = types.ModuleType('retention_observer_control')
exec(compile(file.read_text(), str(file), 'exec'), module.__dict__)
class Entry:
 def __init__(self,view,fd,entry):self.view=view;self.fd=fd;self.entry=entry;self.name=entry.name
 def stat(self,follow_symlinks=True):
  if self.view.churning and self.view.paths[self.fd]==self.view.target and self.name=='transient-object':
   os.rename(self.name,'renamed-object',src_dir_fd=self.fd,dst_dir_fd=self.fd);self.view.renames+=1
  return self.entry.stat(follow_symlinks=follow_symlinks)
class Scan:
 def __init__(self,view,fd):self.view=view;self.fd=fd
 def __enter__(self):
  if self.view.paths[self.fd]==self.view.target:
   self.view.scans+=1
   if (self.view.target/'renamed-object').exists():os.rename(self.view.target/'renamed-object',self.view.target/'transient-object')
  self.inner=os.scandir(self.fd);return iter([Entry(self.view,self.fd,e) for e in self.inner.__enter__()])
 def __exit__(self,*args):return self.inner.__exit__(*args)
class View:
 def __init__(self,target,churning):self.target=target;self.churning=churning;self.paths={};self.scans=self.renames=self.opened=self.closed=0
 def __getattr__(self,name):return getattr(os,name)
 def open(self,p,flags,mode=0o777,dir_fd=None):
  fd=os.open(p,flags,mode,dir_fd=dir_fd);self.paths[fd]=Path(p) if dir_fd is None else self.paths[dir_fd]/p;self.opened+=1;return fd
 def close(self,fd):os.close(fd);del self.paths[fd];self.closed+=1
 def scandir(self,fd):return Scan(self,fd)

base = Path(tempfile.mkdtemp(prefix='ct-retention-rename-')).resolve()
try:
    roots = tuple(str(base / name) for name in ['bundle', 'controls', 'work'])
    for root in roots:
        Path(root).mkdir()
    native = Path(roots[2]) / 'native-build'
    native.mkdir()
    (native / 'transient-object').write_bytes(b'original-mutable-object')
    (native / 'stable-object').write_bytes(b'ordinary-near-miss')
    (Path(roots[1]) / 'controller').write_bytes(b'fixed')
    view = View(native, sys.argv[2] == 'running')
    module.os = view
    stderr = io.StringIO()
    result = error = None
    with contextlib.redirect_stderr(stderr):
        try:
            result = module.count_c_build_roots(roots, 1)
        except BaseException as failure:
            error = {'type': type(failure).__name__, 'errno': getattr(failure, 'errno', None)}
    assert native.is_dir()
    print(json.dumps({'result': result, 'error': error, 'actualRenames': view.renames,
        'actualDirectoryEnumerations': view.scans,
        'retryDiagnostics': [json.loads(line) for line in stderr.getvalue().splitlines()],
        'allRealFDsClosed': not view.paths and view.opened == view.closed}))
finally:
    shutil.rmtree(base)
