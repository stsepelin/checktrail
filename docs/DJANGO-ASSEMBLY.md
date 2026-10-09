# Selected Django assembly contract

`python.django-routes` accepts an opt-in `checktrail.django.json` schema version 2.
Version 1 retains its route-only inventory. Planning validates data and the settings
entry file without importing project code. Execution still requires operator trust
at CLI invocation or MCP startup; a tool argument cannot grant it.

Version 2 requires `settings`, `assembly`, `environment`, explicit `signals`
(module/attribute pairs), `expectedRoutes`, `expectedMiddleware`, `expectedSignals`,
`expectedApps`, and completed `requests` with literal expected status/body/event
projections. See the synthetic contract in
`test/review-django-assembly-fixture.ts`. Expectations are operator declarations,
not automatically inferred answers. The whole configuration is bounded to 64 KiB.

The selected native runtime is Python 3.12.13, Django 6.1.1 and asgiref 3.12.1.
An isolated `python3 -I` bootstrap checks distribution versions and selected source
bytes before framework/project imports. Framework imports precede adding the
project path. A unique empty bytecode-cache prefix excludes unchecked pre-existing
project/framework caches. Missing, incompatible or changed selected runtime bytes
are unavailable before importing settings. Complete wheels, transitive dependencies,
publisher authenticity and license closure are separate unfinished gates.

Native `django.setup()` populates app/model registries and runs app `ready()` hooks.
The projection preserves installed-app order, selected config class, ready method,
implicit/explicit config selection, default auto-field and model-module presence.
It traverses actual nested URL resolvers, built-in converters, pattern regex/flags/
endpoint mode, namespace order, callbacks, and hashes typed merged defaults.
Unsupported custom/translated patterns, opaque default values, cyclic/deep URL
hierarchies and empty route/app inventories cannot pass. Depth is bounded to eight,
total visited URL nodes and each collection to 2048, apps/middleware to 256.

A temporary observer of Django's native middleware import alias records actual
factory construction and `MiddlewareNotUsed` omissions. It preserves factory
capability attributes, arguments, native returned objects and native exceptions,
and restores the alias in `finally`. Native view hooks retain declared order;
template-response and exception hooks retain reverse order. Construction does not
prove invocation. The in-process native `WSGIHandler` performs controlled requests,
including Django's actual URL conversion, inherited defaults, middleware, template
rendering, exception handling and response-close lifecycle. No socket is opened.
Setup/handlers may access files/services using the trusted process's privileges;
this adapter does not sandbox executed project code.

Signal observation starts before project setup and model-signal imports. Selected
native `Signal`/`ModelSignal` instances retain receiver order and multiplicity,
truthy dispatch-UID semantics, native bound-method identity, weak references,
sender identity and async registration. Native callbacks are not wrapped or held
strongly. Duplicate UID attempts preserve the original receiver; native disconnects,
dead weak callbacks and sender caches keep their native behavior. Opaque UID/sender
objects, unobserved registrations and overridden native dispatch/helpers remain
incomplete. Registration/removal attempts have a lifetime budget of 4096, including
ignored operations. Native `send`, `send_robust`, `asend` and `asend_robust` execute
unchanged; selected event projections contain sender/receiver identities and error
booleans, excluding callback arguments, exception text and return values. Native
sync/async result ordering can differ from registration order.

Controlled requests are bounded to 64, headers to 32, input bytes to 32 KiB,
response bytes to 64 KiB and response chunks to 64. WSGI-normalized duplicate and
reserved host/content headers are rejected. Declared Host ports reach native
`SERVER_PORT`. Every response is closed in `finally`; repeated/invalid response
starts and unsupported response encodings remain incomplete. Selected dispatch
events are bounded to 2048. Actual registration identities and sidecar generations
must remain stable over probes, including same-name replacement and removal/readd.

The shared engine emits ordered `routes`, `middleware`, `listeners` and `bindings`
collections and checks literal contracts plus controlled responses. Exact duplicate
pattern chains are scoped by namespaces. Arbitrary regex overlap, general
handler/authorization correctness, per-request URLconf inventory, ASGI serving,
opaque middleware internals, database/migration effects, model accuracy and
independent-session isolation remain unverified. Detailed runtime entries/logs
require operator detail selection; summary output omits them. Low-entropy hashes
and response projections are not a secrecy guarantee.

The required `django-assembly-arm64` job prepares pinned public tools, then verifies
original callbacks, compiling mutations and the same callbacks against an offline
production installation. Reproduce with an operator-prepared image through
`node scripts/verify-django-assembly-container.mjs`; use the shared foreground task
runner on this machine. The acceptance environment has offline networking,
read-only source/root, two CPUs, 2 GiB memory, 256 PIDs and bounded no-execute temp
storage. Its process isolation does not establish host/model session isolation.
Gate A remains open until all selected profiles, freezes and final matrix pass.
