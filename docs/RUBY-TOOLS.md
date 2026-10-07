# Bounded Ruby native tools

The bounded native source and offline installed-package profiles have passed,
including compiling guard mutations with original test callbacks and no skips.
The [measurement receipt](measurements/ruby-tools-native-2026-10-06.json) pins the
implementation, harness, runtime, artifacts and measured scope. Broader E13 profiles
and Gate A remain open.

`ruby.rubocop`, `ruby.rspec` and `ruby.minitest` share the engine used by the CLI
and MCP. They are opt-in through `checktrail.ruby-tools.json` or explicit check
selection. Select only the frameworks declared by the project in `checktrail.json`;
a selected framework with no declared test files is unavailable. Existing
`ruby.syntax` remains independent and does not evaluate Ruby manifests.

The bounded profile selects MRI 4.0.7, Bundler 4.0.20, RuboCop 1.91.0,
RSpec Core 3.13.6 and Minitest 6.0.6. It uses exact source-gem versions and raw
SHA-256 checksums for every locked archive. A configured gem repository is prepared
by the operator; execution restores it into fresh owned output with `bundle install
--local`, frozen resolution and checksum validation. Native extensions and gem
code execute under operator trust. The engine never invokes the network preparation
scripts, and an MCP tool argument cannot grant execution.

## Declarative scope and configuration

The schemas are [ruby-tools-config.schema.json](../schemas/ruby-tools-config.schema.json)
and [ruby-tools-repository.schema.json](../schemas/ruby-tools-repository.schema.json).
The original [example](../examples/ruby-tools) includes the checksum-bearing lock.
Declare all inventoried Ruby sources exactly once, selected test files, explicit
support files and exact cop identifiers. Test/support files must belong to that
source set. Test targets cannot be duplicated across frameworks. Inputs and the
raw artifact tree are bounded, canonical and regular, without links or unexpected
archives.

Planning reads data and never evaluates a Gemfile, gemspec or project config.
This profile accepts only literal public-source Gemfile declarations with exact
versions and a pinned Ruby version. The bounded lock grammar requires one GEM
source, a complete spec/dependency/checksum closure, source platforms, the selected
runtime and Bundler identity. GIT/PATH sources, conditional/grouped DSL, version
ranges in top-level declarations, platform-specific binary gems and other lock
formats need another verified profile.

RuboCop gets an owned config enabling only the declared cops, an explicit complete
file list and JSON output. Repository config, inherited options, correction and
cache behavior cannot narrow or rewrite this invocation. Its metadata, file set,
diagnostics, target/inspection counts and native exit must reconcile. Syntax
diagnostics remain failures even when syntax is not a selected cop.

RSpec uses an owned empty options file and records the unfiltered registered
examples, started IDs, results and summary. A filtered, empty, omitted or duplicate
case cannot pass. Display names do not supply source identity: the selected
callback's native source location must belong to a declared test file.

Minitest records registered runnable methods, native prerecord/result events,
source locations and the native summary. Discovery sets the selected seed before
querying runnable methods. The observer disables a second autorun and preserves
the native reverse-order after-run callbacks. Plugin changes, missing source
locations, unknown counts and lifecycle errors remain incomplete.

## Source, artifact and outcome evidence

The pinned MRI compiler maintains `SCRIPT_LINES__` for parsed file bytes.
The original TracePoint observer binds those bytes to inventoried SHA-256 pins;
Gemfile evaluation is bound through its native `eval_script` bytes. This profile's
file-load instruction sequences do not expose retained `script_lines`, so a
filename or a later filesystem read cannot substitute for that compiler input.
Dynamic/fake project sources without this binding remain incomplete.

Every native collection binds the owned observer/settings, before/after project
inputs, raw gem repository, restored artifact manifest and actual native tool
entry-point bytes. This is receipt coherence under trusted execution; it is not
hostile-project OS attestation or complete Ruby SDK provenance. The fresh install
is removed at completion, and cancellation removes the owned command directory.
Native source locations identify the registered failing case. They do not establish
its production cause, severity or a remedy.

Source-bound native test failures produce findings. A fully reconciled run passes
only when every registered case ran and none was skipped. All-skipped, zero-test,
filtered, malformed, interrupted and unavailable checks cannot pass. RSpec assertion
counts remain unknown; Minitest's reported assertion count is reconciled with its
results. Framework errors outside cases are incomplete, with no invented test count.

## Required controls and preparation

The `ruby-tools` profile in
[required-native-tests.json](../scripts/required-native-tests.json) requires exact
original callback identities with zero skips. Each original native control runs in
its own test file under the same 300-second file deadline. The earlier combined
main and lifecycle files exhausted that deadline on the local pinned runtime;
those incomplete attempts do not count as acceptance. The shared lifecycle
helper and the offline installed harness retain every original callback. Engine
command limits are unchanged. The [CI repair receipt](measurements/ruby-ci-sharding-2026-10-06.json)
records the unchanged callback bodies and separate source/installed results.
Its controls cover literal near misses,
production boundary regressions and repair, artifact/runtime/settings/source/case
mutations, empty/filtered/skipped/setup/teardown/after-run behavior, protected host
options, changed archives and sources, CLI/MCP privacy and startup trust, and reached
RSpec/Minitest body cancellation with descendant/output cleanup.

Run these explicit operator preparation commands from a prepared checkout:

```sh
npm run build
CHECKTRAIL_TEST_TASK=original-ruby-task node scripts/prepare-ruby-tools-runtime.mjs
node scripts/prepare-ruby-tools-container-dependencies.mjs
```

The runtime preparer retrieves each original Alpine compiler package from its
exact official URL, using the architecture-specific size and SHA-256 pins in
`scripts/ruby-tools-archives.json`. It does not resolve a current package index:
new transitive package revisions cannot silently replace the pinned closure.
It checks regular raw artifacts and builds the pinned Ruby/Node image with network
disabled and normal APK signature checks. The declared ARM64 package hashes match
the original recorded profile; x86-64 package pins support the hosted preparer.
An operator-prepared cache can be selected with `CHECKTRAIL_RUBY_APK_DIRECTORY`;
every cached file receives the same path, size and digest checks. Prepare gems inside that image by running
`scripts/prepare-ruby-tools-dependencies.mjs` in an explicitly network-enabled
preparation container with the checkout mounted writable. That command validates
all raw gem checksums, leaves the public Gemfile/lock unchanged and installs no gems.
The engine performs no such fetch. The container dependency command above is
the explicit preparation invocation. Then run:

```sh
node scripts/verify-ruby-tools-container.mjs
```

Acceptance uses networking disabled, bounded container CPU/memory, readonly
checkout/cache mounts and original fixtures copied into container-owned scratch.
Source and fresh offline production installation are separate required runs. The
external harness imports shipped runtime bytes and invokes the installed CLI;
fixtures and the acceptance client remain outside the production package.

At task end, stop the owned foreground work and verify its status, then run
`node scripts/cleanup-ruby-tools-runtime.mjs` to remove only the recorded owned
image tag. It refuses cleanup while any owned container remains and preserves
code, branches and preparation artifacts. Agents on this Mac use the shared
`dev-env` foreground lifecycle for these commands.

These controls invoke no inference and perform no real-project field evaluation.
Hosted CI, other native OS/architecture/SDK versions, broader Gemfile/framework
conventions, complete SDK/compiler/publisher/license attestation and hostile-project
containment remain separate obligations. Performance measurements describe this
small original profile; they do not establish representative project cost or review
quality.

## Primary references

- [RuboCop machine-readable JSON](https://docs.rubocop.org/rubocop/latest/formatters.html)
- [RSpec custom formatter notifications](https://rspec.info/features/3-13/rspec-core/formatters/custom-formatter/)
- [Ruby TracePoint API](https://docs.ruby-lang.org/en/master/TracePoint.html)
- [Ruby retained-source proposal and SCRIPT_LINES__ distinction](https://bugs.ruby-lang.org/issues/18231)
- [Bundler checksum introduction](https://bundler.io/blog/2024/12/19/bundler-v2-6.html)

The original native controls establish the chosen installed versions' behavior;
current documentation alone does not establish that profile's acceptance.
