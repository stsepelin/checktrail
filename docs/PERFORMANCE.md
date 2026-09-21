# Performance measurements

The benchmark creates original synthetic JavaScript projects, then measures the
shared planning and validation engine in a fresh Node process for each sample.
It makes no comparison with human review quality, another product or a private
workflow. These are observations on particular machines and runtime artifacts,
not a performance promise or CI speed budget.

```sh
npm run build
node scripts/measure-performance.mjs > performance.json
```

The default is ten samples per case/operation; `--samples 5` through
`--samples 30` selects a bounded sample count. Progress goes to stderr and the
complete JSON goes to stdout only after all samples succeed. Temporary fixture
creation and final cleanup are outside measured operations. No dependencies,
services, accounts or network access are needed for these fixtures.

## Workloads and accounting

The harness defines a small single package, a single package with many small
source modules, and a multi-package workspace. The exact project, module, file
and byte counts are derived into each report. Every generated test imports all
of its package's modules and asserts their combined value. Planning must report
the expected files, projects and checks. Validation must report one passing,
non-skipped test per project with unchanged source and no incomplete checks.
A fast failure, empty plan or omitted test is rejected as a measurement.

Cases rotate order between rounds. There is no warm-up exclusion and the
filesystem cache is uncontrolled; a fresh process does not imply cold storage.
Each worker has a 60-second bound and 64 KiB output limit. Validation also uses
the engine's normal run limits. Each sample preserves raw timings, counters and
the fixture fingerprint. Runtime artifacts, lockfile and harness digests must
stay unchanged during measurement.

- `wallMs`: elapsed time for launching and completing the fresh worker, including
  module loading, the engine operation and waiting for native child processes.
- `engineMs`: elapsed time around the requested engine operation, excluding
  worker/module startup but including waits for child processes.
- `engineCpuMs`: user plus system CPU consumed by the worker during the operation;
  child-process CPU is excluded.
- `enginePeakRssKiB`: the worker's lifetime peak resident memory, including startup;
  child-process memory is excluded. This uses Node's documented
  [resource usage API](https://nodejs.org/api/process.html#processresourceusage).

Summaries include minimum, median, nearest-rank p95 and maximum. The median
averages the middle two observations for an even sample count. With the default
small sample count, p95 is the maximum observation; it is not a reliable estimate
of production tail latency. Raw samples are retained for independent analysis.
No confidence interval or statistical regression threshold is claimed.

## Recorded evidence

The snapshots in [measurements/](measurements/) identify their runtime, platform,
architecture, available parallelism, timestamps and measured artifact hashes:

- [macOS arm64, Node 26](measurements/performance-darwin-arm64-node26.json).
- [Linux arm64, Node 22](measurements/performance-linux-arm64-node22.json).

The Linux sample was run in the pinned Node container with networking disabled
and the repository mounted read-only; fixtures lived in the container's temporary
filesystem. These environments differ in OS, Node version and filesystem, so
their timings should not be interpreted as an isolated comparison of any one
variable. Neither snapshot is hosted CI or a Windows measurement.

Native compiler/test matrices, large individual files, dependency-heavy builds,
Git impact selection, long-running jobs, concurrent users and peak memory across
whole process trees need separate performance evidence. Measurements do not
establish detection quality or false-positive rates. The separate development
corpus and its limited native comparisons are described in [EVALUATION.md](EVALUATION.md).
