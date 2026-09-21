# Install agent skills with npx skills

Checktrail provides portable workflows for setup, validation and review:

| Skill                 | Use it for                                                                     |
| --------------------- | ------------------------------------------------------------------------------ |
| `checktrail-setup`    | Configure project roots, select supported language checks and connect MCP      |
| `checktrail-validate` | Run authorized checks and distinguish passed, failed and incomplete evidence   |
| `checktrail-review`   | Review code and test adequacy using validation evidence and advisory questions |

Each skill is self-contained in `skills/<name>/SKILL.md` and follows the
[Agent Skills format](https://agentskills.io/specification). The
[Vercel skills CLI](https://github.com/vercel-labs/skills) installs these folders
from GitHub. No Checktrail plugin or separate skills registry registration is
required for installation by repository URL.

## Install

These GitHub commands require the `skills/` directory to be present on the public
repository's default branch. For an unpublished checkout, use the local command
below. Listing the remote source first verifies what is available:

```sh
npx skills add stsepelin/checktrail --list
npx skills add stsepelin/checktrail
```

The interactive installer lets you choose skills and target agents. For an
explicit project installation, run from the repository where you want to use
Checktrail:

```sh
npx skills add stsepelin/checktrail \
  --skill checktrail-setup checktrail-validate checktrail-review \
  --agent codex claude-code cursor
```

Choose only the agents you use. Add `--global` for a personal installation shared
across projects, or `--yes` when deliberately skipping installer prompts. The
default installation uses project directories; it does not configure an MCP server.
Use `--copy` if independent copies are preferable to the installer's default links.

To install from a local checkout before pushing, substitute its absolute path:

```sh
npx skills add /absolute/path/to/checktrail --skill checktrail-validate --agent codex
```

The CLI's agent target names are installer options, not evidence that Checktrail
has been tested end-to-end in every editor. See [client coverage](CLIENTS.md).
Reload skills or start a new session as required by the selected agent. Example
requests are "Set up Checktrail for this repository", "Validate these changes
with Checktrail", and "Review this diff using Checktrail evidence".

## Install the engine separately

`npx skills` installs instructions. It does not install the npm engine, native
language tools, an MCP server, or execution permissions. The skills support an
existing MCP connection or the CLI, including the published preview:

```sh
npx --yes --ignore-scripts @stsepelin/checktrail@0.1.0-alpha.1 plan --root /absolute/project
```

Use Node.js 22+ on macOS or Linux. See [installation](INSTALLATION.md) for persistent
CLI installation, MCP registration and operator-controlled execution. Skills do
not expand native language coverage, grant trust, or replace required CI checks.

## Update and remove

For GitHub-installed project skills, update just Checktrail's workflows:

```sh
npx skills update checktrail-setup checktrail-validate checktrail-review --project
```

Use `--global` instead of `--project` for a global installation. Updates replace
installed instructions; keep project-specific policy in your project's own files.
Retain and review the project installation's `skills-lock.json` and file changes.
For local-path installations, re-run `skills add` against the updated checkout.

The installer version used for local verification is `skills@1.7.0`. It aliases
`skills check` to `skills update`; do not use `check` as a read-only update probe.
Use `npx skills list` to inspect installed skills. Pin the installer itself with
`npx skills@1.7.0` when reproducing the installation checks.

Skill updates and engine updates are separate. The skills declare the Checktrail
version they target. To update the engine, deliberately select a compatible npm
version and restart the MCP process. Updating skills never changes its root,
execution grant or output disclosure settings. For a reproducible skill revision,
install from a reviewed GitHub tree URL containing a commit SHA and the selected
skill path; re-add that same revision to roll back. Do not treat following a branch
as an immutable pin.

Remove the project skills with:

```sh
npx skills remove checktrail-setup checktrail-validate checktrail-review
```

Add `--global` for a global removal. This removes skills, not the separately
installed engine or MCP configuration.

## Verification boundaries

Local checks exercise discovery, selective installation, copy/link destinations,
file integrity, reinstallation from an updated local source and removal in
temporary projects. They do not modify personal agent installations. Skill format
validation does not prove model behavior or improved review quality. Installation
from the public GitHub source and remote update verification require the changes
to be pushed; a local installation is not evidence of either.

Reproduce the installation checks from the Checktrail checkout:

```sh
npm install --prefix .checktrail/skills-tools --ignore-scripts --no-audit --no-fund \
  --package-lock=false --save-exact skills@1.7.0
node scripts/verify-skills-install.mjs .checktrail/skills-tools/node_modules/skills/bin/cli.mjs
```

The helper uses temporary project and installer-state directories, exercises the
real installer, and removes its fixtures afterward. It does not run a model,
register MCP, install global skills, or invoke remote skill updates.
