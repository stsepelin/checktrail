# Install the preview

The first preview version is `0.1.0-alpha.1`, intended for npm's `next` tag.
Check the [npm package page](https://www.npmjs.com/package/@stsepelin/checktrail)
for availability. The registry commands below require that version to be published;
before publication, use the source checkout or a reviewed local tarball.

Use Node.js 22 or newer on macOS or Linux. Windows execution is not supported.
Install each project's compilers, linters and test runners separately; Checktrail
does not download them. Missing tools produce incomplete results.

## CLI

Install the exact version once:

```sh
npm install --global --ignore-scripts @stsepelin/checktrail@0.1.0-alpha.1
checktrail --version
```

From the project you want to inspect:

```sh
checktrail plan --root "$PWD" --detailed
```

Planning only reads files. To execute checks on a project you trust:

```sh
checktrail run --root "$PWD" --trust-project --detailed
```

Exit `0` means the selected checks passed, `1` means at least one failed, and `2`
means evidence is incomplete, execution is untrusted, or input is invalid. A passing
result covers only the checks and files listed in the report. Native checks run
with your user privileges; the tool is not a sandbox.

## Claude Code

From the project directory, register a read-only server scoped to that project:

```sh
claude mcp add --transport stdio --scope local checktrail -- \
  checktrail serve --root "$PWD"
claude mcp get checktrail
```

Restart the client if it is already running. Ask it to call `validation_plan` to
inspect the selected checks. The tested Claude Code surface is connection and
tool discovery; model-driven tool use is not part of the recorded measurement.

## Codex CLI

From the project directory:

```sh
codex mcp add checktrail -- checktrail serve --root "$PWD"
codex mcp get checktrail
```

The server configuration is saved in your Codex configuration. Its root is the
absolute directory captured when you run this command. Use a different server
name for another project rather than expecting the root to follow your working
directory. Restart an existing client session to load the configuration.

Both clients need `checktrail` on their PATH. If the client cannot find it,
use the absolute executable path reported by `command -v checktrail` in place
of the second `checktrail` in the registration command. The first is the server
name. Existing client policies may restrict which MCP servers can run.

## Enable validation execution

The examples above disable execution. To run tests and tools, remove the read-only
entry (`claude mcp remove --scope local checktrail` or
`codex mcp remove checktrail`) and repeat its registration command with
`--allow-execution` after the root argument. Only enable this for a trusted project.
An MCP tool call cannot grant itself this permission.

Summary output is the default. Add `--detailed` to the server command only when
the client may receive file paths, commands and raw diagnostics. An MCP client
may forward the returned information to its model provider.

Validation uses asynchronous calls and supports cancellation. Standard MCP Tasks
is not advertised; the durable worker is a separate library API. See
[client coverage](CLIENTS.md) and [MCP compatibility](MCP-COMPATIBILITY.md).

## Before npm publication

Build the public source checkout:

```sh
git clone https://github.com/stsepelin/checktrail.git
cd checktrail
npm ci --ignore-scripts
npm run build
node dist/src/cli.js plan --root examples/javascript --detailed
```

For a reviewed local package, replace the registry package argument in the install
command with the absolute path to its `.tgz` file. The package's release review
supplies its SHA-256; verify it before installing. This installs the same CLI and
MCP entry point without requiring npm publication.
