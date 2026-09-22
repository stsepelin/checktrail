# Go race checking

Select `go.test-race` explicitly. It runs `go test -race -json -count=1 ./...`
with cgo enabled, automatic toolchain/dependency downloads disabled, and module
edits disabled. The race detector writes to captured stderr and keeps its failing
exit status. Native JSON evidence still requires completed, non-skipped tests.
Defaults remain gofmt, vet and ordinary uncached tests; race instrumentation adds
cost and requires the operator to select this check.

The native fixture runs two workers repeatedly updating one shared counter. The
unprotected version must fail with an actual `DATA RACE` diagnostic; atomic
updates must pass and yield the exact combined count. A passing run cannot
establish freedom from races on paths it did not execute. Native package/file evidence makes undeclared excluded source and untested packages
incomplete; see [Go scope](GO-SCOPE.md) for the explicit exclusion policy available since alpha.4.
Alpha.4 also passes `-race` to package listing so it uses the same build
constraints as the tests. The unpublished alpha.5 source candidate adds
[per-check build-tag profiles](GO-BUILD.md), allowing race and ordinary tests to
use different tags and exclusions. A build/OS matrix is not implemented.

A supported Go race platform and C compiler are required. Compilation and runtime
errors are retained in detailed output; no compiler, library or toolchain is
installed automatically. See the official [Go race detector documentation](https://go.dev/doc/articles/race_detector)
for requirements and runtime coverage limits.
