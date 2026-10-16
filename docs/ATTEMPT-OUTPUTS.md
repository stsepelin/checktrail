# Bounded attempt output foundation

Shared validation now enables physical stdout/stderr capture for its reached
version, scope and body commands. The existing process result retains canonical
Base64, byte counts and SHA-256 digests alongside its UTF-8 presentation. Tool
identification can reuse one observed version command across checks; reuse is
not a new native execution. Ordinary direct `runProcess` calls keep their existing
opt-in capture contract. [Native raw evidence](NATIVE-RAW-EVIDENCE.md) describes
physical limits and the distinction between received output and completed work.

Optional engine-owned API transports add `responseArchive` only to their detailed
source-granted reports. Each reached attempt binds its ordered attempt ID, actual
request-body digest, observed HTTP status and delivered body-byte count. Full JSON
bodies are retained within the configured response limit after scanning raw bytes
and decoded JSON keys/values for the credential value and configured environment
name. The same bounded check covers structured model JSON when the engine decodes
that second layer, before output-schema validation. A detected credential or
inspection limit withholds the response body and prevents review output. Interrupted reads, overflow, undecodable/non-JSON data and credential echoes
withhold the body; they do not fabricate an empty successful response. A transport
failure before any delivered bytes retains an unobserved record. Requests denied
before transport retain no invented attempt.

An HTTP 200 body must complete credential inspection before model identity, usage
or review text is interpreted. A body exceeding either inspection-complexity
bound is malformed and cannot produce a review receipt or candidates. An imported
report carrying an archive also needs a complete final body before it can retain
a review receipt. Non-success
HTTP responses retain their HTTP status and bounded numeric usage observations
without retaining uninspectable bodies or interpreting their prose.

Complete retained bodies replay against the recorded HTTP classification, exact
model identity and reported input/output token observations. Retries bind one
request identity. Canonical bytes, hashes, ordered attempt identities and physical
counts must reconcile. These checks reject contradictory imports; they do not
prove that an imported artifact came from an actual provider. Operator price
estimates remain estimates and provider-reported usage remains unverified.

Summaries omit the entire raw archive. Prior-attempt budget metadata and blind
assignments keep their existing contracts; raw response bodies are not added to
those records. Capture grants no execution or inference permission. The MCP host
continues to own its AI subscription, authentication and sessions. Host model
usage remains unknown without independent evidence.

## Verification and remaining scope

`verify-attempt-outputs.mjs` requires every named foundation control, including
native Go version/scope/body execution and exact broken/fixed two-case accounting.
Absent Go is unmeasured, never an accepted required case. The package verifier
uses a fresh locked offline production installation and an external test harness,
checks exact terminal outcomes and compares all compiled production bytes before
and after execution. It does not install development dependencies in the consumer.
The [measurement](measurements/attempt-output-foundation-2026-10-11.json) records
observed runtimes, immutable code/harness/package identities and paired guard
removals using unchanged assertions on isolated copies.

A [native journal codec and private storage foundation](NATIVE-ATTEMPT-JOURNALS.md)
adds ordered admissions, actual process acknowledgements, bounded physical chunks
and strict replay. Source and offline installed controls are measured; the shared
engine does not collect these journals yet. Shared JVM and Rust workspace calls
now use the streamed invocation boundary; the JVM helper can receive one explicit
journal shared by its calls. The remaining synchronous wrappers are still pending.

The frozen `attempt-archives` profile remains pending. Complete individually
addressed artifacts for every inner compiler/framework/bootstrap attempt,
interrupted-attempt journals, durable replay, the remaining native matrix and
independently supplied host-cost evidence are still required. No model inference,
held-out scoring or real-project MCP field evaluation was performed.
