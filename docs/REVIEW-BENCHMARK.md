# Sealed synthetic workflow benchmark intake

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

| Command                    | Additional input | Result                                      |
| -------------------------- | ---------------- | ------------------------------------------- |
| `review-benchmark-status`  | None             | Source-free whole-run accounting            |
| `review-benchmark-setup`   | `--trial UUID`   | Private journal binding and frozen settings |
| `review-benchmark-packet`  | `--trial UUID`   | Anonymous source packet, with startup grant |
| `review-benchmark-collect` | None             | Exclusive all-slot journal snapshot         |
| `review-benchmark-judge`   | None             | Exclusive anonymous judging packet file     |

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
conditions; the engine does not certify blinding. It neither runs nor archives an
independent judge, releases an answer book, resolves claims, fits calibration or
computes paired cluster uncertainty.

Every reopen checks the frozen manifest pin. Collection is reconciled against the
reached journal bytes; late output, a missing path becoming populated, changed
permissions/content or a forged collection invalidates subsequent status/judging.
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

Raw provider-side attempts, transport rejections before journal admission,
requests refused before audit reservation, arbitrary native stdout/stderr and
unreturned killed-process evidence remain outside the archive. Accordingly every
public result keeps `externalAttemptsComplete`, `hostIsolationVerified`,
`claimsVerified` and `qualityAssessed` false. Full independent benchmark execution,
prior-workflow validity, judged outcomes, all-attempt host archives and quality
scoring remain required work. No field evaluation ran to implement this profile.

Implementation evidence is recorded in
[the synthetic readiness measurement](measurements/review-benchmark-2026-10-05.json).
