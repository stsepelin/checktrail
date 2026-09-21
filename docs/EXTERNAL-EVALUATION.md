# External ESLint integration evaluation

This evaluation uses independently authored synthetic ESLint rule fixtures that
were not used to build Checktrail's adapter. The verifier runtime and lockfile
were hashed before the selected upstream case files were downloaded or inspected.
They remained unchanged during measurement. This supplies an external integration
holdout for that frozen verifier, not independent evidence about ESLint's own
rule algorithms or general code-review quality.

## Provenance and selection

The locally declared plan is `scripts/external-evaluation-plan.json`. It selected
all literal valid/invalid cases from `eqeqeq`, `no-dupe-args` and `no-unreachable`
at ESLint tag `v10.10.0`, resolved to commit
`3f20a57c6293371b6193d3fb6746c2b7b2ac2689`. The source-file sizes and SHA-256 values,
including the upstream MIT license, are pinned in
`scripts/external-evaluation-inputs.json`. The plan digest uses its parsed JSON
serialized with two-space indentation and a trailing newline, so formatting alone
does not change its identity. This is a local declaration, not an externally
witnessed preregistration or proof of an author's prior knowledge.

The source cases and labels come from ESLint's
[rule tests](https://github.com/eslint/eslint/tree/3f20a57c6293371b6193d3fb6746c2b7b2ac2689/tests/lib/rules)
and their documented [RuleTester contract](https://eslint.org/docs/latest/integrate/nodejs-api#ruletester).
Copyright belongs to the OpenJS Foundation and other contributors under the
[pinned MIT license](https://github.com/eslint/eslint/blob/3f20a57c6293371b6193d3fb6746c2b7b2ac2689/LICENSE).
Prepared copies stay in a local input directory, include that license and are not
bundled in the npm package. Reports retain IDs, hashes, labels, diagnostic metadata
and measurements; they contain no copied case source or raw diagnostic prose.
The new extraction, measurement and regression-test code is original.

The extractor parses JavaScript syntax with the prepared Espree 11.2.0. It does
not execute the upstream test modules, invoke their hooks or evaluate fixture
expressions. It preserves literal RuleTester constructor settings, case language
settings and rule options. One recognized array transformation supplies a default
`output: null` without changing source or diagnostic labels; no arbitrary map or
filter is evaluated. Unsupported cases retain an ID, upstream label and exclusion
reason. A dynamic list whose cardinality cannot be established stops measurement.
Excluded cases remain visible in each system's classification denominator.

The baseline and verifier see the same generated files and settings. The baseline
runs the prepared ESLint 10.10.0 CLI with fixes/cache disabled, explicit configuration
and both candidate files selected. The verifier uses `javascript.eslint` through
its shared engine. The configuration file itself has a separate active rule and
is included in file accounting. Copied dependency trees and source fingerprints
are checked for changes; inputs, runtime, lockfile and harness identities are
checked before and after measurement. Nothing is installed during measurement.

## What is checked

Upstream `valid` cases must produce no diagnostics. For an `invalid` case, detection
requires the intended rule ID, each declared message ID, the declared diagnostic
locations and the exact diagnostic count. An unrelated failure is `wrong-signal`,
not a successful detection. A passing invalid case is `missed`; a failing valid
case is `false-positive`. Incomplete results and excluded inputs are separate
columns and are not dropped. Every executable case requires one observation for
each system; missing, duplicate or malformed observations fail the harness.

This does not rerun every RuleTester assertion. Autofixes, suggestions, interpolated
message wording/data and locations not specified by the upstream case are not
assessed. It measures diagnostic preservation for the stated profile. Upstream
unit fixtures are deliberately selected and native ESLint already uses them as
regressions, so they cannot establish independent native-rule effectiveness.

## Recorded results

The [macOS/Node 26 snapshot](measurements/external-eslint-darwin-arm64-node26.json)
and [Linux/Node 22 snapshot](measurements/external-eslint-linux-arm64-node22.json)
have the same corpus, frozen runtime, harness identity and classification matrix.

| Rule             | Cases | Valid cases clean, each system | Invalid cases detected, each system |
| ---------------- | ----: | -----------------------------: | ----------------------------------: |
| `eqeqeq`         |    77 |                             31 |                                  46 |
| `no-dupe-args`   |    13 |                              5 |                                   8 |
| `no-unreachable` |    70 |                             32 |                                  38 |

Across this fixed cohort there are no false positives, misses, wrong-signal
failures, incomplete results or exclusions. Both systems agree; this is evidence
of integration equivalence on these cases, not an improvement over native ESLint.
No comparison with a previous human/model/private review workflow was performed.

Each case was measured once per system, alternating order between cases. Wall
time includes process startup and native execution; engine time excludes the outer
worker startup. Fixture/dependency preparation and cleanup are outside the timed
operation. Raw observations are retained. These purposive, related unit fixtures
are not a random population sample, so population confidence intervals, production
false-positive estimates and representative cost/overhead claims are not justified.
No model was called; model tokens and provider cost are zero. Human and machine
costs are not measured.

Linux measurement used Node 22.23.2 in
`node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32`,
with networking disabled and prepared inputs/repository mounted read-only.
Temporary fixtures were writable. macOS used Node 26.8.1. Hosted CI, Windows,
other native-tool versions and additional rule/language families are separate gates.

## Preserve and reproduce the frozen checkout

The current engine has changed since this measurement: exported guidance and
route schemas were corrected after an actual client exposed a nonstandard format.
Those changes do not retroactively update the observations above. The original
runtime, source, lockfile and original measurement harness were preserved locally
before that edit. The [preservation record](measurements/external-eslint-preservation.json)
identifies the archive and its member manifest. The archive contains original
project code and the MIT license, not upstream cases or installed dependencies.
It is a local prepared artifact, not a published download.

When the compiled checkout still matches the plan's frozen identities, this helper
creates a fresh snapshot, archives the selected files, and prepares copies of the
installed locked dependencies for local replay:

```sh
node scripts/preserve-external-evaluation.mjs .checktrail > /tmp/frozen-evaluation.json
```

It intentionally fails on a later runtime before creating the output snapshot.
Do not edit the freeze pins to make it accept the current engine. Reuse the
preserved artifact or obtain its original exact bytes when reproducing this
particular evaluation. A restored archive needs the original locked dependencies
prepared separately; dependency installation is not part of measurement.

From that frozen checkout, prepare the pinned upstream inputs and run:

```sh
node scripts/prepare-external-evaluation.mjs /path/to/input-parent > /tmp/external-inputs.json
external_inputs_path="$(node -p 'JSON.parse(require("node:fs").readFileSync("/tmp/external-inputs.json", "utf8")).directory')"
node scripts/measure-external-evaluation.mjs "$external_inputs_path" > external-evaluation.json
node scripts/verify-external-evaluation-container.mjs "$external_inputs_path" > external-evaluation-linux.json
```

Preparation explicitly downloads only the pinned public files, verifies every
byte hash before creating a fresh private directory, and retains their license.
It requires `curl` and does not modify an existing input directory. Measurement
requires the original locked development dependencies and compiled runtime; it
never fetches inputs or tools. The container helper additionally requires Docker
and the specified image already available for offline execution.

Archive extraction was checked against every recorded member digest. Rebuilding
the preserved source with the locked TypeScript compiler reproduced the original
runtime digest. The preserved harness was replayed on macOS and Linux: corpus identities, classifications,
diagnostic metadata and source fingerprints matched the original observations.
Replays are reproducibility checks, not new independent holdouts or fresh latency
comparisons. The latest engine's ordinary native regression suite is separate.

The measurement command intentionally rejects a changed verifier runtime or
lockfile. Reproducing the original observation requires the recorded frozen
artifacts. After tuning on these cases, evaluate them as known regressions rather
than claiming a new holdout; declare a new independent cohort for further claims.
The labels here do not prove semantic equivalence to a previous review process.

Synthetic harness tests cover non-execution, configuration inheritance, exact
identifiers and locations, incomplete/excluded denominators, malformed evidence,
privacy projection and independent recomputation of the recorded matrices.
Removing excluded rows from aggregation made the named denominator regression
fail; restoring the guard restored the suite.
