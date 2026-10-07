# Declared per-family reviewer calibration

`fitReviewCalibration`, `review-calibration-fit` and `review_calibration_fit`
share the same bounded numerical engine. `applyReviewCalibration`,
`review-calibration-apply` and `review_calibration_apply` apply that fit to its
reserved evaluation protocol. These operations read numerical artifacts only;
they execute no project code or model. All outputs keep `qualityGate` at
`not-assessed` and `calibratedConfidence` false.

## Declared training and reservation

The strict `review-calibration-input.schema.json` requires a declared model/client
identity, a `development` scoring input and a `held-out` evaluation protocol.
The existing [scoring contracts](REVIEW-SCORING.md) bound each protocol to 512
selected trials and reject duplicate or foreign observations. Training and
reserved trial IDs and cluster IDs must be exactly disjoint. A suffix or prefix
does not make two different identifiers equal. Inputs are canonically ordered and
hashed, including the model declaration and reserved protocol.

Only completed findings with a known claim judgment and a numerical probability
train a curve. The outcome is one for a supported claim and zero for every known
error, including a wrong mechanism, address, remedy or scope. Missing, incomplete,
abstaining, unresolved-judgment and unknown-probability slots remain separately
counted; the accounting categories sum to all selected training slots. Missing
case labels do not turn a separately known claim judgment into an unknown one.

Those checks establish disjoint declared identifiers. They do not authenticate
the model, independent sessions, incident boundaries, label truth, or a protocol
freeze before answers were collected. `splitIsolationVerified`,
`modelIdentityVerified`, `protocolFreezeVerified`, `labelsVerified`,
`claimsVerified` and `independenceVerified` remain false.

## Fitting and unavailable curves

Each declared defect family gets its own nondecreasing isotonic curve. Exact
probability ties are pooled with their original row counts. Weighted adjacent
violations are merged repeatedly, then the fitted block fraction is assigned to
each score in the block. The hand-computed control with scores `0.1, 0.2, 0.2,
0.8` and outcomes `1, 0, 0, 1` fits `1/3, 1/3, 1/3, 1`; averaging tied groups
without their weights would give the wrong result.

This is an original implementation of weighted pool-adjacent-violators fitting,
the monotone least-squares method described in [SciPy's isotonic regression
documentation](https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.isotonic_regression.html).
It adds no SciPy or scikit-learn dependency. A family with fewer than two eligible
rows, only one outcome class, or a constant predictor has no usable curve and a
distinct unavailable state. A usable curve does not demonstrate adequate sample
size, independent outcomes or generalization. The aggregate state can be partial.

The report includes raw and fitted training metrics. These are descriptive
in-sample quantities. Isotonic fitting can overfit small training sets, and a
lower Brier loss alone does not establish better calibration; see
[scikit-learn's calibration guidance](https://scikit-learn.org/stable/modules/calibration.html).

## Applying a fit

`review-calibration-application-input.schema.json` contains the detailed fit, the
same model declaration and evaluation observations under exactly the reserved
protocol. The engine recomputes the retained fit before use and rejects changed
knots, counts, metrics or digests. Application output and its projections are also
recomputed before they are accepted.

Between observed training scores, predictions use linear interpolation. Exact
endpoints are included. Scores outside that family's observed range stay unknown;
there is no clamping or extrapolation. An unseen family never borrows another
family's fit. Unknown probabilities, abstentions and unavailable curves have
separate mapping states. Missing evaluation slots remain in scoring denominators.
Mapping an unknown probability never removes the finding, its label or its
judgment. Raw and mapped proper scores therefore can have different eligible
subsets; compare their counts before comparing losses. A contradicted certainty
prediction retains an infinite-log-loss count and null mean.

Summary outputs omit numerical inputs, model/trial/cluster identifiers, fitted
knots and per-row mappings. Detailed output retains them. MCP accepts only a
bounded root-contained input path and cannot grant execution or inference trust.
Use a separate operator analysis root for numerical artifacts; fresh review
workers must not receive training labels, prior verdicts or evaluation answers.
These tools do not establish that host-side separation occurred.

```sh
node dist/src/cli.js review-calibration-fit --root ANALYSIS --input fit-input.json --detailed
node dist/src/cli.js review-calibration-apply --root ANALYSIS --input application-input.json
```

## Acceptance and remaining work

The required `review-calibration` profile contains original analytic and boundary
controls, complete accounting, exact split/model binding, unavailable families,
forged artifacts, summary privacy and library/CLI/MCP agreement. Its fresh offline
production-install harness stays outside the installed product. Compiling private
mutations test weighted merging, cluster disjointness and support boundaries
against unchanged original test callbacks, then restore source and build.

This slice accepts separately supplied numerical observations. [Candidate probability declarations](REVIEW-CLAIM-PROBABILITY.md) now bind
uncalibrated numerical predictions to sealed single-claim artifacts. Authoritative
judgments, verified confidence provenance, general multi-claim scoring,
observed host isolation, frozen cohort eligibility and held-out quality acceptance
remain required. No field evaluation or model inference is opened by a fit or by
a passing development test. Gate A remains open.

The [dated implementation acceptance](measurements/review-calibration-2026-10-06.json)
records exact source and fresh offline installation profiles, original guard
mutations, file identities, full-check accounting and actual application-client
discovery without inference. The profiles certify their recorded code revision;
hosted results and reviewer quality remain unverified.
