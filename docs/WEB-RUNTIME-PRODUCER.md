# Original web runtime producer observation

This development-only controller prepares the original web-tree-sitter 0.27.1
publisher recipes for a native Linux x86-64 host. It is not invoked by discovery,
the review CLI, MCP, or ordinary pull-request validation. Native acceptance of
this public controller is pending. Its presence does not complete Gate A.

The [input catalog](../scripts/producer-qualification/web-runtime.v1.json)
binds original public archives, source-file identities, selected Emscripten
4.0.15 tools and expected published bytes. The source is Tree-sitter commit
`10eb5ac119eec9cb4267a8e035066473983f5f3a`. Its
[original GitHub build](https://github.com/tree-sitter/tree-sitter/blob/10eb5ac119eec9cb4267a8e035066473983f5f3a/.github/workflows/build.yml)
and [npm release job](https://github.com/tree-sitter/tree-sitter/blob/10eb5ac119eec9cb4267a8e035066473983f5f3a/.github/workflows/release.yml)
select different orders. The original commands run from `lib/binding_web`:

| Recipe | Commands after `npm ci`                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------------------------- |
| GitHub | `CJS=true npm run build`; `CJS=true npm run build:debug`; `npm run build`; `npm run build:debug`                      |
| npm    | `npm run build`; `npm run build:debug`; `CJS=true npm run build`; `CJS=true npm run build:debug`; `npm run build:dts` |

No test or publication command is added to either recipe. Compiler flags and
scripts are preserved. The [translated compiler vectors](../scripts/producer-qualification/web-runtime-command-vectors.v1.json)
are source-derived reference metadata, not observations of compiler invocation.
Execution uses the original npm scripts and Cargo xtask.

## Acquisition and preparation

The [acquisition catalog](../scripts/producer-qualification/web-runtime-acquisition.v1.json)
selects compatible Node 24.22.2/npm 11.19.1 and Rust 1.98.1 archives. These are
selected reproduction inputs; they are not evidence of the historical publisher's
exact tools. Node and Rust release signatures are checked against pinned original
public-key snapshots and exact signer fingerprints. Component checksums must also
occur in their signed release metadata. Full compiler and bootstrap ancestry
remains open.

Acquisition admits a fixed download set below 2 GiB with four download workers,
per-response byte/hash limits, restricted HTTPS redirects and an aggregate
20-minute phase deadline. It retains incomplete downloads and failure journals.
Archive handling reads data without running installers, project hooks or compilers.
Original archives remain intact during the job. The extracted notice index assists
inspection; it does not assert complete upstream notice closure.

Registry inputs are bound to the original npm/Cargo locks. The Cargo catalog
retains the exact selected public index rows so a later mutable index response
cannot silently replace them. Their encoding is derived from the selected Cargo
source. A `manual-sha256` label identifies these frozen row bytes; it is not a
server ETag or a historical registry snapshot. The signed Node distribution's npm
cache APIs perform offline tarball-integrity checks, an actual corruption check
and restored reads, with child-process permissions denied during that preparation.
Actual native Cargo consumption of this public prepared cache remains part of
native acceptance.

The Coq base image uses the same
[raw manifest/config proof](../scripts/producer-qualification/binutils-image-identity.v1.json)
and [validator](../scripts/producer-qualification/binutils-image-identity.mjs)
as the other producer tooling. Both supported Docker image-ID forms require that
exact registry digest and filesystem. The derived image is assembled with `FROM`
and `COPY`, without installer or `RUN` commands. Its observed local IID, base
proof, filesystem layers, copied inputs and actual tool bytes are bound separately.
No derived registry digest or raw OCI-config verification is invented.

## Operator execution

The [dedicated workflow](../.github/workflows/upstream-web-runtime.yml) runs on
`ubuntu-24.04` through explicit dispatch, or a push to
`pr/upstream-runtime/web-tree-sitter-*`. That namespace does not match the Binutils
workflow. Push-trigger admission allows pre-merge native qualification without
assuming that dispatch is available before the workflow reaches the default branch.
Only synthetic controller controls run in the ordinary test suite.

A local operator can use a fresh canonical private output directory:

```sh
node scripts/producer-qualification/web-runtime-inputs.mjs acquire /absolute/new-input-directory
# Explicitly acquire the catalog's fixed base image before assembly.
node scripts/producer-qualification/web-runtime-inputs.mjs assemble /absolute/new-input-directory github --operator-trust-execution --coordinated-heavy-slot
node scripts/producer-qualification/web-runtime-controller.mjs run /absolute/new-input-directory/ready-inputs.json /absolute/new-receipt-directory --operator-trust-execution --coordinated-heavy-slot
node scripts/producer-qualification/web-runtime-inputs.mjs cleanup /absolute/new-input-directory --operator-trust-execution
```

The execution path requires actual Linux/x64/x86_64 host observations as well as
Linux/amd64 image observations. These labels are observations, not hardware
attestation. The original body has fixed 2-CPU, 4-GiB, PID, stream and 20-minute
limits including cleanup reserve. It uses no network, a read-only root, an explicit
UID/GID and cold extracted SDK caches. Each recipe gets a fresh source and SDK;
partial attempts do not silently warm later builds.

Every reached command's physical attempt and logs are retained before success
assertions. Qualification requires every original stage to succeed with complete
terminal observations, exact published outputs, unchanged original inputs and
source, tool/input/cache/harness afterchecks, final image inspection and owned
container absence. Retained source/declaration files are not described as newly
compiled products. Missing, timed-out, truncated, unavailable or unknown results
remain incomplete. Cleanup removes only the observed owned derived image, without
force or global pruning; shared base images are retained.

The bounded observation archive includes receipts and logs, including failures.
Raw SDK/source trees, archive inputs and binary products are hashed and retained
during the job; this upload does not promise indefinite availability of those
bodies. A complete runtime recipe can establish runtime reproduction and byte
agreement only. SDK/compiler/bootstrap producer builds, historical publisher
consumption, complete notice closure and Gate A remain separate unfinished gates.
