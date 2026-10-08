# Dependency provenance and notices

Run `node scripts/audit-dependencies.mjs` from the checkout after installing the
locked dependencies. It makes no network calls or project changes and emits a
JSON inventory of production npm packages, their exact versions, declared licenses,
registry tarball locations, lockfile integrity declarations and notice-file hashes.
The installed production dependency tree must reconcile with the lock. Missing
notices produce incomplete evidence; mismatches and stale fallback entries fail.

This audits installed metadata and notice presence. It does not recompute registry
tarball integrity over installed code, establish legal compliance, cover development
tools or establish native/container supply-chain provenance. The package uses npm
dependencies without bundling their code; installed packages retain their own
notices. Audit and retain those notices if distribution arrangements change.

The unreleased version 3 review context lazily uses TypeScript 6.0.3 as a
production parser dependency. The existing pinned development version moved to
production without changing its version or registry integrity declaration.
It declares Apache-2.0 and includes LICENSE.txt and ThirdPartyNoticeText.txt in
the installed package. The audit records both notice files and their hashes.
The parser serves captured strings from memory; it does not load project
configuration or replace the consumer's separately configured native checks.

## Supplementary upstream notice

`@nodable/entities@3.0.0` declares MIT but its installed distribution omits a
license file. The supplementary notice is preserved verbatim at
[`licenses/nodable-entities-3.0.0.txt`](licenses/nodable-entities-3.0.0.txt).

The npm registry metadata for that exact version identifies Git commit
`d2070d76a8ba07e6c7fa142caeb51ffd756e47eb`. The notice was retrieved from that
commit's [root LICENSE](https://raw.githubusercontent.com/nodable/val-parsers/d2070d76a8ba07e6c7fa142caeb51ffd756e47eb/LICENSE).
Every distributed source/declaration file and the README was compared byte-for-byte
with the commit's `Entity/` directory and matched.

The upstream manifest says **2.2.0**, while the installed/registry manifest says
**3.0.0**. That discrepancy is preserved rather than treated as a matching release
manifest. The fallback records both versions, the exact installed file inventory
and SHA-256 digests. The offline audit rejects changed source, a changed notice,
an unused fallback or a newly bundled notice that makes the fallback stale.

`scripts/license-sources.json` records this preparation evidence. The supplementary
notice and this explanation ship inside the package's existing `docs/` allowlist.
No dependency version or package-manager signature setting was changed.

`node scripts/smoke-package.mjs` also compares two packs of the same checkout byte
for byte, checks the file allowlist and installs the tarball offline into a fresh
consumer. This demonstrates repeated packaging of one built checkout, not an
independent cross-platform rebuild or reproducible native toolchain. The dependency
audit and package smoke passed in the hosted matrix at `52ba415`; see `NATIVE-CI.md`.

## Prepared detekt artifact

The opt-in Kotlin analyzer uses the pinned upstream detekt CLI fat JAR described in
[DETEKT.md](DETEKT.md). It is prepared explicitly and is not bundled in Checktrail's
npm package. Its exact release size and SHA-256 are checked before preparation and
execution. Publisher signatures and the full bundled native component/license
closure remain unverified E6 obligations; the npm metadata audit does not cover them.

## Fixed context grammar assets

Context version 6 adds the exact `web-tree-sitter@0.27.0` production dependency.
Its installed MIT notice is retained by the existing npm audit. The package also
ships the selected compiled grammar assets with their upstream notices under
`assets/context-grammars/`; the source/archive/generated-file and WASM identities
are recorded separately. `audit-context-grammars.mjs` reconciles that exact asset
inventory. Build-tool transitive notices remain an explicit gap. See
[CONTEXT-GRAMMARS.md](CONTEXT-GRAMMARS.md).
