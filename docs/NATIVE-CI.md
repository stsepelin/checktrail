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
matrix remains unrun until the repository is published and hosted jobs succeed.

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
