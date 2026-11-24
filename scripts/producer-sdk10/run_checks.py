"""Run only first-party synthetic controls; never imports SDK/project bodies.

Until bound_tests() has verified the directory, this file imports only the
standard library: the directory is not on sys.path, and isolated mode (-I)
keeps the interpreter from adding it as the script directory.
"""
import sys
if __name__=='__main__' and not sys.flags.isolated:raise SystemExit('run_checks.py must run isolated (python3 -I) so its directory is not importable before verification')
import argparse,hashlib,json,os,pathlib,resource,subprocess,time,unittest
HERE=pathlib.Path(__file__).resolve().parent
class Unreviewed(RuntimeError):pass
def need(value,message):
 if not value:raise Unreviewed(message)
def hash_file(path):
 h=hashlib.sha256();n=0
 with open(path,'rb') as f:
  for block in iter(lambda:f.read(1048576),b''):n+=len(block);h.update(block)
 return n,h.hexdigest()
def importable(folder):
 if str(folder) not in sys.path:sys.path.insert(0,str(folder))

def bound_tests(folder,pin):
 """Return the test modules of an exactly reviewed control directory.

 The directory is first on sys.path while the controls run, so any entry in it
 can be imported by name, not only test_*.py files. Every entry must therefore
 be pinned: MANIFEST.json by the operator pin, its rows by MANIFEST.json, and
 the protected-control files by PROTECTED-CONTROLS.json, which is itself a
 MANIFEST.json row. Nothing in the directory is imported here.
 """
 raw=(folder/'MANIFEST.json').read_bytes();need(hashlib.sha256(raw).hexdigest()==pin,'operator-reviewed first-party bundle manifest')
 def frozen(rows):
  need(type(rows) is list and rows,'nonempty pinned control file list')
  for row in rows:
   name=row.get('path') if type(row) is dict else None;need(type(name) is str and name not in ['','.','..','MANIFEST.json'] and '/' not in name and '\\' not in name,'direct first-party control file name')
   p=folder/name;need(not p.is_symlink() and p.is_file() and hash_file(p)==(row.get('bytes'),row.get('sha256')),'frozen first-party control file changed: '+name)
  return [row['path'] for row in rows]
 rows=json.loads(raw)['files'];names=frozen(rows)
 if 'PROTECTED-CONTROLS.json' in names:
  protected=(folder/'PROTECTED-CONTROLS.json').read_bytes();row=[x for x in rows if x['path']=='PROTECTED-CONTROLS.json'][0];need((len(protected),hashlib.sha256(protected).hexdigest())==(row['bytes'],row['sha256']),'frozen first-party control file changed: PROTECTED-CONTROLS.json')
  names+=frozen(json.loads(protected)['files'])
 need(len(names)==len(set(names)),'each control file pinned once')
 unexpected=sorted(set(os.listdir(folder))-set(names)-{'MANIFEST.json'});need(not unexpected,'unreviewed entry in executed control directory: '+', '.join(unexpected[:8]))
 tests=sorted(x[:-3] for x in names if x.startswith('test_') and x.endswith('.py'));need(tests,'nonempty reviewed Python controls');return tests

def worker(out,pin):
 names=bound_tests(HERE,pin);importable(HERE);from common import encoded,freeze
 suite=unittest.defaultTestLoader.loadTestsFromNames(names)
 result=unittest.TextTestRunner(verbosity=2).run(suite)
 row={'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'skipped':len(result.skipped),'originalSourceDockerSdkOrNetworkExecuted':False}
 freeze(out/'PYTHON.json',encoded(row));return 0 if result.wasSuccessful() and result.testsRun>0 and not result.skipped else 1

def run(out,pin):
 bound_tests(HERE,pin);importable(HERE);from common import encoded,freeze
 need(not out.exists(),'fresh private synthetic output root');out.mkdir(mode=0o700);rows=[]
 for name,args in [('python',[sys.executable,'-I','-S','-B',str(HERE/'run_checks.py'),'--python-worker','--out',str(out),'--manifest-sha256',pin]),('crypto',['node',str(HERE/'test_crypto.mjs'),str(out/'crypto-test-only')])]:
  started=time.monotonic();log=out/(name+'.log')
  def limit():resource.setrlimit(resource.RLIMIT_FSIZE,(4*1024**2,4*1024**2))
  with log.open('xb') as stream:process=subprocess.run(args,stdout=stream,stderr=subprocess.STDOUT,timeout=180,preexec_fn=limit,check=False)
  rows.append({'name':name,'exitCode':process.returncode,'elapsedSeconds':time.monotonic()-started,'logBytes':log.stat().st_size,'logSHA256':hash_file(log)[1]})
  need(process.returncode==0,'synthetic control failed; retain private logs')
 python=json.loads((out/'PYTHON.json').read_bytes());crypto=json.loads((out/'crypto-test-only/RESULT.json').read_bytes());need(python['tests']>0 and not any(python[k] for k in ['failures','errors','skipped']),'nonempty Python controls without skips');need(crypto['controls'] and all(x['passed'] is True for x in crypto['controls']) and crypto['skips']==0,'nonempty crypto controls without skips')
 value={'complete':True,'python':python,'cryptoControls':len(crypto['controls']),'cryptoSkips':crypto['skips'],'processes':rows,'testOnlyKeysNeverUsedForOperatorCaptureOrUploaded':True,'upstreamSourceSdkDockerOrNetworkExecuted':False}
 freeze(out/'RESULT.json',encoded(value));print(json.dumps(value));return 0

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--out',type=pathlib.Path,required=True);p.add_argument('--manifest-sha256');p.add_argument('--python-worker',action='store_true');a=p.parse_args()
 need(a.manifest_sha256,'reviewed first-party manifest pin required')
 if a.python_worker:raise SystemExit(worker(a.out,a.manifest_sha256))
 raise SystemExit(run(a.out,a.manifest_sha256))
