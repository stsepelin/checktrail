# Optional advisory review exchange

Checktrail can prepare a bounded source context for a human, local reviewer or
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
mkdir -p examples/review/.checktrail
node dist/src/cli.js review-context --root examples/review \
  --input selection.json --detailed --allow-review-source \
  > examples/review/.checktrail/context.json
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

### Independent snapshot and diff assignments

Selection version 1 remains supported with its original instructions. Version 2
adds an explicit track and instructions to begin a fresh independent review:

```json
{
  "schemaVersion": 2,
  "track": "snapshot",
  "files": ["catalog.mjs"],
  "topics": ["test-lifecycle"]
}
```

A snapshot context reads current selected files and includes no Git history,
commit identities or earlier source. Earlier assessments are not imported as
review state; the collector exposes only explicitly selected source. This is an
evidence boundary, not proof of reviewer independence:
fresh provider sessions, restricted access, answer hiding and isolated memories
still belong to the pending orchestration and evaluation harness.

For a diff assignment, use `track: "diff"` and `baseCommit` containing the exact
40- or 64-character lowercase commit ID. Branch names and revision expressions
are rejected. The same library function, CLI command and MCP tool collect only
selected base blobs and current regular files, with separate base/HEAD commit
IDs, an index fingerprint and the inventory's working-source fingerprint. Host
Git reads raw objects; hooks, filters, text conversion, replacement objects and
lazy fetching are disabled or avoided. This profile requires the configured root
to be the Git worktree root and currently uses the POSIX runner.

Selected paths may exist only in the base (deleted) or current source (added).
Historical files obey the inventory's secret/dependency/build exclusions even
when those paths have disappeared. Symlinks, submodules, binary/invalid UTF-8
blobs and excessive source fail collection. The same source disclosure gate
protects both revisions. The 128 KiB source budget counts base plus current bytes.
Git inspection shares a five-second, 4 MiB output budget; no project code runs.
HEAD and index identities and the working inventory are checked again before
returning the context. Receipt freshness additionally reconstructs the diff
context, so fabricated base bytes and changed HEAD/index identities cannot remain
current merely because working files are unchanged.

Each selected path has an added/deleted/modified/unchanged disposition, before/after
byte digests and an exact line replacement range. The range removes the common
prefix/suffix and can include unchanged middle lines; it is not a minimal diff.
Empty content, trailing newlines and CRLF bytes are retained. Renames appear as
separate additions/deletions when both paths are selected. File mode changes,
automatic rename inference, staged source and automatic caller discovery are not
implemented. Whole selected files
remain available, and version 2 completeness fields expose the selection and
missing analysis. Unselected paths are not implicitly reviewed.

### Bounded syntax context

Version 3 adds explicit `supportFiles` and a bounded JavaScript/TypeScript syntax
profile to either track. It captures whole functions, declarations/defaults,
selected lexical references and caller links with revision-aware addresses.
Unsupported, malformed and exhausted analysis remains partial; unresolved
dispatch and missing consumers remain explicit. Primary plus support paths share
the existing file/source budgets and disclosure settings. It does not execute
project configuration or code. See [REVIEW-BEHAVIOR.md](REVIEW-BEHAVIOR.md) for
the selection, pinned parser, collection limits and omissions.

Assessment version 1 remains the receipt format for context versions 1–3.
Its quotations address current source only. Version 4 keeps version 3's bounded
syntax profile and source limits, and changes the instructions and assessment
contract explicitly. It requires assessment version 2; the importer rejects
cross-version pairings. Existing contexts, instructions and receipt shapes stay
compatible.

### Revision-aware addresses and declared attribution

Use selection version 4 with the same track, files, support files and topics as
version 3. Each version 2 observation includes `attribution` (`regression`,
`pre-existing` or `unknown`) and `fixScope` (`this-change`, `follow-up` or
`unknown`). Snapshot assignments cannot establish historical attribution and
require `unknown`; a follow-up scope declaration is still allowed. Diff
attribution and fix scope remain declarations, not independently verified facts.
A regression label alone does not demonstrate a regression or an implementable
fix; that requires the pending probes and independent refutation pipeline.

Every citation additionally supplies `revision: "base" | "current"` and
`sourceDigest`, the exact SHA-256 digest of the captured file in that revision.
Deleted source is addressed at base; added source is addressed at current. An
absent revision is rejected without substitution. Even when an identical line
occurs in both versions, the digest must match the declared revision's complete
file. Incorrect digests or quotes produce unmatched checks; neither can become
a matching address on the strength of the other.

Detailed checks report the revision, separate digest and quote matches, and their
combined `matchesContext`. `changeOverlap` describes overlap with the captured
conservative replacement range (`replacement-range`,
`outside-replacement-range` or `not-available`). It is unavailable for snapshots
and unmatched anchors. An unchanged middle line can lie inside a replacement
range: overlap is neither proof the line changed nor proof of a defect.

Receipt version 2 retains the advisory nonverification flags and adds base/current
citation counts and attribution/fix-scope counters, each explicitly marked
`provenance: "reviewer-declared"` and `verified: false`. A deleted-only context
can now anchor observations and account for its selected path. Dispositions count
paths across the assignment; they do not prove either revision was inspected.
Missing dispositions and empty assessments remain visible without becoming a
validation pass. Summaries omit revisions' source, paths, quotations, observation
IDs, reviewer prose and Git identities; detailed output requires the existing
operator disclosure gate. No model is invoked by either track.

### Working-tree and index source with mode evidence

Selection version 5 retains the syntax profile and assessment/receipt version 2,
and explicitly chooses `currentSource`. A snapshot requires `working-tree` and
still contains no Git identities or history. A diff permits `working-tree` or
`index`; the latter captures exact stage-zero blobs rather than unstaged working
edits. Stage-only additions and deletions remain valid even when working files
have a different presence or content. Citations address the chosen revision's
captured bytes, with the same digest/quotation checks.

Each selected path carries separate before/after regular-file modes (`100644`,
`100755` or null for absence). Base/index modes come from raw Git metadata;
working modes reflect executable bits on the selected regular file. Mode-only
changes have no text replacement range. Selected mode changes and fabricated mode
metadata invalidate version 5 freshness. Whole-repository modes remain uncollected.
File handles compare size, identity, mode and nanosecond modification/change times
before and after reading, and version 5 working collection rechecks source/modes
following the final Git identity check. These checks catch the tested races;
they do not make collection an atomic or adversarial filesystem snapshot.

Index conflicts, selected symlinks/nonregular entries, invalid UTF-8, binary text
and aggregate overflow fail collection. The combined base/current source budgets
and historical exclusions still apply. Freshness binds the chosen index rather
than comparing staged bytes to working files, and reconstructs the full version 5
contract. Both source choices share library/CLI/MCP output gates. Older versions
retain their original working-only and mode-uncompared contracts.

The prepared Linux profile now requires Node and Git. Build the pinned local
`scripts/review-tools.Dockerfile` explicitly before running
`scripts/verify-review-container.mjs`; the helper inspects an existing image and
never prepares or downloads tools automatically. Its default local image name is
`checktrail-review-tools:finish-first-v1`; `CHECKTRAIL_REVIEW_IMAGE` can select an
operator-prepared equivalent. The helper records the resolved image digest and
checks both exact required review profiles, then exercises an offline production
installation through the library, CLI and MCP with networking disabled.

## Receive an assessment

The reviewer returns the [assessment schema](../schemas/review-assessment.schema.json),
including the exact context digest, reviewer provenance, UTC creation time,
per-file dispositions and optional observations with exact source quotations. Version 2 assessments require version 4
contexts and explicit revision/digest addresses and attribution/fix-scope fields.
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
  --context .checktrail/context.json \
  --input .checktrail/assessment.json
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
Version 3 and 4 receipts also reconstruct syntax analysis for both tracks before
accepting freshness; fabricated metadata cannot remain current just by
recomputing its digest. Older or modified instruction/catalogue contracts require
an explicit migration; they are rejected rather than silently interpreted as this
version.

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
matching, deleted-only/base/current citations, digest-swapped identical lines,
conservative range boundaries, historical attribution restrictions, stale and
forged source, duplicate/out-of-scope inputs, binary and size limits, native
CLI/MCP permissions and unchanged native validation outcomes.
The package helper `node scripts/verify-review-container.mjs` runs the review tests
and an offline fresh-install library/CLI/MCP workflow in a pinned Linux container
with networking disabled and read-only source mounts. Status belongs in `STATUS.md`;
a helper definition alone does not establish a successful run.

Manual mutations removed the selected-file freshness check and replaced the review
disclosure gate with ordinary detailed mode. The forged-source regression then
incorrectly became current, and the MCP privacy regression exposed source without
the grant. Both tests failed on those exact changes and passed after restoration.

Version 2 guard mutations bypassed collection-time Git identity checks,
diff-context reconstruction at receipt time and source disclosure for diff
contexts. The race, fabricated-base and CLI/MCP disclosure regressions each
failed for the intended reason; the implementation was restored after each run.

Version 4 guard mutations bypassed revision digest matching, substituted current
source for a deleted base address, allowed historical snapshot attribution and
skipped version 4 freshness reconstruction. Each intended regression failed; the
first admitted digest-swapped identical lines, the second rejected a valid deleted
citation, the third admitted unsupported historical attribution, and the fourth
marked fabricated base evidence current. All guards were restored and the
citation suite passed afterwards.

Synthetic model names in tests are labels, not evidence of inference. No independent
held-out assessment, prior-workflow comparison, model accuracy, measured token
cost or calibrated confidence is claimed by this feature. Those M5 evaluation
requirements remain separate from correctness of the exchange protocol.
