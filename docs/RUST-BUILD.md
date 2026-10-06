# Rust workspace build profiles

`checktrail.rust-build.json` opts Cargo compilation, Clippy and tests into a
workspace profile. Without it, the original single-member profiles remain in
place. Formatting has its separate workspace contract in RUST-FORMAT.md.
Planning reads declarative JSON and inventories files; it does not evaluate
Cargo manifests or execute project code. Execution requires operator trust.
Cargo build scripts, procedural macros, configuration and tests run with the
operator's privileges.

```json
{
  "schemaVersion": 1,
  "workspaceMembers": ["crates/core", "crates/consumer"],
  "profiles": [
    {
      "name": "extra",
      "checks": ["rust.cargo-check", "rust.cargo-clippy", "rust.cargo-test"],
      "features": ["core/extra"],
      "defaultFeatures": false,
      "target": null,
      "excludedSources": []
    }
  ]
}
```

The JSON schema is `schemas/rust-build-policy.schema.json`. Select the check IDs
in `checktrail.json` as usual. A selected check needs at least one matching
profile; each matching profile creates a required execution with its own stable
identity. Reports retain the selection and reconcile every required identity.
Invalid later profiles cannot leave earlier checks partly rewritten. Duplicate
members, names, feature selectors, checks or exclusion paths are rejected.

## Native scope

The root Cargo.lock must already exist. Every declared member manifest must be
inventoried, and native locked/offline Cargo metadata must identify exactly those
members under the selected workspace root. This includes a root package or a
virtual workspace and does not rely on Cargo's `default-members`. Metadata,
compiler and test-build artifacts retain native feature resolution. Requested
selectors use the explicit `package/feature` syntax; defaults are a separate
boolean. Transitive resolution can enable other features. If native resolved
features and artifacts disagree, the profile remains incomplete.

Each execution uses fresh canonical temporary build and target directories.
Compiler checks select the whole workspace and all targets, with offline locked
arguments. A target requiring inactive features is accounted for separately;
its source must have an exact exclusion if it would otherwise remain unobserved.
All remaining inventoried Rust source needs native dep-info coverage. An
exclusion names one existing source file and a reason. It becomes stale when
native dep-info observes that source; broad patterns are not accepted. Extra
unlinked source, omitted targets, stale artifacts and malformed evidence do not
pass. Source outside the bounded inventory, generated contents and native
configuration overrides are not a complete hermetic build identity.

`target: null` selects the measured compiler host explicitly, overriding an
implicit Cargo target configuration. A named target needs its installed standard
library; validation never installs it. Native artifact output paths must agree
with the selected target, except host build-script and proc-macro artifacts.
Canonical target names include underscored architectures such as
`x86_64-unknown-linux-gnu`; the same contract validates the native compiler host.
Malformed names, paths and options remain rejected before execution.
Foreign targets are compilation/Clippy profiles. Foreign tests remain unavailable
without a separately supported executor. Cross-compilation is not runtime test
coverage.

## Native tests and findings

Workspace tests build fresh libtest artifacts without running their bodies,
then reconcile full and ignored listings against unfiltered terminal cases.
Documentation tests run for the whole workspace with the same feature selection.
A native control showed that selecting one package rejects feature selectors for
its siblings. Running narrower doctests would therefore change the profile.
Per-package Rustdoc trailers and multiple suites are reconciled together; source
names map to the most specific declared manifest owner.

Every member needs at least one completed non-ignored native case. Counts include
native compile-only and expected-failure doctests and do not count assertion
statements or prove every counted case executed a project body. Empty members,
ignored cases, filtering and interrupted inventories stay incomplete. If native
libtest cases fail and Cargo stops before completing the workspace doctests,
the failure is retained while aggregate test counts remain unknown. Detailed
native output retains the completed and incomplete groups.

Clippy uses the recommended forced warning group from CLIPPY.md. Exact sibling
source addresses remain attached to findings. A verified workspace/member Clippy
configuration error is an execution error with incomplete analysis, rather than
source-quality evidence.

Native invocations have bounded output and inventories. The engine's wall,
output and cancellation limits apply. Normal runner exit removes temporary
output; forced-termination cleanup and a ledger of every internal subprocess are
not established. Source snapshots detect changes to the final bounded inventory.

## Acceptance

```sh
node scripts/verify-required-native-tests.mjs rust-workspace
node scripts/verify-rust-workspace-package.mjs
```

The frozen profile uses Linux arm64, Node 22.23.2, Cargo/rustc/rustdoc 1.98.1,
Clippy 0.1.98, the native aarch64-unknown-linux-musl target, and compile/Clippy
checks for wasm32-unknown-unknown. Tool components are prepared before validation.
Original synthetic controls exercise member dependencies, feature-gated modules
and examples, generated source, proc macros, broken/fixed/near-miss inputs,
missing prerequisites, native CLI/MCP and fresh offline production installation.
The source-bound measurement is
[rust-workspace-2026-10-05.json](measurements/rust-workspace-2026-10-05.json).
The later [CI repair measurement](measurements/rust-ci-repair-2026-10-06.json)
records original macOS arm64 native/source/installed controls and the Linux
workspace regression after correcting underscored target/host names and shared
library discovery. Compiling mutations cover those three repaired guards.
The [GNU loader repair measurement](measurements/rust-gnu-loader-2026-10-06.json)
records Linux arm64 GNU workspace/single-member controls, a fresh offline installed
workspace run, a macOS workspace regression and a compiling loader mutation.
It does not establish Linux x86_64 hosted CI acceptance.
Other platforms, versions, resolvers and configuration shapes need separate
acceptance. Hosted CI, real-project field evaluation, model-session isolation and
review-quality scoring are not established by these controls.

References: [Cargo features](https://doc.rust-lang.org/cargo/reference/features.html),
[workspaces](https://doc.rust-lang.org/cargo/reference/workspaces.html),
[Cargo test](https://doc.rust-lang.org/cargo/commands/cargo-test.html).
