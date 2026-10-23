# Common defects and paired external-review scores

This operator component connects [physical independent judgments](EVALUATION-JUDGING.md)
to separately frozen common-defect identities, anonymous mapping responses and
the existing [paired multi-claim scorer](REVIEW-MULTI-SCORING.md). It invokes no
model, downloads nothing and does not authorize a trial. Development controls use
original synthetic records only. The full independent-evaluation profile and
Gate A remain open.

`freezeReviewEvaluationCommonDefects` validates an exact prospective protocol and
one inventory row per selected case. Rows declare a label and unique material or
nonmaterial defect identities, families and descriptions. A defect-labelled case
requires at least one defect; valid, near-miss and unresolved cases have none.
Missing, foreign, duplicate and contradictory inventories fail before a file is
written. The immutable private `common-defects.frozen.json` must be created before
local capture sealing. This local order check does not authenticate an external
freeze date, label authority, source exposure history or license grant.

Ordinary review and judge packets never read this answer inventory. After all
planned judge paths have been sealed, `prepareReviewEvaluationMatching` binds the
exact judgment archive and frozen inventory to one anonymous matching slot per
selected case. Every target and disclosure bound is validated before exclusively
creating `matching.book.json`. An earlier file is never replaced.

The explicit operator source grant returns one matching packet containing that
case's source context, common defect inventory and all retained anonymous review
claims across roles/repetitions. It omits structured role identities, reviewer
probabilities, earlier judge dispositions and host sessions. The curator can map
several claims to the same defect. This stage intentionally sees the common
inventory; the earlier independent judges do not. Untrusted text can identify
itself, so structural omission does not prove semantic anonymity or host isolation.

Responses bind the exact packet and declare a fresh session, terminal status and
one mapping per exact anonymous review/claim address. Each mapping names an exact
same-family common defect or null. Prefixes, adjacent identities, omitted or
repeated addresses and foreign claims are rejected. Declared curator sessions
cannot repeat across supplied responses or reuse any reached review or parseable
judge response session. Unique strings do not authenticate execution independence.

`sealReviewEvaluationMappings` retains bounded physical response files by digest,
including malformed, missing, duplicate, foreign and unfinished submissions. Its
exclusive sealed archive supports replay without reopening incoming blobs.
Changed hashes, duplicate/unused/omitted retained inventories and inconsistent
missing inventories fail replay. Summaries retain complete planned/supplied
counts and mapped/unmapped/unavailable claim counts; these categories reconcile.
The private POSIX storage and link/permission/read-stability boundaries are shared
with capture and judgment sealing.

`scoreReviewEvaluationArtifacts` rederives two comparisons over the same complete
case/repetition inventory: baseline versus verifier, and reference versus verifier.
Every repetition retains its incident cluster. It uses the existing whole-cluster
resampling, pooled case/claim denominators and explicit missing/unresolved states.
No unsuccessful arm or missing judgment/mapping disappears from selection.

A supported disposition needs both an accepted independent judgment and an
accepted same-family common-defect mapping. Curator agreement alone does not
support a claim. Duplicate claims remain in claim counts while material-defect
recall uses the unique common defect. Probabilities come only from the sealed
original reviewer output; judges and curators cannot supply replacements. Unknown
probabilities and unscored/unresolved claims remain explicit. This binding is not
confidence calibration or verification of claim truth.

Invalid/free-prose reviews remain incomplete. A structurally valid empty review
can finish with no claims; it still misses every declared material defect and
has undefined claim precision. Complete structural scoring bindings do not mean
a quality pass. Unknown labels, absent judgments, unresolved dispositions and
missing mappings keep the corresponding binding/readiness states incomplete.
Measurement accounting remains separate from those artifact bindings. Actual
host budgets, billing, independence and label authority remain unverified.

The core scorer's `held-out` purpose follows the declared reserved cohort here;
actual holdout provenance and chronology are not independently verified. Returned
comparisons are descriptive projections with no raw source, claims, case/session
addresses or private identity mappings. Hashes, activity counts and statistical
aggregates can still disclose equality and usage. Quality is not assessed and no
Gate A completion follows from numerical results. The operator must separately
apply the frozen thresholds and the later evaluation gates to real eligible data.

Limits include 256 selected cases, 32 defects per case, 4,096 total defects,
32 claims per review and 192 mappings per case. At most 512 submitted mapping
records permit retained duplicate/foreign records. Physical responses are limited
to 1 MiB each, 16 MiB of unique response bytes and 32 MiB per encoded book/archive;
complete disclosed packets are limited to 4 MiB. The existing scorer separately
limits retained claims to 4,096 per arm. These combined limits do not promise
every schema-maximum combination fits.

The shared setup CLI reads at most 4 MiB of valid UTF-8 JSON:

```sh
node scripts/evaluation-matching.mjs freeze PROJECT STORE PROTOCOL_SHA256 < private-common-inventory.json
node scripts/evaluation-matching.mjs prepare PROJECT STORE JUDGMENTS_SHA256 INVENTORY_SHA256
node scripts/evaluation-matching.mjs packet PROJECT STORE BOOK_SHA256 ANONYMOUS_ID --allow-source
node scripts/evaluation-matching.mjs seal PROJECT STORE BOOK_SHA256 < private-mapping-submissions.json
node scripts/evaluation-matching.mjs inspect PROJECT STORE MAPPINGS_SHA256
node scripts/evaluation-matching.mjs score PROJECT STORE MAPPINGS_SHA256
```

Freeze input is exactly `{declaration, inventory}`. Submissions are
`{blindId, responseSha256}` records; null explicitly retains an unrun slot.
The packet command deliberately discloses source and common answers to the
curator. Seal/inspect/score produce aggregate projections. Exit 0 means internally
complete resolved stage/binding accounting, 2 means incomplete/unresolved
accounting and 1 means invalid/unavailable input or artifacts. Error text omits
private input. No command adds a model-granted execution permission or changes
the installed MCP catalogue.

The required `evaluation-common-matching` source and fresh offline installed
controls cover the complete original capture/judge/map/score path, repeated
clusters, duplicate defects, preserved probabilities, missing/foreign/reused
sessions, stale physical inputs, exact boundaries, abstention and CLI privacy.
Final runtime acceptance, the actual private reference/acquisition/protocol freeze,
whole-profile Gate A callbacks and demonstrated review quality remain separate.
