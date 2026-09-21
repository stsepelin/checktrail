# Pest validation

Select `php.pest` explicitly with Pest installed in `vendor` and a local
`phpunit.xml` or `phpunit.xml.dist`. Planning reads paths only. Configuration is
required because Pest otherwise creates temporary configuration, including during
its version probe. Execution loads trusted project bootstrap code and plugins.

The adapter uses `--ci` to run focused siblings, `--no-tia` to disable cached
impact-result replay, and PHPUnit's full selection, no history, warning/risky
failure and fresh JUnit flags. Pest writes progress to stdout; JUnit is streamed
separately through stderr and parsed with bounded XML validation. Malformed or
mixed output is incomplete. Every planned `*Test.php` file must have native case
evidence, and passed cases need positive assertions. Native method suffixes in
Pest's file attributes are removed before exact file comparison; filenames
containing `::` are unavailable because that representation is ambiguous.

Pest 5.2.1 with PHP 8.5.6 has been exercised in the installed official Composer
Linux image with no network and synthetic sources created inside the container. Regression cases
cover assertions, focused siblings, datasets, fixture failures, skipped/todo and
empty suites, assertionless cases, missing snapshot rejection, multiple files,
missing plugin metadata and configured always-on TIA. No source changes occurred.
This does not establish Laravel integration, browser tests, parallel execution,
ancestor-vendor workspace bootstrapping or compatibility with older Pest versions.
The verifier does not select Pest automatically from PHP filenames.

Prepare tools as documented in [PHPStan](PHPSTAN.md), then run
`node scripts/verify-php-tools-container.mjs` after building. The locked development
manifest allows only `pestphp/pest-plugin`; Composer uses that plugin to generate
Pest's plugin inventory. Project scripts remain disabled. The native fixture
prepares the mutation plugin's empty vendor cache directory before its
run. This preparation is separate from consumer validation and never runs
implicitly during planning or validation.

Pest documents its [CI behavior](https://pestphp.com/docs/continuous-integration)
and [CLI flags](https://pestphp.com/docs/cli-api-reference). Native tests, rather
than those descriptions alone, establish the behavior advertised here.
