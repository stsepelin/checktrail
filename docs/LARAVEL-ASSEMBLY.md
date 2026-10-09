# Laravel assembly contracts

`php.laravel-runtime` configuration version 2 compares an operator-declared
assembly with native Laravel registrations and controlled HTTP responses.
Configuration version 1 remains the inventory-only profile in `LARAVEL.md`.
Planning reads configuration and paths without loading Composer or application
code. Execution requires CLI `--trust-project` or MCP startup
`--allow-execution`; a tool argument cannot grant trust. This executes project
code and does not provide an operating-system sandbox.

The bounded compatibility target is PHP 8.5.6, Laravel 13.32.0, Carbon 3.14.0,
Symfony HTTP Foundation 8.1.7 and Symfony Routing 8.1.6. Required native acceptance
uses Linux ARM64 Node 22.23.2 and a synthetic in-memory SQLite application.
The version probe reads installed Composer metadata and selected native file
bytes without loading autoload.php. The collector repeats those checks before
Composer/application imports and verifies Laravel's loaded version constant.
The selected pins in `src/laravel-assembly-runtime-pins.ts` cover the documented
native APIs; they are not a complete dependency, binary or publisher-license
closure. CLI opcode caching, preload, automatic prepend and append are disabled
for the version-2 commands.

## Operator contract

The strict `checktrail.laravel.json` version-2 schema requires `assembly`, testing
`environment`, a UTC `clock` with at most microsecond precision, selected Eloquent
`models`, all five `expectedCollections`, and controlled `requests`. See
`schemas/laravel-config.schema.json` and the complete original contract in
`test/review-laravel-assembly-contract.ts`. That contract was authored from native
development witnesses; it is not independent review-accuracy evidence.

Collections declare exact kinds, completeness and ordering. Routes, middleware,
listeners and schedules retain native order and multiplicity. Container bindings
are compared as an unordered multiset; tag member arrays and extender positions
retain their own order. Route keys are checked against their decoded native
method/domain/URI tuple, including PHP's escaped-slash JSON spelling. Empty
served routes or bindings and missing global/priority middleware projections
remain incomplete. Empty listener and schedule collections can be valid.

The shared collector captures actual framework/package routes, expanded route
middleware, global middleware order and aliases, exact/wildcard event listeners,
cron/environment/filter/callback registrations, factories, aliases, contextual
bindings and resolved instance identities. Version 2 also captures tags,
extenders, bound methods and declared model defaults. The nine enumerated native
application path instances must equal their corresponding Application getter and
remain inside the project; their identity is normalized to a project-relative
path rather than a temporary-root hash. Other scalar instances retain hashes.

Selected model instances are created before the initial registration projection.
Their inherited eager loads/counts, native casts, default attributes, table,
connection, key, timestamps, pagination, appends, guarded/fillable fields, global
scope identities and global lazy-loading policy are captured. Scalar/array
hashes preserve types and key order. Objects, resources, non-finite values and
oversized/deep values remain unsupported. Overridden selected model getters,
kernels, streamed/opaque responses and unsupported native assembly classes
remain incomplete rather than being certified through replacement APIs.

Each request declares path, method, host, port, ordered headers, nullable body and
exact expected status/body/exception class. Headers cannot replace the controlled
host or content length and must be unique after case normalization. Requests use
Laravel's actual Request and HTTP kernel; each handled response is terminated
before evidence is emitted. Non-streaming native response content is bounded and
its actual attached exception class is retained. No listening server is started.
Event, container and scheduling behavior in the fixtures is reached through the
application's own native request handlers; the engine does not infer which
listeners or scheduled callbacks should run.

The Date facade supplies the declared clock to native scheduler filters. Changed
clock/factory/timezone settings, registrations, selected-model global scope tables
or callback/object identities across probes make evidence incomplete. Unselected
model scope tables are outside the declared model projection. Weak identity references do not extend
callback lifetimes. Resolved instance state and ordinary framework caches can
evolve; they are not treated as immutable registration tables. Initial inventory
is taken after bootstrap/model inspection and before the requests. These checks
do not serialize arbitrary object state or closure captures.

## Budgets and evidence

Configuration is bounded to 256 KiB of UTF-8 and transported as base64 chunks of
at most 64 KiB per argument. Request bodies are bounded to 32 KiB; expected and
actual response bodies to 64 KiB; class selectors, requests, headers, collections,
typed data and snapshot traversal have separate schema/runtime limits. The shared
runner additionally bounds total output, time and source freshness. Argument
transport and the complete profile are verified on the declared Linux ARM64
runtime; Windows command-line transport is not certified by that result.

Source fingerprint, producer identity, runtime versions, clock, model selectors,
collection counts/attributes, request identity and completion must agree. A
complete mismatch produces a finding against the operator contract; malformed,
unsupported, stale, truncated, empty or unfinished evidence remains incomplete.
Summary output omits detailed inventories and raw responses; detailed CLI/MCP
output requires operator detail selection. Typed hashes and detailed projections
are not a secrecy guarantee.

The original fixture uses two existing rows to arm Eloquent's real hydration
lazy-loading guard. Its inherited eager load succeeds; dropping the nested
relation produces an actual LazyLoadingViolationException response. A one-row
counterpart explicitly records an inactive guard and cannot establish multi-row
coverage. Other native controls exercise middleware ordering, provider routes,
listener multiplicity, container tags/context/extenders/method bindings, controlled
cron time and termination. Lifecycle controls cover cancellation, timeout,
output limits, detached descendants and owned temporary-directory cleanup.
The shared POSIX runner quiesces the owned root before descendant capture and
stops it after its direct children are signalled, preventing resumed request work
while cleanup completes. Loss of the Node owner and arbitrary hostile spawning
are not certified by those controls.

The `laravel-assembly-arm64` CI job prepares the locked public Composer tools and
runs `scripts/verify-laravel-assembly-container.mjs`. Source originals, compiling
JavaScript/PHP guard removals, supplemental cases, legacy owned-cache behavior and
the same originals in a fresh offline production installation are required.
The acceptance containers use read-only source/root, no network, two CPUs,
2 GiB memory and 256 PIDs; the controller provides 512 MiB non-executable temporary
storage and the fresh installed harness provides 256 MiB. Process isolation does
not establish host/model/session independence. Gate A stays open until its other
profiles, freezes and exact final matrix have accepted evidence.
