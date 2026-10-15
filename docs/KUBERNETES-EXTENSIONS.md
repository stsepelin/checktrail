# Offline Kubernetes schema extensions

The shared `infrastructure.kubeconform` check accepts the explicit
`"schemaProfile": "kubernetes-1.36-extended-kinds-v1"` setting in
`checktrail.kubeconform.json`. It selects exactly thirteen byte-pinned Kubernetes
1.36.0 strict schemas. Omitting the setting retains the original three-kind
contract described in [KUBECONFORM.md](KUBECONFORM.md).

| API version                    | Added exact kinds                        |
| ------------------------------ | ---------------------------------------- |
| `apps/v1`                      | StatefulSet, DaemonSet                   |
| `batch/v1`                     | Job, CronJob                             |
| `networking.k8s.io/v1`         | Ingress                                  |
| `v1`                           | Secret, Namespace, PersistentVolumeClaim |
| `rbac.authorization.k8s.io/v1` | Role, RoleBinding                        |

Deployment (`apps/v1`), ConfigMap and Service (`v1`) remain included. Unknown
kinds, kind prefixes and other API versions are unavailable before execution.
Ordinary annotation values are data; annotation text resembling a kind does not
change the selected contract. The public catalog pins each added file's length
and SHA-256 from the same immutable upstream schema revision as the baseline.
Upstream schemas are acquired by operator preparation and are not shipped inside
the npm package.

## Receipt and execution boundaries

Planning reads bounded source, raw policy, selected schema and executable bytes.
It starts no tool or project code and acquires no schema. The operator must
prepare all thirteen canonical regular schema files in the declared directory
and select the pinned Linux ARM64 kubeconform 0.8.0 executable. Missing, changed,
extra or linked inputs remain unavailable. Execution still requires CLI or MCP
startup trust; a tool argument cannot grant execution or detailed disclosure.

Fresh native strict validation binds every physical document and its kind,
version, name, source hash and location. All selected schemas, actual tool bytes,
raw stdout/stderr, exact arguments and native summary/resource accounting must
agree. Empty, skipped, omitted, malformed, partial and exhausted evidence cannot
pass. Type errors retain physical source addresses, including later documents.
The extension also rechecks current physical source, raw policy, every schema and
the selected tool when interpreting an old receipt. A coherent saved receipt is
inconclusive after any of those bytes change; restoring the bytes restores its
validity.

These findings describe schema validation. They do not establish API-server
admission, RBAC authorization, cluster state, image availability, application
correctness or reviewer severity. The engine never applies manifests or starts a
cluster. Wider kinds, versions, custom schemas and platforms require their own
acceptance.

## Preparation and required acceptance

On the measured ARM64 host, prepare the base runtime and then its schema extension:

```sh
npm run build
CHECKTRAIL_TEST_TASK=original-kubernetes-task node scripts/prepare-infra-tools-runtime.mjs
CHECKTRAIL_TEST_TASK=original-kubernetes-task node scripts/prepare-kubernetes-extensions-runtime.mjs
node scripts/prepare-package-cache.mjs
node scripts/verify-kubernetes-extensions-container.mjs
```

The extension preparer verifies every selected artifact before publishing any
combined context. It refuses an existing destination or owned image tag, builds
without network access, checks its exact parent before and after the build, and
keeps the baseline schema directory intact. Set
`CHECKTRAIL_KUBERNETES_SCHEMA_ARTIFACT_DIRECTORY` to canonical already acquired
files to exercise offline preparation. Default acquisition uses bounded public
artifact requests; publisher signatures and whole artifact/license closure remain
unverified.

The controller checks Node 22.23.2, Linux ARM64, actual binary and all schema bytes.
It requires preserved kubeconform/Kustomize callbacks, nine named source callbacks
and the same nine callbacks in a fresh offline production installation. The
external harness exercises shipped library, CLI and MCP bytes with lifecycle
scripts disabled. It also requires original native regressions and fourteen
compiling controls: unchanged original callbacks pass, assertion-killing mutants
compile, and restored originals pass. Two resource-accounting controls remove
coupled guards together; they do not establish that either line alone is necessary.

Validation runs as user 1000 with no network, a read-only root and source/cache
mounts, two CPUs, 4 GiB memory, 256 PIDs and a 2 GiB executable temporary filesystem.
Reached cancellation, timeout and output exhaustion must remove actual native
processes and owned outputs. The named acceptance file has a five-minute budget;
engine and callback deadlines remain explicit. Optional absent-native host checks
are recorded as skips and never credited as acceptance.

The [local record](measurements/kubernetes-extensions-2026-10-10.json) binds this
selected scope and its acceptance. The `kubernetes-extensions-arm64` CI job repeats
it. On this Mac, agents use the shared foreground environment runner. After
foreground work stops, remove the owned extended tag with
`node scripts/cleanup-kubernetes-extensions-runtime.mjs`, then the base tag with
`node scripts/cleanup-infra-tools-runtime.mjs`; both preserve source and prepared
artifacts and refuse while an owned container remains.

Gate A remains open. No AI inference, held-out reviewer evaluation or real-project
MCP field trial is part of this work.
