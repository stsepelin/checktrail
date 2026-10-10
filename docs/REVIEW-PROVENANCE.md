# Review confidence and evidence provenance

`review-provenance --root ROOT --input RELATIVE_JSON` and the read-only MCP tool
`review_provenance` inspect one bounded packet through the shared engine.
`inspectReviewProvenance(root, serializedJSON, options)` accepts serialized JSON
only, capped at 1 MiB; it does not evaluate object getters, coercion hooks,
project code, AI models or remote services. Inspection cancellation and the
operator wall deadline are checked before parsing, after parsing, after current
source verification and after derivation. The default wall budget is 30 seconds;
the library accepts 1–120,000 ms and an AbortSignal. CLI `--timeout-ms` and the
MCP server's startup timeout supply that budget. The MCP request's cancellation
signal is passed to inspection. File reads and synchronous parsing finish before
the next checkpoint; this is a checkpoint deadline, not preemption of those steps.

## Packet and derived evidence

The strict version-1 input joins a captured revision-addressed review context,
version-2 assessment, up to 32 unique host candidates, up to 32 optional imported
native probe receipts and optional descriptive scoring. Each assessed observation
must match one candidate's ID, claim, severity, citations, attribution and fix
scope exactly. The report retains candidate digests; changing a probability also
changes that digest. Current physical source and every citation are rechecked
using the existing review intake. Context/assessment version mismatches, foreign
claims, unsupported receipt versions and incoherent bindings are rejected.

Each candidate retains one evidence tier:

| Tier                        | Meaning                                                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native-receipt-reconciled` | Current source addresses match, and a completed current raw-output-bound native receipt matches the exact context, candidate, source and captured function range. |
| `source-bound-host-claim`   | Current captured addresses match, without a completed current reconciled native receipt. Partial receipt status remains visible.                                  |
| `unmatched-source`          | At least one citation does not match its captured source address.                                                                                                 |
| `stale-source`              | The current source no longer matches the captured context.                                                                                                        |

Native imports are **unattested**. Structural, raw-output and budget accounting
can reconcile without proving that an imported receipt was honestly produced.
Even a native mismatch does not establish production reachability, intended
policy, severity, attribution or an implementable in-scope remedy. Claim truth,
confidence verification, calibration and host-session independence remain false;
the quality gate remains `not-assessed`. The inspection itself records
`nativeExecution: false`. Native probes used to construct receipts require the
existing independent operator-level execution trust.

A host probability is preserved as an unverified declaration for the event
`supported-in-scope-actionable`; zero is a known probability, while null or an
omitted confidence declaration remains unknown. Labels and judgments supplied
for scoring are operator declarations, not independent authority. An empty
observation set records `labelProvenance: not-supplied`.

## Scoring and completeness

Optional scoring extends [descriptive scoring](REVIEW-SCORING.md) with one exact
trial/source binding for every selected trial. Each candidate binds to one trial
with the same family and a current cited file/digest. A finding's probability
must equal its bound host declaration; a trial without a candidate cannot become
a finding. Stale source cannot retain current scoring observations, including
current abstentions. Fully stale observations may retain descriptive stale state.
Missing observations remain unreviewed, and unsupported, abstained, incomplete,
budget-exhausted, stale and cancelled decisions remain separate. Candidate tier
counts, known/unknown probabilities and trial decisions each sum to their own
selected totals. Existing proper losses, denominators and undefined states are
preserved without certifying calibration or quality.

`completed` means this inspection reconciled its selected input. It does not mean
that every scoring trial was reviewed, an empty candidate set was approved, a
host claim was verified or the project passed validation. Unmatched addresses,
unreviewed selected files or partial native receipts make inspection incomplete;
stale source produces stale inspection. CLI exit 0 means completed inspection;
exit 2 means incomplete, stale or an error. No deterministic validation outcome is
changed.

## Shared surfaces and source privacy

All surfaces return a strict summary by default. It omits source, citation quotes,
free claim text, reviewer identity, candidate IDs and raw native streams. CLI
`--detailed` alone does not disclose them; `--detailed --allow-review-source`
requires the explicit operator grant. For MCP, the startup grant selects the full
output schema. Tool arguments cannot elevate source disclosure or execution
trust. Root escapes and MCP errors remain sanitized.

`projectReviewProvenance(report, allowSource)` checks strict report shape and
rederives retained evidence, counts and scoring before returning a projection.
It validates the recorded inspection; it does not perform a new filesystem
check or authenticate an imported report. Reinspect the packet against the root
for current freshness. Do not treat a stored projection as a fresh or signed
attestation.

The public schemas are `review-provenance-input`, `review-provenance-report` and
`review-provenance-summary`. Synthetic acceptance exercises broken and fixed
native behavior, valid near misses, multiple claims, stale and forged bindings,
empty/unknown observations, library/CLI/MCP projections and reached native
cancellation, timeout, output exhaustion and descendant/workspace cleanup.
Fresh offline production installation repeats the same frozen callbacks. POSIX
native lifecycle acceptance is distinct from the still-open wider platform
matrix and independent evaluation. This feature invokes no inference or field
review evaluation; Gate A remains open.
