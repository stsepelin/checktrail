# ADR: Retain interrupted inner native attempts

**Status:** Codec and private storage implemented; streamed engine integration pending
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

The engine does not create or consume these journals yet. Wrapper streaming,
complete native call migration, required Windows/Linux acceptance, durable replay
and host-model usage remain open. The frozen attempt-archives profile remains
pending. No Gate A closure, model inference or real-project field evaluation is
claimed.
