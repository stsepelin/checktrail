# Release preparation

The source is public at [stsepelin/checktrail](https://github.com/stsepelin/checktrail);
`@stsepelin/checktrail@0.1.0-alpha.2` is published on npm. Its downloaded artifact
matched the reviewed tarball with SHA-256
`ffd0564f40a12a238a52fe25fe8c34fb36cf6f6480be7b6994bab82a3bd657fb`.
Fresh registry installation, CLI/library validation, generated npx startup with
fresh/warm caches and MCP pass/fail/incomplete results were verified. Alpha.2 adds
[setup and diagnosis](ONBOARDING.md). The
[MCP Registry entry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.stsepelin%2Fchecktrail/versions/0.1.0-alpha.2)
is active and matches `server.json`, with execution disabled. The Registry omits
`isSecret: false`, whose schema default is false. No credentials or automatic
publishing workflow are stored here.
The [GitHub prerelease](https://github.com/stsepelin/checktrail/releases/tag/v0.1.0-alpha.2)
points to source commit `4ce8398` and includes the same tarball plus `SHA256SUMS`.
The downloaded release asset was verified against the digest above.

Publication is configured for npm's `next` tag. After alpha.1 publication, the
registry assigned both `next` and `latest` to that preview; attempts to remove
`latest` returned HTTP 400. Alpha.2 publication updated `next` while leaving
`latest` on alpha.1. Cleanup remains unresolved; use exact versions, do not treat
`latest` as evidence of a stable release, and never republish an existing version.

## Prepared artifacts

- The npm package has an explicit file allowlist, public MIT license, documentation,
  versioned schemas and data-only packs. Dependency notice auditing and repeated
  tarball comparison are implemented in the local verification scripts.
- `server.json` pins the package version and uses stdio. Its generated command
  starts `serve` with a required operator-selected project root. Execution and
  detailed output remain disabled; an operator can configure a trusted local
  installation separately as documented in `README.md`.
- `package.json` declares `mcpName` matching the registry identity. A regression
  test reconciles package, lockfile, engine and registry versions, starts the
  metadata-derived command through an SDK client, verifies root-private summary
  output and requires execution to remain denied. The offline package smoke also
  loads the installed metadata and verifies its actual startup command.
- CI definitions cover the host suite and prepared native profiles. Local
  containers and package checks are evidence only for the environments actually
  exercised. The [hosted run at 4ce8398](https://github.com/stsepelin/checktrail/actions/runs/35590670960)
  passed all jobs for the alpha.2 release commit. The local Claude Code health/discovery and
  Codex direct app-server profiles have fresh-install evidence in `CLIENTS.md`.

The metadata follows the official registry
[publishing guide](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx)
and the versioned
[2025-12-11 schema](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json).
Registry metadata schema versions are separate from the MCP wire protocol version.
The official schema was downloaded and validated locally; its bytes are pinned
by the verifier below, without bundling a copied schema in the package.

```sh
curl --fail --silent --show-error --location --max-time 30 \
  https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json \
  --output /tmp/checktrail-registry-schema.json
node scripts/verify-registry-metadata.mjs /tmp/checktrail-registry-schema.json
```

The checker requires SHA-256
`3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0`.
A changed schema must be reviewed before changing that pin. Schema validation
does not establish namespace ownership or registry acceptance. The current metadata
identifies this release as `preview` under publisher metadata. That label describes
release maturity, not whether npm or the MCP Registry has accepted it.

## Preview publication sequence

The candidate review records the exact tarball SHA-256, file inventory, source
manifest and test evidence. Keep it outside the package allowlist. Client checks
must report the same tarball hash; repacking after an edit creates a new candidate.
The source commit must pass hosted CI before publication.

After explicit approval and npm authentication for the `@stsepelin` scope, publish
the approved file, not a newly packed working tree:

```sh
npm publish /absolute/path/stsepelin-checktrail-0.1.0-alpha.2.tgz \
  --tag next --access public --ignore-scripts --registry=https://registry.npmjs.org
```

Verify the registry version and dist-tag, download its tarball, compare its digest
to the approved file, and repeat a fresh CLI/MCP installation check. This manual
tarball path does not claim npm build provenance. See
[npm publishing options](https://docs.npmjs.com/cli/v11/commands/npm-publish/).

Only after npm publication and separate registry authentication, publish the
reviewed `server.json` with the official `mcp-publisher` CLI. Verify the returned
server name, version, npm identifier and execution-disabled startup arguments
through the registry API. The registry verifies npm ownership using `mcpName`;
local schema validation alone cannot establish acceptance. See the official
[registry quickstart](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx).

GitHub private vulnerability reporting is enabled. Use the channel linked in
`SECURITY.md`. Tags and GitHub releases also require explicit authorization.

## Before a concrete release

1. Select the supported release scope and version using `LANGUAGES.md` and
   `EXECUTION.md`. Reconcile npm, lockfile, engine and registry versions and replace
   the development-candidate status only when appropriate. Do not advertise Tasks
   until the standard wire/lifecycle gates in `MCP-COMPATIBILITY.md` pass.
2. Run `npm run check`, `npm run format:check`,
   `node scripts/audit-dependencies.mjs`, then
   `node scripts/prepare-package-cache.mjs` with network access before
   `node scripts/smoke-package.mjs` performs its fresh offline installation.
   Run the corresponding native verification helpers for every advertised profile.
   Record actual tool/platform results and explicit skips. Repeat registry schema
   validation against its pinned bytes.
   Run `scripts/verify-package-upgrade.mjs` with the reviewed previous and candidate
   tarballs to verify offline upgrade, policy/report compatibility and rollback.
3. Inspect the exact tarball and its SHA-256, its source revision, dependency/notice
   report, package allowlist, public examples and documentation. The smoke helper
   compares repeated packing of the same checkout and tests a fresh offline install;
   it does not establish reproducibility across operating systems or compiler builds.
4. Obtain the required explicit authorization for the concrete commits, remote
   creation and push. Establish the public repository, vulnerability reporting,
   maintainer ownership and hosted CI evidence. No local script performs these
   actions as a side effect.
5. Re-run the supported client profiles in `CLIENTS.md` against the exact release
   candidate, and complete independent evaluation gates for
   any effectiveness claims. Development fixtures do not prove equal or better
   review quality than a prior workflow; see `EVALUATION.md`.
6. Present the exact version, tarball digest, tested scope and known limitations
   for package/release/registry publication authorization. Configure the chosen npm
   publishing identity and provenance mechanism, then verify the published package
   before registry registration. The registry's npm ownership check uses the
   published package's `mcpName`; a local file cannot satisfy that external gate.

No arbitrary adapter, broad framework/OS matrix or review-quality claim becomes
verified through publication. Keep the compatibility record alongside the release.
