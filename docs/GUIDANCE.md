# Advisory review guidance

`guidance`, `retrieveGuidance()` and MCP `review_guidance` retrieve built-in review
questions. They do not run project code, call a model, fetch references, inspect
behavior or produce automated findings. Every response has `channel: advisory`
and `automatedCoverage: false`; it has no validation outcome. An empty selection
means no catalogue trigger matched, not that the project needs no review.

```sh
node dist/src/cli.js guidance --root examples/javascript
node dist/src/cli.js guidance --root examples/javascript --topic package-consumers --detailed
```

Normal CLI/MCP retrieval plans the project without execution and selects questions
by exact check IDs. Explicit topics add guidance. Each item matches if at least
one check or topic matches; overlap returns the item once. Selection is ordered
by the bundled catalogue. It is a deterministic lookup, not relevance ranking or
source-code analysis. The catalogue's content digest and each item's version
identify the actual guidance used.

Available topics: `test-lifecycle`, `analysis-scope`, `package-consumers`,
`python-imports`, `framework-assembly`, `execution-depth`. Guidance contains public
references for further reading; those references are not claims that a selected
project has a defect. Framework-specific references can illustrate a question
whose application must be checked against the actual framework.

Library callers can supply `{ schemaVersion: 1, checks: [], topics: [] }` directly.
CLI `--input context.json` uses the same bounded schema and cannot be combined
with `--topic`. Such inputs are declarations, not evidence that checks ran.
Unknown well-formed check IDs match nothing; unknown topics, duplicate identifiers,
unknown keys and oversized contexts fail. Input is capped at 16 KiB, 100 check IDs
and 16 topics. No repository-supplied prose or executable guidance packs are loaded.

Summary output includes the public question text, IDs, versions and references.
It omits context and matched triggers. Detailed output includes both. Neither
projection includes source excerpts, file paths or logs. Which questions were
selected can still reveal aspects of a project's tooling.

Native CLI and MCP tests verify execution-free retrieval, exact prefix/suffix
boundaries, deterministic selection, non-mutable catalogue state and output
controls. These are retrieval correctness tests. They do not establish improved
review quality, defect detection rates or equivalence to another review workflow.

For a selected-source context and an externally produced assessment, use the
separate [review exchange](REVIEW-EXCHANGE.md). It reuses this catalogue but does
not convert guidance or reviewer prose into automated findings.
