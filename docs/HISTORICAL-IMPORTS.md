# Historical JS/TS imports and consumers

The `js-ts-historical-imports-v1` profile collects a bounded union of JavaScript
and TypeScript files under explicit, disjoint project roots in an immutable Git
base and the selected current source. It uses the engine's pinned TypeScript
6.0.3 parser. It neither evaluates project configuration nor imports project code.

```json
{
  "schemaVersion": 2,
  "profile": "js-ts-historical-imports-v1",
  "projects": [
    { "id": "library", "root": "packages/library" },
    { "id": "web", "root": "packages/web" }
  ],
  "baseCommit": "0123456789012345678901234567890123456789",
  "currentSource": "working-tree"
}
```

Supply the exact local commit object, rather than a branch name. `currentSource`
is `working-tree` or stage-zero `index`. Collection uses the existing
`collect-imports` CLI, `import_context` MCP tool and shared library. Version 1
current-source inputs remain supported. Public input, report and summary schemas
include both profiles.

The configured root must be the exact Git worktree root before any object-tree
enumeration. Git inspection uses the trusted host Git executable outside the
project with hooks, replacement objects and lazy network fetching disabled.
`executionInvoked: false` describes project-code execution; these read-only Git
subprocesses are still invoked.

Git enumeration automatically finds supported regular source files in both
revisions. A deleted consumer's old source and dependency edges remain visible;
a moved file is an addition and deletion, with no inferred rename identity.
Revision-specific project edges remain separate, and their union drives
conservative reverse-consumer traversal. Changes are derived from the captured
source bytes and selected regular-file modes, rather than operator-supplied
changed paths. Whole functions, declarations, defaults and lexical caller evidence
remain bound to their base/current revision in the retained review context.

The declared source scope is at most 16 distinct paths, 64 KiB per file and
128 KiB combined across both revisions. Git inspection has bounded calls, time,
output and inventory entries. Malformed or exhausted source, unknown imports,
ambiguous resolution, missing aliases, omitted paths, excluded unknown entries,
empty projects and unavailable Git scope retain every declared project in
`full-fallback`. Excluded private/build/vendor source is never opened or restored.
Counts describe this capture, rather than all runtime imports or callers.

The report records immutable base, HEAD, index identity, source inventory,
revision-bound source and parser metadata, modes, captured changes and omitted
scope. Reconstruction re-enumerates Git and physical source before accepting an
imported report; a recomputed report digest alone is not freshness evidence.
Working-tree modes belong to working-tree receipts. Index receipts bind the
stage-zero mode. The broader physical inventory fingerprint still includes
working file bytes and exclusions, as documented in `ARCHITECTURE.md`.

Detailed source and graph disclosure requires both operator `--detailed` and
`--allow-review-source`. Summary output omits source, addresses, roots, project
IDs and Git revision identities. MCP arguments cannot grant those permissions.
Partial CLI collection exits with status 2. The profile leaves validation plans
unchanged and does not prove runtime reachability, a complete project-module
graph, intended policy, claim truth or review quality.

Acceptance uses original synthetic deleted/moved consumers, broken/fixed and
root-boundary near misses, staged/working differences, old unresolved imports,
symlinks, malformed/exhausted/omitted source, stale/rehashed evidence, and real
CLI/SDK MCP disclosure controls. Compiling mutations retain the original test
callbacks. The fresh offline package harness selects `import-history`; the
original `import-context` profile is repeated separately. Other language,
framework, impact and Gate A obligations remain open. No inference or field
review is invoked by this development acceptance.

Revision-pinned historical import acceptance is recorded in
[historical-import-context-2026-10-07.json](measurements/historical-import-context-2026-10-07.json).
The receipt retains both final profiles and unaccepted development attempts; it
does not promote broader Gate A capabilities or review quality.
