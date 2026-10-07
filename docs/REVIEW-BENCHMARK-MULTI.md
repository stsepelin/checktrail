# Sealed synthetic multi-claim scoring

`multiScoring` freezes the separate `sealed-multi-claim-paired-synthetic-v1`
profile before any review starts. It is mutually exclusive with `scoring`; the
legacy single-claim profile keeps its original contract. Both arms share the exact
case inventory, repetitions and incident clusters. Every broken case declares
one or more distinct expected defect IDs, family and material classification;
fixed and valid near-miss cases declare none. IDs must exactly match the frozen
case's expected-defect descriptions. Missing, duplicate, foreign and contradictory
inventories fail before any artifact is written.

The frozen profile also declares independent matching instructions and host
identity. Every planned trial has a separate random matching UUID and fixed private
response path. Reviews and independent judgments must be collected and sealed
before `review-benchmark-match` prepares curation assignments. Reviewer and judge
packets continue to withhold curator answers. Matching is explicitly curation: its
packet contains its anonymous source, blind claims and common defect descriptions.
It withholds prior judgments, probabilities, severity, arm identities and sibling
outputs. A matching packet is not another blinded review.

A matcher must account for every opaque claim ID exactly once as `defect`, `none`
or `unresolved`. Positive matches name an exact common defect ID in the claim's
family. Resolved mappings cite current source with matching path, digest, line range
and quote. Host, assignment and slot bindings are checked; curator, reviewer, judge
and sibling matcher session reuse invalidates affected responses, including declared
identities in malformed records. These checks do not prove that the AI host actually
reset its context or independently authenticated the declaration.

Operator commands use the same engine as the read-only worker surfaces:

```sh
checktrail review-benchmark-match --root SYNTHETIC_ROOT --benchmark REFERENCE
checktrail review-benchmark-matcher-setup --root SYNTHETIC_ROOT --benchmark REFERENCE --matcher UUID
checktrail review-benchmark-matcher-packet --root SYNTHETIC_ROOT --benchmark REFERENCE --matcher UUID --detailed --allow-review-source
checktrail review-benchmark-seal-mappings --root SYNTHETIC_ROOT --benchmark REFERENCE
checktrail review-benchmark-multi-score --root SYNTHETIC_ROOT --benchmark REFERENCE
```

`serve --benchmark REFERENCE --matcher UUID` pins exactly one matching worker.
Source disclosure requires the operator's startup grant. Its `review_benchmark`
tool accepts only `packet` and `status`; it cannot change the selected UUID, grant
source access, seal artifacts, score arms or invoke inference. The operator owns
host authentication and writes the bounded response to the predeclared private
path. These commands do not invoke a model or project code.

Sealing retains every fixed response slot, including absent, unavailable, malformed,
foreign, cancelled and unresolved responses. Files must be private, singly linked,
regular and bounded; the response limit is inclusive. Reopening reconciles the raw
bytes and recomputes disposition checks. Late responses, changed permissions,
forged seals, modified matching assignments or changed reached journals prevent
scoring. Frozen engine/runtime identity still applies.

`ReviewBenchmark.scoreMulti()` derives every claim from accepted sealed reviewer
submissions and its uncalibrated probability from that exact original candidate.
An accepted independent judgment must agree with the common frozen case label.
Positive credit additionally requires an accepted independent mapping to the exact
common ID and family. Unsupported or missing positive mappings leave the claim
unresolved. Known judgment errors remain errors; matching cannot override them.
All completed claims stay in precision denominators, including duplicates and
unresolved findings. Interrupted prefixes remain retained and unscored. Known
material defects in missing or unfinished trials stay in recall denominators.
The [descriptive multi-claim engine](REVIEW-MULTI-SCORING.md) supplies unique-defect
counts, false-alarm controls, proper losses and paired whole-cluster resampling.

Reports bind protocol, collection, judging, judgments, matching, mappings, frozen
parameters and arm digests. Summary mode withholds numerical row identities and
inputs; detailed mode is operator-only. `scoringReady` requires complete accepted
and consistent slots; CLI exits `2` when readiness is incomplete. Structural binding
is distinct from truth: labels, independent host isolation, external attempt
completeness, calibrated confidence and quality remain explicitly unverified.
The numerical report retains its declaration provenance. No field review or
held-out evaluation is authorized by these synthetic readiness checks.

Required native controls cover preflight atomicity, answer separation, duplicates,
material denominators, probabilities, mixed families, exact private-file/byte
boundaries, missing and interrupted trials, raw response accounting, reuse and
artifact tampering, plus real CLI/MCP worker calls. Compiling guard mutations preserve
the original callbacks and restore the shipped runtime. The installed-package
harness repeats the controls outside an offline production installation, with the
wire client declared separately from production dependencies.
