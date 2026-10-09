# Declared Rust extension acceptance

The workspace contract in [RUST-BUILD.md](RUST-BUILD.md) supports explicit member,
feature and target profiles. The `rust-extensions` acceptance profile exercises
host-native lean/extra combinations and wasm32 compilation and Clippy, with
native runtime and documentation tests on the host. A compiler success for wasm32
is not runtime coverage. Existing workspace acceptance separately retains
build-script generated modules and procedural macro participation; generated
contents are not a complete source identity.

A workspace profile may select `nativeToolchain: "linux-arm64-gnu-1.98.1"`.
This optional declaration requires the measured Linux ARM64 GNU installation:
six executable resolutions and sixteen selected compiler, driver, LLVM, host and
wasm32 standard-library artifact identities must agree before Cargo resolves or
executes the workspace, and again after the witnesses finish. Version output
alone is insufficient. Discovery and planning read data only. Execution still
requires operator trust, including build scripts, procedural macros and tests.

The selection checks the artifacts in `src/rust-toolchain-pins.ts`; it does not
cover the whole installed toolchain, system libraries, linker, all environment
variables, Cargo configuration overrides or publisher/license provenance.
The public component preparer verifies six exact official archives against the
pinned release manifest before installing any output. Archive member paths and
links are preflighted for all components before task-owned extraction. Corrupt
final components are rejected before any extraction, including with Python
optimization enabled; retained payload is never replaced. This is
selected byte identity, not signature or whole dependency closure verification.

Every workspace command binds the planned bounded inventory fingerprint and
rechecks it before project execution and after native witnesses. Changed source
invalidates the check. Build and target directories belong to the engine's
per-command temporary directory, so reached cancellation, timeout and output
exhaustion remove the actual native build directory. Caller-owned `target`
contents remain separate. Actual child stdout/stderr are forwarded while alive
with bounded capture and backpressure; Cargo may itself buffer build-script
logs. This does not establish a ledger of every internal subprocess or a bound
on Cargo's internal buffering and storage.

The acceptance controller requires preserved Rust callbacks, all nine source
categories, a fresh offline production installation of the same categories,
compiling guard removals, and planning/source/schema regressions. A successful
native test changes a selected executable in its owned toolchain copy; the
post-execution byte check invalidates that receipt despite stable project source. The original
boundary failure rejects `grantToken` while allowing `grant` and `grant:read`.
Native tests that finish with a failure retain known counts; interrupted doctest
execution retains unknown aggregate counts. Summary, CLI and negotiated MCP
checks retain privacy and operator-only trust. Lifecycle controls reach both an
actual Rust test process and its detached worker before applying control.

```sh
node scripts/prepare-rust-extension-components.mjs
python3 scripts/extract-rust-extension-components.py
docker build --network none --file scripts/rust-extension-tools.Dockerfile \
  --tag checktrail-rust-extensions .
CHECKTRAIL_RUST_EXTENSIONS_IMAGE=checktrail-rust-extensions \
  node scripts/verify-rust-extensions-container.mjs
```

Prepare the locked npm acceptance cache before the controller. Agents use the
shared managed task runner for these commands. Further platforms, full native
license/artifact closure and the final runtime matrix require separate evidence.
Gate A, inference, field evaluation and comparative review quality remain open.
