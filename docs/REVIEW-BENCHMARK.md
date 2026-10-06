# Sealed synthetic workflow and judgment intake

`ReviewBenchmark` connects the shared reviewer workflow and its durable journals to
an operator-frozen, paired synthetic readiness protocol. The library, operator CLI
and `review_benchmark` MCP worker view share this engine. It invokes neither a
model nor project code. AI selection, subscriptions/API authentication and actual
session isolation remain the host's responsibility.

This profile prepares R7/R8 tooling before Gate A. It accepts only declared original
synthetic development cases. It does not enable new real-project field trials,
held-out execution, quality claims or a prior-workflow comparison. Required tasks
and Gate A remain open. See [REVIEWER-TASKS.md](REVIEWER-TASKS.md).

## Frozen protocol

The strict version 1 plan uses profile `workflow-journal-paired-synthetic-v1` and
provenance `operator-declared-original-synthetic`. Origin and labels are declarations,
not independently verified facts. The operator supplies:

- A curator session identity, exact Node/platform/architecture profile and one or
  two repetitions.
- Exactly two named arms, their instructions, pinned host client/version/provider/
  model declarations, and full workflow/native startup settings. Arm instructions
  are visible to their worker; arm names stay in the operator manifest. This
  engine checks recorded settings, not the host's implementation of an arm.
- One to four cases with distinct curator IDs, group IDs, hidden broken/fixed/
  near-miss labels and expected-defect declarations. Each case contains a parsed
  version 5 working-tree snapshot from `createReviewContext`. Diff/history contexts
  are unavailable in this readiness profile. Fixed/near-miss labels cannot declare
  expected defects.

An optional `judging` profile freezes the judge instructions and exact declared
client/version/provider/model before review. Existing plans without it remain
readable but cannot prepare judge response paths or seal judgments. It cannot be
added after freezing. This profile predeclares exactly one response slot per
anonymous judging ID; retries and all external host attempts are not implemented
by this intake.

Every case/repetition has both arms using the same captured source context. Pair
order is randomly selected before any trial; trial and judging IDs are independent
UUIDs. The inventory is exhaustive and rejects duplicate or missing slots. The
manifest pins engine version and an observed runtime JS/package byte digest, contexts, labels, instructions, host/runtime/settings
and trial inventory. Its exact bytes have a SHA-256 reference supplied independently
at operator startup. There is no model-selected protocol replacement.

Each trial requires `workflowLimits.maxWorkflows: 1` and explicit full workflow
limits. Native wall/output/aggregate limits and probe digests must fit the existing
native profile. The journal path is derived from the trial ID before review:
`journals/TRIAL_UUID.jsonl`. Journal admission is fixed at 4 MiB and 256 events per
trial. The audit's completion reservation still applies, so large packets or many
commands can exhaust admission earlier than these nominal maxima. Exhaustion is
incomplete evidence. This profile has at most sixteen planned trials; each archive
is bounded to 128 MiB and the manifest to 16 MiB.

Storage requires POSIX, an absolute destination outside the reviewed root and an
existing operator-owned parent with mode `0700`. Freeze creates a fresh private run
directory, a private journals directory and a `0600` manifest. Existing destinations
are rejected. Inputs are validated before writes; ordinary creation failure removes
the new directory. A crash can leave an unfinished directory, which cannot be
loaded as a valid frozen run. Artifact publication uses flushed private temporary
files and exclusive links; earlier collection/judging files are never overwritten.
These checks are ordinary filesystem guards, not an OS security boundary.

## Operator and worker interfaces

Prepare the plan privately; its schema is distributed as
`schemas/review-benchmark-plan.schema.json`. Freeze it with:

```sh
node dist/src/cli.js review-benchmark-freeze --root /path/to/synthetic-source \
  --input /path/to/private-operator/plan.json \
  --output /path/to/private-operator/new-run
```

The output contains `{ reference: { directory, sha256 }, summary }`. Subsequent
operator commands use `--benchmark ABSOLUTE_DIRECTORY#sha256=DIGEST`:

| Command                           | Additional input | Result                                      |
| --------------------------------- | ---------------- | ------------------------------------------- |
| `review-benchmark-status`         | None             | Source-free whole-run accounting            |
| `review-benchmark-setup`          | `--trial UUID`   | Private journal binding and frozen settings |
| `review-benchmark-packet`         | `--trial UUID`   | Anonymous source packet, with startup grant |
| `review-benchmark-collect`        | None             | Exclusive all-slot journal snapshot         |
| `review-benchmark-judge`          | None             | Exclusive anonymous judging packet file     |
| `review-benchmark-judge-setup`    | `--judge UUID`   | Private fixed response path and binding     |
| `review-benchmark-judge-packet`   | `--judge UUID`   | One source packet, with startup grant       |
| `review-benchmark-seal-judgments` | None             | Exclusive all-slot judgment archive         |

Packet disclosure requires `--detailed --allow-review-source`. Setup is an operator
operation: it returns a path and `{runId, trialId, protocolDigest}` binding. Give a
fresh `ReviewWorkflowSession` its `audit` settings, or write the binding and workflow
limits to private operator JSON files and pass:

```sh
node dist/src/cli.js review-session --root /path/to/fresh-trial-source \
  --detailed --allow-review-source \
  --workflow-limits /path/to/private-operator/limits.json \
  --workflow-audit-binding /path/to/private-operator/binding.json \
  --workflow-audit /path/to/private-operator/new-run/journals/TRIAL_UUID.jsonl \
  --workflow-audit-max-bytes 4194304 --workflow-audit-max-events 256
```

The operator must prepare each fresh source workspace with the frozen bytes and
its context file, end every host process before collection, and separately enforce
fresh AI sessions with no curator, sibling-output or earlier conversation access.
The engine's source checks verify ordinary workflow freshness. This harness does
not launch a host, copy dependencies, enforce an OS sandbox, clear conversations,
or observe whether those isolation steps occurred. Native recipes and execution
trust remain independent operator startup inputs.

For a worker MCP process, `serve` requires both the pinned reference and one trial:

```sh
node dist/src/cli.js serve --root /path/to/fresh-trial-source \
  --benchmark /path/to/private-operator/new-run#sha256=DIGEST --trial TRIAL_UUID \
  --detailed --allow-review-source
```

Add the same audit/binding/limits flags if that process runs `review_workflow`.
`review_benchmark` accepts only `{operation: "status"}` or `{operation: "packet"}`.
The selected trial is fixed at startup. Its metadata/packet contains no sibling
handles, curator IDs/groups/answer labels, journal paths, previous outputs, host
profile or arm name. Unknown fields and attempted collection/judging operations
are rejected. Discovery and worker reads create no benchmark artifacts. Operator
library methods `command`, `trialSetup`, `collect` and `prepareJudging` are distinct
from the restricted `workerCommand` method.

Source and instruction text can itself identify a case or condition. A host with
filesystem access can read the operator manifest. These structural omissions do
not prove semantic blinding or host isolation. Issuing packets is not an audit of
external AI attempts; admitted workflow commands are recorded by the separate
[workflow audit](REVIEW-WORKFLOW-AUDIT.md).

## Collection and judging preparation

Collection captures every predeclared path in one operation, then checks the paths
again before publishing. A private bounded file is retained byte-for-byte, including
invalid records and interrupted tails. Missing paths remain missing; unsafe,
unreadable or oversized files are unavailable, with no invented digest or command
counts. Invalid journals have unknown counts. Counts are `null` when unknown.
There is no successful-only intake, replacement path or favorable retry selection.
Repetitions and the workflow's bounded stage retries retain their planned identities.

Valid journal prefixes use the existing hash/order/command/assignment/native-receipt
inspector. Intake additionally reconciles version 2, the frozen run/trial/protocol
binding, engine version/runtime byte digest and host runtime identity, startup settings, one workflow, source context,
issued reviewer source and declared host profile. Cross-trial reuse of a declared
session ID, or reuse of the curator ID, marks every affected trial foreign. This
also checks session declarations in structurally malformed admitted submissions.
It cannot establish that different IDs identify different actual sessions.

Trial statuses distinguish missing, unavailable, invalid, foreign, interrupted,
sealed-incomplete and sealed-completed evidence. Completed means the recorded
advisory workflow disposition finished with retained command/native accounting;
it does not mean a defect was verified, a native check ran, or a repository passed.
All planned slots contribute to `accounted`, including failures. CLI collection,
status and judging preparation exit `2` after collection when any planned trial is
not completed. Worker packets close after collection.

`judging.json` cannot be prepared before all slots have been collected. It contains
one anonymous packet per planned trial, sorted by independent judging ID, with the
frozen context, accepted reviewer output and reached structured native receipts.
Rejected/replayed submissions remain in the private raw archive and do not become
extra accepted outputs. Foreign/invalid evidence has no attributed reviewer output.
Curator labels, arm names, host identity/usage and trial-to-judge mapping remain in
the operator manifest. Model/recipe/source prose and native observations can reveal
conditions; the engine does not certify blinding. The separate judgment intake below retains bound responses. It does not run an
independent judge, release an answer book, verify claims, fit calibration or compute
paired cluster uncertainty.

Every reopen checks the frozen manifest pin. Collection is reconciled against the
reached journal bytes; late output, a missing path becoming populated, changed
observed permissions/content or a forged collection invalidates subsequent status/judging.
Unavailable files have no observed byte digest; changes that remain unavailable
cannot be compared as though their contents were known.
Prepared judging packets are recomputed from the retained collection and compared
to their file. Journals are never resumed by this harness. The runtime byte digest covers the shipped top-level JS modules and package
declaration, with bounded regular-file reads and observed file/inventory stability.
Observation reads the bounded module inventory on each run load/audit preflight;
collection/status also rechecks the bounded journal inventory. Representative
performance remains unmeasured. Dependency contents, cached loaded modules and future dynamic loads are not
authenticated by this digest. A frozen run rejects different observed runtime
bytes under the same package version. The chains and receipts
remain internally checked and externally unanchored; manufactured complete
artifacts cannot be authenticated.

## Anonymous judgment response intake

After collection and judging preparation, `judgeSetup(blindId)` returns the fixed
private `judgments/BLIND_UUID.json` path, response bound and binding. `judgeWorkerCommand`
accepts only the same strict `status`/`packet` operations as a reviewer worker. The
CLI uses `--judge UUID`; `serve --benchmark REFERENCE --judge UUID` selects one
judge slot at startup, mutually exclusive with `--trial`. `review_benchmark` then
returns only that judge's packet or source-free metadata. Packet disclosure still
requires `--detailed --allow-review-source`. Tool arguments cannot select a sibling,
write a response, seal results or grant disclosure. Discovery writes no artifacts.

A packet contains the assigned source context, reached native receipts, accepted
reviewer outputs and occurrence-bound claim IDs. Its assignment digest binds the
frozen protocol, collected bytes, instructions and exact anonymous evidence. Curator
answers, arm names, trial mapping, host profile, sibling packets and earlier judgment
responses are absent. Source, instruction, model and recipe prose can still reveal
conditions; these omissions do not prove semantic blinding or host isolation.

The host writes one private `0600`, singly linked response to the predeclared path
before sealing. The distributed `review-benchmark-judgment-response` schema requires
the blind ID/digest, host/session/isolation declarations, terminal status, nullable
usage meters and nullable output. A completed output accounts for every issued
claim exactly once and declares a case label and supported, wrong-mechanism,
wrong-address, unreachable-fix, out-of-scope, refuted or unresolved dispositions.
Known labels/dispositions require citations whose file, current revision, digest,
line range and quote match the frozen source. A supported claim requires a defect
label. Unresolved labels and claims can omit citations. Refusal/cancellation/other
incomplete statuses must have null output. No missing token, duration or cost meter
is changed to zero.

`sealJudgments()` reads every planned response path twice before publishing
`judgments-sealed.json` exclusively. Raw bounded response bytes, including malformed
JSON and interrupted tails, are retained. Missing paths, unsafe/oversized/unreadable
files, invalid responses, foreign bindings/host profiles and incomplete evidence
remain distinct. Every planned slot is accounted; unavailable bytes have unknown
digests. A declared session reused by the curator, any retained parseable reviewer
journal or another judge makes every affected judge row foreign, including malformed
JSON objects that still declare a session ID. Unknown isolation or unusable review
trial evidence remains incomplete. The engine cannot authenticate declared IDs or
recover session identities from unparseable reviewer journals.

`accepted` means that these structural checks passed with a fresh-session declaration;
it is not a verified claim or independently observed session. `resolved` counts
accepted outputs with no unresolved label/claim declarations. Neither count is a
quality result. CLI status/sealing exits `2` after sealing if any planned review is
incomplete or any judgment is unresolved/unaccepted. The response bound is 256 KiB,
the archive bound 8 MiB and each disclosed judge packet is bounded to 16 MiB. These
are engine storage/disclosure bounds, not host inference or billing ceilings.

Reopening compares the archive to the reached response snapshots and the current
frozen collection/judging artifact. Late population, changed observed bytes or
permissions, and forged verdicts fail the comparison. Unavailable-to-unavailable
changes have no authenticated content to compare. Packets and setup close after
sealing; prior artifacts are never overwritten. Pre-seal host attempts/overwrites
are not observed, so one retained response does not establish complete external
attempt accounting. This is a bounded original synthetic readiness profile;
independent claim validation, full host archives and paired scoring remain required.

Raw provider-side attempts, transport rejections before journal admission,
requests refused before audit reservation, arbitrary native stdout/stderr and
unreturned killed-process evidence remain outside the archive. Accordingly every
public result keeps `externalAttemptsComplete`, `hostIsolationVerified`,
`claimsVerified` and `qualityAssessed` false. Full independent benchmark execution,
prior-workflow validity, independently verified judged outcomes, all-attempt host archives and quality
scoring remain required work. No field evaluation ran to implement this profile.

Implementation evidence is recorded in
[the intake readiness measurement](measurements/review-benchmark-2026-10-05.json).
Judgment acceptance is tracked separately in
[the judgment readiness measurement](measurements/review-benchmark-judging-2026-10-05.json).

## Scoring sealed synthetic artifacts

An optional `scoring` profile must be present before freezing: profile
`sealed-single-claim-paired-synthetic-v1`, a 64-character hexadecimal seed,
128–4,096 resamples, confidence between 0.80 and 0.99, and exactly one family
assignment for every case ID. It requires the frozen judging profile and exactly
one expected defect for each broken case. Legacy plans may still be frozen without scoring at the current engine identity.
Already frozen artifacts retain their exact engine/runtime-byte identity requirement
and cannot acquire scoring after freezing.

`ReviewBenchmark.score()` and the operator command share this read-only engine:

```sh
node dist/src/cli.js review-benchmark-score --root SYNTHETIC_ROOT \
  --benchmark ABSOLUTE_DIRECTORY#sha256=DIGEST
```

Add `--detailed` for numerical rows. Anonymous reviewer/judge MCP workers cannot
score or access this operator view. The existing numerical MCP scoring tool remains
separate; workers cannot substitute its input for these sealed artifacts.

Scoring first reconciles the pinned manifest, every reached journal, collection,
judging packet, sealed judgment and current response. It derives both arm slots
from the manifest, keeping case repetitions in their declared incident group.
Pair/cluster identifiers in numerical rows are opaque digests. Common labels come
from the frozen synthetic variants, rather than choosing a favorable arm's judge
label. Missing review slots stay missing with known labels preserved. Interrupted
and unusable reviews stay incomplete; retained claims from those prefixes are
counted separately as unscored. The paired engine's metrics describe claims from
completed reviews, not every attempted or partial claim.

A completed review must contain exactly one accepted reviewer output and at most
one claim. Multiple completed claims abort scoring without a partial result;
there is no first/best-claim selection. The profile does not resolve general
multi-claim deduplication. An absent, rejected, unresolved or label-disagreeing
judgment leaves a completed claim unresolved in the conservative precision
denominator. A claim outside the declared family does the same. Disagreements,
unknown judge labels and missing/rejected responses have separate counts.
No probability is inferred from severity: the candidate contract has no numerical
probability, so proper probability losses remain unscored.

The report binds observed artifact digests, arm declarations and frozen scoring
parameters. `artifactBindingsChecked` and `pairingBoundToManifest` describe these
structural checks. They do not authenticate labels, claim truth, independent host
sessions, all external attempts or statistical sampling. These remain explicitly
unverified, and quality is unassessed. `scoringReady` requires completed reviews
and resolved, consistent accepted judgments; it can be true when every claim was
refuted. CLI exits `2` when readiness is incomplete. The calculation writes no
artifacts, executes no project code/model and cannot open a field trial.

Original `review-benchmark-scoring` controls cover exact preflight, legacy intake,
common-label denominators, repetitions, hand-computed claim errors/false alarms,
missing and interrupted evidence, label/family disagreements, multiple claims,
artifact changes, privacy and real CLI/MCP worker boundaries. The installed-package
helper repeats these original assertions with the harness outside shipped code.
Independent authoritative judgments, host isolation, complete external attempts,
numerical confidence/calibration and broader benchmark cohorts remain required.
