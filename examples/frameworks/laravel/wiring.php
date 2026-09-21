<?php
use Illuminate\Support\Facades\Route;
use Illuminate\Support\ServiceProvider;
use Illuminate\Console\Scheduling\Schedule;
class SyntheticAuth {}
class SyntheticGuest {}
class CatalogService {}
class AlternateCatalogService {}
class CatalogConsumer {}
class SyntheticListener { public function handle() { throw new RuntimeException('Listener executed'); } }
class SyntheticController { public function show() { throw new RuntimeException('Request executed'); } }
function syntheticJob() { throw new RuntimeException('Scheduled work executed'); }
function syntheticRoutes() {
    Route::get('/catalog', 'SyntheticController@show')->name('catalog')->middleware('synthetic.auth');
    Route::get('/catalog-extra', 'SyntheticController@show')->name('catalog-extra')->middleware('synthetic.auth-extra');
}
function syntheticSchedule(Schedule $schedule) { $schedule->call('syntheticJob')->name('catalog-refresh')->hourly(); }
class SyntheticProvider extends ServiceProvider {
    public function register(): void {
        $this->app->bind('synthetic.catalog', CatalogService::class);
        $this->app->alias('synthetic.catalog', 'synthetic.alias');
        $this->app->when(CatalogConsumer::class)->needs(CatalogService::class)->give(AlternateCatalogService::class);
    }
    public function boot(): void {
        $this->app['events']->listen('synthetic.saved', SyntheticListener::class.'@handle');
        $this->app['events']->listen('synthetic.*', SyntheticListener::class.'@handle');
    }
}
