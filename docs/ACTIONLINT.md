# GitHub Actions workflow validation

`infrastructure.actionlint` statically checks inventoried
`.github/workflows/*.yml` and `*.yaml` files using the official actionlint 1.7.12
release executable. Planning reads files only. Execution requires operator trust
and an already prepared tool on `PATH`; the engine never downloads one.

Each workflow directory identifies its repository root, including nested roots.
Workflow dependencies use the full inventory below that root even when a local
action also contains a separate package manifest. Default planning retains an
unsupported result for Terraform, Helm and Kustomize markers beside workflows.
Selecting this check explicitly covers workflows only.

## Configuration

Place `repo-verifier.actionlint.json` at the repository root:

```json
{
  "schemaVersion": 1,
  "runnerLabels": [],
  "variables": []
}
```

`runnerLabels` lists additional self-hosted runner labels. Only literal ASCII
letters, digits, underscores and hyphens are accepted; glob patterns are rejected.
`variables` lists configuration-variable identifiers available to `vars` expressions.
An empty list declares none. Case-insensitive duplicates and unknown keys are
rejected. These declarations describe the expected environment; they do not query
GitHub or prove that a runner or variable exists. The generated schema is
`schemas/actionlint-config.schema.json`; runtime validation also checks duplicates.

To select the profile explicitly, use `infrastructure.actionlint` in the
repository policy. `packs/actionlint.json` is the corresponding data-only public
pack. Neither the profile nor a pack grants execution permission.

## Execution and evidence

The wrapper makes a fresh bounded copy of inventoried project files. It omits
Git metadata and repository actionlint configuration, including case variants,
creates its own empty Git marker, and supplies its own explicit native config.
Consequently repository `paths.*.ignore` settings cannot suppress findings.
This intentionally differs from running actionlint with repository defaults.

Before running actionlint, the wrapper checks local `uses` references in workflows
and local action metadata. A local action needs exactly one inventoried
`action.yml` or `action.yaml`; referenced runtime files and local reusable
workflows must also be inventoried. Missing, excluded, symbolic-link or escaping
inputs cannot pass. Main/pre/post scripts, Dockerfiles and entrypoint files are
copied as data. They are never executed by this profile. Composite metadata
dependencies are inspected, but this does not establish semantic validation of
every composite step.

YAML parser errors produce `yaml/*` findings and incomplete analysis. YAML aliases,
merge keys, unsupported tags/warnings and dependency-inspection failures produce
incomplete results. These are explicit profile limits, not claims that GitHub
rejects those constructs.

The wrapper invokes one actionlint process per workflow with JSON diagnostics,
verbose tracing, ShellCheck disabled and Pyflakes disabled. The parser reconciles
the planned files, native project selection, parse/total counts, disabled optional
integrations and exit status. Missing, duplicate, unexpected or contradictory
evidence cannot pass. Errors retain their `actionlint/*` identifiers and source
locations; failed analysis does not establish complete findings. Successful
analysis provides no test-execution evidence.

Source fingerprints are checked before copying and after validation, alongside
the shared engine's source checks. Limits include 128 workflows, 512 YAML files in
the local dependency closure, the shared inventory's 8 MiB/file and 64 MiB total,
100 KiB invocation arguments, 2,000 parsed diagnostics per native result and the
shared time/output limits. A source change or exceeded limit prevents success.
Native tool identity is version evidence, not an attestation of every executable
byte; the preparation recipe separately verifies the release archive digest.

## What this does not validate

No jobs, shell/Python bodies, actions, JavaScript payloads, containers, remote
checkouts or services are executed. Remote actions are not downloaded; analysis
uses actionlint's static knowledge. There is no claim of complete GitHub runtime
compatibility, action supply-chain auditing, least-privilege authorization,
secret safety, deployment safety or successful CI execution. This is not an OS
sandbox. Terraform, Helm, Kustomize and arbitrary YAML need separate profiles.

## Reproduction

With the pinned official release prepared on `PATH`:

```sh
npm run build
node --test dist/test/actionlint.test.js
node dist/src/cli.js run --root examples/actionlint --trust-project --detailed
```

The Linux fixture image downloads and verifies a fixed release during its explicit
preparation step. Validation and packaged library/CLI/MCP smoke tests then run
with networking disabled and read-only source/consumer mounts:

```sh
docker build --file scripts/actionlint-tools.Dockerfile --tag repo-verifier-actionlint-test:1.7.12 scripts
node scripts/verify-actionlint-container.mjs
```

The native tests cover broken/fixed expressions, YAML failures, literal runner and
variable settings, reusable workflow inputs, local metadata and runtime assets,
repository suppression bypass, missing dependencies, and evidence tampering.
The CI job is configured separately; a local container run is not hosted CI.

Upstream references: [release and assets](https://github.com/rhysd/actionlint/releases/tag/v1.7.12),
[CLI usage](https://github.com/rhysd/actionlint/blob/v1.7.12/docs/usage.md),
[configuration](https://github.com/rhysd/actionlint/blob/v1.7.12/docs/config.md),
[checks](https://github.com/rhysd/actionlint/blob/v1.7.12/docs/checks.md).
