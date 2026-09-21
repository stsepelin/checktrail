export const laravelRunner = String.raw`
function rv_property(object $object, string $property): mixed {
    return (new ReflectionProperty($object, $property))->getValue($object);
}
function rv_identity(mixed $value): string {
    static $sources = [];
    static $sourceBytes = 0;
    if (is_string($value)) return $value;
    if (is_array($value) && count($value) === 2 && isset($value[0], $value[1]) && is_string($value[1])) {
        return (is_object($value[0]) ? get_class($value[0]) : $value[0]).'@'.$value[1];
    }
    if ($value instanceof Closure) {
        $reflection = new ReflectionFunction($value);
        $file = $reflection->getFileName();
        if (!$file || !is_file($file)) throw new RuntimeException('Unsupported closure source');
        $prefix = getcwd().DIRECTORY_SEPARATOR;
        $vendor = dirname($GLOBALS['rv_autoload']).DIRECTORY_SEPARATOR;
        $location = str_starts_with($file, $prefix) ? substr($file, strlen($prefix)) : (str_starts_with($file, $vendor) ? 'vendor/'.substr($file, strlen($vendor)) : null);
        if ($location === null) throw new RuntimeException('Closure source outside project and local vendor');
        if (!isset($sources[$file])) {
            $bytes = file_get_contents($file, false, null, 0, 8 * 1024 * 1024 + 1);
            $sourceBytes += strlen($bytes);
            if (strlen($bytes) > 8 * 1024 * 1024 || $sourceBytes > 64 * 1024 * 1024) throw new RuntimeException('Closure source limit exceeded');
            $sources[$file] = explode("\n", $bytes);
        }
        $lines = $sources[$file];
        $source = implode("\n", array_slice($lines, $reflection->getStartLine() - 1, $reflection->getEndLine() - $reflection->getStartLine() + 1));
        return 'closure:'.$location.':'.$reflection->getStartLine().':'.$reflection->getEndLine().':'.hash('sha256', $source);
    }
    if (is_object($value)) return get_class($value).'@__invoke';
    throw new RuntimeException('Unsupported callable registration');
}
function rv_scalar_hash(mixed $value, int $depth = 0): string {
    $walk = function (mixed $value, int $depth) use (&$walk): mixed {
        if ($depth > 32) throw new RuntimeException('Registration data too deep');
        if (is_array($value)) {
            $result = [];
            foreach ($value as $key => $item) $result[$key] = $walk($item, $depth + 1);
            return $result;
        }
        if (is_null($value) || is_scalar($value)) return $value;
        throw new RuntimeException('Unsupported registration data');
    };
    return hash('sha256', json_encode($walk($value, $depth), JSON_THROW_ON_ERROR));
}
function rv_collect(string $kind, bool $ordered, callable $read): array {
    $entries = [];
    try {
        $read($entries);
        return ['kind' => $kind, 'complete' => true, 'ordered' => $ordered, 'entries' => $entries];
    } catch (Throwable $error) {
        fwrite(STDERR, $kind.': '.get_class($error).': '.$error->getMessage().PHP_EOL);
        return ['kind' => $kind, 'complete' => false, 'ordered' => $ordered, 'entries' => $entries];
    }
}
function rv_add(array &$entries, string $key, array $attributes): void {
    if (++$GLOBALS['rv_count'] > 20000) throw new RuntimeException('Assembly entry limit exceeded');
    $entries[] = ['key' => $key, 'attributes' => (object) $attributes];
}
$rv_count = 0;
$rv_temporary = null;
$rv_autoload = $argv[1];
ob_start(function ($text) { fwrite(STDERR, $text); return ''; }, 1);
try {
    require $rv_autoload;
    if (!class_exists(Illuminate\Foundation\Application::class) || Illuminate\Foundation\Application::VERSION !== '13.32.0') {
        fwrite(STDOUT, json_encode(['unavailable' => 'laravel-runtime', 'reason' => 'unsupported-version']));
        exit(3);
    }
    $config = json_decode($argv[2], true, flags: JSON_THROW_ON_ERROR);
    $rv_temporary = sys_get_temp_dir().'/checktrail-laravel-'.bin2hex(random_bytes(16));
    if (!mkdir($rv_temporary, 0700)) throw new RuntimeException('Cannot create temporary cache directory');
    register_shutdown_function(function () use ($rv_temporary) {
        foreach (glob($rv_temporary.'/*') as $file) if (is_file($file) || is_link($file)) @unlink($file);
        @rmdir($rv_temporary);
    });
    $cachePaths = [];
    foreach (['CONFIG', 'ROUTES', 'EVENTS', 'SERVICES', 'PACKAGES'] as $kind) {
        $key = 'APP_'.$kind.'_CACHE';
        $cachePaths[$kind] = $rv_temporary.'/'.strtolower($kind).'.php';
        putenv($key.'='.$cachePaths[$kind]);
        $_ENV[$key] = $_SERVER[$key] = $cachePaths[$kind];
    }
    $app = require getcwd().'/bootstrap/app.php';
    if (!$app instanceof Illuminate\Foundation\Application || realpath($app->basePath()) !== getcwd() || $app->hasBeenBootstrapped()) throw new RuntimeException('Unsupported application bootstrap');
    $app->useEnvironmentPath($rv_temporary)->loadEnvironmentFrom('.env');
    $http = $app->make(Illuminate\Contracts\Http\Kernel::class);
    $console = $app->make(Illuminate\Contracts\Console\Kernel::class);
    $console->bootstrap();
    $console->all();
    $http->bootstrap();
    if ($app->environment() !== 'testing') throw new RuntimeException('Expected isolated testing environment');
    foreach (['CONFIG' => 'getCachedConfigPath', 'ROUTES' => 'getCachedRoutesPath', 'EVENTS' => 'getCachedEventsPath', 'SERVICES' => 'getCachedServicesPath', 'PACKAGES' => 'getCachedPackagesPath'] as $kind => $method) {
        if ($app->$method() !== $cachePaths[$kind]) throw new RuntimeException('Application changed protected cache paths');
    }
    $router = $app->make('router');
    $dispatcher = $app->make('events');
    $schedule = $app->make(Illuminate\Console\Scheduling\Schedule::class);
    $collections = [];
    $collections[] = rv_collect('routes', true, function (&$entries) use ($router) {
        if (get_class($router) !== Illuminate\Routing\Router::class || get_class($router->getRoutes()) !== Illuminate\Routing\RouteCollection::class) throw new RuntimeException('Unsupported router or cached route collection');
        foreach ($router->getRoutes() as $route) {
            if (get_class($route) !== Illuminate\Routing\Route::class) throw new RuntimeException('Unsupported route class');
            $middleware = array_map('rv_identity', $router->gatherRouteMiddleware($route));
            foreach ($route->methods() as $method) {
                rv_add($entries, json_encode([$route->getDomain(), $method, $route->uri()], JSON_THROW_ON_ERROR), [
                    'domain' => $route->getDomain(), 'method' => $method, 'uri' => $route->uri(),
                    'name' => $route->getName(), 'handler' => rv_identity($route->getAction('uses')),
                    'middleware' => array_values($middleware), 'constraintsHash' => rv_scalar_hash($route->wheres), 'defaultsHash' => rv_scalar_hash($route->defaults),
                ]);
            }
        }
        if (!$entries) throw new RuntimeException('No served routes');
    });
    $collections[] = rv_collect('middleware', true, function (&$entries) use ($http) {
        foreach (['global' => $http->getGlobalMiddleware(), 'priority' => $http->getMiddlewarePriority()] as $kind => $values) rv_add($entries, $kind, ['type' => $kind, 'stack' => array_values(array_map('rv_identity', $values))]);
        foreach ($http->getMiddlewareGroups() as $name => $values) rv_add($entries, 'group:'.$name, ['type' => 'group', 'name' => $name, 'stack' => array_values(array_map('rv_identity', $values))]);
        foreach ($http->getMiddlewareAliases() as $name => $value) rv_add($entries, 'alias:'.$name, ['type' => 'alias', 'name' => $name, 'target' => rv_identity($value)]);
    });
    $collections[] = rv_collect('listeners', true, function (&$entries) use ($dispatcher) {
        if (get_class($dispatcher) !== Illuminate\Events\Dispatcher::class) throw new RuntimeException('Unsupported event dispatcher');
        foreach (['exact' => $dispatcher->getRawListeners(), 'wildcard' => rv_property($dispatcher, 'wildcards')] as $kind => $events) {
            foreach ($events as $event => $listeners) foreach ($listeners as $listener) rv_add($entries, $kind.':'.$event, ['type' => $kind, 'event' => $event, 'listener' => rv_identity($listener)]);
        }
    });
    $collections[] = rv_collect('schedules', true, function (&$entries) use ($schedule) {
        if (get_class($schedule) !== Illuminate\Console\Scheduling\Schedule::class) throw new RuntimeException('Unsupported scheduler');
        foreach ($schedule->events() as $event) {
            if (!in_array(get_class($event), [Illuminate\Console\Scheduling\Event::class, Illuminate\Console\Scheduling\CallbackEvent::class], true)) throw new RuntimeException('Unsupported scheduled event');
            $callback = $event instanceof Illuminate\Console\Scheduling\CallbackEvent;
            $target = $callback ? rv_identity(rv_property($event, 'callback')) : $event->command;
            $attributes = ['type' => $callback ? 'callback' : 'command', 'target' => $target];
            foreach (['expression', 'repeatSeconds', 'user', 'environments', 'evenInMaintenanceMode', 'evenWhenPaused', 'withoutOverlapping', 'releaseOnTerminationSignals', 'onOneServer', 'expiresAt', 'runInBackground', 'description', 'output', 'shouldAppendOutput'] as $field) $attributes[$field] = $event->$field;
            $attributes['timezone'] = $event->timezone instanceof DateTimeZone ? $event->timezone->getName() : $event->timezone;
            $attributes['parametersHash'] = rv_scalar_hash($callback ? rv_property($event, 'parameters') : []);
            foreach (['filters', 'rejects', 'beforeCallbacks', 'afterCallbacks'] as $field) $attributes[$field] = array_values(array_map('rv_identity', rv_property($event, $field)));
            $attributes['mutex'] = get_class($event->mutex);
            $attributes['mutexNameResolver'] = $event->mutexNameResolver === null ? null : rv_identity($event->mutexNameResolver);
            $attributes['attributesHash'] = rv_scalar_hash($event->attributes);
            rv_add($entries, ($callback ? 'callback:' : 'command:').$target, $attributes);
        }
    });
    $collections[] = rv_collect('bindings', false, function (&$entries) use ($app) {
        $factoryMethod = new ReflectionMethod(Illuminate\Container\Container::class, 'getClosure');
        $scoped = rv_property($app, 'scopedInstances');
        foreach ($app->getBindings() as $abstract => $binding) {
            $factory = $binding['concrete'];
            $identity = rv_identity($factory);
            if ($factory instanceof Closure) {
                $reflection = new ReflectionFunction($factory);
                if ($reflection->getFileName() === $factoryMethod->getFileName() && $reflection->getStartLine() >= $factoryMethod->getStartLine() && $reflection->getEndLine() <= $factoryMethod->getEndLine()) $identity = $reflection->getStaticVariables()['concrete'];
            }
            rv_add($entries, 'factory:'.$abstract, ['type' => 'factory', 'abstract' => $abstract, 'target' => $identity, 'shared' => $binding['shared'], 'scoped' => in_array($abstract, $scoped, true)]);
        }
        foreach (rv_property($app, 'aliases') as $alias => $abstract) rv_add($entries, 'alias:'.$alias, ['type' => 'alias', 'abstract' => $alias, 'target' => $abstract]);
        foreach ($app->contextual as $consumer => $bindings) foreach ($bindings as $abstract => $value) rv_add($entries, 'contextual:'.$consumer.':'.$abstract, ['type' => 'contextual', 'consumer' => $consumer, 'abstract' => $abstract, 'target' => rv_identity($value)]);
        foreach (rv_property($app, 'instances') as $abstract => $instance) rv_add($entries, 'instance:'.$abstract, ['type' => 'instance', 'abstract' => $abstract, 'target' => is_object($instance) ? get_class($instance) : 'scalar:'.rv_scalar_hash($instance)]);
    });
    $result = ['version' => 1, 'laravelVersion' => Illuminate\Foundation\Application::VERSION, 'entryCount' => array_sum(array_map(fn ($collection) => count($collection['entries']), $collections)), 'runtime' => [
        'schemaVersion' => 1, 'format' => 'runtime-inventory', 'producer' => ['name' => 'checktrail.laravel-runtime', 'version' => '1.0.0'],
        'assembly' => ['name' => $config['assembly'], 'environment' => $config['environment']], 'sourceFingerprint' => $argv[3], 'capturedAt' => gmdate('Y-m-d\TH:i:s\Z'), 'collections' => $collections,
    ]];
    fwrite(STDOUT, json_encode($result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
} catch (Throwable $error) {
    fwrite(STDERR, get_class($error).': '.$error->getMessage().PHP_EOL);
    exit(2);
}
`;
