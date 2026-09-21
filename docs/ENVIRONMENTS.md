# Project environments

A project may declare required environment variable names in `checktrail.json`:

```json
{
  "schemaVersion": 1,
  "projects": [
    {
      "path": ".",
      "checks": ["javascript.node-test"],
      "environment": ["APP_ENV", "DATABASE_URL"]
    }
  ]
}
```

The declaration does not grant access. The CLI operator must name each permitted
variable, whose value is read from the CLI's environment:

```sh
checktrail plan --root /path/to/project --allow-env APP_ENV --allow-env DATABASE_URL
checktrail run --root /path/to/project --trust-project --allow-env APP_ENV --allow-env DATABASE_URL
checktrail serve --root /path/to/project --allow-execution --allow-env APP_ENV --allow-env DATABASE_URL
```

The library accepts an explicit `environment` record in `createPlan` and
`validate` options. MCP uses values captured at server startup; tool-call
arguments cannot add names, supply values or change permissions. Reading a
`.env` file is not part of this feature. Tools may independently read their own
configuration because executed project code is trusted, not sandboxed.

Only names requested by each configured project are added to that project's
validation processes and version probes. Other supplied values are not forwarded.
The existing minimal process environment remains present. Missing permission or
an unset required value makes that project's checks unavailable before execution.
A named but unset CLI permission is a startup error; explicitly empty values are
allowed. Names use uppercase ASCII letters, digits and underscores, start with a
letter or underscore, and are bounded along with values and the number of entries.
Duplicate names and conflicts with fixed adapter settings, such as Go's offline
proxy setting, are rejected.

Plans contain required names. Detailed results contain supplied names and a
SHA-256 fingerprint of their sorted values. Values are not copied into command
metadata; summary output omits names and fingerprints. Fingerprints are identity
signals, not secret encryption, and invoked tools can print values into detailed
logs. Tool identity reuse is scoped to the environment fingerprint. Operator
values are copied at the start of a library invocation and at MCP startup.

This supplies process configuration; it does not start databases, load credentials
from external services, validate service availability, or promise isolated tests.
Those prerequisites still need explicit preparation by the consumer.
