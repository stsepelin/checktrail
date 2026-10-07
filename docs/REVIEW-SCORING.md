# Descriptive reviewer confidence scoring

`scoreReviewTrials`, `review-score` and `review_score` compute the same bounded
`declared-claim-probability-v1` report. They execute no project code or model and
make no claim that operator-supplied labels, probabilities or independence were
verified. `qualityGate` stays `not-assessed`, `calibratedConfidence` stays false
and deterministic outcomes are unchanged. This is measurement tooling, not a
confidence assignment or permission to open a held-out field evaluation.

## Protocol and labels

`review-scoring-input.schema.json` contains a declared protocol and observations.
The protocol identifies at most 512 trials, project/incident clusters and families,
with strictly ascending probability thresholds. Empty or duplicate assignments,
foreign or duplicate observations and contradictory decisions are rejected.
Reports hash the canonical protocol and observations. An external harness must
freeze the protocol before collecting answers; this scorer does not prove that
freeze or independent adjudication happened.

Each observation records a terminal review status, finding or abstention, optional
claim probability, case label and adjudicated finding outcome. The probability
means the chance that **this submitted claim is supported, in scope and actionable**;
it is not the probability that its entire snapshot contains a defect. A supported
claim requires a defect label. Wrong mechanisms, wrong addresses, unreachable
fixes, out-of-scope claims and refutations are errors even when a material defect
exists nearby. Unknown case labels and unknown claim judgements remain distinct.

Only completed reviews can submit findings; incomplete, unsupported, exhausted,
stale, cancelled and unreviewed states retain abstention with no scored probability.
Missing observations become explicit unreviewed/unresolved rows. A completed
abstention is not evidence that a snapshot is clean. Summaries hide trial and
cluster identifiers; detailed output includes the original numerical input.

## Denominators and probability scores

All selected trials appear in status and label totals, family slices and completion
coverage. Conservative precision divides supported claims by **all** emitted
findings, including unresolved judgements. Recall divides supported findings by
known selected material-defect cases, including unreviewed cases with known labels.
Unresolved case labels remain separately counted; this is not full-cohort recall
when labels are missing. False-alarm rates use completed known-valid cases and
completed known-near-miss cases separately. Unreviewed valid cases cannot dilute
a false-alarm rate. Every zero denominator is null, not a perfect result.

Brier loss is mean `(p - y)^2`; negative logarithmic loss is mean `-log(p)` for
supported claims and `-log(1 - p)` for known errors. Lower is better. These are
binary proper scoring rules; see [Gneiting and Raftery](https://sites.stat.washington.edu/people/raftery/Research/PDF/Gneiting2007jasa.pdf).
Missing probabilities and unresolved finding judgements are unscored and counted,
not silently converted to failures or zeros. A certainty prediction contradicted
by its outcome has infinite logarithmic loss: the report records the infinite
count and null mean rather than clipping the probability or serializing infinity.

Ten fixed-width reliability bins retain scored/unscored counts, mean scored
probability and supported fraction. Risk/coverage at each declared threshold uses
all selected trials as its coverage denominator; unresolved accepted findings count
against conservative precision. Findings without a probability remain separately
counted. Neither descriptive agreement nor a good Brier score establishes held-out
calibration.

## Confidence limits and limits of inference

One-sided 95% limits invert the exact binomial tail, following the
[NIST exact-binomial method](https://www.itl.nist.gov/div898/software/dataplot/refman2/auxillar/exacbino.htm).
The implementation uses bounded floating-point bisection rather than a normal
approximation. Each limit explicitly assumes independent Bernoulli trials; that
assumption remains unverified. Repeated cluster IDs make these limits ineligible
and null. A separate descriptive paired-cluster profile is implemented below; it still needs
the benchmark harness to establish authoritative pairing, labels and provenance.
Supplying different cluster strings is not proof of independence.

Analytic controls check the one-trial and two-trial endpoints and sample-size
boundaries: even a perfect small sample does not reach the specified lower precision
bound or upper false-alarm bound. This is a calculation under the stated assumptions,
not evidence that the actual reviewer reached a quality target. Thresholds, model
versions, budgets, independent labels, pairing and held-out eligibility remain
separate requirements.

## Use and development evidence

```sh
node dist/src/cli.js review-score --root PROJECT --input .checktrail/scoring.json
```

`review_score` accepts only that numerical artifact path. It cannot grant execution,
inference, calibrated confidence or a passed quality gate. `review-scoring.test.ts`
uses authored synthetic labels to check independent status/label totals, hand-computed
losses, risk and reliability, missing/unknown cases, infinite losses, exact interval
controls, cluster limitations, altered retained metrics, summary privacy and
library/CLI/MCP agreement. These are development controls only. Authoritative labels, evidence tiers, verified confidence provenance and held-out
quality demonstration remain required work.

Required scoring profiles pass on macOS arm64 Node 26.9.0 and Linux arm64
Node 22.23.2, including fresh offline production installation. Removing missing-trial
accounting, cluster eligibility or unknown-judgement exclusion fails the intended
regression; the restored required profile passes. Installed Codex 0.159.0 and Claude
Code 2.1.284 clients discover the updated tool inventory without inference.

## Descriptive paired-cluster comparison

`scorePairedReviewTrials`, `review-paired-score` and `review_paired_score` use the
same `declared-paired-cluster-v1` engine. Its strict numerical input separately
contains a declared protocol, common labels and anonymous arm A/B observations.
The protocol fixes trial/cluster/family identities, a hexadecimal seed, 128–4,096
resamples and a confidence level between 0.80 and 0.99. The scorer validates
identities and hashes canonical ordered inputs; it does not prove that the
protocol was frozen before answers arrived or that the arms used independent
sessions. Missing observations remain unreviewed on their selected cases, with
known labels preserved in recall denominators. Missing labels remain unresolved.
Contradictory supported claims and labels are rejected.

Five differences are reported as B minus A: conservative precision, known-label
material-defect recall, completed coverage, false-alarm rate and near-miss
false-alarm rate. Higher is better for the first three; lower is better for the
last two. The existing single-arm summaries retain proper probability losses,
unknown findings and all terminal statuses. Loss differences are not computed:
two reviewers can submit different claims, and their claim probabilities need
not predict the same event.

The estimator uses ratios of pooled trial counts. It resamples whole clusters
with replacement, draws as many clusters as selected, and uses the same drawn
clusters for both arms. Every member of an unequal-sized cluster travels together;
this is not an equally weighted average of cluster metrics. Family slices apply
the same procedure to their selected family members. This follows the cluster
resampling unit described by [Stata's panel-bootstrap documentation](https://www.stata.com/support/faqs/statistics/bootstrap-with-panel-data/)
and the shared paired indices described by [SciPy's bootstrap documentation](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.bootstrap.html).
The implementation is original and does not invoke either tool.

A versioned SHA-256 counter stream with bounded rejection generates reproducible
sampling indices without modulo bias. An available interval uses the two empirical
percentiles, interpolated between adjacent sorted differences. Fewer than two
clusters, an undefined point, any undefined resample, or a degenerate distribution
returns a null interval and a named state. Undefined draws are counted, not dropped
to manufacture an interval. These are descriptive percentile calculations under
unverified sampling assumptions; nominal confidence is not demonstrated coverage,
and small cluster counts remain weak evidence. No simultaneous family-wise or
multiple-metric quality claim is made.

Summary output omits trial/cluster identifiers, labels and raw observations.
Detailed output includes the numerical input. Projection recomputes every retained
metric and rejects altered derived values. Both outputs keep `qualityGate` at
`not-assessed`, and keep claims, pairing, independence and calibration unverified,
even if the input says `held-out`. This tool performs no project execution or
inference and cannot open a field trial.

```sh
node dist/src/cli.js review-paired-score --root PROJECT --input .checktrail/paired.json
```

The mandatory `review-paired-scoring` controls use original synthetic cases with
hand-computed denominators, unequal clusters, identical-arm pairing, missing and
unknown slots, undefined/degenerate intervals, boundary inputs, forged summaries
and library/CLI/MCP agreement. `verify-review-paired-package.mjs` repeats those
same assertions with the harness outside a fresh offline production installation.
These are implementation checks, not a reviewer quality result.

The [dated paired-scoring acceptance](measurements/review-paired-scoring-2026-10-06.json)
records exact source/runtime and fresh-install evidence, original unchanged-callback
guard mutations and scope limits. Hosted CI for the new profile remains unverified.

The [sealed synthetic benchmark profile](REVIEW-BENCHMARK.md#scoring-sealed-synthetic-artifacts)
now derives paired numerical inputs from frozen case families, common declared
labels and reconciled review/judgment artifacts. This closes a bounded structural
connection; it does not verify case labels, claims, independent sessions or cohort
eligibility. [Candidate probability declarations](REVIEW-CLAIM-PROBABILITY.md) now
connect original uncalibrated predictions to sealed single-claim scoring. Missing
declarations stay unknown. General multi-claim scoring, authoritative judgments
and held-out calibration remain required.

[Declared per-family calibration](REVIEW-CALIBRATION.md) now implements a bounded
development fit and reserved-protocol application using separate family curves,
tie-weighted isotonic regression, exact declared split/model binding and unknown
predictions outside observed training support. Fitting does not verify label
truth, host separation, candidate confidence or held-out calibration.
