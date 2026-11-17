"""Run only first-party synthetic controls; never imports SDK/project bodies."""
import argparse,hashlib,json,os,pathlib,resource,subprocess,sys,time,unittest
HERE=pathlib.Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
from common import need,encoded,freeze,hash_file

def worker(out):
 suite=unittest.defaultTestLoader.discover(str(HERE),pattern='test_*.py')
 result=unittest.TextTestRunner(verbosity=2).run(suite)
 row={'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'skipped':len(result.skipped),'originalSourceDockerSdkOrNetworkExecuted':False}
 freeze(out/'PYTHON.json',encoded(row));return 0 if result.wasSuccessful() and result.testsRun>0 and not result.skipped else 1

def run(out,pin):
 from driver import manifest_check
 manifest_check(pin);need(not out.exists(),'fresh private synthetic output root');out.mkdir(mode=0o700);rows=[]
 for name,args in [('python',[sys.executable,'-I','-S','-B',str(HERE/'run_checks.py'),'--python-worker','--out',str(out)]),('crypto',['node',str(HERE/'test_crypto.mjs'),str(out/'crypto-test-only')])]:
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
 if a.python_worker:raise SystemExit(worker(a.out))
 need(a.manifest_sha256,'reviewed first-party manifest pin required');raise SystemExit(run(a.out,a.manifest_sha256))
