# Native Rust test profile

`rust.cargo-test` is opt-in. It requires an existing Cargo.lock and installed
Cargo, rustc and rustdoc 1.98.1. Planning inventories source and builds argument
arrays without evaluating manifests, build scripts or test bodies. Execution
requires operator trust. Compilers, build scripts, procedural macros, wrappers
and test bodies execute with the operator's privileges.

## Native phases

The shared Rust collector first checks all declared targets with offline locked
Cargo metadata, fresh compiler artifacts and exact inventoried Rust dep-info
accounting. It then runs `cargo test --no-run --all-targets --offline --locked`
with JSON build evidence in the same fresh output directory. This linking phase
produces test executables; it does not run their bodies. Unavailable compiler
profiles and incomplete source remain incomplete. Compilation errors and test
build/linking failures remain distinct from terminal test-case failures.

Every selected native test executable must be a fresh artifact for the current
package and declared target, confined to the canonical temporary output tree.
The collector obtains full and ignored listings, then executes each native
libtest harness with one test thread, no filters and no color. It similarly lists
and runs the declared rustdoc target through `cargo test --doc`. Without a build policy, the collector supports one workspace member and at most
one documentation target. The explicit multi-member feature/target profile is
documented in [RUST-BUILD.md](RUST-BUILD.md).

On macOS, direct libtest invocations use the canonical installed compiler's
host library directory and the owned executable's output/dependency directories
in `DYLD_FALLBACK_LIBRARY_PATH`. Cargo commands keep their own environment.
This supports the shared standard library used by native proc-macro test
executables. Arbitrary build-script library search paths are not reconstructed;
unsupported runtime dependencies remain incomplete. See Cargo's
[dynamic library paths](https://doc.rust-lang.org/cargo/reference/environment-variables.html#dynamic-library-paths).

The native profile runs whole groups. A controlled native probe showed that a
listed doctest name containing spaces could select zero cases with an exact
filter. Test inventories therefore have to reconcile against every terminal case
and result suite; a successful empty or filtered command cannot substitute for
that evidence.

## Counts and completeness

Native names, ignored identities, case statuses, suite totals and process exits
must agree. Multiple doctest suites are reconciled together. Exact native suffixes
identify expected-panic, compile-only (`no_run`) and expected-compilation-failure
(`compile_fail`) cases. Counts describe native framework cases, including those
compiler cases; they are not a count of runtime assertion statements. Mode labels
and native outputs remain in the detailed receipt. Captured failure output is
kept distinct from terminal native statuses, including success-like text printed
by a panicking test.

A passing profile needs at least one passing native case, no ignored cases and
complete compiler, artifact, listing and terminal evidence. Empty groups are
retained without inventing tests. Mixed or entirely ignored cases, unsupported
benchmark/custom-harness output, stale artifacts, escaped executables and omitted
source or targets cannot pass. Native case failures remain failed; incomplete
compiler scope and ignored accounting stay visible. Doctest source names must map
to an inventoried Rust source path; unsupported source forms remain incomplete.

Native output is bounded per invocation; group and test inventory limits also
apply. The engine enforces the validation's wall, output and cancellation limits.
This receipt does not audit every internal compiler subprocess or guarantee
cleanup after forced termination. Temporary output is removed on normal runner
exit. The collector directs Cargo output away from existing project caches;
project test bodies can still write files. A changed final source inventory
invalidates an aggregate pass. Files outside that inventory are not fully
fingerprinted.

## Readiness evidence

```sh
node scripts/verify-required-native-tests.mjs rust-tests
node scripts/verify-rust-test-package.mjs
```

Original synthetic Linux arm64 controls and fresh offline production installation
are recorded in [rust-tests-2026-10-05.json](measurements/rust-tests-2026-10-05.json).
The native profile uses Node 22.23.2. The public support matrix does not infer
macOS, Windows, other tool/runtime versions or hosted CI acceptance from that run.
These controls establish bounded integration readiness. Field evaluation,
independent model sessions and review-quality scoring have not run.

References: [Cargo test](https://doc.rust-lang.org/cargo/commands/cargo-test.html),
[libtest](https://doc.rust-lang.org/rustc/tests/index.html),
[doctest semantics](https://doc.rust-lang.org/rustdoc/write-documentation/documentation-tests.html).
