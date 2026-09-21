# Policy packs and private overlays

Policy packs are versioned JSON that require registered checks and named
environment inputs. Public and private packs use the same schema. Loading a pack
does not execute it, install tools, grant trust, or accept custom commands.

The distribution includes profiles in `packs/` for Node/ESLint, Vue, Python/pytest,
Go, PHP/Pest, PHP/PHPUnit, Rust/Cargo, Ruby syntax, Swift syntax, C/C++ Clang checks,
explicit Java compilation and C# compilation. These compose the documented native adapters. They
do not add semantic framework rules or claim authorization, business-logic or
application-integration coverage. The Vue profile combines template/script type
checking, linting and Vitest; PHP profiles still require the consumer's framework
bootstrap and test configuration.

Copy a selected pack into the consumer repository or its ignored local policy
directory, or explicitly download a pinned pack using [pack distribution](PACK-DISTRIBUTION.md). Inspect it and compute its digest with `shasum -a 256 path/to/pack.json`
(or another SHA-256 utility). Reference the exact digest in `checktrail.json`:

```json
{
  "schemaVersion": 1,
  "projects": [
    {
      "path": ".",
      "checks": [],
      "packs": [
        {
          "path": "policies/vue.json",
          "sha256": "REPLACE_WITH_THE_64_CHARACTER_SHA256_OF_THE_FILE"
        }
      ]
    }
  ]
}
```

The placeholder must be replaced before this configuration is valid. Paths are
relative to the operator root, including when the consuming project is nested.
References cannot escape the root. Files are UTF-8 JSON; the hash covers their
exact bytes, including whitespace. A digest mismatch fails planning before any
check executes. A digest establishes content integrity, not publisher identity.
Updates require an explicit consumer policy change to the pinned digest.

Pack schema fields are `schemaVersion`, `id`, `version`, `description`,
`requiredChecks`, and optional `requiredEnvironment`. Unknown fields, duplicate
requirements, duplicate pack IDs within a project's reference list, and different
contents claiming the same pack ID anywhere in a resolved policy are rejected.
Different projects may share the same pinned pack. Unknown or inapplicable check
IDs fail planning. Empty checks are allowed only when pack expansion supplies
required checks. Limits are 64 KiB per pack, 32 references per project, 64 distinct
references per resolution, 256 resolved checks and 64 environment names per project.

Project checks, pack checks, and environment requirements are combined by set
union. Repository fields cannot remove a pack requirement. Named environment
inputs still need operator permission and cannot override protected adapter
settings. A data-only pack cannot register executable plugins. There is no pack
inheritance, automatic download or registry resolution. External executable
adapters require separate operator registration; see `EXTERNAL-ADAPTERS.md`.

Private overlays use the normal configuration schema and are explicitly selected:

```sh
checktrail run --root /path/to/project --trust-project \
  --policy-overlay .checktrail.local.json
checktrail serve --root /path/to/project --allow-execution \
  --policy-overlay .checktrail.local.json
```

The library option is `policyOverlay`. MCP cannot set or change it through a tool
argument. The filename is not loaded automatically. It is ignored by this
project's Git and source inventory defaults; consumers should keep private policy
files out of their own public commits and package allowlists.

An overlay requires an explicit base `checktrail.json`. It can add projects,
checks and environment requirements; omitting a base requirement never removes
it. A conflicting workspace declaration fails instead of overriding dependency
semantics. The resolved policy fingerprint covers requirements, loaded pack
digests and overlay selection. Execution re-reads policy afterward, so changes in
ignored private files still invalidate a passing report. If policy cannot be
re-read, source verification fails. This does not authenticate mutable policy or
protect it from malicious code with the same operating-system privileges.

Git change selection currently uses the full configured project set whenever a
pack or operator overlay is active. Shared-policy impact has not been inferred.
Required tools still have to be installed separately, and missing tools remain
unavailable. Selecting a pack is never evidence that its checks ran.

Native Node/ESLint regressions exercise composition, failures, privacy and CLI/
MCP startup behavior. Tests also cover integrity, unknown fields/checks, duplicate
and conflicting identities, environment permissions, hidden mid-run policy changes,
resource bounds and conservative Git selection. The offline package smoke uses
the actual distributed Node profile through the installed library, CLI and MCP.

The `infrastructure.actionlint` profile in `packs/actionlint.json` selects static
GitHub Actions analysis. It requires explicit `checktrail.actionlint.json`
settings and a prepared native checker; see [ACTIONLINT.md](ACTIONLINT.md).

The separate `public.vue-router` profile in `packs/vue-router.json` selects native
route capture and URL probe contracts. It requires explicit registration/probe
configuration and prepared Vue/Router dependencies; see [VUE-ROUTER.md](VUE-ROUTER.md).
It does not add navigation, authorization or Nuxt semantics.

The `public.nuxt` profile in `packs/nuxt.json` selects a fresh native SSR testing
assembly with explicit successful-page contracts. Framework tooling is prepared
separately; this profile does not establish browser or production equivalence.
See [NUXT.md](NUXT.md).
