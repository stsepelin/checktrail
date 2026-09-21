# Configured golangci-lint profile

Select `go.golangci-lint` with exactly one project-local `.golangci.yml`,
`.golangci.yaml` or `.golangci.json`. This initial profile verifies golangci-lint
2.13.2 and supports selection of `errcheck`, `govet`, `ineffassign`, `staticcheck`
and `unused`, using their native defaults. Choose `standard` or `none` for the
default group, with explicit enable/disable lists. The always-on native type
checker does not count as an enabled configured linter.

```yaml
version: "2"
linters:
  default: none
  enable: [govet, staticcheck, unused]
```

Other linters, nonempty custom settings, formatters and Go build-version/tag
profiles are incomplete until separately verified. This is deliberately a
constrained profile, not support for every golangci-lint configuration. YAML
duplicates, unsupported tags and excessive aliases are rejected. Planning only
discovers the local config and source; parsing/native execution occurs with trust.

The wrapper creates a temporary native configuration retaining linter selection.
It disables fixes, change-only filtering, exclusion presets/paths/rules, generated
file exclusion, issue-count limits and line deduplication. It forces test analysis,
read-only module resolution, absolute JSON locations and no extra output files.
Output and native analyzer cache use a fresh temporary directory, removed after
normal completion. Existing project config and output paths are not rewritten.
Native Go source accounting follows [the shared contract](GO-SCOPE.md).

Native `nolint` and Staticcheck ignore directives are currently unsupported and
make the check incomplete. The wrapper scans Go comment boundaries, including
quoted/raw-string handling; matching text in strings or unrelated comments does
not count as a suppression. A future exception policy must reconcile actual
findings before these directives can be accepted. Tests and native tools remain
trusted executable code, without a sandbox guarantee.

Passing requires native JSON, at least one supported configured linter, no
diagnostics or warnings, and complete package/file evidence. Diagnostics become
normalized findings and fail. Unknown/duplicate active linters, omitted source,
malformed evidence, runtime/configuration errors or missing tools are incomplete.

Native synthetic tests cover a discarded return value and its fix; clean source;
configured issue filtering/fixing/output paths; no active linters; rejected custom
settings; real and literal suppression text; excluded Go source; and malformed
YAML. The suite verifies original source bytes and absent output artifacts.
Current evidence is Go 1.27.1 / golangci-lint 2.13.2 on macOS arm64.

Development preparation is separate from validation:

```sh
mkdir -p .repo-verifier/go-tools/bin
GOBIN="$PWD/.repo-verifier/go-tools/bin" go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2
npm run build
node --test dist/test/golangci.test.js
```

Preparation may download dependencies. Consumer validation requires an installed
binary on the operator PATH and never installs it. The hosted profile passed
at `52ba415`; see `NATIVE-CI.md`.

References: [CLI](https://golangci-lint.run/docs/configuration/cli/),
[configuration](https://golangci-lint.run/docs/configuration/file/),
[verified source version](https://github.com/golangci/golangci-lint/tree/v2.13.2).
