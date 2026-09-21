# Rust compilation profile

`rust.cargo-check` is the default check for an inventoried Cargo project. It uses
installed Rust/Cargo 1.98.1 and requires an existing local `Cargo.lock`. Planning
never invokes Cargo or build scripts. Validation needs the normal operator trust
permission; Cargo build scripts and procedural macros can execute project code.

The current profile supports one Cargo workspace member rooted at the discovered
project. Multi-package workspaces and other toolchain versions remain unavailable
until separately verified. Native fixtures run on Linux with the official
`rust:1.98.1-alpine` image and Node 22.23.2. The container helper prints resolved
image digests and disables networking. Host platforms beyond that fixture remain
unverified for this profile.

## Execution and scope

The collector resolves native metadata with `--offline --locked --no-deps`, then
runs `cargo check --all-targets --offline --locked --message-format=json` with
fresh temporary target and build directories. Both native metadata directory
values must confirm the overrides before compilation starts. Existing target
directories are not reused. Incremental compilation and rustup's automatic
toolchain installation are disabled. No dependency or lockfile installation is
performed. These Cargo settings do not sandbox build scripts, macros or custom
compiler wrappers; their network and filesystem privileges remain the operator's.

Each inventoried `.rs` file must appear in fresh rustc dep-info dependencies. Each
declared native target must have a matching artifact, with test-mode artifacts
required where the target enables tests. Missing source, excluded feature targets,
missing test-mode compilation and artifacts marked fresh/reused are incomplete
evidence. No test bodies are executed and no test counters are reported. This does
not prove every conditional branch or feature combination was compiled. Default
Cargo features and the configured host/target apply; other feature/target matrix
profiles are not implemented.

Dep-info decoding supports ordinary paths, Unicode and escaped spaces. Newline,
backslash, dollar, hash and colon in the inventoried source paths are outside this
initial verified grammar. Malformed or unsupported dependency rules fail
completeness rather than being guessed. The collector bounds native output, build
inventory entries and dependency-file bytes; the shared process runner bounds
time, cancellation and total output. Temporary output is removed on normal runner
exit; forced termination can leave temporary files for host cleanup.

Compiler error diagnostics fail the check. Their normalized code, message and
available source location are retained; compilation errors are never eligible as
complete baselinable analysis. Warnings remain visible but do not fail this
compilation check. A nonzero Cargo exit without structured compiler-error evidence
is an execution/configuration error. A passing result requires a successful final
build event, complete target/source accounting and identified native tools.

This is compiler checking, not linking, Clippy, formatting, test execution or a
hermetic build guarantee. Dependency content, external files, custom wrappers and
all environment effects are not fully fingerprinted. Users with non-default
`CARGO_HOME`/`RUSTUP_HOME` locations can declare those environment requirements and
grant them through the existing operator environment mechanism.

## Reproduce

With the pinned toolchain installed:

```sh
node dist/src/cli.js run --root examples/rust --trust-project
```

Change the module's numeric return to a string in a temporary copy to observe
`rustc/E0308`. Add an unlinked Rust file to observe incomplete scope. The development
native suite is `node scripts/verify-rust-container.mjs`; it uses already installed
images and does not pull them. It verifies escaped-space paths, broken/fixed code,
target/source accounting, preserved existing build output, unavailable workspaces
and build-script source. The fixture contains a deliberately panicking test body
to distinguish compilation from test execution.

References: [Cargo check](https://doc.rust-lang.org/cargo/commands/cargo-check.html),
[JSON messages](https://doc.rust-lang.org/cargo/reference/external-tools.html),
[rustup environment controls](https://rust-lang.github.io/rustup/environment-variables.html).
