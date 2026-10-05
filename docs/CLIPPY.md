# Clippy analysis profile

`rust.cargo-clippy` is opt-in. Planning only inventories source and describes the
command; execution requires operator trust. The profile requires installed
Rust/Cargo 1.98.1, Clippy 0.1.98 and an existing local Cargo.lock. It never installs
components or dependencies. Build scripts, procedural macros and configured
compiler wrappers may execute project code with the operator's privileges.

The collector runs `cargo clippy --all-targets --offline --locked` with native
JSON compiler events and fresh temporary build and target directories. It passes
`--force-warn clippy::all` to the compiler. This deliberately activates Clippy's
recommended correctness, suspicious, style, complexity and performance groups,
including when source uses `allow` or `expect`. Project lint suppressions cannot
silently disable these groups in this selected profile. Other groups, including
pedantic, nursery, restriction and Cargo-manifest lints, are not activated by this
flag. Native Clippy configuration and its thresholds still apply.

Warnings carrying Clippy diagnostic codes fail this check even when native Cargo
exits successfully. Compiler warnings remain visible. Compiler errors fail with
incomplete analysis; configuration/execution errors and missing native completion
never pass. Identical findings across repeated target compilation are normalized
once. Native findings without a verified source address are retained without a
complete-analysis claim.

The same fresh artifact and exact inventoried Rust dep-info accounting as
[RUST.md](RUST.md) applies. The current compiler collector supports one member
rooted at the selected Cargo workspace. Unlinked inventoried source, stale output,
omitted test-mode targets and unavailable required-feature targets are incomplete.
Default Cargo features and the configured target apply. Passing does not establish
other feature combinations or target platforms. Compiling test targets does not
execute test bodies or produce test counts.

The required development profile is:

```sh
node scripts/verify-required-native-tests.mjs clippy
```

Offline installed-package acceptance uses `scripts/verify-clippy-package.mjs`.
The original synthetic Linux arm64 controls, compiling fault controls and fresh
production installation are recorded in
[clippy-2026-10-05.json](measurements/clippy-2026-10-05.json). The recorded native
profile uses Node 22.23.2. Other operating systems, runtime/tool versions and the
hosted CI run remain unverified. These are readiness controls; real-project field
evaluation and review-quality scoring have not run. The wider Rust test and
explicit compiler feature/target integrations remain required.

References: [Clippy groups](https://doc.rust-lang.org/clippy/index.html),
[usage](https://doc.rust-lang.org/clippy/usage.html),
[rustc lint levels](https://doc.rust-lang.org/rustc/lints/levels.html).
