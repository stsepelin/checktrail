# Observed POSIX descendant cleanup

The shared process runner uses a fixed Node owner for each macOS or Linux command.
The owner has its own process group and a private IPC channel to the calling
process. Only that channel admits the original literal command. Project arguments
and environment grants do not configure the owner. The execution deadline also
bounds owner bootstrap. Loss of the calling process closes the channel, aborts
the active command and cleans the observed family. An owner stopped during
bootstrap cannot start project code after its parent has gone.

Fixed read-only host Git metadata stays on its original bounded direct collector,
with the existing five-second aggregate inspection budget and four-MiB output
budget. Admission enumerates only version, revision, tree, index and blob reads,
requires an executable outside the project, disables project hooks/filters and
[network protocols](https://git-scm.com/docs/git/2.47.0), and offers no MCP-selectable metadata bypass.

The owner retains its group through normal target exit, so ordinary orphaned
members and children retaining output pipes can still be selected. The native
macOS snapshot omits its own short-lived inspection process by its actual PID.
Missing, malformed or failed owner transport is explicit unavailable evidence;
received physical output is checked against byte counts, digests and decoded
presentation before returning it.

The owner pauses its target before observing
and stopping descendants. Cancellation, deadlines and output exhaustion use this
path. Every observed descendant is paused before a child is killed. Repeated
snapshots include children forked before their parent's stop acknowledgement;
only an observed stopped or exited state counts as quiescence. Deeper children
must physically exit before their waiting parents are killed. Stopped parents
cannot reap zombies, so direct children are signalled before root termination,
then disappearance of every observed identity is required under the same
two-second cleanup deadline. Signal delivery, physical exit and reaping remain
separate observations. A
surviving or unreadable observed identity, snapshot error or
changed process group produces `PROCESS_TREE_CLEANUP_UNAVAILABLE`; the runner
still attempts to terminate the observed owned family and never promotes that
cleanup failure into a passing check.

Observations bind the PID, start identity and process group. A PID reused for a
different start identity is left alone. A missing snapshot row is checked against
the native PID before it is treated as absence. After signalling, a native PID
existence check can confirm physical disappearance directly. An already absent
observed PID needs no further global snapshot; surviving, unreadable and reused
PIDs still require the original identity, group and state checks. This also avoids
a final global snapshot when no descendants were observed. The snapshot and
cleanup deadlines are unchanged. Unrelated sibling tasks are not selected. Unknown macOS `?` status is retained as running/unknown; it never
proves quiescence. Linux start identity comes from `/proc/PID/stat`; macOS uses the fixed
`/bin/ps` PID, parent, group, status and start-time columns without command lines or
process environments.

This is bounded observation, with PID reuse and visibility limits. It does not
provide kernel ownership, track every fork, or contain malicious project code.
Descendants that escape after their parent disappears can be unobservable. Abrupt loss does not promise a durable CLI report or recovery of every parent-created
ephemeral journal. Controlled cancellation/deadline/output paths retain their
normal report and owned scratch cleanup. The
Windows Job Object profile has its own separate contract and acceptance gate.

`posix-cleanup` requires every original callback in `process-tree.test.ts`, including
native detached-child cancellation, delayed child exit, unrelated siblings,
surviving/unreadable/changed-group identities and reused PIDs. Additional required
callbacks cover actual replacement-child prevention, late forks before stop
acknowledgement, unknown statuses, family quiescence and final reaping. Paired
controls preserve assertions while removing and restoring each addressed guard. `verify-posix-cleanup-package.mjs` repeats the
same preserved profile together with the `posix-owner` controls against a fresh
locked offline production install. Source and installed engine artifacts and the
unchanged external harness are reconciled before/after the required callbacks. It
reports installed runtime acceptance separately from CLI/MCP acceptance.

No model execution, inference, field evaluation or review-quality claim follows
from these process-lifetime controls.

Containers executing acceptance fixtures use a native child reaper (`docker run --init`) so orphaned
processes can be reaped. A runtime whose PID 1 leaves observed orphan zombies
cannot supply confirmed cleanup. Missing-executable fixtures allow owner startup
while still requiring an actual `ENOENT` result; a separate stopped-owner control
keeps pre-execution deadline expiry distinct from an attempted executable lookup.

Linux procfs can expose an already-dead task with parent zero, process group `-1`
and session `-1` while its signal-handler state is being released. The parser
admits that exact sentinel only for the native `X` or `Z` exited states and keeps
its start identity. An unrelated dying task therefore does not invalidate the
whole snapshot. Negative groups on live/stopped states and partial or malformed
identities still fail. This row grants no live-process ownership, and existing
owned-identity group checks and final physical-reaping requirements remain in
force. The kernel representation is defined by `do_task_stat` in
[the Linux procfs implementation](https://code.googlesource.com/linux/torvalds/linux/+/7acf90feab8b009fde7def08ff2c622d0f10e99f/fs/proc/array.c).
