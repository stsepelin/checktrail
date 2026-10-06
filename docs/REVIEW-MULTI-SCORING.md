# Descriptive multi-claim scoring

The shared library, `review-multi-score --input RELATIVE_JSON` CLI command and
read-only `review_multi_score` MCP tool implement `declared-multi-claim-paired-v1`.
They execute no project code or model. This numerical profile uses operator-supplied
case labels and defect mappings; it does not authenticate findings, labels,
independence, calibration or a quality gate. The sealed benchmark's existing
single-claim profile remains unchanged. Binding multiple sealed claims to a common
independently adjudicated defect inventory remains required separately.

## Inputs and identity

Declare the same case/repetition slots for both arms, with explicit incident
clusters, purpose, seed, resampling count and confidence level. Common labels
identify defect, valid, near-miss or unresolved cases. Each known defective case
has distinct expected defect IDs, a family and a declared material/non-material
classification. Valid, near-miss and unresolved labels cannot carry expected
positive defects. Missing labels remain missing and cannot confer support.

Every review has a terminal state and an array of all retained claims. Each claim
has a distinct ID within its case, one disposition, optional probability and an
exact common defect mapping for support. Supported mappings must match a known
case's expected ID and family. Other dispositions cannot claim a supported mapping.
The engine rejects duplicate/foreign case IDs, duplicate expected IDs or claim IDs,
contradictory labels, out-of-family mappings and invented unreviewed prefixes.
Expected IDs are scoped per case, so independent repetitions do not deduplicate
away each other's outcomes. Operator labels/mappings belong to this separate
scoring view; they must not be supplied to anonymous reviewer workers as answers.

The schema bounds slots, per-case defects and claims; admission additionally bounds
each arm to 4,096 retained claims and the common inventory to 4,096 defects. An
excessive input fails before computing any score. The limits are inclusive. CLI/MCP
input files also retain the shared regular-file/root and byte limits.

## Metrics and missing evidence

Completed claims are all retained in the precision denominator, including wrong,
unresolved and duplicate reports. `supportedClaimPrecision` counts each supported
claim. `uniqueDefectPrecision` counts distinct supported expected defects per case
against all completed claims, so repeated reports cannot improve it.
`duplicateSupportedClaims` exposes their difference. Neither chooses a first,
best or highest-probability finding to discard the rest.

`materialDefectRecall` counts distinct supported material defects against every
known material expected defect, including those in missing or unfinished reviews.
Non-material expected defects can contribute precision without inflating material
recall. Missing/unresolved labels cannot add a known defect denominator; their
explicit counts must accompany that conditional metric. They cannot confer support
or resolved probability scores. Known material defects missed by either arm stay
in that arm's denominator.

Completed coverage uses every planned slot. Valid and near-miss false-alarm rates
count any completed claim, including unresolved ones, once per case against the
corresponding completed controls. A missing review does not become a successful
valid control. Interrupted retained prefixes remain separately counted and
unscored. Every completed disposition is accounted for as support, a resolved
error or unresolved; incomplete claims are never promoted by a favorable judgment.

Claim probabilities come from the supplied claims, remain uncalibrated, and keep
exact zero/one/unknown values. Brier and log losses use only resolved completed
claims with known labels and probabilities. A wrong probability endpoint records
an infinite log-loss count and a null mean log loss; no epsilon hides it. Unknown
or unresolved claims remain unscored. Per-arm proper scores do not become a paired
comparison between different submitted claims.

## Paired uncertainty and projections

Incident clusters are sampled whole with both arms and all their case/claim counts
together. The calculation uses ratios of pooled counts, preserving unequal cluster
sizes and duplicate-report denominators. Insufficient clusters, undefined points,
undefined resamples and degenerate draws return explicit states with null intervals.
They are not replaced by zero-width confidence claims. Independent representative
clusters and authoritative labels remain unverified assumptions.

Canonical retained inputs bind protocol, labels and observations separately. A
projection recomputes every metric and rejects forged derived values. Summary mode
withholds case, defect and claim IDs and retained inputs; detailed mode is an
operator view. Original required controls use hand-computed counts and probability
losses, common-defect duplicates, unequal incident clusters, missing/unfinished
reviews, unknown labels, identity/family/budget boundaries, forgery and real CLI/MCP
calls. The package helper repeats these same assertions outside a fresh offline
production installation. These are synthetic readiness controls, not field results.
