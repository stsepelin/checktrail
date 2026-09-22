# Releases and publication

The source is public at [stsepelin/checktrail](https://github.com/stsepelin/checktrail).
The published preview is `@stsepelin/checktrail@0.1.0-alpha.4`.
Its downloaded npm artifact and GitHub release asset match the reviewed SHA-256:

```text
4cc6dca5877b29cb452595c1c50233b0d377248f6f6e84e18ffe1b74b2031f8c
```

The [GitHub prerelease](https://github.com/stsepelin/checktrail/releases/tag/v0.1.0-alpha.4)
and tag point to source commit `ebe7f5c114428aebc5084a2a33d38113cad13583` and include
the same tarball plus `SHA256SUMS`. The [hosted release run](https://github.com/stsepelin/checktrail/actions/runs/35603451711)
passed all jobs. The [MCP Registry entry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.stsepelin%2Fchecktrail/versions/0.1.0-alpha.4)
is active and matches `server.json`, with execution disabled. The Registry omits
`isSecret: false`, whose schema default is false.

Fresh public-registry installation verified CLI/library validation, generated
npx startup with fresh/warm caches, onboarding, and MCP pass/fail/incomplete
results, retained reports and execution denial. The exact artifact also passed
offline installation, alpha.3 → alpha.4 → alpha.3 upgrade/rollback, the known UUID
scope replay, Claude Code health/discovery and Codex direct MCP calls. A clean
archive of the committed source, rebuilt with the same installed compiler and
dependencies on the same host, produced an identical tarball. This does not
establish cross-platform reproducibility.
The [release record](measurements/release-alpha4.json) links these observations to
the artifact; client profile limits remain in [CLIENTS.md](CLIENTS.md).

## Alpha.5 candidate (unpublished)

The current source metadata identifies `0.1.0-alpha.5`; it has not been published.
Alpha.4 remains the public preview. Alpha.5 adds named per-check Go build-tag
profiles in `checktrail.go-build.json`, with independent explicit exclusions.
Native listing and execution use the same tags, including race and analyzer
checks. Missing assignments, ambiguous declarations and stale exclusions cannot
pass. Formatting still checks the full inventory. See [GO build profiles](GO-BUILD.md).

Detailed plans/reports add optional `goBuild` profile/tag metadata. Summary output
adds only `goBuildTagCount`, alongside the existing exclusion count. Older strict
schema consumers must update before accepting these fields. Projects must choose
between the new build-profile policy and the module-wide scope policy; combining
both is rejected. Each selected check runs once. Repeated-check, cross-target and
cross-compilation matrices remain unsupported.

Alpha.4 does not understand the new build-profile sidecar. Rolling back preserves
its bytes but does not apply its tags or exclusions. Revalidate after rollback;
a project relying on profile-selected files can become incomplete. No claim of
coverage transfers from one profile or package version to another.

The installed MCP SDK 2.0.0 routing probe was repeated on 2026-09-22: standard
Tasks remains unavailable and is not advertised by this candidate.

The candidate also makes the task-retention regression deterministic by controlling
its clock and checking the exact expiry boundary. Production retention logic is
unchanged. CI action pins have been updated; npm dependency versions are unchanged.
The source before release preparation passed all 13 [hosted jobs](https://github.com/stsepelin/checktrail/actions/runs/35614737518)
after retrying an actionlint download that received HTTP 504. The release commit
still needs its own hosted CI run. Candidate checks and artifact identity belong
in the concrete release review; this section does not claim publication.

## Alpha.4 scope

Alpha.4 adds optional exact Go file exclusions in `checktrail.go-scope.json`.
Native package evidence must account for each declared exclusion. Active, absent
or otherwise unaccounted-for declarations cannot pass. Go formatting continues
to cover the full source inventory, and race-test package discovery now uses the
same `-race` constraints as execution. See [GO-SCOPE.md](GO-SCOPE.md).

Detailed plan/report schemas add an optional `goScope` declaration and summaries
add an optional `goExcludedFileCount`. Consumers that validate with older strict
schemas must update their schemas before accepting these fields. The policy is
opt-in; existing projects retain strict scope accounting. Dependencies are unchanged.

Alpha.3 does not understand the new sidecar policy. The synthetic Go upgrade test
verified that rollback keeps its bytes on disk but restores strict Go accounting:
a project relying on exclusions becomes incomplete. Exclusions never establish
validation of another platform or custom build-tag configuration. No cross-target
execution is added.

The installed MCP SDK routing probe was rechecked on 2026-09-21: standard Tasks
remains unavailable; see [MCP-COMPATIBILITY.md](MCP-COMPATIBILITY.md). The release
targets Node.js 22 or newer on macOS and Linux. The immutable tarball contains
preparation-time candidate documentation; current source documentation records
verified publication.

## Distribution tags and previous releases

`next` points to alpha.4. `latest` remains on alpha.1 because npm rejected its
removal. Use exact versions; neither tag implies a stable release. Never republish
an existing version. No credentials or automatic publishing workflow are stored here.

The [alpha.3 prerelease](https://github.com/stsepelin/checktrail/releases/tag/v0.1.0-alpha.3)
fixed the plain TypeScript adapter's unsupported `--noCheck` argument on the
exercised TypeScript 4.9.5 profile, retaining the TypeScript 6.0.3 override and
native file accounting. Vue and solution-build retain their separately verified
versions; see [TYPESCRIPT.md](TYPESCRIPT.md). The [alpha.3 record](measurements/release-alpha3.json)
preserves its source, artifact, CI and known mitt replay evidence.

The [alpha.2 prerelease](https://github.com/stsepelin/checktrail/releases/tag/v0.1.0-alpha.2)
introduced [setup and diagnosis](ONBOARDING.md), from source commit `4ce8398`.
Its reviewed and downloaded artifact has SHA-256
`ffd0564f40a12a238a52fe25fe8c34fb36cf6f6480be7b6994bab82a3bd657fb`.
Its [hosted run](https://github.com/stsepelin/checktrail/actions/runs/35590670960)
and fresh installation checks passed; its npm and Registry versions remain published.
The historical alpha.2 [adoption record](PUBLIC-ADOPTION.md) remains unchanged;
its initial failures are not rewritten as later-release successes.

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
  exercised. The [hosted run at ebe7f5c](https://github.com/stsepelin/checktrail/actions/runs/35603451711)
  passed all jobs for the alpha.4 release commit. The local Claude Code health/discovery and
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
npm publish /absolute/path/reviewed-new-version.tgz \
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
