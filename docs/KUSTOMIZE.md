# Bounded offline Kustomize assembly validation

The opt-in `infrastructure.kustomize` profile uses the shared library, CLI and MCP
engine. Its [local measurement](measurements/kustomize-native-2026-10-06.json)
records original native and fresh offline installed-package controls. E16 and
Gate A remain open.

Declare complete scope in `checktrail.kustomize.json` using the published
[schema](../schemas/kustomize-config.schema.json), and select this check explicitly
in `checktrail.json`. The original [example](../examples/kustomize) contains a local
base and overlay. Nested kustomizations are discovery boundaries; the planner
reconciles the complete declared assembly against the root inventory.

## Accepted scope

The measured Linux ARM64 profile pins Kustomize 5.8.2, kubeconform 0.8.0 and the
same three local Kubernetes 1.36.0 strict schemas as [KUBECONFORM.md](KUBECONFORM.md).
Only local `resources`, `namePrefix`, Deployment `replicas` and native
`buildMetadata: [originAnnotations]` are accepted. Every kustomization and resource
must be declared exactly once. The root requires origin annotations. Cycles,
repeated resources, ambiguous replica selectors, omitted inputs, remote resources,
plugins, generators, patches and other transforms remain unavailable. Resources
are single unambiguous YAML documents for Deployment, Service or ConfigMap. Aliases,
merge keys, duplicate keys, nonfinite values and user-supplied native origin annotations are rejected.
Native scratch names are reserved. Scope, depth, input and output bounds are explicit.

Planning only reads data. Operator trust is required for execution through the CLI
or MCP server startup; a model argument cannot grant it. The collector builds in
fresh owned source, native, schema, document, HOME and temporary directories. The
native environment uses fixed settings with no cluster configuration. Exact original
and copied input, schema, binary and rendered-document hashes are checked before
and after collection. Both version commands use the same owned collector. Native
build/validation cancellation controls first observe the pinned executable,
arguments, owned cwd and process start identity. This is trusted execution, not an
OS sandbox or hostile-project attestation.

## Findings and completion

The native build must match the passive model of every declared resource exactly,
including origin annotations and supported overrides. Object key order is ignored;
array order is preserved. Raw rendered documents are retained as native slices and
validated against the pinned local schemas. Every result's filename, kind, version,
name, diagnostic pointers, counter, status and exit code must reconcile. Empty,
skipped, malformed, stale or unknown evidence cannot pass.

Native origin annotations identify resource files; they do not identify the source
of an overlay field override. The bounded passive model separately records physical
override nodes for `/metadata/name` and `/spec/replicas`. Other diagnostic pointers
resolve to original resource nodes. Native output reconciliation is required before
any such address is emitted. Unknown pointers remain incomplete. A valid overlay
can replace an invalid base replica value before validation; the original control
checks this behavior and also detects the defect when the override is removed.
Findings establish Kubernetes schema defects, not cluster admission, operational
impact, policy, reviewer severity or a general remediation mechanism.

## Reproduction

Explicitly prepare the infrastructure runtime and offline package cache as described
in [KUBECONFORM.md](KUBECONFORM.md), then run:

```sh
npm run build
node scripts/verify-kustomize-container.mjs
```

The verifier requires every named native control and repeats them through a fresh
offline production install. The official MCP client belongs to the external
acceptance harness. Validation containers have no network and read-only source
mounts; their root filesystem remains writable. Cleanup preserves worktrees and
branches. A configured hosted job is not evidence of a completed hosted run.

Helm, wider Kustomize transforms, additional schemas/platforms, complete publisher
and SDK/license closure, hosted CI for this revision, representative-project cost
and the wider Gate A inventory remain unverified. These controls invoke no reviewer
inference, field evaluation, cluster access or infrastructure apply.

The Linux acceptance observer now reads a PID's command first, then verifies the
exact pinned executable link before crediting it. Disappeared or inaccessible
per-PID entries remain unobserved and cannot satisfy native-body acceptance;
unexplained IO errors still fail. A directory-wide `/proc` failure is not hidden.
The same helper is used by kubeconform and Terraform controls. Every required
body still needs its own phase/owned-workspace/argument match and PID/start-time
identity before cancellation or mutation. Missing that observation still fails
the bounded wait; all original process and owned-output cleanup assertions remain.

This repairs the observed hosted readlink permission failure without skipping a
required test or treating an inaccessible process as a successful observation.
The `native-process-observer` required profile covers rejected identities,
permissions, disappearance and unexplained errors; all three native source and
fresh-installed sibling profiles are rechecked.
