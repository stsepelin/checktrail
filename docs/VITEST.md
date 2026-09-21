# Vitest validation

Select `javascript.vitest` explicitly in the root policy. The adapter resolves an
installed Vitest within the configured root, including hoisted installations.
Planning reads paths only. Execution requires operator trust because configuration,
test code, plugins and setup/teardown hooks can run arbitrary code.

Scope is the project's inventoried `.test` and `.spec` files with JavaScript or
TypeScript extensions, including module/CommonJS and JSX/TSX variants. Each planned
file must appear exactly once in the native report. Configuration exclusions and
filters that omit a file produce incomplete evidence. A file executed repeatedly
through multiple Vitest projects is currently ambiguous and also incomplete.

The child invokes the public Vitest API in run mode with a JSON reporter explicitly
directed to stdout. It overrides configured report output files, watch mode,
snapshot updating, focused-test allowance, result caches and unhandled-error
bypasses. Automatic installation through Vitest's package installer is disabled;
missing dependencies must be prepared by the operator. User code can still write
files or access networks. This is not an execution sandbox.

Evidence reconciles native totals with per-assertion statuses and checks file
identity and suite counters. Empty, all-skipped, unfinished, malformed and
truncated reports cannot pass. Successful assertions cannot hide a failing suite,
unhandled error or nonzero process exit. Test logs that corrupt the JSON output
produce incomplete evidence rather than being guessed around. Detailed reports
retain native diagnostics; summaries omit them.

The integration suite exercises Vitest 5.0.1 with Vite 8.3.0, using original
synthetic tests. It covers passing/failing assertions, skips/todos, excluded files,
focused tests, snapshot protection, unhandled rejections and missing environment
packages. Other versions, browser mode, custom pools and workspace multi-project
duplication need separate verification. This check does not establish coverage
quality or type-checking support.

References: [Vitest reporters](https://vitest.dev/guide/reporters),
[Vitest API](https://vitest.dev/advanced/api/).
