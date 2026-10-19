# ADR: Retain interrupted inner native attempts

**Status:** Codec, private storage, streaming, selected engine-wrapper collection and bounded detailed Tasks retention implemented; complete native call-family acceptance pending
**Date:** 2026-10-11
**Deciders:** Implementation owner, within the authorized Gate A scope

## Context

The shared engine now retains physical output from outer version, scope and body
commands. Inner compiler/framework calls still use several independent invocation
helpers. Some retain decoded output or hashes; synchronous calls cannot publish
partial output while their wrapper is blocked. A killed wrapper can therefore
lose its reached inner process evidence before returning its normal JSON result.
The frozen attempt-archives profile requires failed, interrupted and missing
attempts to remain explicit. Execution still requires operator-level trust.

## Decision

Add an engine-owned bounded ephemeral journal for instrumented wrapper calls.
Create and validate its private directory and all files before spawning the
wrapper. Use the existing caller-only Windows access checks and POSIX ownership,
mode, non-link and size checks. Journal configuration is an internal capture
setting and cannot grant execution authority. Discovery and planning create no
journal and execute no project code.

Instrument native calls through a shared asynchronous invocation helper. Record
admission separately from actual spawn acknowledgement. Preserve bounded physical
stdout/stderr chunks while the native child is alive, with ordered attempt IDs,
actual PID, command digest and explicit terminal state. Keep spawn failures,
interrupted prefixes and unstarted calls distinct. Transport exception prose and
operator environment values are not journal metadata.

The engine reads the journal after process-tree cleanup and before deleting owned
scratch files. Validate canonical chunk bytes, hashes, IDs, order, physical byte
counts, source/outer-command bindings and terminal accounting. A missing,
corrupted, overflowed or unfinished required journal cannot produce a passing
check. Existing native semantic parsers retain their own counters and source
checks; received output is not evidence that execution completed correctly.
Summaries and independent reviewer packets omit private journal bodies.

Journal data is observed from trusted execution, not independently authenticated
proof against deliberately malicious project code. Imported evidence retains its
existing unverified claims. External host AI sessions and billed usage remain
outside this native journal.

## Options considered

| Option                                                | Result                                                                                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Add final raw fields to each wrapper JSON response    | Preserves successful output, but loses interrupted calls before the response exists.                                                            |
| Add an extra inherited descriptor                     | Streams evidence, but requires separate integration with the Windows direct-executable/job keeper and careful handle inheritance.               |
| Private engine-owned journal plus streamed invocation | Retains interrupted prefixes on POSIX and Windows through one file protocol; needs explicit ownership, byte bounds, framing and cleanup checks. |

The private journal is selected because the repository already has native Windows
private-access checks and engine-owned scratch lifecycles. The shared invocation
helper must replace synchronous inner calls wherever interrupted physical capture
is required; final-response capture alone cannot close that obligation.

## Consequences

Native wrappers gain one bounded private storage channel and an asynchronous
invocation boundary. Output mirroring and native parser behavior must remain
unchanged. Journal admission occurs before execution and cleanup retains evidence
before deleting files. Individual tool migrations need actual failure, valid
near-miss, cancellation, deadline and overflow controls. Required matrix and
license/provenance acceptance remain separate obligations.

## Action items

1. Define strict journal frames and replay with independent tamper controls.
2. Implement private all-target admission and bounded append/read operations.
3. Add shared streamed invocation and interrupted-prefix retention controls.
4. Bind collection to the outer engine source/command identity and cleanup.
5. Enumerate and migrate the complete wrapper-call family, preserving native behavior.
6. Require original source and offline installed controls on the selected native runtime slots.

The strict codec and private storage have source and fresh offline installed
foundation controls on native macOS ARM64 Node 24 and 26. They cover actual binary
child output, success/failure exits, interrupted/unconfirmed accounting,
independent byte/identity/quota contradictions, hard links, partial/empty frames,
changed headers, prefix limits and replacement-safe cleanup. Package and code
bindings are recorded in the [foundation measurement](measurements/native-attempt-journal-foundation-2026-10-11.json).

The shared streamed invocation now writes admission, actual child PID and physical
binary chunks before returning. Successful and failed exits, missing executables,
preaborted calls, journal and caller output limits, cancellation, deadlines,
observer failures and a killed wrapper have original synthetic controls. The
ordinary POSIX process-group control is separate from Windows Job Object cleanup.
The JVM invoker accepts one explicit journal shared by quiet and observed calls;
JVM and Rust workspace invocations use the shared streamed process boundary and
retain their existing native parsers, output limits and mirroring backpressure.
Asynchronous mirror errors retain the delivered prefix and make the invocation
incomplete. Pending mirror writes remain bounded by the invocation deadline,
including when the native child exits before the mirror callback. Caller-owned
stream listeners remain installed.
Physical journal completion does not validate decoded semantics: bytes rejected
by strict UTF-8 decoding remain recorded as actual observed bytes.
Source and fresh offline installed controls on native macOS ARM64 Node 24/26 and
Linux ARM64 Node 22, with independent guard removals, are recorded in the
[streaming invocation measurement](measurements/native-streaming-invocation-2026-10-11.json).
These Node process controls do not qualify every native language/tool migration.

The selected TypeScript wrapper family now routes 33 formerly synchronous calls
in 29 files through the shared async boundary, with three downstream .NET
collectors awaiting their results. Ruby prerequisite checks await their boolean
result; Swift version probes stay sequential and stop at the first mismatch.
The adapter preserves Buffer or UTF-8 replacement parser input while retaining
raw byte capture separately. Output limits apply to the combined streams, and
calls without a shorter explicit timeout receive a 110-second native deadline.
An incomplete capture gives parsers a null status while retaining the physical
exit code separately. No frozen language assertion or tool pin is weakened.
These wiring controls do not establish every language native acceptance.
The [wrapper streaming measurement](measurements/native-wrapper-streaming-2026-10-11.json)
records scoped source/installed receipts and paired guard removals.

The engine now prepares and collects journals after operator trust for an exact
catalog of shipped Node wrapper entrypoints. Source discovery and planning still
create no journal and execute no project code. The external-adapter version path
and F# formatter version path only validate metadata, so their exact identity
commands retain outer capture without claiming a native call. Other execution
paths cannot pass with an empty, invalid or interrupted journal. Existing failed,
unavailable and error outcomes are preserved.

An internal environment channel opens one held writer per wrapper process. The
exact reserved name and its case aliases are rejected as operator environment
permissions and stripped from native-child environments; prefix/suffix near misses
remain distinct. A malformed or foreign context stays failed across later calls,
and a conflicting explicit writer cannot silently replace the engine writer.
The channel supplies evidence capture, never execution authority.

Collection revalidates held file and directory identities and reads physical
header/frame buffers once. Their lengths, canonical base64 and SHA-256 accompany
the report even when the header changed or a final frame is partial or malformed.
Only a complete newline-terminated prefix is replayed. Runtime report validation
recomputes replay and binds every body/tool journal to its recorded outer command
and the report source fingerprint. Public JSON Schema describes the structure;
physical hash/replay reconciliation requires the runtime validator. A changed
producer entrypoint or failed cleanup prevents parser pass while preserving
successfully collected data. Entrypoint hashes do not establish the entire
producer dependency or tool/license closure.

These controls include original two-file native adapter success/failure,
actual child PID witnesses, raw binary output, cancellation after a reached output
frame, repeated initialization failure, exact catalog near misses, false replay
claims and an exit-zero wrapper that reaches no native call. The CLI and stateless
MCP use the shared engine; detailed reports retain native journals and summaries
omit them. Cleanup-error injection is a synthetic policy control, separate from
physical producer-change observations.

The [selected engine journal measurement](measurements/native-engine-journals-2026-10-11.json)
records source and fresh offline installed native macOS ARM64 Node 24/26 and
Linux ARM64 Node 22 receipts, alongside unchanged-callback paired guard removals.
These scoped controls preserve the earlier journal/streaming controls; they do
not qualify every language toolchain or Windows engine execution.

Detailed Tasks now retain oversized reports, including captured native journals,
through bounded hashed report chunks. The original inline result limit,
startup-only disclosure, source binding, cancellation and terminal rules remain
in force; failed archive retention is not successful completion. See
[TASK-STORAGE.md](TASK-STORAGE.md) and the
[durable archive measurement](measurements/durable-task-report-archives-2026-10-11.json).

Complete native call migration acceptance, embedded language/VM subprocesses,
required Windows/runtime acceptance and host-model usage remain open. The frozen
attempt-archives profile remains pending.
No Gate A closure, model inference or real-project field evaluation is claimed.
