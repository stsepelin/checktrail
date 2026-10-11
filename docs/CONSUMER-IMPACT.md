# Consumer impact

Git selection still requires an explicit complete workspace declaration. The
shared engine additionally reconciles a finite captured-source import profile
before narrowing an all-Node-test plan. Planning executes no project code,
loader, compiler configuration or manifest script.

The selected profile reads regular UTF-8 `.js`, `.mjs` and `.cjs` files. It follows
literal imports, reexports, dynamic imports and direct `require` calls naming an
exact inventoried relative `.js`, `.mjs`, `.cjs` or `.json` file. Unowned shared
module bridges are traversed before projecting consumer/producer edges. Project
ownership compares full directory boundaries, using the longest configured root.
Every captured edge must be reachable through the declared dependency graph;
cycles terminate. An omitted captured edge retains every configured check.

Named `readFile`/`readFileSync` imports from `fs` or `fs/promises` additionally
capture an exact literal `new URL(relative, import.meta.url)` resource. Reader
aliases are accepted only at their import and direct calls. Indirect paths,
namespace readers, shadowed bindings and excluded physical inputs retain the
full plan. Captured resource edges include shared JSON contracts.

The exact selected Node builtin set is `assert`, `assert/strict`, `path`,
`path/posix`, `path/win32`, `url`, `buffer`, `fs` and `fs/promises`, with their
`node:` spellings, plus `node:test` (whose prefix is mandatory). Other builtin capabilities, bare package imports, package
aliases, extension searches, directory entry points, query/encoded paths,
computed runtime access, dynamic loaders (including the CommonJS global `module`)
and environment-dependent source inputs are unknown. TypeScript/compiler configurations, other language families,
non-Node-test checks, granted project environments and overlapping root/subproject
ownership retain the full plan. These restrictions deliberately trade selection
for broader validation.

Bounds are 256 project roots, 512 parsed files, 4 MiB per parsed file, 16 MiB in
total, 100,000 visited syntax nodes, nesting depth 64 and 8,192 file edges. Reads
use held regular-file descriptors with byte/stat reconciliation. Invalid UTF-8,
syntax, exhausted bounds or an observed source-fingerprint change produce unknown
impact. The later execution source/Git freshness checks remain in force.

This profile supplies additional conservative evidence for the maintainer's
declaration; it does not prove a complete runtime graph, attest source races,
resolve arbitrary JavaScript execution or add unconfigured checks. Summary
plans/reports retain only the existing selection reason/count projection.

`scripts/impact-corpus-v2.json` defines the current original development controls.
Its misdeclared graph expects full validation and both failing consumers. The
version 1 corpus and published observations remain unchanged historical evidence
of the earlier omission. Neither corpus is independent held-out evidence.

[Measured foundation controls](measurements/consumer-impact-foundation-2026-10-11.json)
passed on the recorded macOS/Node and offline Linux/Node profiles, including paired
guard removal and a fresh production installation with an external
harness. Both current paired corpora retain every observed native failure. The
CommonJS global module-loader regression fails before its guard and passes after
the repair. CI runs source controls, paired guards and offline installed checks.

The broader Gate A consumer-impact profile remains pending: native
producer/consumer chains for every advertised language, whole-profile frozen
nine-case source and fresh installed acceptance, and final acceptance bindings
still need measurement. No inference, field evaluation or review-quality claim
follows from this foundation.
