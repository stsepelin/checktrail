# Bounded imports and consumer context

The `js-ts-selected-imports-v1` profile discovers inventoried JavaScript and
TypeScript files beneath explicit, disjoint project roots. It parses captured
strings with the pinned engine TypeScript 6.0.3 dependency. It does not import
project modules, read project compiler configuration, load plugins or run a build.

```json
{
  "schemaVersion": 1,
  "profile": "js-ts-selected-imports-v1",
  "projects": [
    { "id": "library", "root": "packages/library" },
    { "id": "web", "root": "packages/web" }
  ],
  "changedFiles": ["packages/library/src/decision.ts"]
}
```

```sh
checktrail collect-imports --root /path/to/project --input import-scope.json
checktrail collect-imports --root /path/to/project --input import-scope.json \
  --detailed --allow-review-source
```

The library exports `collectImportContext`, `assertImportContextCurrent` and
`projectImportContext`. MCP exposes the read-only `import_context` tool with one
relative input path. Full source, addresses and project identities require both
startup `--detailed` and `--allow-review-source`. A tool argument cannot grant
source disclosure or execution. Summary output retains counts and the impact
mode, with no source, paths, graph edges or project IDs. Partial capture exits the
CLI with status 2; it never counts as complete capture.

## Scope and edges

The roots use exact path-segment boundaries: `web` does not include `website`.
They cannot overlap, escape the configured root or share identifiers. The profile
recognizes `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts` and `.cts`.
Discovery applies the existing inventory exclusions. Selected strings are retained
in a version 5 snapshot review context, including whole functions, declarations,
defaults, references, lexical callers and exact current-source/mode evidence.

Static imports, reexports, TypeScript import-equals external module references and
type-import expressions retain module occurrence addresses. Relative resolution
uses only captured files and the existing [syntax profile](REVIEW-BEHAVIOR.md).
A module can resolve to exactly one selected relative file. Ambiguous alternatives,
unselected/missing targets, package aliases and escaping targets remain unresolved.
Type edges are conservatively retained for impact, without claiming they execute.
A globally unbound `require` or dynamic import remains unknown; a locally declared
function named `require` is a lexical call, not a module import.

Project dependencies point from consumer to producer, deduplicating repeated
observations. The captured occurrence graph remains in the source context;
project-edge counts do not claim to count import occurrences. Traversing the reverse
project graph includes every declared consumer of a changed producer and terminates
for cycles. Root boundaries and sibling projects remain independent.

## Completeness and conservative impact

A collected result means the inventoried JS/TS scope under these roots was captured
and its recognized module occurrences resolved. It does not establish a complete
runtime graph or identify consumers outside the declared projects. Runtime dispatch,
project module resolution, excluded build/vendor source, other languages and
historical consumers remain explicit omissions.

Any unresolved occurrence, malformed/exhausted syntax, unknown changed path,
nonstandard inventory exclusion, empty project or capture/file limit selects all
declared projects in `full-fallback`. Deleted paths and configuration changes are
unknown changed paths in this current-source profile. A known excluded build/vendor
or sensitive entry is outside the declared profile; excluded symlinks with other
names force fallback. No excluded source is opened or restored to the context.

The result is advisory consumer evidence. `validationPlanUnchanged` remains true:
this profile does not narrow the engine's validation plan or override declared
workspace dependencies. Existing conservative plan selection stays in force.
Dependencies can be supplied to the explicit architecture artifact contract; that
contract's capture-completeness flag describes the supplied collector scope and
does not attest runtime reachability or project compiler resolution.

The profile allows 16 disjoint projects and captures at most 16 files, each at most
64 KiB and at most 128 KiB combined source. Additional inventoried JS/TS files are
counted as omitted, preserving full fallback. Graph/traversal limits are those of
`js-ts-syntax-v1`; overflowing them discards graph metadata and remains partial.
Input and report serialization are each bounded to 2 MiB. Limits are bounded
capture/traversal limits, not an OS sandbox or a parsing wall-clock deadline.

Reports bind normalized input, inventory identity, source strings, parser metadata,
project edges and impact through a digest. `assertImportContextCurrent` reconstructs
the report from current inventory and source, rejecting stale content/modes and
rehashed fabricated edges or impact. Projection alone validates the declared report
and its digest; use reconstruction before trusting an imported report as current.

## Acceptance and remaining work

The required `import-context` profile includes original synthetic broken/fixed/valid
boundary controls, transitive consumers, exact sibling roots, cycles, type imports,
shadowed-loader controls, malformed/exhausted/omitted source, escaping/ambiguous
imports, stale content/modes, rehashed forgery and source execution traps. It uses
real shared library, CLI and SDK MCP calls. The offline production-package helper
runs the same selected tests without installing project development tools; acceptance
client dependencies remain outside the product.

The [measurement receipt](measurements/import-context-2026-10-06.json) records the exact source and installed runtime identities,
unchanged-assertion mutations and limits. It establishes this bounded parser profile,
not reviewer quality. R1/R5/E3 still require other language collectors, wider caller
and framework context, historical consumer discovery and live integrations. Gate A
remains open; this work runs no model inference or real-project field review.

The bounded `js-ts-historical-imports-v1` profile additionally captures immutable
base and working/index consumers, deleted/moved source and revision-specific
edges through the shared import interface. See
[HISTORICAL-IMPORTS.md](HISTORICAL-IMPORTS.md). Broader language, framework and
impact obligations remain open; this does not narrow validation plans.
