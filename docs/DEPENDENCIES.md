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
