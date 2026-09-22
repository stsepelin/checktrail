# Go scope and Staticcheck

`go.vet`, `go.test`, `go.test-race`, `go.staticcheck` and `go.golangci-lint` first run
native `go list -json ./...`. The race profile includes `-race` in both listing and
test execution, so their build constraints agree. By default, a passing result
requires the union of native Go, cgo and internal/external test source files to
exactly match the inventoried Go files.
Malformed package output, missing packages, duplicate/unexpected files and load
errors prevent completeness. Real diagnostic/test failures retain their failure
status even when scope is incomplete.

Files excluded by build tags, OS/architecture suffixes or Go directory conventions
remain unverified. Without an explicit scope policy, such projects are conservatively incomplete. This includes intentional
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

## Explicit exclusions (alpha.4 and later)

Alpha.4 adds `checktrail.go-scope.json` at each Go module root. Earlier releases
do not support this policy. Opt in only after reviewing
which files the intended native run leaves unverified:

```json
{
  "schemaVersion": 1,
  "excludedFiles": [
    {
      "path": "platform_windows.go",
      "reason": "Windows implementation; validated separately on its target"
    }
  ]
}
```

Paths are exact, case-sensitive, module-relative inventoried `.go` files. Globs,
parent traversal, absolute paths, duplicate entries, blank reasons, unknown fields,
missing files and symlink/directory policy files are rejected. An empty list keeps
strict coverage. Planning only reads this file; native commands still require
operator trust. A reason records the operator's statement, not proof of another run.
The schema is [go-scope-policy.schema.json](../schemas/go-scope-policy.schema.json).

For each selected native check, every declared file must appear in Go's
`IgnoredGoFiles`, and every other inventoried Go file must appear exactly once in
its selected source lists. An exemption becomes stale if its file disappears or
becomes selected. New omissions, duplicate/contradictory native entries, malformed
or interrupted output remain incomplete. A whole package excluded from `./...`,
`testdata`, dot/underscore files and arbitrary unlisted files cannot be excused by
this policy unless native package evidence accounts for them as ignored Go files.

The same policy applies to vet, tests, race tests, Staticcheck and golangci-lint.
A file ignored by ordinary tests may be selected under `-race`; one shared
exemption then cannot pass both profiles. Do not exempt active code to suppress a
diagnostic. Real diagnostics/test failures still fail. Every tested package still
needs a passing test; exempted source supplies no test evidence. Formatting ignores
the scope policy and checks every inventoried Go file.

Detailed plans and reports retain the declarations as `goScope`; the original
`scope` remains the complete inventory. A passing native check covers that scope
minus its reconciled exemptions. Summary plans and reports expose
`goExcludedFileCount` without paths or reasons. This is the number declared, even
on an incomplete or unexecuted plan; it does not independently establish that the
exemptions reconciled. Other-platform and excluded build-tag behavior is unverified.

This policy does not introduce build-tag flags, cross-compilation, cross-target
test execution or a build matrix. Use separately prepared native target runs for
coverage outside the selected profile. Existing protected Go settings stay intact.

The source checkout separately adds [per-check build-tag profiles](GO-BUILD.md).
They use their own per-profile exclusions and cannot coexist with this module-wide
policy. That capability is in the unpublished alpha.5 candidate; alpha.4 retains the behavior above.

## Known-case replay

The [pinned public UUID replay](measurements/go-scope-policy-replay.json) uses the
same upstream revision as the alpha.2 adoption exercise, with an unreleased packed
CLI/library/MCP. Default scope remains inconclusive for vet/tests. Explicitly
acknowledging `node_js.go` makes those selected native checks pass while retaining
the skipped test and the existing formatting failure. An injected failing test
still fails through all three surfaces. The JavaScript-target file is unverified;
this is a known-case regression replay, not independent effectiveness evidence.
The upstream tracked files and original policy were preserved; temporary scope
policy and failing control were removed. The record identifies the tested tarball
and runtime source hashes; adding this record changes later package bytes.

The exact alpha.4 release candidate repeated this replay before publication; see
the [release record](measurements/release-alpha4.json). Its synthetic upgrade test
also confirms that rolling back to alpha.3 preserves the policy file but restores
strict scope accounting: a project relying on exclusions becomes incomplete.

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
mkdir -p .checktrail/go-tools/bin
GOBIN="$PWD/.checktrail/go-tools/bin" go install honnef.co/go/tools/cmd/staticcheck@v0.8.1
npm run build
node --test dist/test/go-scope.test.js dist/test/staticcheck.test.js
```

Preparation may download dependencies. Validation never performs that installation.

References: [Go package listing](https://pkg.go.dev/cmd/go#hdr-List_packages_or_modules),
[Staticcheck CLI](https://staticcheck.dev/docs/running-staticcheck/cli/),
[Staticcheck source](https://github.com/dominikh/go-tools/tree/v0.8.1).
