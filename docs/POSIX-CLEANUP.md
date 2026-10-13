# Observed POSIX descendant cleanup

The shared process runner pauses its owned macOS or Linux root before observing
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
still attempts to terminate its original process group and never promotes that
cleanup failure into a passing check.

Observations bind the PID, start identity and process group. A PID reused for a
different start identity is left alone. A missing snapshot row is checked against
the native PID before it is treated as absence. Unrelated sibling tasks are not
selected. Unknown macOS `?` status is retained as running/unknown; it never
proves quiescence. Linux start identity comes from `/proc/PID/stat`; macOS uses the fixed
`/bin/ps` PID, parent, group, status and start-time columns without command lines or
process environments.

This is bounded observation, with PID reuse and visibility limits. It does not
provide kernel ownership, track every fork, or contain malicious project code.
Descendants that escape after their parent disappears can be unobservable. The
Windows Job Object profile has its own separate contract and acceptance gate.

`posix-cleanup` requires every original callback in `process-tree.test.ts`, including
native detached-child cancellation, delayed child exit, unrelated siblings,
surviving/unreadable/changed-group identities and reused PIDs. Additional required
callbacks cover actual replacement-child prevention, late forks before stop
acknowledgement, unknown statuses, family quiescence and final reaping. Paired
controls preserve assertions while removing and restoring each addressed guard. `verify-posix-cleanup-package.mjs` repeats the
same required profile against a fresh locked offline production install. It
reports installed runtime acceptance separately from CLI/MCP acceptance.

No model execution, inference, field evaluation or review-quality claim follows
from these process-lifetime controls.
