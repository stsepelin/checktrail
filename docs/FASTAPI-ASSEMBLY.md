# Selected FastAPI assembly contracts

Opt-in `checktrail.fastapi.json` configuration version 2 extends the existing
`python.fastapi-routes` adapter. Version 1 retains its flat inventory contract.
Planning reads the local profile and import entry without loading Python or the
application. Execution requires the existing operator trust setting; an MCP
argument cannot grant it. The CLI, library and MCP use the shared engine.

The selected runtime is Python 3.12.13, FastAPI 0.141.1, Starlette 1.6.0 and
Pydantic 2.13.5. Isolated Python bootstrap and isolated metadata probes exclude
project stdlib shadows. Version and selected collector-facing source byte gates
precede framework/project imports. A unique empty Python cache prefix prevents
existing unchecked bytecode from replacing captured source; it is removed on
normal and exceptional collector exit. Those source pins do not establish whole
wheel, compiled dependency, publisher or license closure.

## Declared assembly

Version 2 retains `module`, `attribute`, `assembly` and `environment`, and adds
required `expectedRoutes`, `expectedMiddleware`, `expectedLifespan`,
`expectedBindings` and `requests`. Operators supply complete expected projections;
the validator never generates expectations from the assembly it is checking.
The [generated schema](../schemas/fastapi-config.schema.json) defines the exact
fields. The original synthetic
[fixture](../test/review-fastapi-assembly-fixture.ts) provides a complete example
with expectations frozen from native behavior.

Native effective route contexts retain included-router prefixes and dependencies.
Supported concrete native route classes are FastAPI HTTP/WebSocket routes,
Starlette HTTP/WebSocket routes, mounts and hosts, with selected FastAPI,
Starlette or router children. Custom route subclasses, opaque ASGI children,
low-priority routes outside the selected inventory, cycles and excessive hierarchy
remain unsupported. Scope records distinguish mounts and hosts without guessing
path concatenation. Every method is retained; HTTP and WebSocket identities are
separate even for a literal HTTP method named `WEBSOCKET`.

The route projection includes handler identity, name, schema visibility,
response-model serialization schema, response class/options and status code.
Dependency traversal retains order, multiplicity, callable kind, caching and
scope, own/parent/effective OAuth scopes and selected security-scheme metadata.
The binding collection retains ordered dependency overrides. User middleware
registration arguments/options use typed data encoding so callable metadata
cannot collide with literal objects. The constructed native middleware chain is
captured after requests. Construction does not attest that every middleware or
route ran.

The lifespan projection preserves native merged-context entry order and explicit
startup/shutdown callback registrations. Only the root application's native
lifespan is entered. Mounted application lifespan registrations are captured;
they are not declared to have run. Root yielded state is copied into each
controlled request as the ASGI lifespan protocol requires. Same-name route and
middleware object replacement or any projected registration drift during probes
or shutdown prevents complete evidence.

## Controlled requests and limits

Requests call the native ASGI application in process, without a listening socket.
Each declares protocol, decoded path, ASCII host with optional port, uppercase alphabetic method,
headers, UTF-8 body and expected status/body/WebSocket messages. HTTP and
WebSocket completion are checked before accepting responses. Native serialization,
middleware and dependencies run; their returned values are compared exactly.
The ASGI server pair retains the declared hostname and port separately. Text WebSocket accept/send/close is supported. Binary frames, HTTP trailers,
query/fragment input, IPv6 host syntax and incomplete or unsupported event streams
remain outside this profile. A Host header cannot override the explicit host.

Configuration is bounded to 64 KiB. Hierarchy depth is eight, total raw hierarchy
accounting and each projected collection are bounded to 2,048, and there are at
most 256 projected applications. Dependencies are bounded to 256 nodes per
route and eight levels. Typed middleware data has eight levels and 64 members per
container; encoded metadata is bounded to 4,096 characters. There are at most 64
requests, 32 input headers, 64 receive/send events per request, a 32 KiB input-body
character limit and a 64 KiB UTF-8 response-byte limit. The shared engine also
applies wall time, output and descendant controls. These are execution controls,
not an OS security boundary for trusted project code.

Receipt validation reconciles source/assembly/producer/version identity, all four
ordered collection kinds, scope/registration counters, keys and request inputs.
Empty, stale, malformed, unavailable, unbuilt or incomplete evidence cannot pass.
Known assembly/response differences produce findings at the declared profile;
summary output omits assembly details and raw output. Operator-detailed results
retain the runtime inventory and native request evidence.

## Acceptance

The required profile is `assembly-fastapi`. Its same nine original callbacks run
from source and a fresh offline production installation. Synthetic controls reach
an actual 403 when authorization precedes initialization; repair produces native
200 responses with two coerced model rows and inherited defaults. They also cover
security scopes, duplicate dependency caching, an override, HTTP/WebSocket method
and host/mount distinctions, root lifespan teardown, prerequisites, stale/empty
receipts, CLI/MCP privacy and reached descendant cleanup.

Supplemental controls cover project module shadows, unchecked caches, bounded
hierarchies, identical-name object replacement and incomplete native responses.
Compiling JS and Python mutations must fail unchanged original assertions, retain
fixture/callback byte bindings and restore each source before positive controls.
The parallel ARM CI job prepares pinned public wheels, then runs native acceptance
without networking, with a read-only source/root filesystem, two CPUs, 2 GiB
memory, 256 PIDs and a bounded noexec temporary filesystem.

No general authorization correctness, arbitrary handler truth, live-service
integration or reviewer accuracy is established. Full artifact/notice closure,
other assembly profiles and final Gate A matrix acceptance remain separate. No
inference or field evaluation is invoked.
