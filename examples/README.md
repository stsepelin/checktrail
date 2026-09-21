# Synthetic examples

Each directory is independent and contains original fictional demonstration code.
From the repository root, build once, then run:

```sh
node dist/src/cli.js run --root examples/javascript --trust-project --detailed
node dist/src/cli.js run --root examples/python --trust-project --detailed
node dist/src/cli.js run --root examples/go --trust-project --detailed
node dist/src/cli.js run --root examples/php --trust-project --detailed
node dist/src/cli.js run --root examples/rust --trust-project --detailed
node dist/src/cli.js run --root examples/ruby --trust-project --detailed
node dist/src/cli.js run --root examples/swift --trust-project --detailed
node dist/src/cli.js run --root examples/cpp --trust-project --detailed
node dist/src/cli.js run --root examples/java --trust-project --detailed
node dist/src/cli.js run --root examples/dotnet --trust-project --detailed
node dist/src/cli.js run --root examples/actionlint --trust-project --detailed
```

These require the corresponding installed native toolchains. Rust uses the pinned
Cargo compilation profile; Ruby and Swift demonstrate syntax-only validation. Missing tools produce an
incomplete result. The PHP example checks syntax only. To demonstrate failure,
change the arithmetic implementation while keeping its tests unchanged. To
demonstrate false-green prevention, replace the JavaScript test file with an
empty file: the run becomes incomplete even though Node exits successfully.

Executable rule-specific broken/fixed/near-miss cases also live in the automated
tests. More semantic rule packs and larger integration fixtures are planned.

The `mutations/` example runs an explicitly authored mutation recipe against flat
Node tests. From the repository root:

```sh
node dist/src/cli.js mutate --root examples/mutations --input mutations.json --trust-project --detailed
```

It demonstrates an assertion kill and a survivor in temporary copies. Neither
classification is a repository-wide test adequacy claim.
