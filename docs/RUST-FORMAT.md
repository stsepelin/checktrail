# Rust formatting profile

`rust.cargo-fmt` is opt-in; the default remains `rust.cargo-check`. The measured
profile uses Cargo/rustc **1.98.1**, stable Rustfmt **1.9.0**, and Linux arm64 with
Node **22.23.2**. Discovery and planning do not invoke Cargo or execute manifests.
Native execution requires operator trust and is not sandboxed. Rustfmt/Clippy are
optional Rust toolchain components; validation never installs them.

The formatter requires a checked-in `Cargo.lock` and resolves native metadata
with `--offline --locked --no-deps`. The selected project must be the workspace
root. Multi-member and virtual workspaces retain every declared Rust file under
that root, including generated and unlinked files. Native package membership
supplies each file's edition. Files without a selected package owner and local
path dependencies outside selected workspace membership are unsupported. Registry
dependencies must already resolve offline; no dependency or lock is installed.

The profile uses one explicit root `rustfmt.toml` (preferred) or `.rustfmt.toml`,
or a disposable empty configuration for native defaults. Nested formatting
configuration is unsupported. Native configuration introspection must confirm
formatting enabled, child/generated processing enabled, and no ignored files or
skipped macro invocations. Exact Rustfmt skip paths in attributes leave the
profile incomplete. The bounded lexical scanner handles comments, nested block
comments, strings/raw strings, characters, Unicode identifiers and raw identifiers;
it does not evaluate `cfg_attr`. Any conditional Rustfmt skip is conservatively
unsupported, even when its predicate might be false.

Cargo runs `fmt --all --check` with this explicit configuration. Separate native
per-file Rustfmt checks retain each package edition and disable child traversal
only for that invocation; every selected child file receives its own check.
Native check mode preserves BOM and CRLF semantics which stdout rendering does
not preserve. Process output byte hashes must reconcile; source hashes identify
the exact input. Cargo's verbose processing addresses must remain inside the
declared scope, including when external modules have no formatting changes.
This per-file evidence includes files not selected as Cargo targets. Formatting
is independent of compile feature/target execution. Empty/skipped files, disabled
formatting, malformed syntax/configuration, missing components, unsupported native
versions and incomplete output cannot yield pass. The stable toolchain's
unsupported JSON formatter mode is never enabled.

Style findings identify the file and `rustfmt/style`; they omit line numbers.
Detailed output retains bounded native evidence; summary output hides source paths
and raw output. The runner bounds total collected native output, selected files
and lexical scanning; the shared process runner bounds time/cancellation. Forced
termination can leave its temporary configuration for host cleanup. These controls
do not contain malicious project configuration, native tools or Cargo behavior.
Formatting does not establish type correctness, feature coverage or test coverage.
Doc comment code blocks and macro formatting follow the native configuration.

```json
{
  "schemaVersion": 1,
  "projects": [{ "path": ".", "checks": ["rust.cargo-fmt"] }]
}
```

The `rust-format` required profile exercises original broken/fixed/near-miss,
workspace-edition, generated-source, exclusion, output and CLI/MCP trust/privacy
controls. `verify-rust-format-package.mjs` requires the same tests against a fresh
offline production installation. The toolchain image pins its base and installs
only the two Rust 1.98.1 components during preparation. This is not complete
component artifact authentication or a development/container license audit.
See [recorded evidence](measurements/rust-format-2026-10-05.json).

Other OS/runtime/tool versions and hosted CI remain unverified. Clippy, Rust tests,
explicit compile feature/target profiles and the rest of Gate A remain open.

References: [Rustfmt](https://github.com/rust-lang/rustfmt),
[Cargo fmt](https://doc.rust-lang.org/cargo/commands/cargo-fmt.html).
