# Go build profiles

Published alpha.5 supports version 1 module-local `checktrail.go-build.json`
with one build-tag profile per selected check. The current source adds version 2
for repeated profiles, explicit targets and the opt-in `go.build` check. These
additions have not been published.

## Configure

Select registered checks in `checktrail.json`. A build profile never enables an
unselected check. `go.build`, race tests, Staticcheck and golangci-lint require
explicit selection. The existing [synthetic example](../examples/go-build/checktrail.go-build.json)
retains version 1 compatibility. Version 2 can repeat checks across profiles:

```json
{
  "schemaVersion": 2,
  "profiles": [
    {
      "name": "linux-build",
      "tags": ["integration"],
      "checks": ["go.build", "go.vet"],
      "excludedFiles": [],
      "repetitions": 2,
      "target": { "os": "linux", "arch": "arm64", "cgo": false }
    },
    {
      "name": "ordinary-tests",
      "tags": ["integration"],
      "checks": ["go.test"],
      "excludedFiles": [],
      "repetitions": 3
    }
  ]
}
```

Version 1 remains strict: up to five profiles, unique names and exactly one
assignment per native check; every check runs once. It cannot select `go.build`
or set targets/repetitions. Version 2 permits a check in several named profiles,
but rejects duplicates within one profile. It requires `repetitions` from 1
through 16, permits up to 16 profiles and caps the complete declaration at 128
check executions per module, including assignments to unselected checks.
Missing assignments produce unavailable results rather than an untagged fallback.

Tags are distinct ASCII identifiers `[A-Za-z_][A-Za-z0-9_]*`, each at most 64
characters, with at most 32 tags. Profile names begin with an ASCII letter and
allow letters, digits, underscores and hyphens, up to 64 characters. Targets
accept lowercase ASCII names `[a-z][a-z0-9]{0,15}` and a Boolean cgo mode. Native
preflight establishes whether the installed toolchain supports that exact pair.
The policy cannot select a compiler, executor, custom environment or arbitrary
arguments. Malformed, ambiguous, over-limit or nonregular policies make the
original native checks unavailable without partially applying earlier profiles.

Each profile declares exact inventoried `excludedFiles` with nonblank reasons,
as in [Go scope](GO-SCOPE.md). Native `IgnoredGoFiles` must confirm every applicable
exemption. Active, stale and undeclared omissions cannot pass. An exclusion never
suppresses a compiler or analyzer diagnostic. Do not combine build profiles with
`checktrail.go-scope.json`; migrate the old exclusions into each applicable profile.

## Execution and target evidence

Listing and execution receive identical tags and target environment. Race listing
and tests also receive `-race`; a race target with cgo disabled is unavailable
before execution. Golangci-lint receives the same tags in its generated config;
its own `run.build-tags` remains unsupported. Existing protected Go settings and
analyzer version requirements still apply. Operator environment values cannot
override protected profile settings.

A targeted execution first records native `go env -json` target/host/cgo values
and `go tool dist list -json` support metadata. Malformed, interrupted, contradictory
or duplicate evidence remains inconclusive. An unsupported pair or cgo mode is
unavailable. Test profiles must match native `GOHOSTOS`/`GOHOSTARCH`: a foreign
profile stops after preflight, records no executed tests and makes validation
incomplete. There is no configured emulator or remote target executor.

`go.build` compiles production packages and links main packages into separate
fixed outputs in an owned temporary directory that the runner removes. Its source scope excludes
`_test.go`; the native listing parser uses production files for this check.
It never reports executed tests. Cross-target compilation does not establish
runtime behavior on that target. A cgo cross-build still requires an installed
compatible C toolchain; missing infrastructure cannot establish a successful build.

Formatting runs once against the full inventoried Go source. Other profiles
reconcile their native selection and exact exclusions separately. Tests use
`-count=1` in a new native process for every repetition and need a passing test
in each package. Repeating a test does not create independent test cases, model
reviews or statistical quality evidence. Process globals are fresh; the project
filesystem and declared external resources can persist between repetitions.

Every required profile/repetition gets a terminal result, including failures,
cancellation, exhausted time/output budgets and unavailable targets. All share
the existing validation wall/output budget; repetition does not multiply it.
Any native failure makes the aggregate failed; otherwise missing conclusive work
makes it incomplete. Source freshness checks apply to the whole run.

## Identities, exports and privacy

Version 2 retains `goBuild.repetition` with one-based `iteration` and `total`.
A stable SHA-256 `executionId` binds the project, check, source scope, profile,
tags, exclusions, target and repetition. The report source fingerprint separately
binds file contents. Detailed reports retain the required execution manifest and
native `goTarget` evidence. Report import checks exact identities, group completeness,
manifest reconciliation and target evidence before finding comparison or SARIF export.
These consistency checks do not authenticate an independently manufactured report.

SARIF keeps one run per execution with the identity and profile metadata. Finding
baselines optionally include `executionId`; the same diagnostic in two executions
produces two entries. Changing profile identity cannot silently reuse a baseline
from another profile. Legacy baseline hashes remain unchanged. Strict schema
consumers must update for the new optional fields before importing these artifacts.

Summary plans/reports expose opaque execution identities, repetition counts,
`goBuildTagCount` and `goExcludedFileCount`. Profile names, tags, target names,
paths, commands, logs and exclusion reasons require detailed output. Summary
counts describe declarations and individual execution outcomes.

Planning reads data only. Execution requires operator trust through the shared
CLI/library/MCP engine; project policy or MCP arguments cannot grant it.

## Reproduce

From a built checkout with Go and the pinned analyzers prepared:

```sh
node --test dist/test/go-matrix.test.js
node scripts/verify-required-native-tests.mjs go-matrix
node scripts/verify-required-native-tests.mjs go
node scripts/verify-go-matrix-package.mjs
```

The original controls cover data-only planning, staged policy application,
invalid bounds and exact target near misses, intermittent failures across fresh
processes, missing/duplicate/forged execution identities, exhausted/cancelled
work, native host/race tests, foreign compilation/linking, unsupported test
execution, analyzer diagnostics, baseline reconciliation and CLI/MCP privacy/trust.
The [source-bound local record](measurements/go-matrix-native-2026-10-02.json)
retains the actual macOS/Linux profiles, native controls, installed package and
guard mutations. The required `go` profile includes the matrix controls. Unavailable native tools
cannot satisfy that profile. Hosted CI results require their own run.

References: [Go commands and environment](https://pkg.go.dev/cmd/go),
[Staticcheck CLI](https://staticcheck.dev/docs/running-staticcheck/cli/),
[golangci-lint configuration](https://golangci-lint.run/docs/configuration/file/).
