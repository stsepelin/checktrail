# npm dependency provenance audit

The operator setup audit reads the installed dependency tree, lockfile, manifests
and notices. It does not load dependency entry points or execute project code.
Run it directly from a prepared source checkout:

```sh
node scripts/audit-dependencies.mjs
node scripts/audit-dependencies.mjs --include-dev
```

The default production report retains schema version 1. The explicit development
mode uses version 2 and reconciles every locked location with its actual installed
package identity. Alias names and duplicate nested locations remain distinct.
Unknown or repeated arguments fail before the audit starts. This is source setup
tooling; it is not an MCP discovery operation or an installed-package command.

Development mode records manifests and ordered installed-file content digests,
excluding the separately enumerated nested `node_modules` tree. Symlinks,
nonregular entries, changed files, individual files above 128 MiB and package
contents above 256 MiB or 8,192 files are refused. These are per-package bounds;
they do not establish a global resource bound or a hermetic filesystem snapshot.

Absent optional packages remain accounted for. Literal OS/CPU constraints and
inherited incompatible ancestors can justify a platform exclusion only when no
compatible root path reaches the missing package. An absent compatible optional
package remains a gap. Required missing packages and conflicting installed
locations are errors. Platform selection is not a claim that another platform's
binary has been validated.

Notice filenames use an exact case-insensitive set. Backup names such as
`LICENSE.backup`, `NOTICE.old` and `COPYING.save` cannot supply a notice.
Recognized license variants and the existing pinned upstream fallback retain
content bindings; a fallback that has become unnecessary is refused. An
unrecognized filename remains a gap pending deliberate reconciliation.

A complete audit exits 0. Missing declarations or notices produce an incomplete
report and exit 2. Invalid trees, stale bindings and unsafe contents fail without
a successful report. The current development audit remains incomplete because
some packages omit notices; [the measured results](measurements/npm-provenance-2026-10-11.json)
record the exact gaps and package accounting. The recorded production audit is
complete for its narrower npm scope.

Original synthetic controls passed on the recorded macOS ARM64 Node runtimes.
Paired mutations remove scope, content, bounds, notice and optional-path guards;
each causes its unchanged callback to fail for the intended assertion before the
guard is restored. A native reproduction showed that the former notice pattern
admitted `LICENSE.backup`; both report modes now refuse it. These source harness
results do not certify a fresh production installation or native Windows.

The current source controls also admit each exact aggregate package limit and
refuse one extra byte or file while the individual files remain valid. Removing
either aggregate guard left the earlier controls passing; the added boundary
cases reject both valid guard removals. Dated measurements retain their original
source and installed-tree bindings and do not qualify later refreshes.

Declared registry integrity is retained, not recomputed against npm archives.
Installed content hashes do not authenticate producers. License strings and notice
presence do not establish legal compliance. Native compilers, framework artifacts,
container layers and complete artifact/license closure remain outside this slice.
Gate A, inference and field evaluation remain open.
