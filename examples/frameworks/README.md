# Synthetic framework inventories

Prepare the pinned Python dependencies from
`scripts/framework-tools.requirements.txt` in an isolated Python 3.12 environment
and build Repo Verifier from the checkout. These examples use no database or
network service.

```sh
node dist/src/cli.js run --root examples/frameworks/fastapi --trust-project
node dist/src/cli.js run --root examples/frameworks/django --trust-project
```

The default applications have unique native routes. To reproduce a failure in a
temporary copy, change the FastAPI profile's `module` from `app` to `broken`, or
the Django profile's `settings` from `settings` to `broken_settings`. Both fixtures
register a duplicate route without changing the producer's response. The route
inventory check fails even though calling that response function would still
return the expected data.

Detailed reports include the captured `runtime` object for before/after comparison.
These checks inspect their documented route projections; they do not send HTTP
requests or establish complete application/test coverage. See `docs/FASTAPI.md`
and `docs/DJANGO.md` for supported native classes and explicit limitations.

The Laravel example uses only synthetic routes, listeners, schedules and services.
Prepare the locked development dependencies from `scripts/laravel-tools` outside
validation, and copy its `vendor` directory into a temporary copy of
`examples/frameworks/laravel`. Run the selected `php.laravel-runtime` check there
with operator trust and detailed output. Its five collections are suitable for
`compare-runtime`: changing `hourly()` to `daily()`, adding another listener, or
changing `bind` to `singleton` produces a changed inventory. Capturing that changed
assembly still passes; the before/after comparison reports the difference.
The fixture's request, listener and job bodies throw if invoked, so collection does
not depend on executing application work. See `docs/LARAVEL.md` for the exact
projection and `node scripts/verify-laravel-container.mjs` for the native regression
suite against these public source files.
