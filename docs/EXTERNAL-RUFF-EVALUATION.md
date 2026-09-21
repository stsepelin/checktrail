# External Ruff integration evaluation

This cohort checks whether the verifier preserves native Ruff diagnostics on
externally authored Python fixtures. It does not measure general review quality
or independently validate Ruff's own rules. The selected fixtures and expected
snapshots come from Ruff's own test suite.

The [declared plan](../scripts/external-ruff-plan.json) freezes the verifier and
lockfile before source/snapshot inspection. It selects the primary non-preview
fixture for F401 (unused imports), F821 (undefined names) and F841 (unused local
variables), with a fixed upstream commit and explicit extraction exclusions.
Filename resolution from the upstream tree is recorded in that plan. No case was
replaced after its result was known.

## Results and limits

The [macOS report](measurements/external-ruff-darwin-arm64-node26.json) and
[Linux report](measurements/external-ruff-linux-arm64-node22.json) retain the
expected diagnostics, observations and independently recomputable comparisons.
Both native Ruff and the frozen verifier match all expected primary diagnostics
in the three selected files: 15 F401, 13 F821 and 16 F841. Neither run has missing
or unexpected diagnostics, incomplete results or excluded files.

These are three whole files containing mixed constructs, not 44 independent
labeled programs. There is no separate clean-file denominator. No population
false-positive rate or confidence interval follows from this sample. Rule code,
filename, line and start column are compared; message prose, end positions and
suggested fixes are not. The verifier's normalized findings preserve rule, file
and line; the harness checks columns using the retained native JSON output.

The worker receives only the source root, never the expected diagnostics. Each
system's operation must preserve the source fingerprint. Native/worker order
alternates between files. `wallMs` includes process startup and native execution;
`engineMs` excludes worker import/startup. Preparation and cleanup are outside the
measurement. Caches, scheduling and platform differences are uncontrolled, so
these timings are observations rather than a representative overhead estimate.
No model was called; model tokens and provider cost are zero. Machine and human
costs are not measured. A prior review-workflow comparison remains separate work.

## Reproduction

Inputs are pinned by commit, byte length and SHA-256 in the
[input manifest](../scripts/external-ruff-inputs.json). The preparation helper
fetches only those public files, verifies every download before creating its
output directory, and keeps the complete upstream license alongside the files.
The source and snapshots remain ignored local inputs; public reports contain
only diagnostic metadata and hashes. Ruff's upstream LICENSE includes its MIT
license and third-party notices; retain the entire file when reproducing.

From a checkout with the declared runtime artifacts and lockfile:

```sh
node scripts/prepare-external-ruff.mjs .repo-verifier
node scripts/measure-external-ruff.mjs /prepared/input-directory /prepared/ruff
node scripts/verify-external-ruff-container.mjs /prepared/input-directory /prepared/linux/ruff
```

Preparation needs network access; measurement downloads and installs nothing.
Use Ruff 0.16.8. The executable must be named `ruff`. This frozen verifier also
requires `python3` for tool identity; the harness checks that prerequisite before
measuring any cases. The binary itself can run without Python. An initial
container lacking Python was rejected during harness preparation and is not
counted as a code-validation outcome.

The macOS executable came from the upstream `ruff-aarch64-apple-darwin.tar.gz`
release archive, verified against its published SHA-256
`0ffa53899f2970d24f14fbed8d8265c87180b159b7100794d97a1527dc60fa79`.
Both reports record their actual executable hashes, runtime versions and harness
identity. The Linux wrapper uses local immutable image
`sha256:50acdf79e4b3fcfafb4151579ac00b097382f64190481a1d69399efea05c9fed`,
prepared using [external-tools.Dockerfile](../scripts/external-tools.Dockerfile).
It disables networking and mounts the checkout, inputs and Ruff binary read-only.
The image is local evidence, not a published reproducible image or hosted CI run.

The harness rejects a runtime or lockfile that differs from the declaration,
checks input and harness identities again after measurement, and fails on worker
crashes rather than interpreting them as code results. Malformed process evidence
is incomplete; unsupported snapshot contracts remain excluded rows for both
systems. Tests exercise location/identifier boundaries, duplicate diagnostics,
incomplete/excluded denominators and reconciliation of both recorded reports.

A later verifier revision cannot be silently substituted into this frozen
cohort. Reuse after implementation changes is regression evidence and must be
labeled accordingly. See [the ESLint cohort](EXTERNAL-EVALUATION.md) for the
separate earlier freeze and its preserved artifact.
