# Playwright adapter

Select `javascript.playwright` explicitly. The adapter requires an installed
Playwright inside the configured root and inventories `.test`/`.spec` JS/TS/JSX/TSX
files. It loads native configuration only after execution trust is granted.
Framework setup files with other names need a future scope contract; unexpected
test files cannot silently extend the claimed scope.

The native configuration integration is gated to Playwright 1.63.0. Other versions
are incomplete until this internal API and its lifecycle are verified. The public
reporter API supplies collected tests, project names, expected statuses, retry
attempts, errors and terminal outcomes. The report identifies Playwright from its
installed package metadata, separately from the Node runtime.

## Execution controls

The adapter runs all native configured projects with one worker. It overrides
name filters and sharding, rejects `.only`, disables snapshot creation/updates
and snapshot-check disabling, and fails flaky retries. Native project retries,
dependencies, fixtures and global setup/teardown remain active. Project names must
be unique; every configured project and inventoried test file must have evidence.
Union file accounting does not claim that each file ran in every project/browser;
native `testMatch`/`testIgnore` still describe that per-project distribution.

Configured `webServer` and private runner plugins are rejected before runner
startup. Supply already-running test services through normal configuration and
operator-authorized environment variables. Trusted configuration, setup and test
code can still perform arbitrary actions; this is not a sandbox.

Native output and last-run state use a fresh temporary directory, removed on
normal completion. Existing output directories and snapshots are preserved.
Cancellation may leave temporary artifacts, and native transform caches outside
the source inventory are not a hermetic build guarantee. Project reporters are
replaced with the evidence reporter; their side effects do not run.

## Interpretation

Passing requires non-skipped native tests, unique test identities, terminal retry
evidence, every planned file, and every configured project. Skips, expected
failures, empty projects or omitted files are incomplete. An unexpected pass,
assertion failure, flaky outcome, fixture/import failure or runner error fails.
A native missing-browser diagnostic is unavailable; an accompanying ordinary
assertion failure still fails the check. Timeouts, cancellation, malformed or
truncated evidence cannot pass.

Counts describe native test cases, not a proof that each body contains a useful
assertion. Test content and assertions remain the project's responsibility.
No browser, dependency, test server or model provider is installed by validation.

## Native verification

The synthetic suite exercises arithmetic and actual Chromium DOM assertions,
failures, focus, retries, skips/expected failures, snapshot protection, excluded
files, multiple/empty projects, TypeScript configuration, rejected startup,
unsupported versions and absent browsers. Browser fixtures use only `setContent`;
they do not contact a website. Current native evidence is macOS arm64 with
Playwright 1.63.0 and its Chromium headless shell revision 1243.

Prepare development browsers explicitly after installing the locked npm tools:

```sh
PLAYWRIGHT_BROWSERS_PATH=.checktrail/playwright-browsers node node_modules/playwright/cli.js install chromium --only-shell
npm run build
node --test dist/test/playwright.test.js
```

Browser preparation downloads development tools; validation does not. The CI
definition additionally prepares OS libraries with `--with-deps`. Hosted CI has
not run. Absent local browser preparation is an explicit native-test skip.

References: [reporter lifecycle](https://playwright.dev/docs/api/class-reporter),
[test configuration](https://playwright.dev/docs/test-configuration),
[CLI controls](https://playwright.dev/docs/test-cli).
