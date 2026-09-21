---
name: checktrail-setup
description: Configure Checktrail validation for a repository or monorepo. Use when adding Checktrail, selecting language checks, or connecting its local MCP server to a coding agent.
license: MIT
metadata:
  author: stsepelin
  version: "1"
  checktrail-version: "0.1.0-alpha.1"
---

# Set up Checktrail

Requires Checktrail 0.1.0-alpha.1; Node.js 22+ on macOS or Linux. Native compilers, linters and test runners must be installed separately.

Configure the requested repository and client. Installing this skill does not
install Checktrail, register an MCP server, or authorize project execution.

## Discover before configuring

Read the repository's instructions and existing `checktrail.json`. Identify its
project roots from manifests and its runners from actual scripts/configuration.
Do not execute manifests or install project dependencies to discover them.

Use an existing compatible Checktrail installation when available. For the
published preview, the CLI can be launched without a global installation:

```sh
npx --yes --ignore-scripts @stsepelin/checktrail@0.1.0-alpha.1 adapters
npx --yes --ignore-scripts @stsepelin/checktrail@0.1.0-alpha.1 plan --root /absolute/project
```

Downloading the npm package requires network access. `plan` does not execute
project code. Its summary hides paths; inspect manifests locally when mapping
checks to project roots. Use detailed output only within the user's disclosure
scope, since it includes paths and commands.

## Select supported checks

Use IDs returned by `adapters` and the version's
[language matrix](https://github.com/stsepelin/checktrail/blob/main/docs/LANGUAGES.md).
Manifest recognition does not imply test execution support. Keep unsupported
languages and missing tools visible as gaps. A syntax check is not a test suite.

For example, a synthetic repository with a Go module at `service` and a Python
unittest project at `worker` can use:

```json
{
  "schemaVersion": 1,
  "projects": [
    { "path": "service", "checks": ["go.format", "go.vet", "go.test"] },
    { "path": "worker", "checks": ["python.unittest"] }
  ]
}
```

Use exact discovered roots relative to the configured root, or `.` for the root
project. When present, `projects` selects only the listed projects and checks;
preserve existing requirements when editing it. Configuration cannot enable
execution or provide arbitrary commands. Re-run planning after edits and account
for every intended project, unavailable check and omitted ecosystem.

## Connect the requested client

Register a local stdio command using the client's supported configuration:

```sh
npx --yes --ignore-scripts @stsepelin/checktrail@0.1.0-alpha.1 serve --root /absolute/project
```

The root is fixed at server startup. Tool calls cannot choose another root.
Preserve other servers and use a distinct name for a different project. See the
[client setup commands](https://github.com/stsepelin/checktrail/blob/main/docs/INSTALLATION.md).
Verify discovery and `validation_plan` after connecting.

Execution starts disabled. Add `--allow-execution` only when the operator has
authorized native checks for this project; installing a skill is not that grant.
Native checks run with the user's privileges and are not sandboxed. `--detailed`
separately permits paths, commands and diagnostics in client-visible output.

Report the selected roots/checks, connection status, execution setting and missing
prerequisites. Do not report successful planning as successful validation.
