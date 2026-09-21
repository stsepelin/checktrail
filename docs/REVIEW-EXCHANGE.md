# Optional advisory review exchange

Repo Verifier can prepare a bounded source context for a human, local reviewer or
model-backed MCP client, then inspect a structured assessment returned by that
reviewer. The engine does not invoke inference, select a provider, upload source,
execute reviewer instructions or apply changes. This implements an exchange
workflow; it does not establish review quality or independently verify a defect.

Every receipt has `channel: advisory`, `automatedCoverage: false`,
`claimsVerified: false` and `deterministicOutcomeChanged: false`. It has no
validation outcome and cannot become a native finding, SARIF result or finding
baseline through this API. A reviewer reporting no observations is not a passing
validation result. Native validation continues through its existing engine.

## Prepare a context

Select exact files and public guidance topics in a JSON artifact:

```json
{
  "schemaVersion": 1,
  "files": ["catalog.mjs"],
  "topics": ["test-lifecycle"]
}
```

`examples/review` supplies an original synthetic source and selection. In a local
checkout, prepare an ignored artifact directory before capturing the context:

```sh
mkdir -p examples/review/.repo-verifier
node dist/src/cli.js review-context --root examples/review \
  --input selection.json --detailed --allow-review-source \
  > examples/review/.repo-verifier/context.json
```

The default output is a summary. `--detailed` alone still omits source and review
prose for these commands. Source-enabled review output requires both `--detailed`
and `--allow-review-source`. For MCP, these are server startup settings; tool
arguments cannot grant access. The same gate protects imported assessment prose
and quotations, which can themselves contain source or private information.
Library callers use `createReviewContext()` and explicitly choose their output
projection with `projectReviewContext()`.

Contexts contain exact UTF-8 text, per-file byte digests, the bounded inventory's
source fingerprint, selected public guidance, a fixed review instruction and a
content digest identifying the complete context. Files and topics are sorted;
duplicate selections fail. Source and comments are labeled untrusted data. They
may contain misleading instructions; neither the collector nor importer executes
them, and a consuming reviewer must maintain that boundary.

Limits are 16 files, 64 KiB per file, 128 KiB combined source and 16 public topics.
Sources must be inventoried regular files with normalized relative paths. Excluded
secrets/dependencies/build output and symlinks cannot be selected. Binary NUL data
and invalid UTF-8 are rejected. These exclusions are not a secret scanner: a
credential embedded in an ordinary source file remains source. Enabled source
output can reach the MCP client's provider according to that client's behavior.

Context collection compares before/after inventory fingerprints. This detects
ordinary concurrent edits but is not an atomic filesystem snapshot or protection
against adversarial filesystem races. Fingerprints retain the inventory's limits
for dependencies, external files and services. Saving output outside the ignored
artifact directory can itself change the inventory; creating a new excluded
directory after capture also changes the recorded exclusion list.

## Receive an assessment

The reviewer returns the [assessment schema](../schemas/review-assessment.schema.json),
including the exact context digest, reviewer provenance, UTC creation time,
per-file dispositions and optional observations with exact source quotations.
Human reviewers declare a name; model reviewers declare provider, model and
version. Those identities and the reported creation time are declarations, not
verified credentials or measured execution evidence.

Usage fields are input tokens, output tokens, elapsed milliseconds and cost in
USD. Unknown values must be `null`, not zero. The engine labels every value
`reviewer-declared`; it does not infer pricing or claim a model call occurred.
Observations have a concern/suggestion label and at least one citation. IDs must
be unique. Files outside the selected context and reversed line ranges are rejected.
Out-of-bounds line numbers cannot match a quotation.
There are at most 64 observations, eight citations per observation and 256 KiB
of serialized assessment input.

Save the assessment under the ignored artifact directory and inspect it:

```sh
node dist/src/cli.js review-receipt --root examples/review \
  --context .repo-verifier/context.json \
  --input .repo-verifier/assessment.json
```

`receiveReview()` and MCP `review_receipt` use the same implementation. MCP
receives paths to local artifacts, not an arbitrary executable reviewer command.
The CLI returns 0 for a current, structurally accepted receipt with matching
quotations, and 2 for stale context, unmatched quotations or invalid input. Exit 0
means the receipt was processed; it does not approve code or verify claims.

The importer verifies the context's digest, captured bytes and current supported
guidance/instruction version, then compares the recorded inventory and selected
file bytes against current source. `freshness: current` only describes that
comparison. A recomputed digest cannot make fabricated source bytes current.
Older or modified instruction/catalogue contracts require an explicit migration;
they are rejected rather than silently interpreted as this version.

Citations use one-based inclusive line ranges. A quote must equal the complete
selected lines joined with LF, excluding the delimiter after the final line.
CR bytes in CRLF input are preserved. A matching quote establishes an anchor in
the recorded context, not the truth of the surrounding claim. After source changes,
a receipt can correctly say both `freshness: stale` and `citations.matched: 1`.

Coverage counters distinguish selected, declared reviewed, declared not reviewed
and unaccounted files. Missing dispositions stay visible; they are not silently
counted as reviewed. These counters describe the reviewer's accounting, not proof
that the reviewer inspected any file. Summaries omit paths, quotations, claims,
observation IDs and arbitrary reviewer names; they retain counts, usage declarations
and the opaque context digest. Detailed review output requires the source gate.

## Evidence and remaining limits

Tests exercise original synthetic contexts and assessments, exact quotation
matching, stale and forged source, duplicate/out-of-scope inputs, binary and size
limits, native CLI/MCP permissions and unchanged native validation outcomes.
The package helper `node scripts/verify-review-container.mjs` runs the review tests
and an offline fresh-install library/CLI/MCP workflow in a pinned Linux container
with networking disabled and read-only source mounts. Status belongs in `STATUS.md`;
a helper definition alone does not establish a successful run.

Manual mutations removed the selected-file freshness check and replaced the review
disclosure gate with ordinary detailed mode. The forged-source regression then
incorrectly became current, and the MCP privacy regression exposed source without
the grant. Both tests failed on those exact changes and passed after restoration.

Synthetic model names in tests are labels, not evidence of inference. No independent
held-out assessment, prior-workflow comparison, model accuracy, measured token
cost or calibrated confidence is claimed by this feature. Those M5 evaluation
requirements remain separate from correctness of the exchange protocol.
