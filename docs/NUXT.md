# Nuxt SSR testing assembly

`javascript.nuxt-runtime` builds a fresh Nuxt SSR testing assembly and sends
explicitly declared page requests through Nitro's in-process `localFetch`. An
injected server-only plugin observes the actual Nuxt router at `app:rendered`,
after plugins, initial navigation and rendering. The hook retains a reader; the
collector invokes it only after the in-process request completes, including later
awaited render hooks. This includes generated page
routes and runtime registration; it does not reconstruct routes from filenames.
No listening socket or external infrastructure is started by the collector.

This experimental profile is version-gated to Nuxt/Kit/Vite-builder/Nitro-server
4.5.2, Nitro 2.13.4, Vue 3.5.43 and Vue Router 5.3.1. Dependencies must be prepared
inside the operator root. Fixture tooling has a separate lockfile in
`scripts/nuxt-tools`; the production package does not install or redistribute that
framework toolchain. Package metadata identifies tools, not an attestation of
unaltered installed bytes or bundler aliases.

## Request contract

Select `javascript.nuxt-runtime` explicitly and add `repo-verifier.nuxt.json`:

```json
{
  "schemaVersion": 1,
  "assembly": "example.catalog",
  "environment": "test",
  "probes": [{ "path": "/", "matched": [{ "path": "/", "name": "index" }] }]
}
```

The project must contain exactly one inventoried `nuxt.config.js`, `.ts`, `.mjs`,
`.mts`, `.cjs` or `.cts`. Planning never loads it. Execution requires operator
trust. Configuration, modules, Vite/Nitro plugins, server handlers, middleware,
SSR plugins and page rendering execute project code with the user's privileges.
They may perform their own I/O; the execution allowlist is not a sandbox.

Each probe expects HTTP 200 and an exact ordered matched chain. Names may be null.
At least one probe and one matched record per probe are required; at most 16
unique request paths and 32 records per chain are allowed. Every final native
route record, including aliases, must participate in a declared SSR request.
Negative HTTP status contracts, redirects, client-only navigation and browser
hydration are outside this profile. An unexpected HTTP status is a failed finding;
missing capture remains incomplete even when HTTP 200 was returned.

Every request gets a new Nuxt application through the built SSR renderer. The
ordered route projection must remain identical across requests. Request-dependent
registration is reported as incomplete rather than merged into an invented
single assembly. Record indices, signatures, counts, matched identities and
source identity are reconciled by the evidence parser. Empty, partial or malformed
evidence cannot pass. Known request/route failures remain failed even when capture
is also incomplete, with `findingsComplete: false`.

## Assembly and projection boundaries

The collector sets `NODE_ENV=test`, clears `NODE_OPTIONS`, disables Nuxt telemetry
and devtools, and selects non-development SSR with the native Vite builder and
Nitro's `nitro-prerender` preset. Nuxt dotenv loading is disabled. It uses a fresh
canonical temporary build/output/cache directory owned by the shared runner;
normal completion, timeout and cancellation remove that directory. Nuxt build-cache
reuse, Chrome DevTools project metadata and the experimental TypeScript plugin
are disabled. Project code can still
read local files or change settings; this is a selected testing assembly, not a
proof of production equivalence. The internal Nitro preset is pinned and tested.

Probes use the synthetic host `repo-verifier.invalid`, without supplied credentials
or cookies. Server route rules or handlers may intercept requests; a response
without the instrumented SSR capture cannot establish route coverage. The check
executes the selected SSR behavior but does not prove that middleware permissions,
rendered content, data access or monetary calculations are correct. It does not
validate all possible route parameters, browser state or deployment presets.

Route entries use the [Vue Router projection](VUE-ROUTER.md): path/name, alias
identity, view keys, bounded metadata/static redirect data, guard function names,
child counts and global matcher flags. Function bodies and component behavior are
not serialized. Unsupported data makes the collection incomplete. Captures are
bounded to 2,048 native records, with shared process time/output limits. The planned
scope identifies the Nuxt configuration entry; this is not per-source type checking,
linting or an assertion that every source file was included by the build.

Detailed reports retain the runtime inventory and request paths. Summary output
omits them. Source fingerprints cover the engine inventory and retain its usual
limits for dependencies, external services and ignored files. Runtime comparison
can review changes in the captured projection under equivalent settings.

## Reproduction

Prepare the separate development fixture installation explicitly:

```sh
mkdir -p .repo-verifier/nuxt-tools
cp scripts/nuxt-tools/package.json scripts/nuxt-tools/package-lock.json .repo-verifier/nuxt-tools/
npm ci --prefix .repo-verifier/nuxt-tools --ignore-scripts --no-audit --no-fund
npm run build
node --test dist/test/nuxt.test.js
```

`node scripts/verify-nuxt-container.mjs` runs the native tests and a fresh offline
package installation through library, CLI and MCP in a pinned Node 22 Alpine
container with networking disabled and read-only source mounts. On macOS it needs
a second prepared installation in `.repo-verifier/nuxt-linux-tools`, installed by
that Linux image from the same lockfile, because native compiler bindings differ.
On Linux it uses `.repo-verifier/nuxt-tools`. The helper requires Docker and the
pinned image. `examples/nuxt` contains only original synthetic fixtures.

Native regressions cover generated pages, asynchronous runtime registration,
broken/fixed route contracts, uncovered records, HTTP failure, request-dependent
assemblies, unsupported metadata, parser accounting and cancellation observed
while startup is actually running. A lifecycle regression first reproduced a false
pass when a later awaited `app:rendered` hook added an uncovered route; deferring
the native read until request completion makes that case incomplete. The read-only
package fixture also verifies that Chrome DevTools metadata is not written into
the project dependency directory. Verification status belongs in `STATUS.md`;
a defined helper or CI job is not evidence that it ran.

A manual mutation removed the complete-record participation guard. The native
uncovered-route regression failed because the result became passed instead of
incomplete. Restoring the original evaluator restored the passing regression;
subsequent container/package checks used the restored code.

References: [Nuxt hooks](https://nuxt.com/docs/4.x/api/advanced/hooks),
[Nuxt programmatic APIs](https://nuxt.com/docs/4.x/api/kit/programmatic).
The pinned installed framework and native tests determine this profile's behavior.
