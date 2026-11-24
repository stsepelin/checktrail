"""Run only first-party synthetic controls; never imports SDK/project bodies.

Until the bundle has been verified, this file imports only the standard
library: the directory is not on sys.path, and isolated mode (-I) keeps the
interpreter from adding it as the script directory. Verification reads every
pinned file once; from then on entry scripts, first-party imports and the
data files the code reads are served from those verified bytes, and nothing
is imported from the directory on disk. The --entry mode applies the same
order to one pinned script and its arguments.
"""
import sys
# A cache written beside the verified files would itself be an unreviewed entry.
sys.dont_write_bytecode=True
if __name__=='__main__' and not sys.flags.isolated:raise SystemExit('run_checks.py must run isolated (python3 -I) so its directory is not importable before verification')
# Containers start this file too, so only core modules are imported up front.
import argparse,errno,hashlib,importlib.machinery,json,linecache,os,pathlib,stat,subprocess,time,types
HERE=pathlib.Path(__file__).resolve().parent
class Unreviewed(RuntimeError):pass
# Every start of this file goes through this isolated bootstrap, run as
# python3 -I -S -B -c BOOTSTRAP <run_checks.py> <sha256> <arguments...>. It
# reads the file once, compares those bytes with the given SHA256 and
# executes exactly those bytes as __main__, never reopening the file, so a
# change after the comparison cannot run. Its exit status is the launcher's.
BOOTSTRAP=("import hashlib,sys;p=sys.argv[1];f=open(p,'rb');b=f.read();f.close();"
 "hashlib.sha256(b).hexdigest()==sys.argv[2] or sys.exit('run_checks.py differs from its pinned SHA256');"
 "sys.argv=[p]+sys.argv[3:];exec(compile(b,p,'exec'),{'__name__':'__main__','__file__':p,'__spec__':None,'__loader__':None,'__package__':None,'__cached__':None})")
# Child processes of a verified launcher start through this bootstrap instead:
# python3 -I -S -B -c BUNDLE_BOOTSTRAP <run_checks.py> <manifest sha256>
# <arguments...>, with the parent's verified bundle (Bundle.packed) on stdin.
# It runs run_checks.py from those bytes only if the pinned manifest names
# them, and hands the bundle on as PINNED_BUNDLE, which run_checks.py verifies
# in full against --manifest-sha256. The child never reads the directory.
BUNDLE_BOOTSTRAP=("import hashlib,json,sys;p=sys.argv[1];b={k:v.encode('latin-1') for k,v in json.loads(sys.stdin.buffer.read()).items()};m=b.get('MANIFEST.json',b'');"
 "hashlib.sha256(m).hexdigest()==sys.argv[2] or sys.exit('bundle manifest differs from its pinned SHA256');"
 "r=[x for x in json.loads(m)['files'] if type(x) is dict and x.get('path')=='run_checks.py'];"
 "len(r)==1 and hashlib.sha256(b.get('run_checks.py',b'')).hexdigest()==r[0].get('sha256') or sys.exit('run_checks.py differs from its pinned SHA256');"
 "sys.argv=[p]+sys.argv[3:];exec(compile(b['run_checks.py'],p,'exec'),{'__name__':'__main__','__file__':p,'__spec__':None,'__loader__':None,'__package__':None,'__cached__':None,'PINNED_BUNDLE':b})")
def need(value,message):
 if not value:raise Unreviewed(message)
def hash_file(path):
 h=hashlib.sha256();n=0
 with open(path,'rb') as f:
  for block in iter(lambda:f.read(1048576),b''):n+=len(block);h.update(block)
 return n,h.hexdigest()

def verified_files(pin,read):
 """Every pinned file of a first-party bundle, each read once by read(name, size).

 MANIFEST.json is checked against the operator pin, its rows by MANIFEST.json,
 and the protected-control files by PROTECTED-CONTROLS.json, which is itself
 a MANIFEST.json row. The returned bytes are the only ones run or read later.
 """
 raw=read('MANIFEST.json',None);need(raw is not None and hashlib.sha256(raw).hexdigest()==pin,'operator-reviewed first-party bundle manifest');files={'MANIFEST.json':raw}
 def frozen(rows):
  need(type(rows) is list and rows,'nonempty pinned control file list')
  for row in rows:
   name=row.get('path') if type(row) is dict else None;need(type(name) is str and name not in ['','.','..','MANIFEST.json'] and '/' not in name and '\\' not in name,'direct first-party control file name');need(name not in files,'each control file pinned once')
   size=row.get('bytes');data=read(name,size) if type(size) is int and size>=0 else None
   need(data is not None and (len(data),hashlib.sha256(data).hexdigest())==(size,row.get('sha256')),'frozen first-party control file changed: '+name);files[name]=data
 frozen(json.loads(raw)['files'])
 if 'PROTECTED-CONTROLS.json' in files:frozen(json.loads(files['PROTECTED-CONTROLS.json'])['files'])
 return files

def reviewed_bundle(folder,pin):
 """Read and verify an exactly reviewed first-party directory, each file once.

 Every entry of the directory must be pinned. Nothing in it is imported here,
 and after this read no import, entry or data read reaches the directory.
 """
 folder=pathlib.Path(folder)
 def read(name,size):
  try:fd=os.open(folder/name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
  except OSError:return None
  try:
   if not stat.S_ISREG(os.fstat(fd).st_mode):return None
   with open(fd,'rb',closefd=False) as f:return f.read() if size is None else f.read(size+1)
  finally:os.close(fd)
 files=verified_files(pin,read)
 unexpected=sorted(set(os.listdir(folder))-set(files));need(not unexpected,'unreviewed entry in executed control directory: '+', '.join(unexpected[:8]))
 return files

def given_bundle(given,pin):
 """Verify a bundle a verified parent passed on stdin, exactly as one read from disk."""
 need(type(given) is dict and all(type(k) is str and type(v) is bytes for k,v in given.items()),'verified first-party bundle mapping')
 files=verified_files(pin,lambda name,size:given.get(name));unexpected=sorted(set(given)-set(files));need(not unexpected,'unreviewed entry in executed control directory: '+', '.join(unexpected[:8]));return files

def reviewed_names(folder,pin):
 """Return every pinned entry name of an exactly reviewed first-party directory."""
 return [x for x in reviewed_bundle(folder,pin) if x!='MANIFEST.json']

def bound_tests(files):
 """Return the test modules of an exactly reviewed control bundle."""
 tests=sorted(x[:-3] for x in files if x.startswith('test_') and x.endswith('.py'));need(tests,'nonempty reviewed Python controls');return tests

class OutsideBundle:
 """The standard path finder over the search path at verification, without the bundle directory.

 Entry scripts and controls put their own resolved directory first on
 sys.path after verification; a replaced entry can resolve that elsewhere.
 A top-level name the bundle does not pin therefore searches only the
 isolated startup path, never an entry added later.
 """
 def __init__(self,folder):self.folder=folder;self.trusted=[x for x in sys.path if self.outside(x)]
 def outside(self,entry):
  try:return os.path.realpath(entry or os.getcwd())!=self.folder
  except (TypeError,ValueError,OSError):return False
 def find_spec(self,fullname,path=None,target=None):
  return importlib.machinery.PathFinder.find_spec(fullname,list(self.trusted) if path is None else [x for x in path if self.outside(x)],target)
 def invalidate_caches(self):importlib.machinery.PathFinder.invalidate_caches()

class Bundle:
 """Import, run and read first-party files only from verified in-memory bytes."""
 def __init__(self,folder,files,pin):self.folder=os.path.realpath(folder);self.files=dict(files);self.pin=pin
 def path(self,name):return os.path.join(self.folder,name)
 def code(self,name):
  path=self.path(name);source=self.files[name]
  # Tracebacks then show the verified lines, not whatever the file holds now.
  linecache.cache[path]=(len(source),None,source.decode('utf-8','replace').splitlines(True),path)
  return compile(source,path,'exec',dont_inherit=True)
 def find_spec(self,fullname,path=None,target=None):
  if '.' in fullname or fullname+'.py' not in self.files:return None
  return importlib.machinery.ModuleSpec(fullname,self,origin=self.path(fullname+'.py'))
 def create_module(self,spec):return None
 def exec_module(self,module):
  name=module.__spec__.name+'.py';module.__file__=self.path(name);exec(self.code(name),module.__dict__)
 def get_source(self,fullname):return self.files[fullname+'.py'].decode('utf-8')
 def get_data(self,path):
  """The verified bytes of one bundle file; no other path is served."""
  folder,name=os.path.split(os.fspath(path))
  if os.path.realpath(folder)!=self.folder or name not in self.files:raise OSError(errno.ENOENT,'not a verified first-party bundle file',os.fspath(path))
  return self.files[name]
 def module(self,name):
  """A private module built from the verified bytes, outside sys.modules."""
  module=types.ModuleType(name);module.__file__=self.path(name+'.py');module.__loader__=self;exec(self.code(name+'.py'),module.__dict__);return module
 def install(self):
  """Make this bundle the only source of first-party code in this process."""
  outside=OutsideBundle(self.folder);sys.path[:]=outside.trusted
  sys.meta_path[:]=[self]+[outside if x is importlib.machinery.PathFinder else x for x in sys.meta_path]
  return self
 def run_main(self,script,args):
  """Run one pinned script as __main__ with its arguments, as runpy.run_path would."""
  path=self.path(script);sys.argv=[path,*args];module=types.ModuleType('__main__')
  module.__dict__.update(__file__=path,__loader__=self,__spec__=None,__package__=None,__cached__=None)
  previous=sys.modules.get('__main__');sys.modules['__main__']=module
  try:exec(self.code(script),module.__dict__)
  finally:sys.modules['__main__']=previous
 def packed(self):return json.dumps({k:v.decode('latin-1') for k,v in self.files.items()},sort_keys=True).encode()
 def child(self,argv):
  """The command and stdin that run one pinned script of this bundle in a new process."""
  return [sys.executable,'-I','-S','-B','-c',BUNDLE_BOOTSTRAP,self.path('run_checks.py'),self.pin,'--manifest-sha256',self.pin,'--entry',*argv],self.packed()
 def observer_argv(self,mount,script,args):
  """The container command that runs one pinned script of this bundle mounted at mount.

  The container's interpreter starts through BOOTSTRAP, which reads the
  mounted run_checks.py once and checks it against this bundle's bytes;
  run_checks.py then reads and verifies the whole mount against the pin and
  runs the script from those bytes, so even the mounted copy is never
  executed from disk.
  """
  return ['/usr/bin/python3','-I','-S','-B','-c',BOOTSTRAP,mount+'/run_checks.py',hashlib.sha256(self.files['run_checks.py']).hexdigest(),'--manifest-sha256',self.pin,'--entry',script,*args]

def load(pin,given=None):
 return reviewed_bundle(HERE,pin) if given is None else given_bundle(given,pin)

def verified_entry(pin,argv,given=None):
 """Run one pinned first-party script only after its whole bundle verifies.

 Entry scripts put their own directory on sys.path and import siblings at
 module level, before any check of their own can run, so the operator pin is
 checked here first; the script and every sibling it imports then run from
 the verified bytes.
 """
 need(type(argv) is list and argv,'pinned first-party entry script required')
 script=argv[0];need(type(script) is str and script.endswith('.py') and '/' not in script and '\\' not in script and script!='run_checks.py','direct first-party entry script name')
 files=load(pin,given);need(script in files,'entry script is not a reviewed first-party file: '+script)
 Bundle(HERE,files,pin).install().run_main(script,argv[1:]);return 0

def worker(out,pin,given=None):
 files=load(pin,given);names=bound_tests(files);Bundle(HERE,files,pin).install()
 import unittest
 from common import encoded,freeze
 suite=unittest.defaultTestLoader.loadTestsFromNames(names)
 result=unittest.TextTestRunner(verbosity=2).run(suite)
 row={'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'skipped':len(result.skipped),'originalSourceDockerSdkOrNetworkExecuted':False}
 freeze(out/'PYTHON.json',encoded(row));return 0 if result.wasSuccessful() and result.testsRun>0 and not result.skipped else 1

def run(out,pin):
 import resource
 files=reviewed_bundle(HERE,pin);bound_tests(files);bundle=Bundle(HERE,files,pin);common=bundle.module('common')
 need(not out.exists(),'fresh private synthetic output root');out.mkdir(mode=0o700);rows=[]
 for name in ['python','crypto']:
  if name=='python':args,stdin=[sys.executable,'-I','-S','-B','-c',BUNDLE_BOOTSTRAP,bundle.path('run_checks.py'),pin,'--python-worker','--out',str(out),'--manifest-sha256',pin],bundle.packed()
  else:
   # Node resolves ./envelope.mjs beside the script, so both run from private copies of the verified bytes.
   need(all(x in files for x in ['test_crypto.mjs','envelope.mjs']),'pinned crypto controls');code=out/'crypto-code';code.mkdir(mode=0o700)
   for x in ['test_crypto.mjs','envelope.mjs']:common.freeze(code/x,files[x])
   args,stdin=['node',str(code/'test_crypto.mjs'),str(out/'crypto-test-only')],None
  started=time.monotonic();log=out/(name+'.log')
  def limit():resource.setrlimit(resource.RLIMIT_FSIZE,(4*1024**2,4*1024**2))
  with log.open('xb') as stream:process=subprocess.run(args,stdout=stream,stderr=subprocess.STDOUT,input=stdin,timeout=180,preexec_fn=limit,check=False)
  rows.append({'name':name,'exitCode':process.returncode,'elapsedSeconds':time.monotonic()-started,'logBytes':log.stat().st_size,'logSHA256':hash_file(log)[1]})
  need(process.returncode==0,'synthetic control failed; retain private logs')
 python=json.loads((out/'PYTHON.json').read_bytes());crypto=json.loads((out/'crypto-test-only/RESULT.json').read_bytes());need(python['tests']>0 and not any(python[k] for k in ['failures','errors','skipped']),'nonempty Python controls without skips');need(crypto['controls'] and all(x['passed'] is True for x in crypto['controls']) and crypto['skips']==0,'nonempty crypto controls without skips')
 value={'complete':True,'python':python,'cryptoControls':len(crypto['controls']),'cryptoSkips':crypto['skips'],'processes':rows,'testOnlyKeysNeverUsedForOperatorCaptureOrUploaded':True,'upstreamSourceSdkDockerOrNetworkExecuted':False}
 common.freeze(out/'RESULT.json',common.encoded(value));print(json.dumps(value));return 0

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--out',type=pathlib.Path);p.add_argument('--manifest-sha256');p.add_argument('--python-worker',action='store_true');p.add_argument('--entry',nargs=argparse.REMAINDER,help='pinned script and its arguments, run after verification');a=p.parse_args()
 need(a.manifest_sha256,'reviewed first-party manifest pin required');given=globals().get('PINNED_BUNDLE')
 if a.entry is not None:raise SystemExit(verified_entry(a.manifest_sha256,a.entry,given))
 need(a.out is not None,'synthetic control output root required')
 if a.python_worker:raise SystemExit(worker(a.out,a.manifest_sha256,given))
 need(given is None,'the controller reads its own bundle')
 raise SystemExit(run(a.out,a.manifest_sha256))
