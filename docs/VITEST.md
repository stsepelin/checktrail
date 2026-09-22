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

Execution accepts stable Vitest 4 and 5 package versions. It selects the API
signature and filesystem-cache option from the installed package metadata before
importing the tool. Unsupported majors, prereleases and malformed metadata fail
without executing the tool or project configuration; no signature retry runs a
test suite twice. Vitest 4 receives the explicit `test` mode and
`experimental.fsModuleCache: false`; Vitest 5 receives the current API and
`fsModuleCache: false`.

The Vitest 4 branch was added after the published `0.1.0-alpha.5` package.
That archive remains unchanged and uses the Vitest 5 invocation; its Vitest 4
failure is retained as evaluation evidence. Use a release containing this fix
or a built checkout for the Vitest 4 behavior described here.

The default integration suite exercises Vitest 5.0.1 with Vite 8.3.0. The same
original synthetic tests have also passed against Vitest 4.1.9 using an
operator-prepared Linux installation. To repeat that run, set
`CHECKTRAIL_TEST_VITEST_NODE_MODULES` to an existing Vitest 4.1.9 `node_modules`
directory with dependencies for the current platform, build Checktrail, then run
`node --test dist/test/vitest.test.js`. The tests copy those dependencies into
temporary roots and do not install anything. This optional input is only for the
test suite; normal validation resolves the target project's local installation.

Both runs cover passing/failing assertions, skips/todos, excluded files, focused
tests, snapshot and cache protection, unhandled rejections and missing environment
packages. Other minor versions within the accepted majors, browser mode, custom
pools and workspace multi-project duplication need separate verification. This
check does not establish coverage quality or type-checking support.

References: [Vitest reporters](https://vitest.dev/guide/reporters),
[Vitest API](https://vitest.dev/advanced/api/).
