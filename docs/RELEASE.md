# Release preparation

The source is public at [stsepelin/repo-verifier](https://github.com/stsepelin/repo-verifier);
the first preview is `0.1.0-alpha.1`. `server.json` describes the
intended `io.github.stsepelin/repo-verifier` MCP registry identity and the matching
`@stsepelin/repo-verifier` npm package. The npm and registry names are proposed
metadata, not evidence of a published package or registry entry. Package publishing
is configured for public access on npm's `next` tag. No credentials or automatic
publishing workflow are stored in this repository.

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
  exercised. All 13 hosted jobs passed at source baseline `52ba415`; the preview
  release commit requires its own run. The local Claude Code health/discovery and
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
  --output /tmp/repo-verifier-registry-schema.json
node scripts/verify-registry-metadata.mjs /tmp/repo-verifier-registry-schema.json
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
npm publish /absolute/path/stsepelin-repo-verifier-0.1.0-alpha.1.tgz \
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
