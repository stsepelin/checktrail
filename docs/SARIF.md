# SARIF export

The CLI and library export existing detailed validation reports as SARIF 2.1.0:

```sh
repo-verifier run --root /path/to/project --trust-project --detailed > report.json
repo-verifier export-sarif --root /path/to/project --input report.json > results.sarif
```

The input path is relative to the configured root and is subject to the normal
bounded-read and path-escape checks. Export only reads the report: it neither
executes project code nor establishes that a stored report still describes the
current source. Preserve the original command's exit status in CI; exports also
retain the report's passed/failed/incomplete exit convention.

```js
import { exportSarif, validate } from "@stsepelin/repo-verifier";
const report = await validate(root, { trusted: true });
const sarif = exportSarif(report);
```

ESLint, Ruff, PHPStan, Staticcheck, golangci-lint and TypeScript solution builds currently provide normalized source findings. Each has
its native rule identifier, severity, message, repository-relative file and line
when available. Columns are omitted until cross-tool character-unit behavior is
verified. These findings appear only in detailed reports. CLI/MCP summary output
continues to omit messages and paths.

Each selected check becomes a SARIF run. Rule IDs include both the check and
native rule ID, and locations use percent-encoded relative URIs with `%SRCROOT%`
as their base ID. No absolute base directory, source snippets, commands, logs or
environment values are exported. Native messages can still contain sensitive
project information; SARIF is an explicitly requested detailed artifact.

A completed analysis with source diagnostics has `executionSuccessful: true`
even when it found violations. Tool errors, unavailable/skipped/inconclusive
checks, source changes and failed checks without an explicit
`findingsComplete: true` evidence marker produce
error execution notifications and `executionSuccessful: false`. Generic command
or test failures never become invented source findings. Passed checks without
normalized diagnostics retain their status and indicate that normalized findings
are unavailable. Run properties preserve the complete report's outcome, source
and policy fingerprints, check status, test counts and labeled tool identities.
Do not interpret an empty results array as proof that validation passed.

Older reports without this optional marker remain readable, but failed checks
cannot claim complete SARIF execution. A finding can remain visible even when
file accounting or another native failure prevents complete analysis.

The exporter validates the detailed report schema and rejects contradictions
between its aggregate outcome and check statuses. It rejects absolute, escaping
or non-normalized finding paths. Stale findings remain visible with failed
execution metadata. Importing a report does not independently attest its origin.

Tests validate exports against the unmodified OASIS supporting schema, pinned by
SHA-256. That schema's language patterns require JavaScript regex compilation
without the Unicode flag because they contain an unescaped closing bracket;
the exporter does not emit a language field. Tests also exercise the real ESLint
adapter, CLI round trips, failed/incomplete/stale/empty reports, URI encoding,
message braces, schema rejection and unchanged summary privacy. The external
schema and its OASIS notices are development fixtures and are excluded from the
published package allowlist.

References: [OASIS SARIF 2.1.0 specification](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html),
[official supporting schema](https://docs.oasis-open.org/sarif/sarif/v2.1.0/cos02/schemas/sarif-schema-2.1.0.json).
