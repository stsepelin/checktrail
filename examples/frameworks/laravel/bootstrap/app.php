<?php
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Console\Scheduling\Schedule;
require __DIR__.'/../wiring.php';
return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(using: fn () => syntheticRoutes())
    ->withMiddleware(function (Middleware $middleware) { $middleware->alias(['synthetic.auth' => SyntheticAuth::class, 'synthetic.auth-extra' => SyntheticGuest::class]); })
    ->withExceptions()
    ->withProviders([SyntheticProvider::class])
    ->withSchedule(fn (Schedule $schedule) => syntheticSchedule($schedule))
    ->create();
