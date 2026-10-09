import { access, cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { TestContext } from "node:test";
import { fixture } from "./helpers.js";
import { validate } from "../src/engine.js";
import { profile } from "./review-laravel-assembly-contract.js";
export { profile };
const vendor = fileURLToPath(
  new URL("../../.checktrail/laravel-tools/vendor", import.meta.url),
);
export const available = await access(path.join(vendor, "autoload.php")).then(
  () =>
    spawnSync("php", ["-r", "echo PHP_VERSION;"], {
      encoding: "utf8",
      timeout: 10000,
    }).stdout === "8.5.6",
  () => false,
);
export const source: Record<string, string> = {
  "composer.json":
    '{\n  "name": "synthetic/assembly-contract",\n  "type": "project",\n  "require": {\n    "php": "^8.5",\n    "laravel/framework": "13.32.0"\n  },\n  "config": {\n    "allow-plugins": false\n  }\n}\n',
  "bootstrap/app.php":
    "<?php\nuse Illuminate\\Foundation\\Application;\nuse Illuminate\\Foundation\\Configuration\\Middleware;\nuse Illuminate\\Console\\Scheduling\\Schedule;\nrequire __DIR__.'/../assembly.php';\nreturn Application::configure(basePath:dirname(__DIR__))\n ->withRouting(using:fn()=>assemblyRoutes())\n ->withMiddleware(function(Middleware $m){$m->use([AssemblyInitialize::class,AssemblyAuthorize::class]);})\n ->withExceptions()\n ->withProviders([AssemblyProvider::class])\n ->withSchedule(fn(Schedule $s)=>assemblySchedule($s))\n ->create();\n",
  "bootstrap/providers.php": "<?php return [];\n",
  "config/app.php":
    "<?php return ['name'=>'Original Assembly','env'=>'testing','key'=>null,'debug'=>false,'url'=>'http://root.example.test','timezone'=>'UTC','locale'=>'en','fallback_locale'=>'en'];\n",
  "config/database.php":
    "<?php return ['default'=>'sqlite','connections'=>['sqlite'=>['driver'=>'sqlite','database'=>':memory:','prefix'=>'','foreign_key_constraints'=>true]]];\n",
  "assembly.php":
    "<?php\nuse Illuminate\\Database\\Eloquent\\Model;\nuse Illuminate\\Database\\Schema\\Blueprint;\nuse Illuminate\\Support\\Facades\\Schema;\nuse Illuminate\\Support\\Facades\\Route;\nuse Illuminate\\Support\\ServiceProvider;\nuse Illuminate\\Console\\Scheduling\\Schedule;\nuse Illuminate\\Http\\Request;\nclass AssemblyState { public int $notifications=0; public int $scheduled=0; public int $terminated=0; }\nclass AssemblyInitialize { public function handle($request,$next){ $request->attributes->set('assembly-ready',true);return $next($request); } public function terminate($request,$response){app(AssemblyState::class)->terminated++;} }\nclass AssemblyAuthorize { public function handle($request,$next){if(!$request->attributes->get('assembly-ready'))return response()->json(['detail'=>'initialization required'],403);return $next($request);} }\nclass AssemblyOwner extends Model { protected $table='owners';public $timestamps=false;protected $guarded=[]; }\nclass AssemblyParent extends Model { protected $table='parents';public $timestamps=false;protected $guarded=[];public function owner(){return $this->belongsTo(AssemblyOwner::class,'owner_id');} }\nclass AssemblyItemBase extends Model { protected $table='items';public $timestamps=false;protected $guarded=[];protected $with=['parent.owner'];protected $casts=['score'=>'integer'];protected $appends=['display'];public function parent(){return $this->belongsTo(AssemblyParent::class,'parent_id');}public function getDisplayAttribute(){return $this->parent->owner->label.':'.$this->score;} }\nclass AssemblyItem extends AssemblyItemBase {}\nclass AssemblyCatalog { public function label(){return 'basic';} }\nclass AssemblyAlternateCatalog extends AssemblyCatalog { public function label(){return 'alternate';} }\nclass AssemblyDecoratedCatalog extends AssemblyCatalog { public function __construct(public AssemblyCatalog $inner){} public function label(){return $this->inner->label().'+extended';} }\nclass AssemblyConsumer { public function __construct(public AssemblyCatalog $catalog){} }\nclass AssemblyJob { public function handle(){throw new RuntimeException('Bound method must replace this implementation');} }\nclass AssemblyListener { public function handle($event,$rows=[]){app(AssemblyState::class)->notifications++;} }\nfunction assemblyRefresh(){app(AssemblyState::class)->scheduled++;}\nfunction assemblySchedule(Schedule $schedule){$schedule->call('assemblyRefresh')->name('assembly-refresh')->hourly()->environments(['testing']);}\nclass AssemblyController {\n public function items(Request $request){\n  $rows=AssemblyItem::query()->orderBy('id')->get();$state=app(AssemblyState::class);$before=$state->notifications;\n  foreach($rows as $row)app('events')->dispatch('assembly.saved',[$row->id]);\n  $scheduledBefore=$state->scheduled;$selected=0;\n  foreach(app(Schedule::class)->events() as $event)if($event->description==='assembly-refresh'){$selected++;if($event->isDue(app())&&$event->filtersPass(app()))$event->run(app());}\n  return response()->json(['rows'=>$rows->toArray(),'armed'=>$rows->map(fn($r)=>$r->preventsLazyLoading)->all(),'existing'=>$rows->map(fn($r)=>[$r->exists,$r->wasRecentlyCreated])->all(),'notifications'=>$state->notifications-$before,'scheduled'=>$state->scheduled-$scheduledBefore,'selected'=>$selected,'tags'=>array_map(fn($c)=>$c->label(),iterator_to_array(app()->tagged('assembly.catalogs'))),'contextual'=>app(AssemblyConsumer::class)->catalog->label(),'method'=>app()->call([new AssemblyJob(),'handle']),'terminatedBefore'=>$state->terminated]);\n }\n public function single(){ $rows=AssemblyItem::query()->orderBy('id')->limit(1)->get();return response()->json(['rows'=>$rows->toArray(),'armed'=>$rows->map(fn($r)=>$r->preventsLazyLoading)->all()]); }\n public function package(Request $request){return response()->json(['route'=>$request->route()->getName(),'method'=>$request->method(),'host'=>$request->getHost(),'port'=>$request->getPort()]);}\n public function echoBody(Request $request){return response()->json(['body'=>$request->getContent(),'header'=>$request->header('X-Original'),'terminatedBefore'=>app(AssemblyState::class)->terminated]);}\n}\nfunction assemblyRoutes(){Route::get('/items',[AssemblyController::class,'items'])->name('assembly.items');Route::get('/single',[AssemblyController::class,'single'])->name('assembly.single');Route::post('/echo',[AssemblyController::class,'echoBody'])->name('assembly.echo');}\nclass AssemblyProvider extends ServiceProvider {\n public function register():void{\n  $this->app->singleton(AssemblyState::class);\n  $this->app->bind('assembly.basic',AssemblyCatalog::class);$this->app->bind('assembly.extra',AssemblyAlternateCatalog::class);\n  $this->app->tag(['assembly.basic','assembly.extra'],'assembly.catalogs');\n  $this->app->extend('assembly.basic',fn($catalog)=>new AssemblyDecoratedCatalog($catalog));\n  $this->app->when(AssemblyConsumer::class)->needs(AssemblyCatalog::class)->give(AssemblyAlternateCatalog::class);\n  $this->app->bindMethod('AssemblyJob@handle',fn($job,$app)=>'bound:'.$app->make('assembly.basic')->label());\n }\n public function boot():void{\n  Model::preventLazyLoading(true);\n  Schema::create('owners',function(Blueprint $t){$t->increments('id');$t->string('label');});Schema::create('parents',function(Blueprint $t){$t->increments('id');$t->integer('owner_id');});Schema::create('items',function(Blueprint $t){$t->increments('id');$t->integer('parent_id');$t->string('score');});\n  app('db')->table('owners')->insert([['id'=>1,'label'=>'first'],['id'=>2,'label'=>'second']]);app('db')->table('parents')->insert([['id'=>1,'owner_id'=>1],['id'=>2,'owner_id'=>2]]);app('db')->table('items')->insert([['id'=>1,'parent_id'=>1,'score'=>'7'],['id'=>2,'parent_id'=>2,'score'=>'9']]);\n  $this->app['events']->listen('assembly.saved',AssemblyListener::class.'@handle');$this->app['events']->listen('assembly.*',AssemblyListener::class.'@handle');\n  Route::domain('package.example.test')->get('/package',[AssemblyController::class,'package'])->name('assembly.package');\n }\n}\n",
};

export async function project(
  t: TestContext,
  program = source,
  configuration: unknown = profile,
  withVendor = true,
) {
  const root = await fixture(t, {
    ...program,
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["php.laravel-runtime"] }],
    }),
    "checktrail.laravel.json": JSON.stringify(configuration),
  });
  if (withVendor)
    await cp(vendor, path.join(root, "vendor"), { recursive: true });
  return root;
}
export async function run(
  t: TestContext,
  program = source,
  configuration: unknown = profile,
) {
  return validate(await project(t, program, configuration), {
    trusted: true,
    timeoutMs: 60000,
  });
}
