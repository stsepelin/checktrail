# C and C++ compilation checks

`cpp.clang-check` runs Clang's front end using a prepared project-root
`compile_commands.json`. Detection recognizes that file, `CMakeLists.txt` and
`meson.build`. Discovery and planning never execute a build system. Missing or
unsupported configuration is unavailable rather than a successful compilation.

```sh
node dist/src/cli.js run --root examples/cpp --trust-project --detailed
```

The public example contains separate C17 and C++20 translation units and shared
headers. Its portable database is authored explicitly. A consumer can prepare a
database using its own build system, then place it in the inventoried project
root. A database left only under excluded `build/` is not used automatically.

## Supported database profile

The [Clang compilation database specification](https://clang.llvm.org/docs/JSONCompilationDatabase.html)
defines argument arrays separately from shell command strings. This profile
requires `arguments`; it never tokenizes or executes `command`. When both fields
exist, the argument array is used. Directory and input paths must resolve within
the operator root, and each entry must name exactly one inventoried C/C++ source.
Relative directories are interpreted from the project root; other relative paths
are interpreted from the entry's directory.

The compiler must be `clang` or `clang++`, or an absolute path resolving to the
same executable selected by PATH. Wrappers, response files and arbitrary compiler
paths are unsupported. The selected PATH is protected for execution. Multiple
distinct configurations of a source file are checked; duplicate normalized entries
are rejected.

The closed flag set supports:

- C and C++ language-standard flags explicitly enumerated in `src/clang.ts`.
- Object-like `-D` definitions and `-U` undefinitions, preserving literal values.
- Root-contained `-I`, `-iquote` and `-isystem` directories.
- `-O0` through `-O3`, `-Os`, `-Og`, `-Oz`, PIC/PIE, pthread,
  no-exceptions and no-rtti settings.
- `-Wall`, `-Wextra`, `-Werror`, `-Wpedantic`, `-Wconversion`,
  `-Wsign-conversion`, `-Wshadow`, `-Wunused`, `-Wunused-parameter` and
  `-Wno-unused-parameter`.

Compile/output/dependency arguments (`-c`, separate `-o`, `-MF`, `-MT`, `-MQ`,
`-MD`, `-MMD`, `-MP`) are replaced with engine-owned front-end/dependency output.
`-g` and `-g0` are omitted. Source and include path spellings are preserved because
rewriting relative paths can change `__FILE__`. All other flags are unavailable;
the adapter does not silently drop unknown target, language, plugin or ABI options.
Cross-compilation, modules, precompiled headers and compiler plugins need separate
profiles. Default Clang configuration loading and implicit modules are disabled.
Compiler override/include environment variables are protected; they cannot be
injected through project environment requirements.

## Evidence and limits

The engine requires native SARIF diagnostics for each database entry and a fresh
compiler dependency file. It reconciles entry identity, process status, diagnostic
severity and compiler version. Native compiler errors fail the check; malformed
or partial evidence cannot pass. Warnings are retained and follow the configured
native warning policy, including `-Werror`; this is not an all-warnings lint policy.
Source-level pragmas and the selected preprocessor definitions remain part of
native compiler semantics.

Every inventoried C/C++ translation unit and header must appear in at least one
observed dependency list. Uncompiled sources, unused headers, generated project
headers under excluded directories, and symlinked project inputs make the result
incomplete. Nested projects retain separate inventory boundaries. The recognized
extensions are listed in `src/clang.ts`; Objective-C, CUDA and assembly are not
covered. C++ module extensions `.ixx` and `.cppm` are explicitly unavailable.

System/toolchain headers outside the root are counted separately in the detailed
process evidence. They are not included in the source fingerprint; host SDKs,
standard libraries and compiler binaries are not hermetic inputs. The evidence
does not cover inactive preprocessor branches, every target configuration, linking,
code generation, ABI compatibility, static-analysis rules or executed tests.
No object files or configured build outputs are written by this profile. Native
tools run with operator trust and are not sandboxed.

The database is bounded to 64 entries and 256 arguments per entry; the prepared
invocation must fit 100 KiB. Each native process has bounded captured output and
the wrapper limits aggregate native output to 4 MiB. Dependency files are capped
at 8 MiB each and 16 MiB total. The shared engine also enforces its total timeout,
output, source-freshness and cancellation limits. Dependency outputs use a fresh
temporary directory, removed on normal completion/error. Forced process or machine
termination can leave that directory. Newline, backslash, dollar, hash and colon
in source paths are unsupported; native literal-space dependencies are tested.

## Verified toolchains

- Apple Clang 21.0.0, build `clang-2100.3.34.2`, arm64 macOS.
- Alpine Clang 22.1.3, arm64 Linux, with Node 22.23.2 in a prepared container.

Other versions are unavailable until their native evidence has been verified.
Apple's SARIF includes an invocation result and a full version banner; the tested
Alpine build omits the invocation record and uses a numeric version. The parser
checks each verified form rather than assuming the outputs are identical.

Prepare the development fixture explicitly, then run it without networking:

```sh
docker build --file scripts/clang-tools.Dockerfile --tag checktrail-clang-test:22.1.3 scripts
node scripts/verify-clang-container.mjs
```

The base image digest and Clang/LLVM package versions are pinned. Auxiliary Alpine
toolchain dependencies are resolved during preparation, so this is not a completely
locked container supply chain. Verification records the resulting image digest,
mounts the repository read-only and creates synthetic fixtures inside the container.

Tests cover the actual public example, native C/C++ errors and repair, header
coverage, ignored build configuration, relative `__FILE__` spelling, working
directories, space-containing includes, standard-library headers, multiple
configurations, warnings, missing compilers and malformed evidence.
