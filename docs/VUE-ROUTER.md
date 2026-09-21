# Vue Router testing assembly profile

`javascript.vue-router` creates a native memory router, awaits an explicitly
selected registration function, captures its final route records and checks
declared URL probes using native resolution. A pass means every native record
participated in a probe and all expected matched chains agreed. It does not prove
that the selected testing assembly matches the application's production assembly.
Reuse application registration code instead of maintaining a second route table.

The verified versions are Vue Router 5.3.1 and Vue 3.5.43, with Node 26.8.1 on
macOS arm64 and Node 22.23.2 on Linux arm64. Other framework versions are unavailable
until verified. Framework dependencies must already exist inside the operator
root; the engine never installs them. Fixture dependencies are locked separately
in `scripts/vue-router-tools/package-lock.json` and are not distributed as runtime
dependencies of Checktrail.

## Configuration

Select `javascript.vue-router` in `checktrail.json`, or use the pinned
`packs/vue-router.json` profile. Add `checktrail.vue-router.json` in that project:

```json
{
  "schemaVersion": 1,
  "module": "routes.mjs",
  "attribute": "configure",
  "assembly": "example.catalog",
  "environment": "test",
  "strict": false,
  "sensitive": false,
  "probes": [
    {
      "path": "/catalog",
      "matched": [{ "path": "/catalog", "name": "catalog" }]
    }
  ]
}
```

The inventoried Node-compatible module exports the named function:

```js
export async function configure(router) {
  router.addRoute({
    path: "/catalog",
    name: "catalog",
    component: { render: () => null },
  });
}
```

Use `name: null` for unnamed records. Each probe contains the complete ordered
matched chain, including parents and default children. Aliases are separate native
records and require participation too. A negative probe uses `matched: []`;
at least one probe must expect a match. Removed or replaced declarations that
are absent from the final router are not counted. Shadowed records that cannot
participate in any selected probe prevent a complete result.

Planning reads configuration without importing the module. Execution requires
the normal operator trust setting. The collector protects `NODE_ENV=test` and
clears `NODE_OPTIONS`; permitted environment inputs remain available to startup.
Startup and imports execute trusted code with the process user's privileges.
They can perform I/O or invoke other router methods themselves. This is not a
sandbox. Node must be able to load the module and its dependencies; the collector
does not build TypeScript/SFC files or install a loader.

## Evidence and limits

The runtime inventory preserves native record order and multiplicity. Each entry
records path/name, alias identity, named view keys, canonical JSON metadata/static
redirect data, per-record guard function names, child count and the configured
global strict/sensitive options. Per-record matcher overrides are exercised by
probes but are not separately serialized. Component bodies, guard bodies, closure
captures, props, global navigation hooks and scroll behavior are not captured.
Changing a function body without changing the projected fields can leave the
inventory unchanged. Use runtime comparison to review changes in this projection.

The collector calls `resolve`, not navigation: it does not follow redirects, run
navigation guards, load lazy views, render components or initialize a browser.
Static redirect targets are recorded without proving they exist. Dynamic redirects,
symbol route names and unsupported metadata make capture incomplete. Metadata
supports bounded finite JSON values in plain objects and dense arrays; functions,
custom prototypes, symbol keys, computed properties, hidden object properties and
extra array properties are unsupported. Metadata and redirects are limited to
eight levels, 1,024 visited values, 64 members per object/array and 4,096 serialized
characters. The whole run retains shared process time/output limits.

Profiles have at most 256 unique probe paths, 32 records per expected chain and
64 KiB of encoded configuration. Native capture permits 2,048 route records.
Empty routers, uncovered records, unsupported projections and malformed accounting
cannot pass. A known probe mismatch is a failed finding even if other evidence is
incomplete; `findingsComplete` records that distinction. Native resolution only
establishes behavior for the supplied URLs, not every path/parameter combination.

Detailed reports include route metadata and configured probe paths. Summary
CLI/MCP output omits them, and MCP arguments cannot enable detailed output.
The profile does not infer authorization, server endpoints, Nuxt page generation,
Nuxt plugins/middleware or application integration. Those need separate profiles
and native evidence.

## Reproduce native evidence

From the checkout, prepare the development fixture tools explicitly:

```sh
mkdir -p .checktrail/vue-router-tools
cp scripts/vue-router-tools/package.json scripts/vue-router-tools/package-lock.json .checktrail/vue-router-tools/
npm ci --prefix .checktrail/vue-router-tools --ignore-scripts --no-audit --no-fund
npm run build
node --test dist/test/vue-router.test.js
node scripts/verify-vue-router-container.mjs
```

The container helper requires its pinned Node image to be available. Validation
uses disabled container networking and read-only source mounts. It runs native
fixtures, installs a freshly packed package offline, and exercises the public
`examples/vue-router` fixture through installed library, CLI and MCP entry points.
An intentionally changed route name must fail before the fixture is restored.
The source tests cover async registration, nested default children, aliases,
removed records, metadata changes, unprobed and shadowed records, unsupported
data, evidence tampering, version gates, trust, protected environment and output
privacy. Hosted CI is configured separately and has not been run remotely.

A manual mutation removed the requirement that every record participate in a
probe. The native uncovered-record regression then failed specifically because
the result changed from incomplete to passed. Restoring the guard restored the
passing native suite; container and package verification ran afterward.

Reference: [Vue Router API](https://router.vuejs.org/api/). Compatibility claims
above come from the pinned installed runtime and native tests.
