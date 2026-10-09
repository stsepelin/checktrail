import {
  laravelNativeHelpers,
  laravelNativeCollections,
} from "./laravel-runner.js";
import {
  laravelAssemblyRuntimePins,
  laravelAssemblyVersions,
} from "./laravel-assembly-runtime-pins.js";
const prepared = Buffer.from(
  JSON.stringify({
    pins: laravelAssemblyRuntimePins,
    versions: laravelAssemblyVersions,
  }),
).toString("base64");
const laravelAssemblyPrerequisites =
  String.raw` $pins=json_decode(base64_decode('__PREPARED__',true),true,flags:JSON_THROW_ON_ERROR);
 $vendor=realpath(dirname($rv_autoload));
 if(!is_string($vendor)||!str_starts_with($vendor,getcwd().DIRECTORY_SEPARATOR))throw new LAUnsupported('Native vendor path escapes project');
 if(PHP_VERSION!=='8.5.6'){fwrite(STDOUT,json_encode(['unavailable'=>'laravel-runtime','reason'=>'unsupported-version']));exit(3);}
 if(!is_file($vendor.'/composer/installed.json')){fwrite(STDOUT,json_encode(['unavailable'=>'laravel-runtime','reason'=>'missing-package']));exit(3);}
 $installed=json_decode(file_get_contents($vendor.'/composer/installed.json'),true,flags:JSON_THROW_ON_ERROR);
 $versions=[];foreach($installed['packages'] as $package)$versions[$package['name']]=$package['version'];
 foreach($pins['versions'] as $name=>$version)if(($versions[$name]??null)!==$version){fwrite(STDOUT,json_encode(['unavailable'=>'laravel-runtime','reason'=>'unsupported-version']));exit(3);}
 foreach($pins['pins'] as $pin){$file=realpath($vendor.'/'.$pin['directory'].'/'.$pin['file']);if(!is_string($file)||!str_starts_with($file,$vendor.DIRECTORY_SEPARATOR)||filesize($file)!==$pin['bytes']||hash_file('sha256',$file)!==$pin['sha256']){fwrite(STDOUT,json_encode(['unavailable'=>'laravel-runtime','reason'=>'runtime-byte-mismatch']));exit(3);}}
`.replace("__PREPARED__", prepared);
export const laravelAssemblyVersionRunner =
  String.raw`class LAUnsupported extends RuntimeException {}
$rv_autoload=$argv[1];try{` +
  laravelAssemblyPrerequisites +
  String.raw`echo '13.32.0';}catch(Throwable $error){exit(4);}`;
export const laravelAssemblyRunner =
  String.raw`
declare(strict_types=1);
class LAUnsupported extends RuntimeException {}
` +
  laravelNativeHelpers +
  String.raw`
function la_hash(mixed $value): string {
 $budget=2048;
 $walk=function(mixed $value,int $depth=0)use(&$walk,&$budget):mixed{
  if($depth>16||--$budget<0)throw new LAUnsupported('Typed model data exceeds limits');
  if(is_array($value)){ $out=[];foreach($value as $key=>$item)$out[]=[is_int($key)?['int',$key]:['string',$key],$walk($item,$depth+1)];return ['array',$out]; }
  if(is_float($value)){if(!is_finite($value))throw new LAUnsupported('Non-finite typed model value');return ['float',bin2hex(pack('E',$value))];}
  if(is_int($value)||is_string($value)||is_bool($value)||$value===null)return [get_debug_type($value),$value];
  throw new LAUnsupported('Opaque typed model data');
 };
 return hash('sha256',json_encode($walk($value),JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE));
}
function la_reflection_default(object $object,array $methods,string $native): void {
 foreach($methods as $method)if((new ReflectionMethod($object,$method))->getDeclaringClass()->getName()!==$native)throw new LAUnsupported('Selected native API is overridden');
}
function la_clock(array $config): void {
 $factory=Illuminate\Support\Facades\Date::getFacadeRoot();
 if(get_class($factory)!==Illuminate\Support\DateFactory::class)throw new LAUnsupported('Date factory is overridden');
 foreach(['dateClass','callable','factory'] as $key)if((new ReflectionProperty($factory,$key))->getValue()!==null)throw new LAUnsupported('Date creation is overridden');
 if(Carbon\FactoryImmutable::getCurrentClock()!==null)throw new LAUnsupported('Carbon current clock is overridden');
 $now=Illuminate\Support\Facades\Date::getTestNow();$expected=new DateTimeImmutable($config['clock']);
 if(!$now instanceof Carbon\CarbonInterface || $now->format('U.u')!==$expected->format('U.u') || Illuminate\Support\Facades\Date::now('UTC')->format('U.u')!==$expected->format('U.u'))throw new LAUnsupported('Controlled clock changed');
}
function la_snapshot($app,$http,$router,$dispatcher,$schedule,array &$references,array $models): mixed {
 $objects=[];$budget=40000;
 $walk=function(mixed $value,int $depth=0)use(&$walk,&$objects,&$budget,&$references):mixed{
  if($depth>32||--$budget<0)throw new LAUnsupported('Native registration snapshot exceeds bounds');
  if(is_array($value)){$out=[];foreach($value as $key=>$item)$out[]=[get_debug_type($key),$key,$walk($item,$depth+1)];return ['array',$out];}
  if(is_object($value)){$id=spl_object_id($value);if(isset($references[$id])&&$references[$id]->get()!==$value)throw new LAUnsupported('Native registration object lifetime changed');$references[$id]??=WeakReference::create($value);return ['object',$id,get_class($value)];}
  if(is_scalar($value)||$value===null)return [get_debug_type($value),$value];
  throw new LAUnsupported('Opaque native registration snapshot');
 };
 $registrations=[];
 foreach(['bindings','aliases','contextual','tags','extenders','methodBindings','scopedInstances'] as $key)$registrations['container:'.$key]=rv_property($app,$key);
 foreach(['middleware','middlewareGroups','middlewareAliases','middlewarePriority'] as $key)$registrations['http:'.$key]=rv_property($http,$key);
 $registrations['events:exact']=$dispatcher->getRawListeners();$registrations['events:wildcard']=rv_property($dispatcher,'wildcards');
 foreach($router->getRoutes() as $route)$registrations['route'][]=[$route,$route->methods(),$route->uri(),$route->getAction(),$route->wheres,$route->defaults];
 foreach($schedule->events() as $event){$row=[$event];foreach(['expression','repeatSeconds','user','environments','evenInMaintenanceMode','evenWhenPaused','withoutOverlapping','releaseOnTerminationSignals','onOneServer','expiresAt','runInBackground','description','output','shouldAppendOutput','timezone','parameters','filters','rejects','beforeCallbacks','afterCallbacks','mutex','mutexNameResolver','attributes'] as $key)if((new ReflectionObject($event))->hasProperty($key))$row[$key]=rv_property($event,$key);if($event instanceof Illuminate\Console\Scheduling\CallbackEvent)$row['callback']=rv_property($event,'callback');else $row['command']=$event->command;$registrations['schedule'][]=$row;}
 foreach($models as $class){$scopes=(new ReflectionProperty($class,'globalScopes'))->getValue();$registrations['model:scopes:'.$class]=$scopes[$class]??[];}
 $registrations['models:lazy-guard']=[Illuminate\Database\Eloquent\Model::preventsLazyLoading(),(new ReflectionProperty(Illuminate\Database\Eloquent\Model::class,'lazyLoadingViolationCallback'))->getValue()];
 return $walk($registrations);
}
function la_collections($app,$http,$router,$dispatcher,$schedule,array $models): array {
 $selectedModels=[];
 foreach($models as $requested){
  if(!class_exists($requested)||!is_subclass_of($requested,Illuminate\Database\Eloquent\Model::class))throw new LAUnsupported('Selected class is not an Eloquent model');
  $selectedModels[$requested]=new $requested();
  la_reflection_default($selectedModels[$requested],['getTable','getConnectionName','getKeyName','getKeyType','getIncrementing','usesTimestamps','getPerPage','getCasts','getGlobalScopes','getAppends','getFillable','getGuarded'],Illuminate\Database\Eloquent\Model::class);
 }
 $GLOBALS['rv_count']=0;
` +
  laravelNativeCollections +
  String.raw`
 $paths=['path'=>'path','path.base'=>'basePath','path.config'=>'configPath','path.database'=>'databasePath','path.public'=>'publicPath','path.resources'=>'resourcePath','path.storage'=>'storagePath','path.bootstrap'=>'bootstrapPath','path.lang'=>'langPath'];
 foreach($collections[4]['entries'] as &$row){
  $a=(array)$row['attributes'];
  if($a['type']==='instance' && isset($paths[$a['abstract']])){
   $native=$app->{$paths[$a['abstract']]}();$actual=rv_property($app,'instances')[$a['abstract']];
   if(!is_string($actual)||$actual!==$native)throw new LAUnsupported('Reserved application path binding changed');
   $prefix=getcwd().DIRECTORY_SEPARATOR;
   if($actual!==getcwd()&&!str_starts_with($actual,$prefix))throw new LAUnsupported('Reserved application path escapes project');
   $row['attributes']->target='project:'.($actual===getcwd()?'.':str_replace(DIRECTORY_SEPARATOR,'/',substr($actual,strlen($prefix))));
  }
 }
 unset($row);
 $entries=&$collections[4]['entries'];
 foreach(rv_property($app,'tags') as $name=>$abstracts){if(!is_string($name)||!is_array($abstracts)||count($abstracts)>1024||array_filter($abstracts,fn($v)=>!is_string($v)))throw new LAUnsupported('Opaque container tag');rv_add($entries,'tag:'.$name,['type'=>'tag','name'=>$name,'abstracts'=>array_values($abstracts)]);}
 foreach(rv_property($app,'extenders') as $abstract=>$callbacks)foreach($callbacks as $position=>$callback)rv_add($entries,'extender:'.$abstract.':'.$position,['type'=>'extender','abstract'=>$abstract,'position'=>$position,'target'=>rv_identity($callback)]);
 foreach(rv_property($app,'methodBindings') as $method=>$callback)rv_add($entries,'method:'.$method,['type'=>'method','method'=>$method,'target'=>rv_identity($callback)]);
 foreach($models as $requested){
  $model=$selectedModels[$requested];$scopes=[];
  $lazyHandler=(new ReflectionProperty(Illuminate\Database\Eloquent\Model::class,'lazyLoadingViolationCallback'))->getValue();if($lazyHandler!==null&&!is_callable($lazyHandler))throw new LAUnsupported('Opaque lazy loading callback');
  foreach($model->getGlobalScopes() as $key=>$scope){
   if($scope instanceof Closure)$identity=rv_identity($scope);
   elseif($scope instanceof Illuminate\Database\Eloquent\Scope)$identity='scope:'.get_class($scope);
   else throw new LAUnsupported('Opaque model global scope');
   $scopes[]=json_encode([$key,$identity],JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE);
  }
  rv_add($entries,'model-defaults:'.$requested,['type'=>'model-defaults','requestedClass'=>$requested,'class'=>get_class($model),'table'=>$model->getTable(),'connection'=>$model->getConnectionName(),'keyName'=>$model->getKeyName(),'keyType'=>$model->getKeyType(),'incrementing'=>$model->getIncrementing(),'timestamps'=>$model->usesTimestamps(),'perPage'=>$model->getPerPage(),'eagerLoadsHash'=>la_hash(rv_property($model,'with')),'eagerCountsHash'=>la_hash(rv_property($model,'withCount')),'castsHash'=>la_hash($model->getCasts()),'defaultsHash'=>la_hash(rv_property($model,'attributes')),'appends'=>$model->getAppends(),'fillable'=>$model->getFillable(),'guarded'=>$model->getGuarded(),'globalScopes'=>$scopes,'lazyLoadingPrevented'=>Illuminate\Database\Eloquent\Model::preventsLazyLoading(),'lazyLoadingHandler'=>$lazyHandler===null?null:rv_identity($lazyHandler)]);
 }
 unset($entries);
 return $collections;
}
$rv_count=0;$rv_temporary=null;$rv_autoload=$argv[1];
ob_start(function($text){fwrite(STDERR,$text);return '';},1);
try{
` +
  laravelAssemblyPrerequisites +
  String.raw`
 $encoded=implode('',array_slice($argv,3));if(strlen($encoded)>350000||!preg_match('/^[A-Za-z0-9+\/=]+$/D',$encoded))throw new LAUnsupported('Native configuration encoding is invalid or oversized');
 $raw=base64_decode($encoded,true);if(!is_string($raw)||strlen($raw)>256*1024)throw new LAUnsupported('Native configuration exceeds 256 KiB');
 $config=json_decode($raw,true,flags:JSON_THROW_ON_ERROR);
 $owned=getenv('CHECKTRAIL_TEMP');if(!is_string($owned)||$owned===''||!is_dir($owned)||is_link($owned))throw new LAUnsupported('Missing owned temporary directory');
 $rv_temporary=realpath($owned).'/laravel-cache';if(!mkdir($rv_temporary,0700))throw new LAUnsupported('Cannot create owned cache directory');
 register_shutdown_function(function()use($rv_temporary){foreach(glob($rv_temporary.'/*') as $file)if(is_file($file)||is_link($file))@unlink($file);@rmdir($rv_temporary);});
 require $rv_autoload;
 if(Illuminate\Foundation\Application::VERSION!=='13.32.0')throw new LAUnsupported('Native framework constant differs from package metadata');
 $cachePaths=[];foreach(['CONFIG','ROUTES','EVENTS','SERVICES','PACKAGES'] as $kind){$key='APP_'.$kind.'_CACHE';$cachePaths[$kind]=$rv_temporary.'/'.strtolower($kind).'.php';putenv($key.'='.$cachePaths[$kind]);$_ENV[$key]=$_SERVER[$key]=$cachePaths[$kind];}
 $app=require getcwd().'/bootstrap/app.php';if(!$app instanceof Illuminate\Foundation\Application||realpath($app->basePath())!==getcwd()||$app->hasBeenBootstrapped()||get_class($app)!==Illuminate\Foundation\Application::class)throw new LAUnsupported('Unsupported application bootstrap');
 $app->useEnvironmentPath($rv_temporary)->loadEnvironmentFrom('.env');$http=$app->make(Illuminate\Contracts\Http\Kernel::class);$console=$app->make(Illuminate\Contracts\Console\Kernel::class);$console->bootstrap();$console->all();$http->bootstrap();
 if(get_class($http)!==Illuminate\Foundation\Http\Kernel::class||get_class($console)!==Illuminate\Foundation\Console\Kernel::class)throw new LAUnsupported('Native kernels are overridden');
 $protected=function()use($app,$cachePaths){if($app->environment()!=='testing')throw new LAUnsupported('Protected testing environment changed');foreach(['CONFIG'=>'getCachedConfigPath','ROUTES'=>'getCachedRoutesPath','EVENTS'=>'getCachedEventsPath','SERVICES'=>'getCachedServicesPath','PACKAGES'=>'getCachedPackagesPath'] as $kind=>$method)if($app->$method()!==$cachePaths[$kind])throw new LAUnsupported('Protected cache path changed');};$protected();
 $router=$app->make('router');$dispatcher=$app->make('events');$schedule=$app->make(Illuminate\Console\Scheduling\Schedule::class);
 Illuminate\Support\Facades\Date::setTestNow(new DateTimeImmutable($config['clock']));
 $collections=la_collections($app,$http,$router,$dispatcher,$schedule,$config['models']);$requests=[];$references=[];
 $snapshot=la_snapshot($app,$http,$router,$dispatcher,$schedule,$references,$config['models']);$timezone=date_default_timezone_get();
 $stable=function()use($app,$http,$router,$dispatcher,$schedule,$config,$snapshot,&$references,$timezone,$protected){$protected();la_clock($config);if(date_default_timezone_get()!==$timezone||la_snapshot($app,$http,$router,$dispatcher,$schedule,$references,$config['models'])!==$snapshot)throw new LAUnsupported('Native registrations changed during controlled probes');};$stable();
 foreach($config['requests'] as $spec){
  $stable();$server=['HTTP_HOST'=>$spec['host'].':'.$spec['port'],'SERVER_NAME'=>$spec['host'],'SERVER_PORT'=>$spec['port'],'REQUEST_SCHEME'=>'http','HTTPS'=>'off'];
  $names=[];foreach($spec['headers'] as $header){$name=strtolower($header['name']);if(isset($names[$name])||in_array($name,['host','content-length'],true))throw new LAUnsupported('Duplicate or reserved request header');$names[$name]=true;$key=strtoupper(str_replace('-','_',$header['name']));$server[in_array($key,['CONTENT_TYPE'],true)?$key:'HTTP_'.$key]=$header['value'];}
  $request=Illuminate\Http\Request::create('http://'.$spec['host'].':'.$spec['port'].$spec['path'],$spec['method'],[],[],[],$server,$spec['body']);
  if($spec['body']!==null&&strlen($spec['body'])>32768)throw new LAUnsupported('Native request body exceeds 32 KiB');
  $response=$http->handle($request);
  try{
   if(!in_array(get_class($response),[Illuminate\Http\Response::class,Illuminate\Http\JsonResponse::class,Symfony\Component\HttpFoundation\Response::class,Symfony\Component\HttpFoundation\JsonResponse::class],true))throw new LAUnsupported('Native response class is unsupported');
   $body=$response->getContent();if(!is_string($body)||strlen($body)>65536)throw new LAUnsupported('Native response is streaming, opaque or exceeds 64 KiB');
   $error=property_exists($response,'exception')?$response->exception:null;if($error!==null&&!$error instanceof Throwable)throw new LAUnsupported('Opaque response exception');
   $requests[]=['path'=>$spec['path'],'method'=>$spec['method'],'host'=>$spec['host'],'port'=>$spec['port'],'headers'=>$spec['headers'],'body'=>$spec['body'],'status'=>$response->getStatusCode(),'responseBody'=>$body,'exceptionClass'=>$error===null?null:get_class($error),'completed'=>true];
  }finally{$http->terminate($request,$response);}
  $stable();
 }
 $counts=array_map(fn($c)=>count($c['entries']),$collections);
 fwrite(STDOUT,json_encode(['schemaVersion'=>2,'versions'=>['php'=>PHP_VERSION,...$pins['versions']],'entryCount'=>array_sum($counts),'counts'=>$counts,'clock'=>$config['clock'],'models'=>$config['models'],'runtime'=>['schemaVersion'=>1,'format'=>'runtime-inventory','producer'=>['name'=>'checktrail.laravel-runtime','version'=>'2.0.0'],'assembly'=>['name'=>$config['assembly'],'environment'=>$config['environment']],'sourceFingerprint'=>$argv[2],'capturedAt'=>gmdate('Y-m-d\TH:i:s\Z'),'collections'=>$collections],'requests'=>$requests],JSON_THROW_ON_ERROR|JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE));
} catch(Throwable $error){fwrite(STDOUT,json_encode(['incomplete'=>'laravel-assembly','reason'=>$error instanceof LAUnsupported?$error->getMessage():'Native setup, models or controlled response is unsupported or incomplete.']));exit(4);}
`.replace("__PREPARED__", prepared);
