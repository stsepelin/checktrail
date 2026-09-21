# Required native CI evidence

The ordinary test suite permits explicit skips for unavailable optional tools.
That makes it useful on a developer machine, but its aggregate exit code cannot
establish that a native adapter ran. CI's prepared profiles additionally use
`node scripts/verify-required-native-tests.mjs PROFILE`.

The [profile manifest](../scripts/required-native-tests.json) lists exact test
names and files. The runner requires each listed test to pass exactly once,
rejects any failure, skip or TODO in the selected files, and distinguishes a
passing suite from a passing test. A similarly named test, a test in another
file, or a passing unit test cannot stand in for a missing native regression.
Expected names are fixed inputs; the runner does not discover its requirements
from whichever tests happen to remain in the source tree.

The main CI matrix prepares and requires `core`, `javascript`, `python`,
`frameworks`, `go`, `php-tools`, `laravel` and `rust`. Dedicated container jobs
require `clang`, `java`, `dotnet`, `actionlint`, `vue-router` and `nuxt`.
Ruby and Swift have dedicated required-native jobs. The packaged review and
durable-task helpers require `review` and `tasks` before their installed-package
checks. The separate PHP syntax helper checks its exact successful TAP test name;
the external-adapter helper already checks exact required native names for each
of its different runtime containers.

The main matrix also prepares the separately locked TypeScript 4.9.5 compiler
from `scripts/typescript-legacy-tools/`. Its named native regression is mandatory
in the `javascript` profile; root build tooling stays on its existing compiler.

A tool version preflight remains useful but is not the acceptance condition.
Installing the expected binary cannot compensate for a skipped, renamed, removed
or failing required test. When intentionally renaming or replacing a regression,
review its behavior and update the manifest with that change. Do not remove a
requirement merely to make an unavailable toolchain green.

The native profiles supplement the full suite; they do not replace linting,
type checking, parser tests, privacy tests or package verification. Some selected
files contain both native and unit cases, so `passed` counts in their summaries
are test counts, not native-tool invocations. Profiles can overlap with the full
suite. Do not add their pass counts together as independent coverage.

Container helpers retain their existing prepared dependencies, network-disabled
execution and read-only source mounts. They do not install tools while measuring.
A main hosted job prepares dependencies before validation. Local container runs
are evidence for their actual versions and platforms only; the GitHub Actions
matrix requires its own successful run before being claimed as verified.

The runner's regression tests exercise required-test absence, exact name/file
identity, duplicates, skips, TODOs, suite-only matches and unrelated failures.
Deleting its missing-test rejection makes the absent-test case fail. To diagnose
a native assertion failure, rerun the named file directly with `node --test` in
the same prepared runtime for the full assertion diagnostics.

The [recorded local profile runs](measurements/required-native-profiles.json) retain
requirement/helper digests, result accounting and available container/package
identities for the expanded profiles. Each listed requirement passed in those
runs. The unchanged Ruby/Swift paths have their separate local evidence in
`RUBY.md` and `SWIFT.md`. These records do not claim that the hosted matrix ran,
that all profiles ran in a single environment, or that overlapping counts are
independent tests.

## Fresh-runner package preparation

`npm ci` installs from the repository lockfile but does not necessarily cache
the registry metadata needed to resolve a new consumer's dependencies. Before
packaged checks, CI runs `node scripts/prepare-package-cache.mjs` with network
access. It packs the current build and installs it in a disposable consumer with
lifecycle scripts disabled, using the same npm cache as the later smoke helpers.
The disposable installation is removed; only the npm cache is reused.

The smoke helpers still create fresh consumers and install with `--offline`.
Native container checks still use `--network none`. Cache preparation is setup,
not evidence that a package can be installed without previously cached dependencies.
For local reproduction, run `npm run build`, the cache preparation script, then
`node scripts/smoke-package.mjs`, keeping the same npm cache configuration.

The [first hosted run](https://github.com/stsepelin/checktrail/actions/runs/35570317427)
exposed this missing setup: Java, C#, actionlint, external adapters, Vue Router and
Nuxt reached packaged installation after their native checks, then failed with
`ENOTCACHED`. All three Linux main-matrix jobs reached the same failure after
passing their full suites and required native profiles. Clang, Ruby and Swift
jobs passed. The macOS main job failed separately because Pint attempted to seek
within `/dev/null`; the adapter now uses a fresh regular cache file in a
runner-owned directory, with cleanup asserted after successful and failed checks.
See `PINT.md`. A later macOS assertion also needed canonical rather than aliased
temporary paths; its fixture now exercises a symlinked root on every platform.
All three fixes are included in the successful run below.

## Successful hosted baseline

[Run 35573066804](https://github.com/stsepelin/checktrail/actions/runs/35573066804)
passed all 13 jobs at commit `52ba415dfc5cfcaab459dc648baaa864627f1642`.
The [job and step record](measurements/hosted-ci-52ba415.json) retains the source
identity, run URLs, outcomes and timestamps. The main matrix covered Linux Node
22/24/26 and macOS Node 24; dedicated jobs covered Java, C#, Clang, actionlint,
external adapters, Vue Router, Nuxt, Ruby and Swift.

This establishes the configured profiles for that revision and those hosted
environments. Optional skips in the general suite still do not count as native
coverage. The `0.1.0-alpha.1` release metadata and documentation follow this
baseline; the release commit needs its own CI run before publication.
