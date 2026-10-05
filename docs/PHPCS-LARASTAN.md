# PHP review tools

The opt-in `php.php-cs-fixer` check uses a project-local Composer installation
of PHP-CS-Fixer **3.95.27** and `.php-cs-fixer.php` (preferred) or
`.php-cs-fixer.dist.php`. Planning reads paths only. Execution requires operator
trust, because Composer autoloading, custom fixers and PHP configuration can run
project code. This execution is not sandboxed.

The original runner resolves configuration once and intersects its native Finder
with declared non-Blade PHP files. The two formatter configuration names are
excluded from formatting; select `php.syntax` separately to check them. It uses
native sequential dry-run processing, disables cache use, rejects risky rules,
and never enables unsupported PHP versions. Native events account for every
selected file, including files requiring no changes. Empty, skipped, excluded,
non-monolithic or unaccounted files remain incomplete. No active rules, a broken
configuration or a fixer exception cannot produce passing source evidence.

Formatting findings retain the native fixer identifier and exact file. The
combined native diff does not identify a separate line for every applied fixer,
so these findings omit a line. Syntax diagnostics preserve their native message.
The engine retains bounded detailed output and checks source identity before and
after execution; summary output excludes file names, tool versions and raw logs.
Arbitrary trusted configuration can still write files or perform other actions.
The no-write controls attest the runner's dry-run/cache settings and the synthetic
fixtures, not containment of malicious configuration.

Larastan is activated by the project's PHPStan NEON `includes`, through the
existing `php.phpstan` check. Installation alone does not activate the extension.
The bounded synthetic profile pins **Larastan 3.12.3**, **PHPStan 2.2.14** and
**Laravel 13.32.0**. PHPStan's native per-file debug output must reconcile with
all declared PHP files, alongside diagnostic totals. Analysis exclusions remain
incomplete. Framework bootstrap failures are execution errors rather than source
findings. The fixture disables database/migration scans and uses generated PHP
source; it does not establish database schema, ORM query, live service or general
Laravel application coverage.

Projects requiring explicit environment variables declare their names in
`checktrail.json`; the operator grants each with `--allow-env NAME`. Supplying a
value without the declaration does not forward it to native execution. Synthetic
framework caches live in the fixture's excluded `.checktrail` directory; missing
cache directories and missing environment grants are prerequisite controls.

```json
{
  "schemaVersion": 1,
  "projects": [{ "path": ".", "checks": ["php.phpstan", "php.php-cs-fixer"] }]
}
```

Prepare the separate locked test toolchain using
`scripts/php-review-tools/composer.json` and `composer.lock`, with Composer plugins
and lifecycle scripts disabled. Existing PHP/Laravel fixture lockfiles are not
upgraded by this profile. `php-review-tools.Dockerfile` pins the PHP/Composer and
Node images. Execution uses no network and a read-only workspace mount; the
container root filesystem remains writable for disposable test fixtures.

The exact `php-review` required tests cover native broken/fixed/valid controls,
missing extension and prerequisites, skipped/excluded files, generated source,
config failures, cache/source preservation and shared CLI/MCP trust/privacy.
`verify-php-review-package.mjs` repeats them against a freshly packed, offline
production installation with an external acceptance harness. Installed dependency
metadata and notice hashes are separately reconciled by
`audit-php-review-tools.mjs`; that audit is not artifact authentication or a legal
assessment. See [recorded evidence](measurements/php-review-2026-10-05.json).

The measured native platform is Linux arm64, PHP 8.5.6 and Node 22.23.2.
macOS native PHP, Windows, other native versions, hosted CI, model inference,
field review and comparative reviewer quality remain unverified. Gate A remains
open for the wider required inventory.
