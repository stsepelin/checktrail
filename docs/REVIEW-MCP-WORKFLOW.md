# Model-independent MCP review workflow

The local MCP server supplies source, rules, native probes and evidence to the
chosen AI host. Codex, Claude or another compatible host owns AI selection,
execution, conversation state and subscription/API authentication. Checktrail
needs no model credentials for this workflow. Compatibility still requires a
recorded MCP client/application profile; provider independence does not mean
every application has been tested.

The shared `ReviewWorkflowEngine`, wrapped by `ReviewWorkflowSession`, backs the `review_workflow` MCP tool and the
foreground `review-session` JSON-lines CLI. Original synthetic controls exercise
reviewer, refuter, live native probe and adjudicator stages without configuring a
model provider. These controls verify exchange and native behavior, not actual
model inference, independent AI sessions or finding quality. See the
[dated measurement](measurements/review-workflow-2026-10-03.json).

## Stage exchange

Use a captured version 4 or 5 context artifact. The host orchestrator keeps the
workflow handle and gives each worker only its issued assignment.

| Operation | Input                                                    | Result                                                            |
| --------- | -------------------------------------------------------- | ----------------------------------------------------------------- |
| `open`    | Relative `context` artifact path                         | Source-checked workflow summary and opaque workflow ID.           |
| `next`    | `workflowId`; issued `target` handle for refutation only | One bounded reviewer, refuter or adjudicator assignment.          |
| `submit`  | `workflowId`, host `response` envelope                   | Consumed attempt metadata and next-stage summary.                 |
| `probe`   | `workflowId`, startup-registered `probeId`               | Live source-bound native observations, retained for adjudication. |
| `status`  | `workflowId`                                             | Retained accounting snapshot, without source or claim prose.      |
| `close`   | `workflowId`                                             | Aborted/scrubbed workflow and retained attempt accounting.        |

Every assignment has an engine-issued UUID, whole-envelope digest, context digest,
stage, instructions, source packet and inner model-output schema. Submission must
match the pending assignment; forged, mismatched and replayed responses consume
that attempt without advancing. These bindings identify what Checktrail issued;
they do not authenticate a model execution. The host supplies the envelope:

```json
{
  "assignmentId": "<issued UUID>",
  "assignmentDigest": "<issued SHA-256>",
  "host": {
    "client": "<client identity>",
    "clientVersion": "<exact version>",
    "provider": "<provider identity>",
    "model": "<exact model>",
    "sessionId": "<new host session identity>",
    "session": "fresh"
  },
  "status": "completed",
  "usage": {
    "inputTokens": null,
    "outputTokens": null,
    "elapsedMs": null,
    "costUSD": null
  },
  "output": { "files": [], "candidates": [] }
}
```

The placeholders are replaced by the host, never invented by the model. Identity
fields are bounded ASCII identifiers. `output` must satisfy the issued schema
and account for every selected file. The empty `files` example is incomplete for
a context containing files. Incomplete, refused, unavailable, cancelled, malformed,
missing-coverage and unmatched-citation submissions never advance. Retry uses a
new assignment and a new declared session within the same total attempt budget.
The engine retains response byte counts/digests and valid host/usage declarations,
not malformed response bodies in engine memory. Opt-in [command auditing](REVIEW-WORKFLOW-AUDIT.md) separately retains admitted raw JSON submissions in private operator storage.

A reviewer may propose several unverified candidates. This bounded workflow
processes one selected opaque target; siblings remain unverified. Refutation
withholds the original candidate identity, severity, attribution, fix scope and
prior verdicts. A complete live operator-pinned probe is required before
adjudication. Adjudication receives raw native observations and unverified target
and counterclaim content, with structural identities and prior labels removed.
Free prose/source may itself contain labels; packet filtering cannot prove full
host containment or semantic blindness.

Matching source/citations or completing every stage never verifies a defect.
Summaries retain `claimsVerified: false`, `hostIsolationVerified: false`,
`resolution: "unresolved"` and `severity: "unassigned"`. An empty candidate list
ends as `no-candidates-declared`, without approving the repository. A full staged
exchange ends as `advisory-stages-completed`. Native outcomes do not change the
deterministic validation result.

## Operator permissions and limits

MCP startup requires `--detailed --allow-review-source` before assignments can be
returned. Native execution additionally requires `--allow-execution` and an
operator-pinned `--probe PATH#sha256=DIGEST`. The CLI uses `--trust-project` for
native execution. No command/tool argument can grant disclosure, execution,
provider selection or budgets. Executed project code is trusted, not sandboxed.

```sh
node dist/src/cli.js review-session --root /path/to/project \
  --detailed --allow-review-source
```

Send one operation object per stdin line and consume one JSON result per line.
The process holds one engine epoch. EOF closes/scrubs its workflows and emits
final summaries; an empty session or unfinished workflow exits with status 2.
SIGINT/SIGTERM cancel owned work and preserve interrupt exit status. These are
ordinary MCP calls, not standard MCP Tasks.

`--workflow-limits OPERATOR_JSON` selects a strict startup file for `serve` or
`review-session`. The library accepts the same limits in constructor options.
The default file content is:

```json
{
  "maxWorkflows": 8,
  "maxAssignments": 6,
  "wallMs": 900000,
  "maxPacketBytes": 524288,
  "maxResponseBytes": 131072,
  "maxRetainedBytes": 4194304
}
```

Closed/terminal workflows retain their metadata and consume an epoch slot; closing
cannot reset the quota. Assignment admission counts every issued retry across
all stages. Packet admission counts the entire canonical JSON assignment;
response accounting counts canonical JSON serialization of the submitted envelope,
not transport bytes. Retention admission measures serialized raw context, outputs,
pending assignment, probe and selected recipe. It excludes bounded summary
metadata and global startup recipes and is not a heap/RSS limit. Raw workflow
artifacts are discarded on close, cancellation, timeout, staleness or terminal
incompleteness. Completed raw artifacts remain until close/dispose.

The workflow wall allowance starts after initial context validation/admission.
It covers subsequent stages and native work, including packet preparation; an
idle timer expires abandoned active workflows. It is not a hard elapsed-time
ceiling for transport, initial opening or cleanup. Native execution separately
uses protected runner-call, delivered-output and wall admission limits. During
an active/cancellation-pending native call, counts remain null and accounting is
incomplete until the native receipt returns. Unknown native errors retain unknown
spent counts. See [native probe budgets](REVIEW-PROBES.md).

Source is checked at opening and before issuing, accepting and executing stages.
`status` is an accounting snapshot, not a new freshness attestation. No atomic
filesystem snapshot is promised. The engine is ephemeral by default. Optional
[startup command auditing](REVIEW-WORKFLOW-AUDIT.md) persists admitted commands,
issued packets and accounting snapshots before results are released. It preserves
interrupted prefixes without resuming them. Complete model/native attempt artifacts
and complete host/model attempts remain required work. The bounded synthetic
[benchmark intake](REVIEW-BENCHMARK.md) now freezes paired slots, restricts MCP
workers to one trial, collects every predeclared journal and prepares anonymous
judging packets. Host isolation and quality remain unverified.

## Independence and remaining gates

An MCP call cannot erase the host's conversation, memory or accessible files.
The host must create separate restricted sessions and return their declarations.
An unknown freshness declaration or a repeated exact provider/client/session
identity is rejected across the engine epoch, including closed workflows. A new
string is not proof of a new session. All host/model/usage provenance remains
`host-declared-unverified`; unknown usage stays null. The server cannot enforce
host model calls, tokens or billing.

Existing `review_context`, `review_hypotheses`, `review_receipt`, `review_probe`
and `review_score` remain separate interfaces. Optional direct API `review_run`,
`review_refute` and `review_verify` use engine-owned inference grants; they are not
required subscription backends. Checktrail launching authenticated native AI
clients is optional.

General claim resolution, deduplication, consequence-based severity, wider native
profiles and the blinded evaluation harness remain open. Evaluation still needs
frozen host/model profiles, observed independent sessions, sealed cases, complete
persisted attempts, independent adjudication and paired scoring. Gate A remains
open; these original synthetic controls enable no new real-project field test or
quality comparison.
