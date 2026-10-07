# Declared claim probabilities and independent evidence views

A candidate can carry `confidence` under the strict
`declared-claim-support-probability-v1` contract. The event is
`supported-in-scope-actionable`: the probability predicts that particular claim's
support, scope and actionability, not whether the whole source snapshot contains
a defect. `probability` is a number from zero through one, or null when unknown.
`calibratedConfidence` must be false. Severity remains a separate advisory label.

Legacy candidates without this field and candidates with null confidence remain
valid and unscored. Zero is a known prediction, not a missing value; one is not
clipped away from certainty. Invalid bounds, non-finite values, strings, foreign
events/profiles, extra fields and claims of calibrated confidence are rejected.
The declaration does not authenticate the model or prove calibration.

## Shared transport and sealed scoring

The provider-neutral workflow schema carries this declaration with the submitted
candidate through source-bound response and journal contracts. Optional direct
API transports use the same parser. Their strict wire objects require every
property and make confidence nullable; local parsing retains legacy compatibility.
This follows the nullable-required pattern in [OpenAI's structured-output
contract](https://developers.openai.com/api/docs/guides/structured-outputs).
Original injected-transport controls check both supported wire formats without
external model calls. Actual API model acceptance and confidence quality are not
established by these controls.

The [sealed single-claim benchmark scorer](REVIEW-BENCHMARK.md#scoring-sealed-synthetic-artifacts)
reads a completed claim's probability only from its original sealed reviewer
candidate. Frozen arm host/model declarations, source context, accepted response,
collection and judgment artifacts retain their existing binding checks. A judge,
refuter, severity label or calibration artifact cannot override that prediction.
The existing single-claim limit still rejects multiple completed claims with no
partial score. Incomplete retained prefixes remain unscored, with their selected
slots preserved.

`declaredClaimProbabilities` and `unknownClaimProbabilities` partition completed
claim slots, not every retained claim in an incomplete prefix. `probabilitiesAvailable`
means at least one such slot has a known numerical declaration; it does not imply
that its judgment is known or that every emitted claim is scored. Unresolved or
rejected judgments stay in conservative finding denominators and are unscored in
proper losses. A contradicted zero or one produces infinite logarithmic loss
accounting, rather than being discarded or clipped. The shared scorer retains raw
Brier/log losses and unknown counts. No loss difference is inferred between claims
that predict different events.

## Independent stage projections

One hypothesis whitelist is shared by refutation, adjudication and anonymous
benchmark judge packets. It retains family, claim, trigger, consequence, evidence
gaps and exact citations. Original candidate IDs, severity, confidence, attribution
and fix-scope declarations are withheld from those independent views. The benchmark
projects every accepted output, every occurrence-bound claim and every reached
native target, including siblings. Claim IDs bind the anonymous slot and full
original candidate, so identical hypotheses in two slots do not share an ID.

The operator-only judging artifact still retains original candidates and complete
native receipts. A judge receives source-bound per-case native observations:
inputs, operator expectations, actual values, scale, execution/guard coverage,
ranges and source/worker/runtime identities. The shared raw-observation projector
checks exact case IDs, roles, expectations and cardinality before pairing them.
Aggregate native verdicts, counts, recipe/case and run/candidate identifiers are
withheld. The surrounding trial status and null/unobserved case values remain
visible; raw observations never establish intended policy, complete mechanism,
caller reachability or a feasible remedy.

These are structural omissions, not a semantic blinding guarantee. Hypothesis,
source and operator prose can reveal conditions or assert confidence. The engine
does not scrub quoted source or authenticate fresh host sessions. Operators must
keep full artifacts and other assignments outside worker access. Claim truth,
model/session identity, consequence severity and calibrated confidence remain
unverified, even when every structural check passes.

## Development acceptance and remaining work

Original controls cover probability endpoints and unknown legacy declarations,
strict nullable wire schemas, every independent candidate view, raw native case
identity siblings, frozen case/arm bindings despite randomized trial order,
hand-computed proper losses, certainty errors, rejected numerical overrides,
changed retained artifacts, incomplete prefixes and library/CLI/MCP agreement.
The source and fresh offline production-install profile uses the same callbacks;
its harness stays outside the product.

The numerical declaration is now connected to sealed single-claim artifacts.
It remains uncalibrated and operator/host-declared. Authoritative labels and
judgments, general multi-claim scoring/deduplication, consequence-based severity,
observed host isolation, broader native probes, frozen evaluation provenance and
held-out calibration/quality acceptance remain required. Gate A remains open.
No field review or model inference is authorized by this contract.

The [dated implementation acceptance](measurements/review-claim-probability-2026-10-06.json)
records exact source/runtime and fresh-install profiles, unchanged original
callback mutation controls, selected file identities, full-check accounting and
actual client discovery/direct tools without inference. These profiles certify
the recorded code revision; hosted acceptance and reviewer quality remain
unverified.
