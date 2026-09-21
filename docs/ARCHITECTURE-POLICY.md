# Explicit architecture boundaries

`check-architecture` evaluates a captured project dependency graph against a
closed project/layer policy. It is language-agnostic: native tooling can supply
graphs from different languages using the same artifact contract. This feature
does not itself scan imports, run a build system, or attest graph completeness.

```sh
checktrail check-architecture --root /path/to/workspace \
  --input dependency-graph.json --policy architecture.json
```

The library exports `checkArchitecture(graph, policy)`. MCP exposes the read-only
`architecture_validation` tool with relative `input` and `policy` paths. Operator
root and output settings remain fixed at server startup. These artifact checks
need no project execution permission. Their outcome is separate from any native
validation report.

## Policy

Every project has an exact ID and exactly one declared layer. An allowed
dependency names a **consumer layer** and a **producer layer**. Edges not in that
allowlist are forbidden, including edges within the same layer unless explicitly
allowed. IDs are case-sensitive literal strings: prefixes, suffixes, `*` and
regular-expression characters have no matching semantics. Duplicate IDs, duplicate
edges and undeclared layers are errors.

```json
{
  "schemaVersion": 1,
  "format": "architecture-policy",
  "layers": ["domain", "application"],
  "projects": [
    { "id": "catalog-model", "layer": "domain" },
    { "id": "catalog-api", "layer": "application" }
  ],
  "allowedDependencies": [{ "consumer": "application", "producer": "domain" }],
  "requireAcyclic": true
}
```

With `requireAcyclic`, observed cycles fail even when every individual edge is
allowed. The report lists strongly connected components, including self-loops;
member order is for deterministic presentation, not a traversal path. Converging
paths and diamonds do not count as cycles. Detection uses bounded iterative graph
traversal rather than recursive calls.

## Evidence

The graph records its collector/version, capture timestamp, a global completeness
flag, project IDs, language labels, recorded source fingerprints, per-project
completeness, and exact consumer/producer edges. An edge referencing an absent
graph node is invalid. A project missing from either graph or policy makes coverage
incomplete. Known forbidden edges or cycles still fail when other evidence is
incomplete; the report does not discard a known violation.

Results carry `imported-dependency-graph` provenance and separate artifact/policy
fingerprints. The recorded graph can describe imports, build references or package
manifest dependencies; the collector must document which. A complete manifest
graph does not establish complete source import coverage. Recorded fingerprints
and completeness flags are declarations by that collector, not independent proof
of origin, current source state or absence of undeclared dependencies.

Project statuses mean `verified` (configured layer and declared complete capture),
`missing`, `unconfigured` or `incomplete`. Edge statuses are `allowed`, `forbidden`
or `unverified`. Their categories sum to the corresponding project/edge totals.
`captureComplete` preserves the graph-wide declaration separately. A one-project
graph with no dependencies can pass if complete and fully configured. It does not
claim that any tests ran.

Inputs are bounded to 8 MiB each, 1,000 projects, 20,000 observed dependencies,
128 layers and 16,384 allowed layer pairs. JSON schemas reject unknown fields.
Summaries omit project IDs, edges, layer names and cycle members; detailed output
is operator-selected. Exit codes are 0 passed, 1 policy violations, and 2 incomplete
or invalid evidence. No network, model or external project code is invoked.

The public `examples/package-contract/architecture.json` applies the same boundary
policy to a built producer and installed consumer. Its native integration test
derives the workspace package edge from the consumer's installed dependency
declaration, validates the packaged artifact through type and runtime checks, and
tests a synthetic reverse-edge violation separately. It is not a general native
import-graph collector. Additional language-specific graph collectors remain work.
