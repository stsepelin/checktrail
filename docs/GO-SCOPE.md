# Go scope and Staticcheck

`go.vet`, `go.test`, `go.test-race` and `go.staticcheck` first run native
`go list -json ./...`. A passing result requires the union of native Go, cgo and
internal/external test source files to exactly match the inventoried Go files.
Malformed package output, missing packages, duplicate/unexpected files and load
errors prevent completeness. Real diagnostic/test failures retain their failure
status even when scope is incomplete.

Files excluded by build tags, OS/architecture suffixes or Go directory conventions
remain unverified. The current policy has no build-matrix or per-file exception
contract, so such projects are conservatively incomplete. This includes intentional
`testdata` Go files if they are inventoried but not compiled. Do not treat that as
a source defect or remove valid platform-specific code to obtain a passing run.

Test checks additionally require a passing native test in every selected package.
An untested package, or one containing only skipped tests, cannot borrow evidence
from a tested sibling. This proves package participation, not statement/branch
coverage or assertion quality. Formatting still checks all inventoried Go files
directly and does not require package selection.

Go commands use `GOPROXY=off`, `GOTOOLCHAIN=local`, `GOFLAGS=-mod=readonly`,
`GOWORK=off`, `GOENV=off` and an empty `GOCACHEPROG`. This keeps module validation
independent of a surrounding workspace, persisted Go settings and custom cache
programs. Cross-module workspace builds need a separate explicit profile. Native
compiler/analyzer caches may be used; test result caching remains disabled.
Dependencies and toolchains must be prepared separately.

## Staticcheck

Select `go.staticcheck` explicitly. It requires the installed `staticcheck`
executable on the operator PATH. It runs with JSON diagnostics, all checks,
test analysis, failure for all diagnostics, and surfaced ignored diagnostics.
The command-level check selection overrides project `checks = ["-all"]`; inline
ignored findings are retained as notes and still fail validation. Configured
exact finding exceptions and baseline reconciliation are available separately in
`FINDING-POLICY.md`; native source-suppression interpretation remains tool-specific.

Normalized diagnostics carry native rule IDs and root-relative file/line evidence
and can be exported to SARIF. Compiler diagnostics fail without inventing a source
finding; malformed configuration/runtime errors are incomplete. Successful empty
diagnostic output requires complete native package evidence and tool identity.

Native evidence currently covers Go 1.27.1 and Staticcheck 2026.2.1 (module v0.8.1)
on macOS arm64. Synthetic fixtures include a discarded pure-function result, its
returned-value fix, disabled rule configuration, inline suppression, malformed
configuration, excluded files, package test participation and native race checks.
Hosted CI and other OS/tool combinations still require their own runs.

Prepare the pinned development tool explicitly:

```sh
mkdir -p .repo-verifier/go-tools/bin
GOBIN="$PWD/.repo-verifier/go-tools/bin" go install honnef.co/go/tools/cmd/staticcheck@v0.8.1
npm run build
node --test dist/test/go-scope.test.js dist/test/staticcheck.test.js
```

Preparation may download dependencies. Validation never performs that installation.

References: [Go package listing](https://pkg.go.dev/cmd/go#hdr-List_packages_or_modules),
[Staticcheck CLI](https://staticcheck.dev/docs/running-staticcheck/cli/),
[Staticcheck source](https://github.com/dominikh/go-tools/tree/v0.8.1).
