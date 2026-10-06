# Bounded offline Kubernetes schema validation

The opt-in `infrastructure.kubeconform` profile shares the CLI/library/MCP engine.
Its [measurement receipt](measurements/kubeconform-native-2026-10-06.json) records
native source and fresh offline installed-package controls and compiling guard
proofs. E16 and Gate A remain open for the other required profiles.

Declare complete scope in `checktrail.kubeconform.json`, using the published
[configuration schema](../schemas/kubeconform-config.schema.json), and select the
check in `checktrail.json`. The original [example](../examples/kubeconform) is data
for validation. The engine never applies a manifest or starts a cluster.

## Pinned native scope

The measured Linux ARM64 profile uses the official kubeconform 0.8.0 release binary
and Kubernetes 1.36.0 standalone strict schemas for Deployment (`apps/v1`), Service
and ConfigMap (`v1`). Binary and schema bytes are pinned by SHA-256. Schema files
must be explicitly prepared as canonical regular files in the declared local
schema directory. Changed, missing or extra schema files make the profile unavailable.
Other kinds, versions, platforms and custom schemas require separate acceptance.

The dedicated manifest project declares every inventoried YAML/JSON input, excluding
its Checktrail configuration and the exact schema directory. Canonical paths and
bounded UTF-8 inputs are required. Every document needs unambiguous native kind,
version and name metadata. Empty documents, duplicate keys, aliases, merge keys and
unsupported YAML syntax remain unavailable. Planning only reads data; it invokes
no tool or project code and fetches no dependencies or schemas.

Execution requires operator trust through the CLI or MCP startup. Model-supplied
arguments cannot grant it. Fresh owned source, document, schema, HOME and temporary
directories prevent output/cache reuse. The collector splits documents into raw
source slices without serializing their YAML values, retaining original source
identity and physical positions. Separate native filenames make same-named objects
in different documents distinguishable despite the native output's omitted namespace.

## Native results and addresses

Native commands explicitly select strict validation, verbose JSON, summary counters,
a single worker, the pinned Kubernetes version and the fresh local schema path.
The validator reconciles every copied document's hash, one native resource result
per document, exact kind/version/name, all summary counters and native exit status.
Skipped resources, missing schema errors, empty output and inconsistent results
cannot become passes. A comment-only file returns native zero without a valid
resource; the original control records that behavior separately from acceptance.

A schema-invalid resource yields findings from native validation errors. Their
JSON pointers resolve to physical YAML/JSON source nodes, preserving the original
document offset, UTF-8 text and one-pass pointer escaping. For an error attached
to a containing object, that object's start is the available address. Unknown
pointers stay incomplete. These are schema defects, not verified cluster admission,
policy, authorization, operational impact, image availability or reviewer severity.

Inputs, copied document bytes, schema files and resolved native binary bytes are
checked before and after collection. This binds coherent trusted execution; it is
not hostile-project attestation, complete SDK provenance or an OS sandbox. Native
raw schema errors stay distinct from successful resources. The parser uses the
measured 0.8.0 status names rather than older output examples.

## Preparation and required acceptance

From an ARM64 checkout, explicitly prepare and verify the runtime:

```sh
npm run build
CHECKTRAIL_TEST_TASK=original-infrastructure-task node scripts/prepare-infra-tools-runtime.mjs
node scripts/prepare-package-cache.mjs
node scripts/verify-kubeconform-container.mjs
```

The operator preparer acquires exact official release archives and pinned public
schema bytes, verifies raw archives and every extracted file, preserves the included
notice/license files and builds from an immutable Node base with networking disabled.
It refuses existing destinations and owned tags. `CHECKTRAIL_INFRA_ARTIFACT_DIRECTORY`
selects exact already acquired archive/schema bytes and
`CHECKTRAIL_INFRA_BASE_PREPARED=1` uses the prepared immutable base. Local acceptance
measures that prepared-artifact path; the default network fetch path and hosted CI
for this revision remain unverified. Release signatures and complete SDK/publisher/
license closure remain open. The runtime also contains pinned Terraform, Helm and
Kustomize for subsequent development; their presence is not engine support.

Copy the verified schemas directory into the declared `schemaDirectory` before
planning a consumer. The public example requires `tools/kubernetes`. Acceptance
makes this copy only in fresh test fixtures. The engine performs no installation.

The required profile fixes original callback names and demands every native control
pass without skips: type defect and repair, zero-replica near misses, diagnostics
in subsequent documents, forged scope/command/hash/metadata/counter receipts,
empty/duplicate/omitted inputs, altered schemas, CLI/MCP trust and summary privacy,
missing tools, protected settings, concurrency cleanup, frozen-plan freshness and
reached native cancellation/source/copied-document changes.
Compiling guard experiments run one original callback and require its intended
assertion to fail; setup errors and skipped tests do not count.

Source and fresh offline production-install acceptance use the same runtime with
networking disabled and CPU/memory limits. Source and consumer mounts are readonly;
container scratch remains writable. Lifecycle scripts are disabled. The acceptance
harness, public example and official MCP client remain outside the installed package;
internal imports and CLI/MCP exercise shipped bytes. On this Mac, agents use the
shared foreground dev-env lifecycle and verify cleanup at task end.
`node scripts/cleanup-infra-tools-runtime.mjs` checks ownership and refuses while
an owned container remains, preserving code and preparation artifacts.

No inference or real-project field evaluation is part of these controls. Broader
Kubernetes schemas, Helm/Kustomize/Terraform engine profiles, Windows, complete
attempt archives, full provenance and representative-project performance remain
required and unverified.
