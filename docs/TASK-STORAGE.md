# Local validation task storage

`openTaskStore` is an optional library component for retaining validation results
on one local macOS or Linux machine. It is not connected to the CLI or MCP server.
The store itself does not advertise the MCP Tasks extension, execute jobs,
resume jobs, stop workers or act as a validation cache. The separate library
[validation worker](VALIDATION-TASKS.md) now connects it to native execution. See [MCP compatibility](MCP-COMPATIBILITY.md)
for the remaining wire and executor integration gates.

The implementation uses Node's built-in SQLite module, imported only when the
store is opened. Native tests cover Node 26.8.1 on macOS and Node 22.23.2 on Linux;
the latter reports SQLite as experimental. Earlier Node releases, Windows and
network filesystems are not verified storage profiles. Core imports do not load
SQLite, and no new npm runtime dependency is required.

## Use from the library

Choose a dedicated storage directory with an existing canonical parent, outside
the project's inventoried source. An existing store directory must belong to the
current user with mode `0700`; database files must be singly linked regular files
with mode `0600`. New directories and files use these modes. Symbolic links,
unexpected directory entries and unrelated nonempty databases are rejected.

```js
import { createPlan, validate, openTaskStore } from "@stsepelin/checktrail";

const store = await openTaskStore({
  root: projectRoot,
  directory: privateStoreDirectory,
  detailed: false,
});
try {
  const { plan } = await createPlan(projectRoot);
  const task = store.create(plan.sourceFingerprint);
  const report = await validate(projectRoot, { trusted: true });
  const transition = store.complete(task.taskId, report);
  if (transition !== "updated")
    throw new Error("Task did not accept this result");
  const retained = store.get(task.taskId);
  // Consume retained.result.structuredContent as a report summary.
} finally {
  store.close();
}
```

Execution trust still comes from the caller. The caller must use the configured
root when validating; a source fingerprint is not proof of a particular root,
policy or environment. `complete` rejects a report whose initial source
fingerprint differs from the one recorded at creation. Full report shape is
validated, then the existing report projection is applied before serialization.
Summary databases never receive detailed report paths, commands or logs through
this API. Summary metadata can still reveal validation activity and check IDs.

Each database records a hash binding it to its canonical root and disclosure mode.
Reopening with a different root or mode fails, including an attempt to open a
detailed store as summary. Returned objects are detached snapshots. Stored
results remain historical evidence: reading them does not establish freshness
against current source, ignored dependencies or a changed toolchain.

## State and ownership

Creation commits before returning an opaque UUID. Result completion and
cancellation transitions use SQLite transactions. A completed result retains the
original validation outcome, including failed or incomplete outcomes; task
completion never means that checks passed.

Only one store handle may own a directory at a time, including within one process.
A separate SQLite database holds an exclusive lock for the handle's lifetime.
The operating system releases this lock when the owning process exits, including
SIGKILL. Contending opens fail immediately; they do not recover or replace a live
owner's tasks. There are no PID-reuse guesses or time-based ownership leases.

On reopening, retained terminal results remain unchanged. Unfinished tasks become
`completed` with a fixed `isError: true` tool result describing interruption, and
no structured validation report. This matches the distinction between tool errors
and JSON-RPC errors in the [Tasks specification](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks).
Interrupted work is never resumed or reported as passing. This store does not
establish that child processes from a crashed executor have stopped; that requires
executor lifecycle integration before exposing a durable MCP handle.

Cancellation has two stages:

1. `requestCancellation(id)` reserves cancellation while status remains `working`.
   Subsequent completion returns `cancellation-requested` and cannot store a result.
2. After the executor confirms workers have stopped, call `finishCancellation(id)`.
   It changes status to `cancelled` without a report. Calling it without requesting
   cancellation throws.

`interrupt(id)` records the fixed tool error for an execution that cannot produce
a retained report; it also respects terminal states and cancellation reservations.
All terminal states are immutable through the API. A late transition returns
`terminal`; missing or expired IDs throw. Repeated cancellation requests return
`cancellation-requested`. A restart during cancellation produces an interruption
error, not an unverified claim that worker termination succeeded. This profile
has no interactive input or JSON-RPC error state.

## Bounds and failure behavior

- At most 32 retained tasks per directory. Capacity exhaustion rejects creation;
  unexpired tasks are never silently evicted.
- TTL defaults to 24 hours, measured from creation, and accepts integer milliseconds
  from 1 through seven days. Wall-clock changes affect expiration. Expired IDs are
  inaccessible; rows are pruned on creation or reopening.
- Each serialized tool result is limited to 256 KiB of UTF-8, including both text
  and structured representations. Oversized completion throws and leaves the
  task working. Retained payloads therefore total at most 8 MiB.
- SQLite uses 4 KiB pages with a 16 MiB database limit, DELETE journaling and FULL
  synchronous commits. A rollback journal temporarily consumes additional bounded
  space. The ownership database and accepted journal sizes have separate limits.
- Short synchronous database operations run on the caller's thread. The store
  rejects malformed state, mismatched result representations and corrupt databases;
  it does not erase an unreadable store and claim successful recovery.

File permissions and path checks assume trusted local ownership. They are not
protection against another process with the same user's privileges replacing or
modifying store files. Do not manipulate SQLite files while a handle is open.
SQLite secure deletion is enabled, but expiry is not a secure-erasure promise for
backups, filesystem snapshots or storage devices. Tests demonstrate process-crash
recovery, not arbitrary hardware or power-loss durability.

## Reproduce

```sh
npm run build
node --test dist/test/task-store.test.js
node scripts/verify-task-store-container.mjs
```

Native regressions cover real validation and reopening, same-process and
cross-process contention, SIGKILL recovery, rollback of an uncommitted deletion,
completion/cancellation ordering, capacity and TTL, UTF-8 byte limits, disclosure
binding, private modes, links, foreign databases and malformed stored results.
The container helper additionally verifies a fresh offline production-only package
installation, native validation and reopening with networking disabled and the
installed package mounted read-only. Hosted CI remains a separate release gate.

Guard-removal experiments made the named cancellation and root-binding tests fail
for their intended conditions: a late completion was accepted after cancellation
reservation, and another project root could open the same store. Restoring each
guard restored the tests. The rollback fixture forces dirty pages to spill to disk
before killing its writer; it does not rely on an unflushed in-memory edit.
