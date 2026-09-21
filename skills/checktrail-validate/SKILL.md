---
name: checktrail-validate
description: Run Checktrail's planned checks and interpret their evidence after code changes or before delivery. Use for validation, incomplete-check diagnosis, and summaries of what actually ran.
license: MIT
metadata:
  author: stsepelin
  version: "1"
  checktrail-version: "0.1.0-alpha.1"
---

# Validate with Checktrail

Requires Checktrail 0.1.0-alpha.1 through a configured MCP server or CLI; Node.js 22+ on macOS or Linux for CLI use.

Use the configured MCP server for the intended project when available. Its root,
execution permission and output detail are operator settings. If multiple servers
exist, establish which one targets the requested repository before running it.

## Plan and run

1. Call `validation_plan` with `{}`. It selects registered checks without executing
   project code. `project_context` currently returns the same inventory, so calling
   both is unnecessary. Identify unavailable checks and unexpected omissions.
2. If execution is authorized, call `validation_run` with `{}`. It accepts an
   optional `timeoutMs` from 1 to 120000, not a root or trust argument. Use the
   default budget unless there is a concrete reason to change it.
3. Read the returned report. Use `validation_report` with its `runId` only when
   retrieving that report again. Reports expire on server restart and retention
   is bounded; retrieving an old report does not validate new source.

An execution-disabled response means no checks ran. Do not evade that setting
through the CLI or silently restart with broader permissions. Apply an existing
operator authorization when it covers the action; otherwise report the needed
setting. Summary output omits paths and logs; do not infer hidden diagnostics or
enable detailed output without the appropriate disclosure scope.

When MCP is unavailable and CLI execution is within the user's scope, use the
same engine with an explicit root:

```sh
npx --yes --ignore-scripts @stsepelin/checktrail@0.1.0-alpha.1 plan --root /absolute/project
```

For a project the operator has authorized for native execution:

```sh
npx --yes --ignore-scripts @stsepelin/checktrail@0.1.0-alpha.1 run --root /absolute/project --trust-project
```

An existing compatible local installation can replace the `npx` prefix. Native
tools must already be installed. Checktrail does not install dependencies or start
services, and their absence is not authorization to do so.

## Interpret evidence

- `passed` covers the selected checks and their scope. It does not establish
  complete review, all-language coverage or that a runtime guard was exercised.
- `failed` means at least one check failed. Read individual statuses too: failures
  and incomplete work can coexist in the same report.
- `incomplete` means required evidence is missing. Empty plans, unavailable tools,
  skipped-only tests, malformed evidence, timeouts and truncated output cannot be
  described as passing.
- CLI exits are 0 for passed/read-only success, 1 for failed checks, and 2 for
  incomplete evidence, untrusted execution or invalid input. Read JSON alongside
  the exit status; a successful `plan` is not a successful `run`.
- Source changes during a run prevent an aggregate pass. After fixing code or
  configuration, obtain fresh evidence; do not reuse a previous `runId` as proof.

Report the outcome, check IDs, relevant executed/skipped counts, evidence gaps
and any unvalidated work. Keep paths and raw logs within the permitted output
scope. When retrying, address the observed cause and retain unresolved failures
rather than deleting checks or weakening policy to obtain a pass.

Validation returns on the original asynchronous tool call. Do not invent standard
MCP Tasks polling methods; this preview does not expose that extension.
