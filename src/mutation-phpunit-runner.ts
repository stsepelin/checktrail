// Native PHPUnit lifecycle events retain exception identity and the phase in
// which it arose. JUnit text alone cannot distinguish setup from test failures.
export const mutationPhpunitRunner = String.raw`
if(PHP_VERSION!=='8.5.6'){echo json_encode(['format'=>'checktrail-mutation-phpunit-1','unavailable'=>'version']);exit(3);}
$root=realpath($argv[1]);
require $root.'/vendor/autoload.php';
if(PHPUnit\Runner\Version::id()!=='13.3.4'){echo json_encode(['format'=>'checktrail-mutation-phpunit-1','unavailable'=>'version']);exit(3);}
final class OriginalMutationTracer implements PHPUnit\Event\Tracer\Tracer {
 public array $events=[];
 public function trace(PHPUnit\Event\Event $event):void {
  $kind=match($event::class){
   PHPUnit\Event\Test\PreparationStarted::class=>'start',
   PHPUnit\Event\Test\Prepared::class=>'prepared',
   PHPUnit\Event\Test\Passed::class=>'passed',
   PHPUnit\Event\Test\BeforeTestMethodFailed::class=>'before-hook-failed',
   PHPUnit\Event\Test\PreConditionFailed::class=>'before-hook-failed',
   PHPUnit\Event\Test\AfterTestMethodFailed::class=>'after-hook-failed',
   PHPUnit\Event\Test\PostConditionFailed::class=>'after-hook-failed',
   PHPUnit\Event\Test\Failed::class=>'failed',
   PHPUnit\Event\Test\Errored::class=>'error',
   PHPUnit\Event\Test\Skipped::class=>'skipped',
   PHPUnit\Event\Test\MarkedIncomplete::class=>'incomplete',
   PHPUnit\Event\Test\ConsideredRisky::class=>'risky',
   PHPUnit\Event\Test\Finished::class=>'finished',
   default=>null
  };
  if($kind===null)return;
  $test=$event->test();
  $row=['kind'=>$kind,'id'=>$test->id(),'file'=>$test->file(),'line'=>$test->isTestMethod()?$test->line():0,'method'=>$test->isTestMethod()?$test->methodName():null,'class'=>$test->isTestMethod()?$test->className():null];
  if(in_array($kind,['failed','error','before-hook-failed','after-hook-failed'],true))$row['exception']=$event->throwable()->className();
  if($kind==='finished')$row['assertions']=$event->numberOfAssertionsPerformed();
  $this->events[]=$row;
 }
}
$tracer=new OriginalMutationTracer();
PHPUnit\Event\Facade::instance()->registerTracer($tracer);
$files=array_slice($argv,2);
$completed=false;
register_shutdown_function(function()use(&$completed,$tracer,$files):void{
 if($completed)return;
 $output=ob_get_level()>0?ob_get_clean():'';if($output!=='')fwrite(STDERR,$output);
 echo json_encode(['schemaVersion'=>1,'format'=>'checktrail-mutation-phpunit-1','php'=>PHP_VERSION,'version'=>PHPUnit\Runner\Version::id(),'selectedFiles'=>array_map('realpath',$files),'exitCode'=>null,'aborted'=>true,'events'=>$tracer->events],JSON_THROW_ON_ERROR)."\n";
});
ob_start();
$code=(new PHPUnit\TextUI\Application())->run(['checktrail','--no-output','--do-not-record-test-run-history','--no-logging','--all','--fail-on-empty-test-suite','--fail-on-risky','--fail-on-warning','--',...$files]);
$completed=true;
$output=ob_get_clean();if($output!=='')fwrite(STDERR,$output);
echo json_encode(['schemaVersion'=>1,'format'=>'checktrail-mutation-phpunit-1','php'=>PHP_VERSION,'version'=>PHPUnit\Runner\Version::id(),'selectedFiles'=>array_map('realpath',$files),'exitCode'=>$code,'aborted'=>false,'events'=>$tracer->events],JSON_THROW_ON_ERROR)."\n";
exit($code);
`;
