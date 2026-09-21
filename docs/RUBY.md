# Ruby syntax profile

`ruby.syntax` parses each inventoried `.rb`, `.rake` and `.gemspec` file, plus
`Gemfile` and `Rakefile` DSL manifests. Project discovery uses Gemfile/gemspec
boundaries, so nested projects receive separate checks. Extension matching is
exact; backups and ERB/RBS files are not silently treated as Ruby source.

Each file runs through installed MRI Ruby with `--disable-gems -c`, with `RUBYOPT`
cleared to prevent injected preload flags. The native version probe uses the same
environment and gem control. Source paths are individual literal arguments, never
shell fragments. Planning only enumerates files. Execution retains the normal
operator trust gate and shared time/output/source-freshness limits.

Every planned process must complete with zero exit, exact `Syntax OK` output and
empty stderr for a pass. Nonzero syntax-check exits fail; missing executables,
warnings/ambiguous output, timeout, cancellation and changed source cannot create
a passing aggregate. No test counts, type guarantees, gem-resolution guarantees
or Rails boot coverage are reported. Ruby runtime code, including `BEGIN` blocks,
is not evaluated by the native syntax-check flag; the fixtures assert this using
file-write sentinels. Invoking an installed tool remains trusted process execution,
not a sandbox or a guarantee about arbitrary wrappers on PATH.

Verified native versions are MRI 4.0.7 on Alpine Linux and the available MRI
2.6.10 on macOS. The older host version is compatibility evidence, not a runtime
recommendation. Other Ruby implementations/version output formats, RSpec,
Minitest, RuboCop, ERB/RBS checking and Rails integrations remain separate work.

The public fixture is `examples/ruby`. Run it with installed Ruby:

```sh
node dist/src/cli.js run --root examples/ruby --trust-project
```

The native container suite is `node scripts/verify-ruby-container.mjs`. It uses
already installed Ruby 4.0.7 and Node 22 images pinned by registry digest, records
their identities, disables
networking, and tests the public files in a temporary Linux copy. No gems are
installed. Native cases cover broken/fixed methods, misleading literal text,
per-file success evidence and top-level/BEGIN non-execution. Hosted CI evidence
remains pending; local tests do not establish remote matrix results.

Reference: [Ruby distributions and maintenance status](https://www.ruby-lang.org/en/downloads/).

The dedicated Ruby CI job prepares those pinned images and invokes the same
helper. `scripts/required-native-tests.json` identifies the exact native regression
that must pass. The required-test runner rejects skips, TODOs, missing or duplicate
required names, and failures elsewhere in the selected test file. A passing unit
test cannot replace the native regression. This job definition and its local
Linux/Node 22 execution are verified; a hosted job result remains pending.
