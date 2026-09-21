# Swift syntax profile

`swift.syntax` parses every inventoried `.swift` file, including `Package.swift`,
using installed `swiftc -frontend -parse -no-color-diagnostics`. It does not run
SwiftPM or evaluate the package manifest. The `.build` tree is excluded as generated
dependency/build output and remains visible in inventory exclusions.

This is grammar validation only. It does not type-check, resolve imports or package
dependencies, evaluate macros, link products, execute application code or run tests.
A syntactically valid `Int` initialized with a string can pass this profile; a native
regression test deliberately demonstrates that boundary. Active compilation
conditions follow the native parser's environment, not an all-platform matrix.

Planning only enumerates source. Running the compiler retains the operator trust
gate and the common literal-argument, process-tree cancellation, time/output and
source-freshness safeguards. Every planned file needs a zero exit and empty
stdout/stderr. Compiler errors fail; unexpected success output is incomplete.
Compiler identity is required. Apple Swift's separate driver-version stderr banner
is accepted only in its exact verified shape; arbitrary warnings are not ignored.

The native profile is verified with Apple Swift 6.4 on arm64 macOS, using the
available compiler build recorded in detailed version-probe output. Its version is
recorded as `6.4`, without inventing a patch component. Linux, SwiftPM build/test,
type checking and compiler plugins need separate execution evidence.

The public fixture is `examples/swift`:

```sh
node dist/src/cli.js run --root examples/swift --trust-project
```

The native test copies those public files to a temporary workspace, verifies that
top-level file-writing code is not executed, checks that `.build` is not generated,
and exercises broken grammar, repaired syntax and the type-checking limitation.
No dependencies are installed. As with every tool invocation, an arbitrary compiler
wrapper still runs with the operator's privileges; this is not sandboxing.

References: installed `swiftc -frontend -help` and the
[official compiler option definitions](https://github.com/swiftlang/swift/blob/main/include/swift/Option/Options.td).

The dedicated macOS CI job prints the runner's Swift version and invokes
`node scripts/verify-required-native-tests.mjs swift`. The exact native regression
must execute and pass; a skipped or missing compiler test fails this job. The
runner also rejects TODOs, duplicate required names and other failures in the
selected test file. Local Apple Swift 6.4 execution passes this required-test
path. The hosted runner's compiler is not pinned, and no hosted job or additional
compiler-version support is inferred from the workflow definition.
