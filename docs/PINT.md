# Pint validation

Select `php.pint` explicitly with Pint installed under `vendor` within the
configured root. This experimental adapter supports Pint 1.32.1. Other versions
are incomplete until their internal integration and native fixtures are verified.
Planning only resolves installed paths and inventoried non-Blade PHP files.
`*.blade.php` templates are outside this check's scope.

After operator trust, a small PHP integration boots the installed Pint PHAR and
uses its native console command. A command-start listener records the native
finder's exact files and resolved fixers. The normal native command then runs in
`--test` mode with JSON agent reporting, no interaction, and a fresh regular cache
file in the process runner's temporary directory. The runner removes that directory
after completion, failure, timeout or cancellation; caches are never reused.
Every planned file must be accounted for, and there must be active
rules before a clean run can pass. Source syntax and style diagnostics fail.
Empty rules, unexpected/missing/duplicate files, unsupported versions, malformed
output and execution failures cannot pass. Explicit file arguments override
Pint's finder exclusions; the native regression proves that an explicitly passed
`notName` file is still checked. This follows native CLI path-override behavior.

Blade/Prettier fixers are rejected before their dependency preparation runs.
This adapter does not install dependencies, update code, run parallel fixing, or
claim Blade support. Configured PHP rules, presets and local configuration
inheritance remain native Pint behavior. The internal PHAR integration is
version-gated because the public CLI JSON output lacks clean-file scope evidence.

Native checks use Pint 1.32.1, PHP 8.5.6 and Node 22.23.2 in Linux. They cover
valid formatting, style and syntax failures, unchanged source/cache files,
explicitly selected excluded files, empty rules, invalid presets, blocked Blade
integration and multiple files. Run `node scripts/verify-php-tools-container.mjs`
after the [development preparation](PHPSTAN.md) and build. Synthetic fixtures
are created in the container filesystem with networking disabled.

The first macOS hosted run exposed that using `/dev/null` as a cache file fails
when Pint seeks within it. The regular temporary file fixes that mechanism;
macOS acceptance still requires the corrected hosted native test to pass.

See [Pint's official documentation](https://laravel.com/framework/docs/pint).
