# Bounded local Helm lint and rendering

The opt-in `infrastructure.helm` profile uses the shared library, CLI and MCP
engine. Its [local measurement](measurements/helm-native-2026-10-06.json) records
original synthetic source, fresh offline installed-package and mutation controls.
E16 and Gate A remain open.

Declare the complete root application chart in `checktrail.helm.json` using the
[published schema](../schemas/helm-config.schema.json), and select
`infrastructure.helm` in `checktrail.json`. The [original example](../examples/helm) contains a complete synthetic chart. The initial profile fixes Helm 4.3.0,
Linux ARM64, Kubernetes version 1.36.0, release `original` and namespace `original`.
It accepts `Chart.yaml`, `values.yaml`, `values.schema.json` and explicitly listed
flat `templates/*.yaml` files. Chart metadata is limited to `apiVersion: v2`,
application type, name, numeric semantic version and description. All value keys
are required flat string, integer or boolean properties with no additional keys.
This initial schema profile accepts only property types, without constraints or
references. YAML aliases, merge keys and duplicate keys are unavailable.

Template actions are restricted passively to value reads, release name/namespace,
conditionals, comparisons, Boolean operations, `quote`, `toString` and `default`.
This restriction does not evaluate Go templates or establish valid Go syntax.
Malformed admitted actions are checked by native Helm. Subcharts, dependencies,
locks, `.helmignore`, CRDs, helpers, NOTES, plugins, postrenderers, external files,
`lookup`, DNS, random functions, `tpl` and other contexts/functions need separately
verified profiles. Unlisted files and excluded chart inputs are unavailable;
root Git and Checktrail operator artifacts are excluded from the chart snapshot.

Execution requires operator trust through CLI `--trust-project` or MCP server
startup `--allow-execution`; a tool argument cannot grant it. Native collection
uses fresh owned source/chart, HOME and temporary directories. It checks declared
input and binary hashes before and after collection and rejects changed original
or copied chart closure. Helm receives fixed arguments, private cache/config/data
paths, no plugins or cluster configuration and a minimal environment. This is
trusted project execution, not an OS sandbox or hostile-project attestation.

The collector runs `helm lint chart --strict` and `helm template original chart`
with fixed version, namespace and color arguments. Rendering uses
`--dry-run=client`. A pass requires warning-free native lint, valid rendered YAML,
exact source headers for every declared template, one resource per template and
unique resource identities. Empty, omitted or duplicated resources are incomplete.
This checks local rendering, not Kubernetes schema/API acceptance or deployment.
The [official Helm command reference](https://helm.sh/docs/helm/helm_template/)
describes the client-only rendering and server-validation boundary.

Both native failure phases must be accounted for. Supported single values-type
errors map a verified JSON pointer to the original YAML node. Supported Go parse
and execution errors map the native physical template address to a declared,
pinned source line. Conflicting or unknown diagnostics remain inconclusive.
Rendered YAML diagnostic line numbers are not original template line numbers;
they remain unresolved without a verified mapping. No source finding is invented.
Summary CLI/MCP results omit paths, source and native output; operator detail
settings retain them. Deadline/cancellation results cannot pass.

Reproduce after preparing the pinned public runtime and building the checkout:

```sh
node scripts/prepare-infra-tools-runtime.mjs
node scripts/verify-helm-container.mjs
node scripts/cleanup-infra-tools-runtime.mjs
```

Agent runs use the shared foreground task lifecycle. The verifier runs the same
required original callbacks against source and a fresh frozen-lock offline npm
install. The acceptance client remains outside the installed package. Controls
cover defects, repairs, zero values, omitted resources, duplicate identities,
protected environment, frozen closure, evidence mutations, concurrency, cleanup,
CLI/MCP privacy and startup-only trust. Compiler-valid tool-pin and template
participation mutants must fail the original evidence callback with no skips.

Broader chart syntax, nested/remote values, chart dependencies, schema diagnostics,
rendered-line mapping, Kubernetes schemas/APIs, other platforms/tool versions,
release-signature and full publisher/license provenance, performance and host
isolation remain required. No model inference or real-project field evaluation
was run for this profile.
