# Durable workflow command and native receipt audit

`ReviewWorkflowSession` wraps the shared `ReviewWorkflowEngine` with an optional
private command journal. The foreground `review-session` CLI and `review_workflow`
MCP tool use the same wrapper. The default remains ephemeral; the direct engine
has no journal. No model provider or credentials are required.

This is a bounded command transcript foundation for R7/R8, not the complete
blinded benchmark harness. The [sealed synthetic intake](REVIEW-BENCHMARK.md)
now connects these journals to frozen trial slots and anonymous judging preparation. Original synthetic controls cover native intent
ordering, malformed submissions, interrupted prefixes, private startup storage,
quota reservations, ledger consistency, cleanup and MCP negotiation. The receipt
extension adds early termination, partial/zero budgets, output overrun, timeout,
stale source, storage loss, concurrent command binding and altered-evidence controls. See the
[command-audit measurement](measurements/review-workflow-audit-2026-10-03.json) and
[native-receipt measurement](measurements/review-workflow-native-audit-2026-10-05.json).

## Operator startup

Create an existing private directory outside the reviewed project. On the recorded
POSIX profiles, its owner must be the current operator and its mode exactly `0700`.
Use a fresh absolute filename; existing files, including empty files, are rejected.
The new journal is a singly linked regular file with mode `0600`. Windows support
is unavailable for this audit profile.

```sh
mkdir -m 700 /path/to/private-audits
node dist/src/cli.js review-session --root /path/to/project \
  --detailed --allow-review-source \
  --workflow-audit /path/to/private-audits/new-epoch.jsonl
```

For MCP, give `serve` the same audit flags at operator startup. Native execution
still requires the separate execution grant and pinned probe. Library callers use
`new ReviewWorkflowSession(root, { allowReviewSource: true, audit: { file } })`.
Source disclosure is required because the journal can retain source, issued
packets and raw submissions. Commands cannot choose an audit path, enable auditing,
raise limits or read journal history through the workflow tool.

MCP performs storage preflight at startup and creates the exclusive journal before
the first workflow command. Official SDK clients can spawn a disposable discovery
process; discovery alone creates no journal. In-process protocol negotiation shares
one workflow epoch across discarded discovery instances. `ReviewWorkflowSession`'s
optional third constructor argument, `"first-command"`, selects this deferred
creation behavior; the ordinary library and CLI create the journal at startup.
Creation rechecks the storage preconditions. There is no append/resume mode.

| Startup setting               | Default    | Maximum     |
| ----------------------------- | ---------- | ----------- |
| `--workflow-audit-max-bytes`  | 67,108,864 | 134,217,728 |
| `--workflow-audit-max-events` | 1,024      | 4,096       |

Limit flags require `--workflow-audit`. Library `audit.maxBytes` and `audit.maxEvents`
use the same strict schema. Admission reserves two MiB for each pending command's
completion and 512 KiB for the terminal event, before exposing an assignment or
executing a native probe. At most sixteen commands can be pending. Exhaustion
stops the epoch without dispatching the rejected request; reached commands retain
their completion reservation. These are journal admission limits, separate from
workflow payload and native budgets. Small limits may reject a command even when
its eventual result would have been smaller than the reserved maximum.

## What persists

The optional startup `audit.binding` / `--workflow-audit-binding PRIVATE_JSON`
adds `{runId, trialId, protocolDigest}` to the header for a frozen benchmark trial.
It is checked against the pinned benchmark protocol at intake; it grants neither
source disclosure nor execution. Existing unbound journals remain readable.

A header records the engine/runtime identities and an observed runtime JS/package
byte digest (older headers may omit it), a digest of the project root,
operator limits and registered probe digests. Each admitted command has a durable
`begin` record before dispatch, followed by a durable `finish` record before the
result is released to the caller. Each record includes source-free workflow
accounting snapshots. Exact JSON command values and issued assignments are
retained, including malformed host responses. Version 2 completion records also
retain the complete structured native run receipt, pinned recipe contents and
selected candidate, bound to their command, workflow and target handle. The runner returns its receipt after native cleanup; capture preserves that
returned evidence before subsequent workflow guards or retention handling can
discard it, including when concurrent termination has already cleared workflow
memory.
Completed runs need no subsequent adjudicator assignment to persist; partial,
zero-call, failed, cancelled, timed-out and stale runs preserve reached trials,
unrun cases, cleanup status and native ledgers when the runner returns a receipt.
A preparation exception with no returned receipt leaves accounting unknown. Errors retain the command and an
error outcome; arbitrary exception messages are not copied into the journal.

Input capture is canonical JSON, not original transport bytes. Inputs over one MiB
retain their total byte count, digest and first 4,096 bytes, are explicitly partial,
and are not dispatched. Unserializable library inputs are explicitly unavailable
and are not dispatched. CLI/MCP transport or schema failures rejected before the
session's admission boundary do not acquire a command record. Requests rejected
because the journal cannot reserve space are not admitted; the terminal reason
records audit exhaustion when durable finalization remains possible.

Writes use the same open file descriptor, with file identity, owner, mode, link
count and size checks. Records are synchronously flushed with `fsync`; creation
also flushes the parent directory entry. Storage failure withholds the result,
stops the session and leaves a prefix rather than reporting successful sealing.
Ordinary shutdown aborts engine work immediately and seals only after pending
commands finish cleanup and retain any reached native accounting receipt. A
process kill can leave a pending intent with unknown execution/accounting. It does
not establish that execution started, or that cleanup occurred.

Raw in-memory workflow data is scrubbed on engine termination. The explicitly
requested journal persists on disk until the operator removes it. It is never
included in later worker packets and is not read to create or resume workflows.
Neither trusted project execution nor an external AI host is isolated from the
operator's filesystem by this journal.

## Read-only inspection

```sh
node dist/src/cli.js review-audit --input /path/to/private-audits/new-epoch.jsonl
```

The inspector reads a bounded private file without following its final symlink,
checks observed file stability, validates the complete newline-terminated prefix,
and returns metadata only. It checks sequence, epoch identity, hash chaining,
command matching, assignment digests, ledger totals and retained workflow/assignment
history. Native receipts reconcile the accepted reviewer candidate, registered
recipe digest and contents, ordered cases and inputs, source/context binding,
engine/runtime identities, startup limits and observed accounting. Inspection
returns receipt counts and completeness without source, recipes or observations.
A torn final line is counted as trailing bytes and remains interrupted.
Complete corrupt events, duplicate/unmatched commands or bytes after finalization
are rejected. Nothing executes, discloses raw source or resumes work.

Exit status is `2` for an interrupted journal, unknown native accounting, partial
command capture, no admitted commands, unfinished workflow or inspection error.
New journals use event schema version 2. The inspector still reads version 1
journals and rejects mixed versions within an epoch. Its summary is now version 2,
with `journalVersion` and `nativeReceipts` metadata. A version 1 journal containing
native work reports incomplete native receipt retention even if its accounting
is complete; CLI inspection exits `2`. A journal without native work can have
complete receipt accounting with zero receipts. Neither case proves a native
check ran. Existing journals are read-only and are never rewritten or resumed.

`nativeReceipts.complete` describes structured receipt retention, independently
of whether the native run succeeded, the workflow completed, or raw output exists.
A pending command, unknown native accounting, or missing native receipt prevents
complete retention. `rawOutputIncluded` remains `false`.

A sealed journal records normal audit closure; it does not mean the review finished
or approved the repository. Completed advisory stages still keep
`claimsVerified: false` and `hostIsolationVerified: false`.

## Evidence limits

The hash chain checks internal prefix consistency. It is not externally anchored,
so a wholly manufactured journal or removed suffix cannot be authenticated. The
file checks are ordinary ownership/change guards, not an atomic filesystem
snapshot or a security boundary against the operator. Process-kill controls do
not simulate physical power loss or prove storage hardware guarantees.

The transcript records admitted workflow commands and engine results. It does not
prove transport delivery, actual model execution, subscription authentication,
model identity, fresh host memory, host call/token/billing limits, or complete raw
native output. Version 2 retains returned structured native receipts even without adjudication;
it does not capture arbitrary stdout/stderr or reconstruct evidence that a killed
process never returned. Version 1 native journals do not establish complete
structured receipt retention. Audit I/O
and caller transport delivery are outside a hard wall-time guarantee.

Sealed benchmark cohorts, frozen execution protocols, complete model and native
attempt artifacts, independently observed host isolation, independent judgments,
calibration and paired clustered quality scoring remain required. Gate A remains
open; this slice starts no real-project field evaluation or quality comparison.
