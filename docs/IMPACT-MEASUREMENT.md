# Measuring Git selection impact

The impact harness compares a full validation run with Git-selected validation on
the same source snapshot and project policy. It measures whether failing checks
are retained, which checks are omitted, disagreement between shared checks and
the actual execution cost. This is a post-implementation synthetic development
evaluation, not held-out evidence or a proof that a consumer's graph is complete.

```sh
npm run build
node scripts/measure-impact.mjs > impact.json
node scripts/verify-impact-container.mjs > impact-linux.json
```

Run these measurements sequentially without other test/build workloads. The
container helper requires prepared, digest-pinned Node and Composer images; it
copies the Node executable into private temporary storage and mounts it read-only
alongside the checkout. The Composer image supplies Git. Measurement containers
have external networking disabled. No project or dependency installation occurs
during the measured operations.

## Cases and checks

`scripts/impact-corpus.json` freezes original case labels and expected selection
before measurement. `scripts/impact-fixture.mjs` creates temporary repositories
with fictional identities and a native Node test in each project:

- `core` exports a value; `service` re-exports it; `web` consumes that export.
  Service and web assertions check the value. Core only asserts its numeric type,
  deliberately making consumer coverage necessary for detecting a wrong number.
- `utility` has an independent value contract.
- `other` reads a root settings file and an unowned shared module, exercising
  conservative global fallback when either input changes.

Cases cover a broken and valid producer edit, a leaf assertion defect, an
independent defect, simultaneous changed owners, an explicitly incomplete graph,
root/unowned changes, no changes and a deliberately misdeclared graph. Dependency
edges are ordered against the transitive chain so closure must revisit them.
The engine receives only the root and immutable synthetic base commit; expected
labels are never passed to the worker.

Every case first runs an unchanged full baseline and requires every native test to
pass. After applying the edit, the harness runs fresh full and selected workers in
alternating order, with repeated pairs. It verifies exact project sets, outcomes,
positive test counts and named native assertion failures. An unrelated runtime
failure does not count as the intended contract defect. Source and policy
fingerprints must match across each pair, and source plus harness/runtime/corpus
identities must remain unchanged throughout measurement.

## What the observations mean

The [macOS/Node 26 observations](measurements/impact-darwin-arm64-node26.json) and
[Linux/Node 22 observations](measurements/impact-linux-arm64-node22.json) agree on
selection and assertion outcomes in this corpus. Correct declarations retained
the observed failing consumers. The explicit incomplete declaration retained the
full run. Global and unowned changes also retained full validation.

The deliberately misdeclared graph omitted the service-to-core dependency while
asserting `complete: true`. Git selection ran only core and passed; full validation
found the service and web assertions failing. The measurement retains this case
and its missed failures in a separate group. This demonstrates a real limitation:
selection relies on the maintainer's declared dependency graph and does not infer
or verify every native import. Use full validation when that assertion cannot be
supported. No confidence in graph completeness follows from a passing selected run.

Each summary reconciles full failures into retained failures, omitted failures and
changed results among checks run by both modes. Unexpected failures and incomplete
check executions are reported separately. All expected case/repetition pairs must
exist exactly once; malformed, missing or duplicate observations fail validation.
Raw check/test/assertion evidence remains alongside the aggregates. Replacing
transitive closure with a single edge pass was manually verified to omit web and
fail the native consumer regression; the original code was restored and the test
passed again. Snapshot tests
recompute metrics and match the frozen corpus instead of trusting copied totals.

## Timing and provenance

Reports record raw full/selected wall time, worker engine time, engine CPU and peak
RSS, native Node/Git identities, source/policy fingerprints and hashes of the corpus,
harness, compiled engine artifacts and package lock. The report omits source text,
raw native logs, absolute paths and temporary worktree identities. SHA-256 identifies
the measured build; it does not attest a publisher or pin every system library.

`wallMs` includes fresh worker startup/import and native execution. `engineMs` starts
after worker imports. Engine CPU/RSS excludes native child resource use. Fixture
creation, baseline preparation and cleanup are outside paired timings; baseline
run measurements are stored separately. Git inspection has an execution cost, so
fewer checks do not by themselves demonstrate reduced latency. The fixtures have
small tests and are not representative of production suites.

Repetitions are repeated observations of the same defects, not additional
independent defect cases. Summary retention fractions use check executions and
show their denominators; timing ratios are descriptive sums, not confidence
intervals or promised speedups. Filesystem caches and host scheduling remain
uncontrolled. macOS/Linux observations are separate environment profiles, not an
isolated operating-system comparison. No prior private workflow, model tokens,
provider cost or independent held-out corpus is measured here.
