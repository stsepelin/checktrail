# MCP compatibility

The server runs locally over stdio using the official TypeScript SDK. The tested
current protocol is `2026-07-28`. Local operation is a deployment choice, not a
separately named MCP standard. No account, HTTP listener, remote service or LLM
provider is required.

## Application clients

Fresh offline package checks with Claude Code and Codex passed their documented
legacy negotiation profiles. Claude Code health/tool discovery and Codex direct
app-server tool calls are different coverage levels; see [CLIENTS.md](CLIENTS.md)
for versions, the corrected schema warning, reproduction and recorded evidence.

## Execution lifecycle

`validation_run` executes asynchronously while its tool call remains pending.
Other inspection calls remain responsive. A second validation is rejected while
one is active. Request cancellation terminates the validation process group;
stdin EOF, SIGINT and SIGTERM close the server connection and cancel active work.
Mutation experiments share the validation execution slot and cancellation path;
read-only guidance and planning remain responsive. Mutation results are advisory
and returned directly, without a retained report ID. Reports from validation are
kept in memory and disappear on restart. The optional `--task-store` startup
profile connects the bounded [store](TASK-STORAGE.md) and
[worker](VALIDATION-TASKS.md) to standard MCP Tasks polling. It adds durable handles
and historical retrieval for capable requests while preserving ordinary calls.

Lifecycle integration tests exercise real child processes. They reproduced
orphaned workers on EOF and signals before the shutdown handler was added. They
also reproduced SDK 2.0.0 ignoring numeric request ID `0` when cancelling. The
application now handles validation cancellation through the public notification
registration API, using exact request-ID equality and the request's connection
abort signal. String `"0"` must not cancel numeric `0`.

## Standard Tasks polling profile

The foreground server advertises `io.modelcontextprotocol/tasks` only when the
operator supplies `--task-store`. A capable `validation_run` creates a durable
handle; get, cancel and update use the public extension methods. Other clients
receive ordinary results. Native failure and completed tool errors retain their
original meaning. See [the operator and wire contract](VALIDATION-TASKS.md) and
[local evidence](measurements/mcp-tasks-wire-2026-10-05.json).

The original routing blocker was observed with older published SDK profiles:

SDK 2.0.0 blocked modern `tasks/get` and `tasks/cancel` before registered
extension handlers run. This was reproduced locally; `tasks/update` reaches its
handler in the same probe. Upstream tracks the method-registry collision in
[typescript-sdk#2598](https://github.com/modelcontextprotocol/typescript-sdk/issues/2598).

Rechecked on 2026-09-21: npm's latest server/client SDK versions are still 2.0.0,
the local probe still returns `-32601` for get/cancel and reaches update, and the
[proposed upstream fix](https://github.com/modelcontextprotocol/typescript-sdk/pull/2599)
remains open. The package retains its pinned SDK; no transport interception or
protocol workaround is introduced.

Rechecked on 2026-09-30: an isolated exact official server/client/core 2.2.0
installation still returns `-32601` for get/cancel and reaches update. Its installed
implementation still uses the blanket historical-method gate. The upstream fix
was merged that day, but is absent from this tested release. The project retains
SDK 2.0.0; see the [pinned routing measurement](measurements/mcp-tasks-routing-2026-09-30.json).
A merged source fix is not evidence that a published artifact contains it.

Rechecked on 2026-10-01: the npm registry still selects server 2.2.0. The exact
published server/client/core 2.2.0 profile again returns `-32601` for get/cancel
and reaches update; see the [current routing measurement](measurements/mcp-tasks-routing-2026-10-01.json).
No project SDK dependency was changed and no Tasks capability is advertised.

Rechecked on 2026-10-05: the exact official server/client/core 2.3.0 artifacts
route get, cancel and update to registered public SDK handlers. The isolated probe
and the project-pinned profile agree. The project now pins server/client 2.3.0 and
core 2.3.0 in the lockfile; no unrelated dependency version changed. See
[the published routing measurement](measurements/mcp-tasks-routing-2026-10-05.json).
That routing measurement predates wire integration. The later polling profile now
verifies durable creation, result retrieval, exact cancellation and shutdown,
restart, expiry, admission and privacy on the recorded macOS/Linux versions. The
ordinary client suite also passes with Tasks enabled, including SDK legacy
negotiation. Fresh offline production installations exercise the shipped CLI and
runtime. No transport interception or SDK patch was added.

Run `npm run probe:mcp-tasks` to repeat the routing prerequisite only. Exit `2`
means a handler was unreachable; exit `0` means routing works. Repeat the wire
acceptance with `node scripts/verify-required-native-tests.mjs mcp-tasks` and the
installed-package controls with `node scripts/verify-mcp-tasks-package.mjs` after
building and preparing the offline cache. These checks do not establish full
Tasks conformance, Windows support, actual model-host Tasks interoperability or
review quality. The profile requests no input and uses polling; subscriptions and
input-required workflows are outside this native validation profile. The SDK's
update-field lifting prevents attesting strict validation of original malformed
update shapes. Ordinary host-client measurements in `CLIENTS.md` predate this
revision and are not reclassified as new Tasks evidence.

References: [core specification](https://modelcontextprotocol.io/specification/2026-07-28),
[Tasks specification](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks).
