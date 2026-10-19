# Local validation task storage

`openTaskStore` is an optional library component for retaining validation results
on one local machine. The shared CLI/MCP Tasks worker uses this store when the
operator supplies `--task-store`.
The store itself does not advertise the MCP Tasks extension, execute jobs,
resume jobs, stop workers or act as a validation cache. The separate library
[validation worker](VALIDATION-TASKS.md) now connects it to native execution. See [MCP compatibility](MCP-COMPATIBILITY.md)
for the remaining wire and executor integration gates.

The implementation uses Node's built-in SQLite module, imported only when the
store is opened. Native tests cover Node 26.8.1 on macOS and Node 22.23.2 on Linux;
the latter reports SQLite as experimental. Earlier Node releases, the new Windows backend and
network filesystems remain unverified storage profiles. Core imports do not load
SQLite, and no new npm runtime dependency is required.

## Windows storage acceptance

The experimental Windows backend checks a caller-only filesystem DACL using fixed
shipped OS inspection. Newly created empty directories/files receive a protected
ACL before data is written; existing objects are inspected and rejected rather
than having their permissions changed. The sole access rule must grant the exact
caller SID full control with the required inheritance/propagation flags. Directory
ACLs are protected; file ACLs may inherit only that caller rule. Owner identity must
match the caller SID or the actual default token owner SID for built-in
Administrators (`S-1-5-32-544`). Other default owner groups are rejected before
SQLite writes because [ownership confers control over the DACL](https://learn.microsoft.com/en-us/windows/win32/secauthz/owner-of-a-new-object). Windows
can apply its default token owner to native SQLite journals. This uses
[Windows token owner semantics](https://learn.microsoft.com/en-us/dotnet/api/system.security.principal.windowsidentity.owner?view=netframework-4.8.1)
and [filesystem ACL operations](https://learn.microsoft.com/en-us/dotnet/api/system.io.directoryinfo.setaccesscontrol?view=netframework-4.8.1).

Canonical local-drive paths, regular singly linked bounded files and the existing
SQLite ownership/root/disclosure guards remain required. Inspection runs the fixed
system PowerShell executable with no profile, path interpolation or project
commands. ACL inspection has a bounded timeout/output; absent or invalid inspection
fails startup. The inspector uses the fixed shipped .NET Framework JSON serializer
and typed filesystem ACL methods. It does not resolve PowerShell JSON, item or ACL
cmdlets through an ambient module path. The serializer has no type resolver and
retains explicit length/depth bounds. This is an account permission check, not isolation from an
administrator or trusted project execution.

The [recorded original controls](measurements/tasks-runtime-controls-2026-10-11.json)
passed on the measured macOS and pinned Linux ARM64 runtimes, against source and
fresh offline production installations. Native Windows source and
installed-package controls are pending. The new Tasks
runtime jobs select the recorded Linux/macOS Node slots, Windows Node slot and
pinned Linux ARM64 runtime; successful job receipts are still required. They retain
observed image metadata, which is not a signed OS-image attestation. The whole
Gate A Tasks profile and final acceptance bindings remain pending.

The frozen Tasks callbacks retain a two-case native identifier-boundary regression,
its repair and valid adjacent control; current-source completion binding;
empty/all-skipped refusal; startup trust/disclosure boundaries; witnessed native
cancellation, deadline and output termination; reopening; and offline production
installation. The preserved wire checks additionally cover capability negotiation,
admission conflicts, crash interruption, expiry and bounded retained output. A
terminal `completed` task can carry failed or incomplete validation; the controls
check the underlying outcome separately.

Repeat the complete runtime controls after building:

```sh
node scripts/verify-tasks-runtime.mjs
node scripts/verify-tasks-runtime-package.mjs
```

CI passes the exact frozen slot identifier. Receipts bind the Node executable,
compiled runtime and unchanged harness/declaration inputs before/after the run.
On Windows they additionally hash the selected system PowerShell executable.
These bindings record observed bytes; they do not attest host isolation or OS-image
provenance. Native Windows results and the complete selected runtime matrix are
required before the Tasks profile can be marked accepted.

## Use from the library

Choose a dedicated storage directory with an existing canonical parent, outside
the project's inventoried source. On POSIX, an existing store directory must belong
to the current user with mode `0700`; database files must be singly linked regular
files with mode `0600`. New POSIX directories and files use these modes. Windows
requires the caller-only ACL profile described above. Symbolic links,
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
- Each inline tool result remains limited to 256 KiB of UTF-8, including both
  text and structured representations. The original `complete()` API rejects
  oversized completion and leaves the task working. Inline payloads therefore
  total at most 8 MiB.
- The detailed worker uses `completeWithArchive()`. Oversized detail is retained
  as exact compact report JSON with a whole-report SHA-256 and fixed 64 KiB chunks
  with individual hashes. Its completed inline result remains an explicit tool
  error directing readers to `validation_archive_read`; completion does not mean
  validation passed. Ordinary small results retain their original representation.
- One archive is limited to 32 MiB and all retained archive bytes to 64 MiB.
  Capacity failures reject the entire completion transaction without evicting
  unexpired sibling results. Summary stores never receive archive bytes.
- SQLite uses 4 KiB pages, a 16 MiB summary or 96 MiB detailed database limit,
  DELETE journaling and FULL synchronous commits. Accepted rollback journals are
  bounded at the selected database limit plus 1 MiB. Ownership files retain their
  separate limits.
- Short synchronous database operations run on the caller's thread. The store
  rejects malformed state, mismatched result representations and corrupt databases;
  it does not erase an unreadable store and claim successful recovery.

File permissions and path checks assume trusted local ownership. They are not
protection against another process with the same user's privileges replacing or
modifying store files. Do not manipulate SQLite files while a handle is open.
SQLite secure deletion is enabled, but expiry is not a secure-erasure promise for
backups, filesystem snapshots or storage devices. Tests demonstrate process-crash
recovery, not arbitrary hardware or power-loss durability.

## Large detailed reports

`completeWithArchive(id, report)` keeps the task's original source binding,
terminal immutability and cancellation reservation. Every chunk, manifest and
terminal result commits in one SQLite transaction. A mid-write refusal rolls all
of them back. The worker records its existing interruption error if retention
fails; it never reports partial retention as a completed report.

`readArchive(id, index)` returns one bounded canonical base64 chunk plus its byte
count, SHA-256 and a manifest binding the task, initial source fingerprint and
whole report. Concatenate decoded chunks in index order and verify the whole
manifest's byte count and SHA-256 before using the report. Reading hashes one
bounded chunk; completion and reopening verify the whole report. These are byte
integrity checks, not producer authentication or current-source revalidation.

Opening a valid version 1 store validates its root, disclosure and original rows
before atomically upgrading to version 2. Existing terminal results are retained.
Older releases refuse the new store version; keep using the upgraded release for
that directory. Reopening refuses missing, extra, reordered or inconsistent
archive artifacts, including wrong source, digests and terminal state. Expiration
cascades through manifest and chunk rows. This retains the report's captured
streams and their original incomplete flags; it cannot recover bytes the engine
never captured or supply missing model-host usage.

The [durable archive measurement](measurements/durable-task-report-archives-2026-10-11.json)
binds the recorded source and fresh installed controls and paired guard removals.
The whole Attempt archives profile, native Windows archive controls, complete
platform matrix and resource release measurements remain pending. Reopening may
read and validate up to the bounded aggregate archive volume. The ordinary
same-user filesystem ownership assumptions above still apply.

## Reproduce

```sh
npm run build
node --test dist/test/task-store.test.js
node scripts/verify-task-store-container.mjs
node scripts/verify-task-archives.mjs
node scripts/verify-task-archives-package.mjs
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
