# Detection and completeness evaluation

The recorded results use the archived `synthetic-evaluation-v1` corpus under
`measurements/evaluation-corpus-repo-verifier.json`. The current runnable corpus
is v2 with Checktrail configuration filenames; these historical measurements
do not validate v2. See [RENAMING.md](RENAMING.md).

The development evaluation compares Checktrail with direct native commands on
the same original synthetic Node, TypeScript and GitHub Actions inputs. The
versioned corpus is separate from the adapter regression tests and was authored
after those profiles were implemented. It is a small, paired convenience sample,
not independent held-out evidence or a comparison with a private review workflow.

```sh
npm run build
node scripts/measure-evaluation.mjs > evaluation.json
```

Prepare TypeScript from the locked development dependencies and the official
actionlint 1.7.12 release on `PATH` first. The harness installs nothing. Its only
inputs are the checked-in development corpus and prepared tools; it accepts no
custom executable commands. Fixtures are created in temporary directories and
removed after each case. The corpus remains unchanged during measurement.

## Labels and observations

`scripts/evaluation-corpus.json` records an ID, family, original source files,
label and expected diagnostic signals for every case:

- `defect`: a deliberately broken assertion, type contract or workflow construct.
- `valid`: a corresponding valid example or valid boundary condition.
- `insufficient-evidence`: empty/skipped tests, a source outside compiler scope or
  a local action whose metadata has not been prepared.
- `unsupported-profile`: a valid YAML alias outside this adapter's declared profile.

A failed command counts as a detected defect only when its expected diagnostic
signal is present. An unrelated runtime failure is not a detected assertion
defect. Incomplete observations remain in the relevant denominators and have
their own matrix column. Valid inputs that produce incomplete results are shown
separately from both passes and false-positive failures. Unknown/duplicate/missing
cases and malformed measurement processes fail the harness instead of shrinking
the sample. Source changes also invalidate measurement.

The report preserves per-case classifications, diagnostic identifiers, tool
versions, source fingerprints, native output digests and raw timings. It also
records hashes of the corpus, harness, runtime artifacts, compiler distribution
and package lock. These identities are checked before and after the run. Raw
source, logs, local paths and command environments are not stored in the report.

## Native baseline and interpretation

The baseline is the exit status from these fixed native operations:

| Family         | Native operation                                                                                | Verifier difference                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Node           | `node --test --test-reporter=tap value.test.js`                                                 | Structured event accounting requires executed, non-skipped tests                              |
| TypeScript     | `tsc --project tsconfig.json --noEmit --incremental false --pretty false`                       | Forces `noCheck=false` and accounts for all inventoried source through the compiler file list |
| GitHub Actions | `actionlint -format '{{json .}}' -shellcheck= -pyflakes= -no-color .github/workflows/check.yml` | Explicit configuration, local input preparation and native per-file completion requirements   |

This compares operational contracts, not competing parsing algorithms. In
particular, the additional TypeScript defect is caught because the verifier
overrides the fixture's `noCheck` setting. The native compiler honors that setting;
this is not a compiler defect. Likewise actionlint's acceptance of a YAML alias
is correct native behavior, while this adapter reports its unsupported profile.
Neither difference establishes generally better detection quality.

## Recorded observations

The [macOS/Node 26 report](measurements/evaluation-darwin-arm64-node26.json) and
[Linux/Node 22 report](measurements/evaluation-linux-arm64-node22.json) agree on
classifications and expected diagnostic signals. In this fixed corpus, both
systems detect the ordinary broken/fixed pairs without failing their valid
counterparts. The verifier additionally identifies the disabled TypeScript
analysis and keeps the insufficient-evidence/profile cases from passing.

The Linux measurement ran with networking disabled and the repository mounted
read-only in the explicitly prepared `checktrail-actionlint-test:1.7.12` image.
The local immutable image reference was
`sha256:60fe972d5efcb28a85a9557afe5e8428949dfe675b57b52bf33e9b3e560354dd`.
Fixture directories were writable temporary storage inside the container.
This is local container evidence; hosted CI and Windows were not measured.

Every case has one observation per system. Native/engine order alternates between
cases; each engine observation starts a fresh Node worker. `wallMs` includes
process startup, engine import and child execution as applicable. `engineMs`
excludes worker startup/import. Fixture preparation, compiler copying and final
cleanup are outside the measured operation. Filesystem caches and scheduling are
uncontrolled. These timings describe this run, not a statistically established
overhead ratio or an isolated comparison between operating systems.

The paired, deliberately selected sample cannot justify population confidence
intervals or production false-positive estimates. Rates are exact fractions over
the stated corpus only; raw counts and all incomplete cases are retained. No
model was called, so model-token usage and provider cost are zero. Machine/runtime
cost, human review effort and the cost of creating this project are not measured.

## External integration sample

A separate [external ESLint evaluation](EXTERNAL-EVALUATION.md) now uses upstream-
authored synthetic cases against a verifier frozen before inspecting them. It
compares diagnostic preservation with the native tool on macOS and Linux. This
does not turn the development corpus above into held-out evidence or establish
general review quality.

The [external Ruff cohort](EXTERNAL-RUFF-EVALUATION.md) adds Python diagnostic
preservation evidence on both platforms. Its mixed files do not supply a separate
clean-case denominator or establish native-rule effectiveness.

## Remaining evidence

Independent end-to-end review cases beyond that integration sample, additional
rule/language families, larger workloads,
native tool configurations beyond these fixed baselines, and comparison with a
previous review process remain work. The project makes no equivalent-or-better
review-quality claim. A private baseline can be evaluated privately against the
same labels, with only aggregate results considered for public documentation.

The tests for the harness reject lost cases, duplicate IDs, invalid observations,
incorrect failure signals and removal of incomplete cases from denominators.
Recorded matrices are independently recomputed from their raw observations.

The [prior-workflow protocol](PRIOR-WORKFLOW-EVALUATION.md) specifies a provisional
public baseline, matched comparison arms, declaration requirements and independent
adjudication. No comparison with a specified previous private workflow has been run.
A separate [historical agent pilot](AGENT-EVALUATION-PILOT.md) exercises the
provisional public baseline with actual reviewer and adjudicator sessions.

## Agent review experiments

The [agent evaluation workflow](AGENT-EVALUATION.md) implements frozen declarations,
separate source packets, sealed reviewer receipts, blinded judging and paired
accounting. It complements these deterministic adapter measurements; it does not
turn their already-inspected cases into an unseen review benchmark.

The [five-language alpha.5 adoption replay](PUBLIC-ADOPTION-ALPHA5.md) separately
rechecks the original pinned libraries with the published package, preserving
remaining scope gaps and the older immutable measurements.
