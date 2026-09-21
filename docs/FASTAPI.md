# FastAPI route inventory profile

The opt-in `python.fastapi-routes` check imports an explicitly configured local
application, enters its native lifespan, captures the flat route table after
startup, exits the lifespan, and checks exact duplicate protocol/method/path
registrations. The verified profile is FastAPI 0.141.1 with Starlette 1.6.0 on
Python 3.12.13 in an isolated Linux container. Other framework versions are
unavailable until their collector behavior is verified.

Select the check in `checktrail.json` and provide this project-local file:

```json
{
  "schemaVersion": 1,
  "module": "app",
  "attribute": "app",
  "assembly": "catalog-api",
  "environment": "isolated-test"
}
```

Save it as `checktrail.fastapi.json`. `module` must resolve to exactly one
inventoried Python module or package in that project. `attribute` is a simple
attribute name, not an expression or a factory invocation. The value must be a
FastAPI application. Planning validates this configuration without importing it.

Execution requires normal operator trust. Import and lifespan code can access
networks, services and files; configure an isolated test environment and supply
required environment names through the existing operator permissions. The
environment label in this profile is descriptive, not a sandbox guarantee. The
engine does not install packages, run an HTTP server or send HTTP requests.

The supported concrete route classes are native FastAPI `APIRoute` and
`APIWebSocketRoute`, and Starlette `Route` and `WebSocketRoute`. Framework default
documentation/OpenAPI routes are included, not inferred from application source.
At least one FastAPI HTTP/WebSocket application route is required. Mounts,
host-based routing, custom route classes and other arrangements outside this flat
profile make the capture incomplete. Any known exact duplicate still fails while
the incomplete runtime collection remains visible.

HTTP and WebSocket identities are distinct, even for an HTTP method literally
named `WEBSOCKET`. Methods and paths match exactly: different HTTP methods, path
suffixes and trailing slashes are not collapsed. This detects exact duplicate
registrations only; it does not resolve overlapping path patterns, redirects,
host constraints or precedence between parameterized and literal routes.

Detailed check results include a `runtime` artifact compatible with
`compareRuntimeInventories`. Capture preserves registration order, multiplicity,
route names, handler identities, schema visibility and dependency callable
identities. Each dependency list is a deterministic depth-first traversal. It does
not include dependency arguments, security scopes, response models, middleware
state or handler bodies; changes to those require other checks. Completeness
refers to this declared projection of the flat route table, not all application
behavior. Summary output omits the inventory and raw application logs.

The collector reconciles native route counts with per-entry registration indices
before accepting an artifact. Unsupported callables, import/startup/shutdown
failures, malformed evidence and execution limits prevent a pass. Normal stdout
from application startup/shutdown is redirected to the bounded stderr log so it
cannot corrupt the structured output. Source and policy fingerprints are verified
after execution by the shared engine. Check scope names the import entry file;
this is runtime assembly inspection, not type or syntax checking of all Python.

Native fixtures verify correct routes, duplicate registrations, HTTP/WebSocket
near misses, framework defaults, startup-added duplicates, successful cleanup,
shutdown failure, a documentation-only app and unsupported mounts. Parser tests
exercise source/assembly identity, native registration accounting and incomplete
evidence. Reproduce prepared Linux tests with
`node scripts/verify-framework-container.mjs`; the pinned preparation requirements
are in `scripts/framework-tools.requirements.txt`. Hosted CI remains unexecuted.

References: [FastAPI lifespan events](https://fastapi.tiangolo.com/advanced/events/),
[Starlette routing](https://www.starlette.io/routing/).
