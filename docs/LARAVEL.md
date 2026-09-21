# Laravel runtime assembly profile

`php.laravel-runtime` captures an explicitly selected Laravel testing assembly.
A passed capture means its five declared projections were collected successfully.
Use `compare-runtime` to detect changes against a reviewed inventory; capture alone
does not decide whether a route, permission, schedule or binding is correct.

The native fixture uses Laravel 13.32.0, PHP 8.5.6 and Node 22.23.2 on Linux.
Other Laravel versions are rejected until their internal API contract is verified.
The development tool installation is pinned in `scripts/laravel-tools/composer.lock`;
the distributed package does not include Laravel or install it for consumers.

Select the check in `repo-verifier.json`, and add `repo-verifier.laravel.json`:

```json
{
  "schemaVersion": 1,
  "assembly": "catalog-test-application",
  "environment": "testing"
}
```

The project needs inventoried `bootstrap/app.php` and a local `vendor/autoload.php`
within the operator root. Planning validates paths and configuration without
loading either. Execution uses the normal CLI/MCP operator trust gate.

## Bootstrap and collection

The collector loads the application, constructs its HTTP kernel, bootstraps the
console kernel, initializes Artisan's command inventory, and resolves the
scheduler. Artisan initialization is necessary for `withSchedule()` callbacks.
It does not dispatch HTTP requests, run command handlers, invoke event listeners,
evaluate schedule filters, or execute scheduled jobs. Bootstrap, command and
controller constructors, service providers and Composer autoload files still run
project code and can perform their own I/O. This is not a sandbox.

The profile fixes `APP_ENV=testing` and `APP_DEBUG=false`, uses a fresh temporary
directory for Laravel's configuration, route, event, package and service caches,
and points Laravel's dotenv loader at that empty directory. Existing project
dotenv files and compiled caches are not consumed by the collector's bootstrap.
Operator-permitted environment variables still reach project code. Bootstrap that
has already run, a different application base path, altered cache paths, or a
non-testing resolved environment produces an error. Temporary cache files are
removed on normal PHP shutdown; forced process termination can leave temporary
files for the host's temporary-directory cleanup.

| Collection | Recorded projection                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routes     | Served domain/method/URI entries, name, handler identity, native expanded and sorted middleware, constraint/default hashes. Includes framework and package routes.                                            |
| Middleware | HTTP kernel global stack, priority, groups and aliases, preserving stack order.                                                                                                                               |
| Listeners  | Exact-event and wildcard registrations, callable identity, order and multiplicity.                                                                                                                            |
| Schedules  | Command/callback identity, cron expression, repeat interval, timezone, environments, user, overlap/server/background/maintenance flags, output settings, callback identities, parameter and attribute hashes. |
| Bindings   | Explicit global factories with shared/scoped flags, aliases, contextual bindings, and currently resolved instance classes or scalar hashes.                                                                   |

Class factories wrapped by Laravel's container retain the actual concrete class
identity. Generic closures retain relative source location and a hash of their
source lines. Listener wildcard maps and scoped binding lists use reflection
against the pinned framework version. Collection failures retain partial evidence
and make the check incomplete. Empty served routes are incomplete; empty listeners
or schedules can be legitimate. Collection entries, closure-source reads, output,
execution time and source freshness are bounded by the collector and shared engine.

## Boundaries

This is a CLI testing assembly after eager deferred-provider loading and native
introspection. It is not an HTTP request, queue worker, Octane or production
assembly. Constructors resolved during inspection can affect the final container
inventory. Collect before/after under equivalent runtime and environment settings.

The projection does not serialize object state or closure captures, execute
factories, infer automatic type bindings, or inventory container extenders, tags,
method bindings and resolution hooks. It does not evaluate authorization, model
relations, response schemas, job behavior or schedule eligibility. Callable identity
is not a semantic proof of behavior. Instance state changes and closure-captured
value changes can therefore leave the projection unchanged. Hashes of scalar
configuration are not a secrecy guarantee.

Laravel can replace a route registration under an existing method/domain/URI key;
this collector records the final served collection, not discarded declarations.
It does not classify duplicate listeners as bugs: inventory comparison preserves
their multiplicity for review. Equivalent route languages and overlapping match
patterns are not normalized. Custom router, route, event dispatcher, scheduler or
scheduled-event classes are unsupported. Unsupported registration data or closure
sources outside the project/local vendor directory also prevent a complete capture.

Detailed reports include the `runtime` object and can contain application names,
paths, schedule commands and callable identities. Summary reports omit it. Save
the runtime objects to compare with the shared CLI/library/MCP runtime comparator;
imported comparisons do not independently establish freshness of the current tree.

## Reproduce native evidence

Prepare the development-only locked Composer installation in
`.repo-verifier/laravel-tools`, build the project, then run
`node scripts/verify-laravel-container.mjs`. It uses installed Composer/PHP and
Node images, reports their digests, disables container networking and creates
synthetic fixture copies inside the container. The helper does not pull images.
Hosted CI preparation is defined but has not been run remotely.

The public fixture is `examples/frameworks/laravel`. Its tests inspect framework
storage routes as well as application routes, distinguish middleware alias near
misses, retain wildcard listeners and concrete binding classes, and compare
changed/fixed listeners, schedules, bindings and route middleware. Separate cases
exercise stale caches, dotenv exclusion, an actually empty native route collection,
custom dispatchers and bootstrap errors. Tests assert the relevant failure reason
or incomplete collection, rather than accepting any nonzero exit.

References: [Laravel routing](https://laravel.com/docs/13.x/routing),
[scheduling](https://laravel.com/docs/13.x/scheduling),
[container bindings](https://laravel.com/docs/13.x/container). The pinned installed
framework source and native fixtures determine this adapter's exact compatibility.
