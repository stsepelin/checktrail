# Go build-tag profiles (alpha.5 candidate)

The source checkout supports named build-tag profiles in module-local
`checktrail.go-build.json`. Published alpha.4 does not support this file. It
selects additional Go build constraints for each check and keeps that check's
exclusions explicit. It does not introduce cross-compilation or a target matrix.

## Configure

Continue selecting checks in `checktrail.json`. A build profile does not enable
checks: `go.test-race`, Staticcheck and golangci-lint still need explicit selection.
Use the [runnable synthetic example](../examples/go-build/checktrail.go-build.json)
with [its check selection](../examples/go-build/checktrail.json), or configure:

```json
{
  "schemaVersion": 1,
  "profiles": [
    {
      "name": "integration",
      "tags": ["integration"],
      "checks": ["go.vet", "go.test"],
      "excludedFiles": []
    }
  ]
}
```

Every selected native Go check must be assigned exactly one profile. Missing
assignments are unavailable; they never silently fall back to an untagged run.
Profile names and check assignments must be unique. A profile may share its tags
and exclusions across several checks; other profiles can use different settings.
Unselected checks are not executed, even if a profile names them. Each check runs
once. Repeating one check across several profiles is not implemented.

Tags are an array of distinct ASCII identifiers matching
`[A-Za-z_][A-Za-z0-9_]*`, each at most 64 characters, with at most 32 tags.
An empty array adds no tags. Profile names start with an ASCII letter and allow
letters, digits, underscores and hyphens, up to 64 characters. Up to five profiles
can assign the five supported native checks. Unknown fields, malformed JSON,
nonregular policy files and invalid exclusions make native checks unavailable.

Each profile has its own `excludedFiles`, using the exact paths and nonblank
reasons described in [Go scope](GO-SCOPE.md). Excluded files must still be
inventoried and confirmed by native `IgnoredGoFiles`. An active or stale exclusion
cannot pass. Listing a source file as excluded never suppresses an actual finding.
Do not combine this file with `checktrail.go-scope.json`; their overlapping policy
is rejected. To migrate, move exclusions into each applicable profile and remove
the old scope policy after reviewing the complete configuration.

## Execution and evidence

Go listing, vet, tests and Staticcheck receive identical `-tags` settings within
each check. Race tests also keep `-race` in listing and execution. Golangci-lint
receives the profile tags in its generated configuration; its project's own
`run.build-tags` remains unsupported to avoid a second source of settings.
Existing protected Go settings, version checks and tool requirements still apply.

Formatting checks the full inventory once and ignores build profiles. Native
checks retain their whole inventory and reconcile selected and excluded files
separately. Tests still need a passing test in each package; test counts and
failures come from native events. A passing ordinary test does not cover a file
selected only by the race profile. An exclusion's reason is an operator statement,
not independent evidence that another check ran or covered it.

Detailed plans/reports add `goBuild` with the profile name and tags alongside
`goScope` with that profile's exclusions. Summary plans/reports expose only
`goBuildTagCount` and `goExcludedFileCount`; names, tags and reasons remain private
unless detailed output is enabled. Counts describe declarations, not proof of
execution. Older strict report-schema consumers must update before accepting the
new optional fields. The [policy schema](../schemas/go-build-policy.schema.json)
defines the data shape; planning also checks duplicate assignments and inventoried
file membership.

Planning reads data only. Execution still requires CLI/library/operator startup
trust. Policy files cannot set environment values or arbitrary command arguments.
Tags do not set `GOOS`, `GOARCH`, the compiler version or enable race instrumentation;
only the selected race check adds instrumentation. No unselected tag combinations
or other operating systems are claimed as validated.

## Reproduce

From a built source checkout with Go and a supported race toolchain prepared:

```sh
node dist/src/cli.js plan --root examples/go-build --detailed
node dist/src/cli.js run --root examples/go-build --trust-project --detailed --timeout-ms 120000
node --test dist/test/go-build.test.js
node scripts/verify-required-native-tests.mjs go
```

The example's ordinary profile selects the integration test and acknowledges the
race-only test. The instrumented profile selects both. This demonstrates source
selection; the arithmetic example does not itself demonstrate race detection.
The separate [race regression](GO-RACE.md) exercises an actual data race.

The native regression suite exercises tagged compiler errors and assertions,
valid near misses, undeclared omissions, stale exclusions, missing assignments,
independent ordinary/race settings, analyzer diagnostics, nonexecuting planning,
summary privacy and CLI/MCP agreement. Standard schema checks cover the exported
policy and report shapes. Prepared CI requires these named cases to run; unavailable
native tools cannot satisfy the required profile.

References: [Go build constraints](https://pkg.go.dev/cmd/go#hdr-Build_constraints),
[Staticcheck CLI](https://staticcheck.dev/docs/running-staticcheck/cli/),
[golangci-lint configuration](https://golangci-lint.run/docs/configuration/file/).
