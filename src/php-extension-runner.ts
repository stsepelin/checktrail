import {
  phpExtensionRuntime,
  phpExtensionToolPins,
} from "./php-extension-pins.js";
const prepared = Buffer.from(
  JSON.stringify({ runtime: phpExtensionRuntime, pins: phpExtensionToolPins }),
).toString("base64");
export const phpExtensionRunner = String.raw`
declare(strict_types=1);
class PEUnsupported extends RuntimeException {}
function pe_canonical(mixed $value): string {if(is_array($value)){if(!array_is_list($value))ksort($value,SORT_STRING);foreach($value as &$item)$item=json_decode(pe_canonical($item),true,flags:JSON_THROW_ON_ERROR);unset($item);}elseif(is_object($value)){$fields=(array)$value;ksort($fields,SORT_STRING);foreach($fields as &$item)$item=json_decode(pe_canonical($item),flags:JSON_THROW_ON_ERROR);unset($item);$value=(object)$fields;}return json_encode($value,JSON_THROW_ON_ERROR|JSON_PRESERVE_ZERO_FRACTION);}
function pe_file(string $relative): string {$root=getcwd();$file=realpath($root.'/'.$relative);if(!is_string($file)||!str_starts_with($file,$root.'/')||is_link($root.'/'.$relative)||!is_file($file))throw new PEUnsupported('PHP input escapes its contained regular file');return $file;}
function pe_inputs(array $manifest): void {foreach($manifest['bindings'] as $binding){$file=pe_file($binding['path']);if(filesize($file)!==$binding['bytes']||hash_file('sha256',$file)!==$binding['sha256'])throw new PEUnsupported('PHP bound input bytes changed');}}
function pe_runtime(): array {
 $names=get_loaded_extensions();sort($names,SORT_STRING);$extensions=[];foreach($names as $name){$r=new ReflectionExtension($name);$dependencies=$r->getDependencies();ksort($dependencies,SORT_STRING);$extensions[]=['name'=>$name,'version'=>$r->getVersion(),'dependencies'=>(object)$dependencies];}
 $paths=[PHP_BINARY];$directory=realpath(ini_get('extension_dir'));if(!is_string($directory)||!is_readable('/proc/self/maps'))throw new PEUnsupported('Native PHP extension mappings unavailable');
 foreach(file('/proc/self/maps') as $line){$parts=preg_split('/\s+/',trim($line),6);$path=$parts[5]??'';if(str_starts_with($path,$directory.'/'))$paths[]=$path;}
 $paths=array_values(array_unique($paths));sort($paths,SORT_STRING);$artifacts=[];foreach($paths as $file){if(!is_file($file)||filesize($file)>64*1048576)throw new PEUnsupported('Native PHP artifact exceeds its bound');$artifacts[]=['kind'=>$file===PHP_BINARY?'interpreter':'extension','name'=>basename($file),'bytes'=>filesize($file),'sha256'=>hash_file('sha256',$file)];}
 return ['php'=>PHP_VERSION,'architecture'=>php_uname('m'),'extensions'=>$extensions,'artifacts'=>$artifacts];
}
function pe_tools(array $manifest,array $pins): void {
 if(pe_canonical($manifest['toolPins'])!==pe_canonical($pins))throw new PEUnsupported('Selected PHP native APIs changed');
 $installed=json_decode(file_get_contents(pe_file('vendor/composer/installed.json')),true,flags:JSON_THROW_ON_ERROR);$versions=[];foreach($installed['packages'] as $package){if(isset($versions[$package['name']]))throw new PEUnsupported('Ambiguous Composer metadata');$versions[$package['name']]=$package['version'];}
 foreach($pins as $pin){$file=pe_file('vendor/'.$pin['path']);if(($versions[$pin['package']]??null)!==$pin['version']||filesize($file)!==$pin['bytes']||hash_file('sha256',$file)!==$pin['sha256'])throw new PEUnsupported('Native PHP tool version or bytes changed');}
}
function pe_value(mixed $value,int $depth=0): array {if($depth>16)throw new PEUnsupported('Accessor data exceeds depth bound');$type=get_debug_type($value);if(!in_array($type,['null','string','int','float','bool','array'],true)||(is_float($value)&&!is_finite($value))||(is_int($value)&&abs($value)>9007199254740991))throw new PEUnsupported('Accessor value is opaque');if(is_array($value)){if(count($value)>1024)throw new PEUnsupported('Accessor data exceeds item bound');$entries=[];foreach($value as $key=>$entry)$entries[]=['key'=>pe_value($key,$depth+1),'value'=>pe_value($entry,$depth+1)];$value=$entries;}if(strlen(json_encode($value,JSON_THROW_ON_ERROR))>32768)throw new PEUnsupported('Accessor data exceeds byte bound');return ['type'=>$type,'value'=>$value];}
function pe_property(object $object,string $name): mixed {return (new ReflectionProperty($object,$name))->getValue($object);}
function pe_defaults(Illuminate\Database\Eloquent\Model $model): array {
 $attributes=[];foreach($model->getAttributes() as $name=>$value)$attributes[$name]=pe_value($value);
 return ['table'=>$model->getTable(),'connection'=>$model->getConnectionName(),'keyName'=>$model->getKeyName(),'keyType'=>$model->getKeyType(),'incrementing'=>$model->getIncrementing(),'timestamps'=>$model->usesTimestamps(),'perPage'=>$model->getPerPage(),'eagerLoads'=>pe_property($model,'with'),'eagerCounts'=>pe_property($model,'withCount'),'casts'=>(object)$model->getCasts(),'attributes'=>(object)$attributes,'appends'=>$model->getAppends(),'fillable'=>$model->getFillable(),'guarded'=>$model->getGuarded()];
}
function pe_identity(ReflectionClass|ReflectionMethod $reflection,array $manifest,array $pins): array {
 $class=$reflection instanceof ReflectionClass?$reflection->getName():$reflection->getDeclaringClass()->getName();$file=$reflection->getFileName();if(!is_string($file))throw new PEUnsupported('Opaque class/method reflection');$file=realpath($file);$root=getcwd().'/';if(!is_string($file)||!str_starts_with($file,$root))throw new PEUnsupported('Class/method source escapes project');$relative=substr($file,strlen($root));
 $binding=null;foreach($manifest['bindings'] as $entry)if($entry['path']===$relative)$binding=$entry;foreach($pins as $entry)if('vendor/'.$entry['path']===$relative)$binding=['path'=>$relative,'bytes'=>$entry['bytes'],'sha256'=>$entry['sha256']];
 if($binding===null||filesize($file)!==$binding['bytes']||hash_file('sha256',$file)!==$binding['sha256'])throw new PEUnsupported('Class/method reflection is not source-bound');
 return ['class'=>$class,'path'=>$relative,'sha256'=>$binding['sha256']];
}
$transport=json_decode($argv[1],flags:JSON_THROW_ON_ERROR);
$manifest=json_decode($argv[1],true,flags:JSON_THROW_ON_ERROR);$prepared=json_decode(base64_decode('__PREPARED__',true),true,flags:JSON_THROW_ON_ERROR);
try {
 if(PHP_OS_FAMILY!=='Linux'||ini_get('opcache.enable_cli')!=='0'||ini_get('enable_dl')!=='0'||ini_get('auto_prepend_file')!==''||ini_get('auto_append_file')!==''||ini_get('opcache.preload')!=='')throw new PEUnsupported('Protected native PHP startup changed');
 pe_inputs($manifest);pe_tools($manifest,$prepared['pins']);$runtime=pe_runtime();
 if(pe_canonical($runtime)!==pe_canonical($prepared['runtime'])||array_column($runtime['extensions'],'name')!==$manifest['config']['nativeExtensions'])throw new PEUnsupported('Native PHP extension closure differs');
}catch(Throwable $error){echo json_encode(['format'=>'checktrail-php-extensions-1','unavailable'=>$error instanceof PEUnsupported?$error->getMessage():'PHP extension prerequisites are unavailable']);exit(3);}
$models=[];$classes=[];$complete=false;$stable=false;$failure=null;
try {
 $temporary=getenv('CHECKTRAIL_TEMP');if(!is_string($temporary)||!is_dir($temporary))throw new PEUnsupported('Owned PHP temporary directory unavailable');
 foreach(['CONFIG','ROUTES','EVENTS','SERVICES','PACKAGES'] as $kind){$cache=$temporary.'/'.strtolower($kind).'.php';putenv('APP_'.$kind.'_CACHE='.$cache);$_ENV['APP_'.$kind.'_CACHE']=$cache;$_SERVER['APP_'.$kind.'_CACHE']=$cache;}
 require pe_file('vendor/autoload.php');
 $selected=[];foreach($manifest['config']['classes'] as $entry)$selected[$entry['class']]=$entry;
 spl_autoload_register(static function(string $name)use($selected){if(isset($selected[$name]))require pe_file($selected[$name]['path']);},true,true);
 $app=require pe_file('bootstrap/app.php');if(get_class($app)!==Illuminate\Foundation\Application::class)throw new PEUnsupported('Unsupported Laravel application');
 $http=$app->make(Illuminate\Contracts\Http\Kernel::class);$console=$app->make(Illuminate\Contracts\Console\Kernel::class);$console->bootstrap();$http->bootstrap();
 if(get_class($http)!==Illuminate\Foundation\Http\Kernel::class||get_class($console)!==Illuminate\Foundation\Console\Kernel::class||$app->environment()!=='testing')throw new PEUnsupported('Native Laravel initialization differs');
 foreach($selected as $name=>$entry){$reflection=new ReflectionClass($name);$identity=pe_identity($reflection,$manifest,$prepared['pins']);if($identity['class']!==$name||$identity['path']!==$entry['path']||$identity['sha256']!==$entry['sha256'])throw new PEUnsupported('Declared class/proxy reflection differs');$classes[]=$identity;}
 $used=[];
 foreach($manifest['config']['models'] as $modelIndex=>$spec){
  $model=$app->make($spec['class']);if(!$model instanceof Illuminate\Database\Eloquent\Model)throw new PEUnsupported('Resolved selected model is unsupported');
  $chain=[];$reflection=new ReflectionClass($model);do{$identity=pe_identity($reflection,$manifest,$prepared['pins']);$chain[]=$identity;$used[$identity['class']]=true;}while($reflection=$reflection->getParentClass());
  $defaults=pe_defaults($model);$probes=[];
  foreach($spec['probes'] as $probeIndex=>$probe){$copy=clone $model;$copy->setRawAttributes($probe['attributes'],true);$key=$probe['attribute'];$method=$copy->hasGetMutator($key)?'get'.Illuminate\Support\Str::studly($key).'Attribute':($copy->hasAttributeGetMutator($key)?Illuminate\Support\Str::camel($key):null);if($method===null)throw new PEUnsupported('Selected attribute lacks a native getter accessor');$origin=pe_identity(new ReflectionMethod($copy,$method),$manifest,$prepared['pins']);$value=pe_value($copy->getAttribute($key));$probes[]=['attribute'=>$key,'attributes'=>$transport->config->models[$modelIndex]->probes[$probeIndex]->attributes,'origin'=>$origin,'value'=>$value];}
  if(pe_canonical(pe_defaults($model))!==pe_canonical($defaults))throw new PEUnsupported('Selected model defaults changed during accessor probes');
  $models[]=['requestedClass'=>$spec['class'],'class'=>get_class($model),'parents'=>$chain,'defaults'=>$defaults,'probes'=>$probes];
 }
 foreach($selected as $name=>$entry)if(!isset($used[$name]))throw new PEUnsupported('Declared model/proxy is absent from resolved native model chains');
 $complete=count($models)===count($manifest['config']['models']);
}catch(Throwable $error){$failure=$error instanceof PEUnsupported?$error->getMessage():'Native initialization, reflection or accessor probes did not complete';}
try{pe_inputs($manifest);pe_tools($manifest,$prepared['pins']);if(pe_canonical(pe_runtime())!==pe_canonical($runtime))throw new PEUnsupported('Native PHP extension closure changed');$stable=true;}catch(Throwable $error){$failure='Native PHP inputs changed during execution';$complete=false;}
echo json_encode(['format'=>'checktrail-php-extensions-1','manifest'=>$transport,'runtime'=>$runtime,'classes'=>$classes,'models'=>$models,'complete'=>$complete,'inputsStable'=>$stable,'failure'=>$failure],JSON_THROW_ON_ERROR|JSON_PRESERVE_ZERO_FRACTION|JSON_UNESCAPED_SLASHES);
exit($complete&&$stable?0:2);
`.replace("__PREPARED__", prepared);
