# Local Kustomize patch and transform extensions

The shared `infrastructure.kustomize` check accepts the explicit
`"assemblyProfile": "local-transforms-v1"` setting in
`checktrail.kustomize.json`. Declare every local patch in `patches` alongside the
complete `kustomizations` and `resources` arrays. Omitting the profile retains
[KUSTOMIZE.md](KUSTOMIZE.md)'s original contract. Planning reads bounded data and
pinned executable/schema bytes; it executes no project or tool code.

## Selected assembly contract

This profile pins Kustomize 5.8.2 and kubeconform 0.8.0 on Linux ARM64, with the
original three Kubernetes 1.36.0 strict schemas: Deployment, Service and ConfigMap.
It supports these finite declarations:

- Local modern `patches` entries. Strategic patches select one exact API/kind/name
  identity and merge maps, selected named lists, null removals and explicit
  `$patch: merge`, `replace` or `delete` directives. Whole-resource deletion and
  ordering directives remain unsupported. JSON patches select one exact resource
  and support `add`, `replace`, `remove`, `test`, `copy` and `move`, canonical
  RFC 6901 paths and bounded array insertion. Replacing the document root is
  unsupported.
- `namePrefix`, `nameSuffix`, `namespace`, exact Deployment `replicas` and image
  repository rewrites in containers and init containers. Registry ports are
  allowed. Tagged selectors and tagged replacement repository names are rejected;
  use separate `newTag` or SHA-256 `digest` fields. Adjacent image and resource
  identifiers remain distinct.
- Literal ConfigMap generators, global/local `disableNameSuffixHash`, selected
  data/binary-data patches and generated references through `envFrom`,
  `configMapKeyRef` and pod volumes, including init containers. References are
  namespace-aware and must remain unambiguous. External reference existence is
  not established.

Every declared source must participate once. Repeated or cyclic local resources,
ambiguous identities/selectors, missing or unused patches, remote inputs, plugins,
generator files/envs/behavior and unrecognized fields remain unavailable. Input,
operation, depth and rendered resource bounds are enforced. YAML aliases, merges,
nonfinite values and source-supplied origin annotations are rejected. The root
requires `buildMetadata: [originAnnotations]`.

The passive reconstruction tracks each value's physical file and line through
patch insertions, replacements and list reordering. Complete rendered native
values must match before schema findings are emitted. A patch-created fault
points at its patch; an unchanged base value retains its base address after a
strategic insertion moves its array index. Unknown diagnostic pointers remain
incomplete.

## Hash and receipt boundaries

Generated names model the observed byte-pinned native binary, including its
ConfigMap hash encoding. The selected binary hashes data with an empty name in
that encoding; transformed names are appended outside it. The compatibility
implementation is original and verified with actual generated output, escaped
Unicode/HTML data, binary data and disabled-hash combinations. This is a contract
for the selected artifact, not a claim about all Kustomize releases. Upstream
source consulted was `api/hasher/hasher.go` at
[the release commit](https://github.com/kubernetes-sigs/kustomize/blob/2e294e3e92a56fe9cfa1e755e6e57c5f1268ce22/api/hasher/hasher.go).
The binary's Go module metadata reports development API/kyaml modules; declared
module versions alone are not attested dependency versions.

Both native tools, all selected schemas, raw input policy, complete rendered
resource participation, raw output hashes, exact argument arrays and native
validation counters must reconcile. Interpreting a saved extension receipt also
rechecks current physical inputs, schemas and both selected executable bytes.
Changing one invalidates the old receipt; restoring it restores validity. Empty,
skipped, stale, omitted, malformed or exhausted evidence cannot pass.

Execution requires CLI trust or MCP startup trust. Model arguments grant neither
execution nor detailed output. Findings establish Kubernetes schema defects;
they do not establish cluster admission, service reachability, image availability,
full Kustomize semantics or reviewer severity. No cluster or infrastructure apply
is performed.

## Reproduction and acceptance

Prepare the existing infrastructure runtime and offline package cache:

```sh
npm run build
CHECKTRAIL_TEST_TASK=original-kustomize-task node scripts/prepare-infra-tools-runtime.mjs
node scripts/prepare-package-cache.mjs
node scripts/verify-kustomize-extensions-container.mjs
```

The controller verifies actual Node/tool/schema bytes, preserved kubeconform and
Kustomize cases, all nine named source cases and the same cases in a fresh offline
production installation. The external harness exercises shipped library/CLI/MCP
bytes without installation lifecycle scripts. It also requires original native
regressions and unchanged-callback compiling controls, with restoration checked
in every mutation. The schema-inventory and resource-participation controls remove
coupled protections together; they do not prove either line is necessary alone.

The container runs as user 1000 with no network, a read-only root/source/cache,
two CPUs, 4 GiB memory, 256 PIDs and a 2 GiB executable temporary filesystem.
Actual build and validator processes must be observed before cancellation,
timeout or output exhaustion is credited; process and owned-output cleanup must
then complete. The named source file has a five-minute deadline, with separate
callback and engine deadlines. Absent-native host callbacks are optional skips
and are not native acceptance.

The [dated local record](measurements/kustomize-extensions-2026-10-10.json) binds the
selected evidence. The `kustomize-extensions-arm64` job repeats this controller;
configuration alone does not establish hosted acceptance. Agents on this Mac use
the shared foreground environment runner. After stopping foreground work,
`node scripts/cleanup-infra-tools-runtime.mjs` removes only the owned unused image
and preserves worktrees, branches and acquired artifacts.

Gate A remains open. Wider platforms, complete publisher/license closures and
remaining implementation profiles still require acceptance. No AI inference,
held-out reviewer evaluation or real-project MCP field trial is included.
