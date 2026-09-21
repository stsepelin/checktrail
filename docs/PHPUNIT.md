# PHPUnit validation

Select `php.phpunit` explicitly. PHPUnit must be installed under `vendor` within
the configured root. Candidate files end in `Test.php`; PHPT and other filename
conventions need separate adapters. Planning does not execute PHP or autoloaders.

The adapter invokes the installed PHPUnit and streams fresh JUnit XML to stdout.
Normal console output is disabled to keep that stream unambiguous. Configured
logging and test-run history recording are disabled; the adapter does not create
or reuse a JUnit file. Native configuration, bootstrap, extensions, environment
requirements and coverage configuration still apply. Trusted application code
can have side effects, and missing prerequisites are not installed automatically.

Native `--all` disables configuration-based test selection, while the explicit
file list fixes this adapter's scope. Empty suites, risky tests and warnings
cannot silently pass. The parser reconciles native suite/case counts, requires
every planned file, and requires positive assertion counts for passing cases.
This last check also rejects assertionless tests when native strictness is turned
off. Skipped cases do not supply passing evidence. A zero-exit report omitting a
planned file is incomplete. Native failures remain failures.

Verified native versions are PHPUnit 13.3.4 and PHP 8.5.6. Fixtures exercise
passing/failing assertions, exceptions, skips, empty files, assertionless tests
with strictness disabled and multiple test files. Parser cases exercise omitted
files, missing assertions, truncation and process failure. Project frameworks,
inherited tests declared outside the planned files, alternate runners and older
PHPUnit CLI versions remain unverified.

The [PHP tooling preparation and container script](PHPSTAN.md) also run these
fixtures. Verification uses an inspected local official Composer image, no
network and synthetic fixtures created inside Linux. Host tests explicitly skip the native
case when PHP or the prepared tools are absent.
