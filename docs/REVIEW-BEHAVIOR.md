# Bounded JavaScript/TypeScript review context

Selection version 3 adds the advisory profile js-ts-syntax-v1 to the shared
library, CLI and MCP review exchange. Versions 1 and 2 retain their contracts.
The profile indexes captured text; it does not execute project code, validate
types, verify defects or establish runtime reachability.

```json
{
  "schemaVersion": 3,
  "track": "snapshot",
  "files": ["src/decision.ts"],
  "supportFiles": ["src/defaults.ts", "app/caller.ts"],
  "topics": ["analysis-scope"]
}
```

The files field identifies primary review scope. The supportFiles field is an
explicit operator selection of declarations and consumers to include as context.
The sets must be disjoint and contain no duplicates. Their combined limit is 16
paths, with 64 KiB per source file and 128 KiB combined source. Diff assignments
additionally require an immutable baseCommit; their source budget counts both
revisions. Paths, exclusions, Git identity checks and source disclosure use the
existing [exchange contract](REVIEW-EXCHANGE.md). No unselected file is added by
following an import. Supporting source requires the same disclosure grant as
primary source.

## Captured behavior

The profile recognizes .js, .jsx, .mjs, .cjs, .ts, .tsx, .mts and .cts, including
declaration files ending in those extensions. It captures:

- Whole function and arrow bodies, methods, explicit constructors and accessors,
  with containing declaration addresses. Function signatures without bodies remain
  declarations rather than callable implementations.
- Function, variable, class, interface, type, enum, property, parameter and import
  declarations. Initializer spans retain parameter defaults and variable values.
- Selected lexical references to declarations, including default expressions and
  class bases.
- Call and construction expressions, their enclosing function where present and
  a unique selected lexical implementation when supported. Renamed imports,
  selected reexports and namespace imports can retain a binding.
- Static import/reexport edges, TypeScript import-equals external module and type-import edges, and explicit unknown dynamic import/require edges.

Every address carries its revision, selected path, half-open UTF-16 character
offsets and one-based inclusive source lines. These offsets address the exact
captured string, rather than UTF-8 bytes. IDs derive from the revision, path,
span and declaration kind. Sources still carry byte digests. The importer checks
range bounds, lines, IDs, ownership and reference targets before projecting a
packet.

For diff assignments, both revisions are analyzed separately. Deleted callers
remain base evidence. The overlapsChange field compares each function with the
existing conservative line replacement range; an unchanged function inside that
range may overlap. Snapshot overlap is null. There is no rename inference or
base-source observation citation in assessment version 1.

## Unknown and incomplete scope

Relative imports can resolve only against captured source. An explicit
JavaScript extension can name a selected TypeScript counterpart; extensionless
imports can name selected files or index files. Multiple candidates are
ambiguous, with no precedence guessed. Packages and aliases are external,
unselected paths are missing, paths escaping the virtual root are outside scope,
and malformed selected targets are unparsed.

A call link identifies a selected lexical definition, not a runtime call graph.
Receiver methods, indirect function values and dynamic dispatch remain
unresolved. Known assignments, destructuring assignments and increments suppress
links through a rebound binding, including selected imported definitions.
Type-only imports and selected named/star reexport paths do not become runtime
implementations. A selected value export path remains a valid lexical control. Unselected writes,
runtime mutation, framework assembly, decorators, prototype behavior, project
module resolution, ambient globals and generated source remain outside this
profile. It does not infer downstream consumers beyond selected support files.

Each captured revision/file has a primary/support role and one of collected,
unsupported, malformed, budget-exhausted or error. Unsupported languages retain
whole source without syntax metadata. Unsupported, malformed or exhausted files
make aggregate analysis partial; they cannot silently count as collected.
Unresolved edges can also exist in a collected syntax packet.

Each revision permits at most 20,000 visited nodes, depth 128, 512 functions,
2,048 declarations, 2,048 calls, 4,096 references and 256 module edges. Type-only star-path inspection is limited to 512 selected
file/name/erasure states per call.
Exhausting a traversal or count budget discards that revision's graph rather
than retaining a misleading partial graph. Combined serialized analysis is
limited to 256 KiB; exceeding it discards both graphs and marks previously
collected files exhausted. Captured source remains available. These are size
and traversal limits, not a wall-clock deadline.

## Parser and evidence boundary

Only version 3 lazily loads the pinned production dependency TypeScript 6.0.3.
Its compiler host serves captured strings from memory. It supplies no standard
library or project configuration, resolves only selected relative modules and
does not use the filesystem compiler host, consumer parser, plugins or emit.
Triple-slash references cannot read unselected files. The approach uses the
[compiler host interface](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API);
the installed pinned declarations define the implementation's API.
The existing parser version moved from development to production dependencies;
no dependency version changed. Package license notices remain with the installed
dependency; see [dependency provenance](DEPENDENCIES.md).

Version 3 receipts reconstruct the current packet for snapshot and diff tracks.
A recomputed digest alone cannot make fabricated syntax analysis fresh.
Summaries omit source, paths, names and graph metadata. Syntax collection grants
no project execution permission and makes no model call.

## Development verification and remaining work

Synthetic regressions cover moved behavior, unchanged neighboring decisions,
deleted consumers, aliases, shadowed names, namespace/type-only imports,
constructors, overloads, known rebinding, cyclic/reexported modules, unknown
resolution, malformed/unsupported source, budget exhaustion, Unicode/CRLF
anchors, fabricated analysis and project/configuration execution traps.
CLI/MCP controls compare exact engine packets and reject tool-level disclosure
grants. Offline package smoke exercises this profile before adding consumer
development tools.

These checks establish the bounded collector contract, not review quality.
Broader language and historical consumer collection, observed independent host
sessions, general claim resolution and blinded quality trials remain in
[the task ledger](REVIEWER-TASKS.md). Bounded current consumer collection,
revision-aware citations and refutation contracts have their separate profiles. New real-project
MCP field trials wait for completion of the planned work.

The required review profile names snapshot syntax controls. The review-git
profile names version 2 identity, historical scope and disclosure controls plus
version 3 deleted callers. The acceptance runner executes whole test files, so
both profiles currently require host Git even though snapshot collection itself
does not. Run node scripts/verify-required-native-tests.mjs review-git on a
prepared POSIX host. Local verification does not close the remaining platform
gates or verify Git availability in the existing container image.

Guard mutations redirected a shadowed parameter to an imported definition,
omitted parameter-default references and bypassed version 3 receipt
reconstruction. Each selected regression failed on its assertion, and the
compiled implementation was restored after each run. An unresolved call carrying
a nonexistent target ID also reproduced a structural validation gap before the
target check was added. These are development controls, not independent quality
measurements.

Context version 4 uses this same parser, profile, limits and completeness contract.
It changes the review instructions to require revision-aware assessment version 2;
see [REVIEW-EXCHANGE.md](REVIEW-EXCHANGE.md) for citation digests and unverified
attribution/fix-scope declarations. It does not broaden language or runtime scope.

Context version 5 retains the same syntax profile over the explicitly chosen
current source view. In index diff assignments, every current syntax address
refers to the captured stage-zero blob, rather than the unstaged working file.
Selected executable-mode evidence is separate from syntax and text change overlap.

The bounded [import and consumer collector](IMPORT-CONTEXT.md) automatically captures
inventoried JS/TS source under explicit disjoint project roots. It retains whole
source and static consumer edges, with full declared-scope fallback for unresolved
or incomplete capture. Other languages and historical consumers remain open.
