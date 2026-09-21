# ESLint validation

Select `javascript.eslint` in `repo-verifier.json`:

```json
{
  "schemaVersion": 1,
  "projects": [{ "path": ".", "checks": ["javascript.eslint"] }]
}
```

The project must have exactly one `eslint.config.js`, `eslint.config.mjs` or
`eslint.config.cjs`. The adapter selects that file explicitly; it does not search
outside the project for configuration or apply nested configuration overrides.
ESLint must already be installed in the project's `node_modules` or an ancestor's
`node_modules` within the operator-configured root. Missing or ambiguous
prerequisites produce an unavailable check. Planning only inspects paths.

## Scope and execution

Candidates are inventoried `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts`,
`.tsx` and `.vue` files owned by the detected project. Dependency/build exclusions
and nested project boundaries apply before planning. Configuration files with
these extensions are candidates too. Every candidate needs matching configuration
and at least one enabled rule; otherwise the check is incomplete.

After operator trust is granted, a child process loads the consumer's installed
ESLint API and configuration. It uses `calculateConfigForFile` and `lintText` for
each explicit file, preserving filenames containing spaces or glob characters.
It requests no fixes and does not use the file-cache path, preserving an existing
`.eslintcache`. Project configuration, plugins and processors remain executable
trusted code with the process user's privileges.

Rule settings and inline suppressions follow the selected configuration. This is
evidence that configured checks ran, not a judgment that the chosen rules are
sufficient. Suppression reconciliation and policy packs are separate future work.
The file must have enabled rules even if its contents happen to be empty.

## Evidence

The child emits versioned JSON with the ESLint version, per-file configuration
and enabled-rule evidence, native diagnostics and counters. Parsing requires
exact planned paths, one result per configured file, consistent severity counts
and complete output. Ignored/unconfigured files, no enabled rules, malformed
output, unexpected stderr, cancellation or output truncation cannot yield pass.
Both errors and warnings fail a fully accounted check. Configuration/runtime
exceptions are execution errors, not code findings.

CLI and MCP use the same engine and interpretation. Summary output omits paths,
rule messages and source excerpts. Detailed mode includes the structured evidence
in the process output. Native lint diagnostics may contain source identifiers.

## Verified scope

Integration tests exercise ESLint 10.10.0 on synthetic JavaScript: valid code,
syntax errors, rule errors/warnings, ignored files, unmatched TypeScript files,
disabled rules, invalid configuration, root-hoisted tooling, unusual filenames,
existing caches and CLI/MCP parity. Other versions, legacy `.eslintrc` files,
TypeScript configuration loaders and parser/processor combinations for TypeScript
or Vue are not verified by this adapter's integration suite. Those file types
are candidates so that lack of matching configuration remains visible.

Reference: [ESLint Node.js API](https://eslint.org/docs/latest/integrate/nodejs-api).

A separate [external integration evaluation](EXTERNAL-EVALUATION.md) checks
upstream-authored synthetic cases for three core rules against a frozen verifier
and the native CLI. This adds diagnostic-preservation evidence for those profiles;
it does not establish a general false-positive rate or parser/plugin compatibility.
