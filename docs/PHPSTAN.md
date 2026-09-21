# PHPStan validation

Select `php.phpstan` explicitly. PHPStan must be installed under `vendor` in the
project or an ancestor within the configured root. A local `phpstan.neon`,
`phpstan.neon.dist` or `phpstan.dist.neon` is required, in that priority order.
Planning only resolves paths; PHP, Composer autoloaders, configured bootstrap
files and extensions execute only after operator trust.

The adapter passes each inventoried PHP file explicitly and runs native debug
mode with JSON formatting. Debug mode prints each analysed file and disables
parallel analysis and result-cache reuse. A passing result needs every planned
path exactly once and consistent native diagnostic totals. An excluded file with
exit zero is incomplete. File/global diagnostics fail; unparseable execution
errors are errors. Filenames containing newlines are unavailable because native
debug paths are line-delimited. Configuration selects rule levels, extensions,
baselines and suppressions; rule sufficiency and baseline reconciliation are
separate capabilities.

Verified native versions: PHPStan 2.2.14 and PHP 8.5.6, using the installed official
Composer image. Synthetic fixtures pass valid return types, reject incompatible
returns and bad configuration, and prevent an excluded file from yielding a
passing result. Verification uses no network and creates synthetic fixtures inside Linux. The host has no PHP and explicitly skips this native test.

Prepare pinned development dependencies separately, then run verification:

```sh
mkdir -p .checktrail/php-tools
cp scripts/php-tools/composer.json scripts/php-tools/composer.lock .checktrail/php-tools/
docker run --rm \
  --mount "type=bind,src=$PWD/.checktrail/php-tools,target=/app" \
  --workdir /app composer:2 install \
  --no-interaction --no-scripts --prefer-dist --no-progress
npm run build
node scripts/verify-php-tools-container.mjs
```

The preparation command downloads locked development dependencies, enables only
the pinned Pest plugin manager to generate its plugin inventory, and requires
installed official Composer and Node 22 Alpine images. The verification script inspects that
local images' digests and never pulls or downloads. It copies the Node executable
from the installed Node image and runs the engine tests in the PHP container,
where fixture creation and native execution share one filesystem. The repository
is mounted read-only; temporary synthetic fixtures are writable inside the
discarded container. This is development tooling, not container support in the verifier. Ordinary PHP syntax has a separate PHP
8.4 verification script. Framework/Larastan integration is still unverified.

See the official [PHPStan CLI reference](https://phpstan.org/user-guide/command-line-usage#--debug)
for the native debug and result-cache behavior.
