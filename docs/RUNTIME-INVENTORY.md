# Runtime inventory comparison

`compare-runtime` compares complete declared collections of routes, listeners,
middleware, schedules and container bindings. It operates on local artifacts
without loading the application. The same implementation is exported as
`compareRuntimeInventories(before, after)` and exposed through MCP
`runtime_comparison` with relative `before` and `after` paths.

```sh
checktrail compare-runtime --root /path/to/project \
  --before before-runtime.json --after after-runtime.json --detailed
```

The versioned `runtime-inventory.schema.json` records producer name/version,
assembly name/environment, source fingerprint, capture timestamp, and explicitly
named collections. Every collection declares completeness and whether entry
ordering matters. Entries have an exact key and flat attributes (strings,
numbers, booleans, null, or ordered string arrays). This permits framework
collectors to retain methods, paths, handlers, middleware, scheduling expressions,
binding implementations and singleton flags without embedding executable code.

Repeated registrations remain repeated entries. Comparison accounts for their
multiplicity; it never deduplicates listeners before comparing them. Attributes
are compared structurally, object property ordering is ignored, and attribute
array ordering is preserved. Declared ordered collections detect a pure reorder
even when every registration remains present. `orderChanged` specifically reports
that pure-reorder case; other changes are reported through added/removed entries.
A changed attribute counts as removing the previous registration and adding its
replacement. Exact identifiers are used throughout.

Both artifacts must name the same assembly, environment and producer. Versions
and source fingerprints may differ, as expected when comparing revisions.
Collection ordering modes must agree. Missing, incomplete or incompatible
collections are unverified; their absent entries are not reported as removals.
Unknown collection kinds, duplicates, unknown schema keys and malformed values
are errors. Empty complete collections are comparable; an entirely empty profile
is rejected. Limits are 8 MiB and 20,000 entries per artifact.

The result is `passed` for matching complete declared collections, `failed` for
known differences, and `incomplete` when remaining collections cannot be
compared. Known changes take precedence over incompleteness, which remains visible
in counts. `compared + unverified = collections`. Added/removed counts describe
registrations, while changed counts describe collections. Detailed results include
changed keys; summaries omit keys, attributes, assembly names and paths.

This is imported evidence, labeled `imported-runtime-comparison`. A matching
snapshot is not evidence of current source freshness, runtime capture correctness,
authorization correctness or coverage of unlisted assembly categories. A producer
must enumerate the actual runtime values, including package/default registrations,
and claim completeness only for categories it can inspect. Collector execution
belongs in a trusted isolated test environment. Native framework collectors and
their compatibility matrices are separate implementation gates.

Synthetic regressions cover every collection family, duplicate multiplicity,
attribute/order changes, exact-name near misses, missing versus empty collections,
partial evidence, artifact limits, CLI exit codes and MCP privacy/root boundaries.
