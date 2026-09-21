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
kept in memory and disappear on restart. There is no durable job
handle or restart recovery in the MCP server yet. A separate library-only
[task store](TASK-STORAGE.md) now provides bounded persistence and process-crash
recovery. Its [library worker](VALIDATION-TASKS.md) integrates execution and
parent-disconnect cleanup; MCP protocol integration remains pending.

Lifecycle integration tests exercise real child processes. They reproduced
orphaned workers on EOF and signals before the shutdown handler was added. They
also reproduced SDK 2.0.0 ignoring numeric request ID `0` when cancelling. The
application now handles validation cancellation through the public notification
registration API, using exact request-ID equality and the request's connection
abort signal. String `"0"` must not cancel numeric `0`.

## Standard Tasks extension: not implemented

The current optional Tasks extension is `io.modelcontextprotocol/tasks`. It adds
negotiated task results, polling, cancellation and durable handles. An asynchronous
JavaScript function and an in-memory report ID do not implement that extension.
The server does not advertise Tasks support.

SDK 2.0.0 currently blocks modern `tasks/get` and `tasks/cancel` before registered
extension handlers run. This was reproduced locally; `tasks/update` reaches its
handler in the same probe. Upstream tracks the method-registry collision in
[typescript-sdk#2598](https://github.com/modelcontextprotocol/typescript-sdk/issues/2598).

Run `npm run probe:mcp-tasks` from the source checkout to repeat the routing probe. Exit `2` means one or
more handlers were unreachable; exit `0` means routing works. A routing success
does not establish Tasks conformance. The probe is separate from the ordinary
check suite because this optional capability is not currently shipped.

Before advertising Tasks, implement and verify:

1. Negotiated extension capabilities and ordinary-call fallback for older clients.
2. Connect the implemented local worker/store to the MCP execution slot. Native
   persistence, cancellation, parent-disconnect cleanup and reopening are verified
   independently; worker lifecycle and wire behavior must still be tested together.
3. Standard task creation, get, update and cancellation wire contracts. Store the
   handle before returning it; retain completed tool errors as completed results.
4. Cancellation races, shutdown, reconnect, restart, expiry, missing IDs and
   concurrent requests against a compatible client and SDK.
5. Summary/detail projections that preserve the operator's privacy choice for
   both task metadata and retained results.

References: [core specification](https://modelcontextprotocol.io/specification/2026-07-28),
[Tasks specification](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks).
