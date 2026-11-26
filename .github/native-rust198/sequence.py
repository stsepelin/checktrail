"""Future first-party build-UID child: exact original commands, bounded cache shutdown.
Upstream source execution is operator-trusted and retains this account's privileges.
"""
from pathlib import Path
import argparse,json,os,subprocess,sys,time
HERE=Path(__file__).resolve().parent;sys.path.insert(0,str(HERE))
from admission import need

def run_sequence(profile,source,sccache,report,runner,clock=time.monotonic,sleep=time.sleep):
 started=clock();deadline=started+profile['bounds']['nativeSeconds'];phases=[];failure=None;cache_stop=None
 def command(name,argv,seconds):
  remaining=deadline-clock();need(remaining>30,'Original sequence deadline reserve');result=runner(argv,source,min(seconds,remaining-30));need(clock()<deadline,'Late original command result');row={'phase':name,'argv':argv,'exitCode':result,'status':'command-passed' if result==0 else 'command-failed'};phases.append(row);return result
 try:
  need(command('configure',profile['configure'],profile['bounds']['configureSeconds'])==0,'Original configure failed')
  prepared=False
  for attempt in range(profile['prepareAttempts']):
   if attempt:
    delay=profile['prepareBackoffSeconds'][attempt-1];need(clock()+delay+30<deadline,'Original retry cannot extend whole deadline');sleep(delay)
   if command('prepare-attempt-'+str(attempt+1),profile['prepare'],profile['bounds']['prepareAttemptSeconds'])==0:prepared=True;break
  need(prepared,'Original prepare attempts exhausted');need(command('original-dist',profile['dist'],max(1,deadline-clock()-30))==0,'Original full default dist failed')
 except Exception as error:failure={'type':type(error).__name__,'reason':str(error)[:512]}
 finally:
  try:cache_stop=runner([sccache,'--stop-server'],source,max(0.1,min(20,deadline-clock())));need(cache_stop==0,'Owned cache shutdown failed')
  except Exception as error:
   if failure is None:failure={'type':type(error).__name__,'reason':str(error)[:512]}
  complete=failure is None and clock()<deadline;value={'originalCommandsComplete':complete,'phases':phases,'failure':failure,'cacheStopExitCode':cache_stop,'elapsedSeconds':clock()-started,'upstreamTestsOrBenchmarkTrialsClaimed':False,'wholeProducerOrGateAClosureClaimed':False};need(not report.exists(),'Fresh child phase report');report.write_text(json.dumps(value,sort_keys=True,indent=2)+'\n')
 return value

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('profile');p.add_argument('source');p.add_argument('sccache');p.add_argument('report');a=p.parse_args();profile=json.loads(Path(a.profile).read_bytes())
 def invoke(argv,cwd,seconds):
  result=subprocess.run(argv,cwd=cwd,stdin=subprocess.DEVNULL,timeout=seconds,check=False,close_fds=True);return result.returncode
 value=run_sequence(profile,Path(a.source),a.sccache,Path(a.report),invoke);return 0 if value['originalCommandsComplete'] else 1
if __name__=='__main__':raise SystemExit(main())
