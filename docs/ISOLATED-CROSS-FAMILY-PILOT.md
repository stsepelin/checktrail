# Isolated cross-family pilot

The September 22, 2026 pilot ran sixteen reviews of public TypeScript and Python
source through a restricted evaluation gateway. Seven MCP validations completed
with matching retained reports. Independent audit supports **four complete reviewer
attempts and twelve incomplete attempts**; both judging attempts also have protocol
failures. These results establish execution and accounting behavior for this small
historical sample. They do not establish an MCP effectiveness improvement or a model
ranking.

The [public measurement](measurements/isolated-cross-family-v1.json) contains frozen
source identities, per-attempt statuses, both score sets, independent audits and
separate development evidence. It omits host paths, session identifiers, account
metadata, raw source and full client transcripts. The
[first cross-family pilot](CROSS-FAMILY-PILOT.md) remains a separate measurement.

## Frozen design

Two public repair histories supplied affected and repaired snapshots:

| Library           | Language   | Declared defect                                                                  | Affected case | Repaired control |
| ----------------- | ---------- | -------------------------------------------------------------------------------- | ------------- | ---------------- |
| `jshttp/cookie`   | TypeScript | Custom encoder skipped for an explicitly empty value                             | `c14e`        | `c62b`           |
| `tkem/cachetools` | Python     | Unnecessary eviction when replacing an entry with a larger value that still fits | `c38d`        | `c91f`           |

These are purposively selected historical cases, new to the earlier pilot but
potentially familiar from model training. Each snapshot received one native-only
and one MCP-assisted review from each family. Source, labels and budgets were frozen
before review; there was one observation per cell. Prepared tests were curated
selections, with common pre-repair test bytes retained in both versions. A repaired
control means the declared defect is absent, not that the library has no other bugs.

| Role     | Client                    | Model             |
| -------- | ------------------------- | ----------------- |
| Reviewer | Claude Code 2.1.263       | `claude-sonnet-5` |
| Reviewer | Codex CLI 0.154.0         | `gpt-6-astra`     |
| Judge    | Fresh Claude Code session | `claude-sonnet-5` |
| Judge    | Fresh Codex CLI session   | `gpt-5.6-sol`     |

Sol was selected before judging was prepared because Astra had reached capacity
during review. No reviewer fallback or retry replaced the failed review. Both fresh
judges graded both anonymous sets. Separate sessions do not establish independent
training data or equal client contexts.

Review budgets were 300 seconds, 40 gateway calls and 10,000 total output tokens.
Judging budgets were 600 seconds, 100 calls and 16,000 output tokens. Output-token
limits were instructed and audited using provider telemetry; they were not reliable
aggregate enforcement limits. Different providers' token and effort settings do not
establish equal compute. Actual subscription billing remains unknown; retained
list-price estimates are not bills.

The trial used published Checktrail `0.1.0-alpha.5`. Its frozen gateway is retained
at commit `b91aa88038bd53fcb7bee5193295f2dfc371fd8a`, with SHA-256
`3bd94d344532f420aa07dc51dc9900d99eb94adaa77eb2362be3953a97de723c`.
Later gateway changes did not run inside these reviews or judges.

## What the boundary covered

The clients exposed only the dedicated evaluation tools, plus Claude's structured
output tool and Codex's client MCP resource wrappers. Reviewers could read their
captured files and execute probes or selected native checks. The MCP arm additionally
received Checktrail planning and validation. Transcript audit found no unexpected
tool calls or outside-source reads in the sixteen reviews.

Executed probes and validators ran in fresh offline, nonroot containers with
read-only source mounts, bounded resources and private temporary scratch space.
Authenticated Claude/Codex client processes remained on the host; this was not an
OS sandbox around those clients. A separate local request capture found account
metadata could remain model-visible. It did not find private project code or global
user instructions in the tested request, and cannot prove the contents of earlier
live requests. No account values are included in the public record.

The internal Checktrail connection pinned MCP `2026-07-28`. The client-to-gateway
handshakes were separate: the tested Codex client used `2025-06-18`, and Claude used
`2025-11-25`. Successful internal modern-protocol use does not demonstrate those
clients negotiated that version themselves.

## Execution and accounting

Independent audit verified 144 captured source-file copies across sixteen reviews,
all sixteen gateway hash chains, and the actual source imports and outputs supporting
21 submitted finding cores. Fifteen direct native comparator runs passed their
selected tests. Seven of eight MCP assignments reached validation; all seven passed,
and each retained report matched the returned report. Cookie selections contained
96 tests and Python selections 38 tests. The eighth MCP review failed at model
capacity before validation.

The trial deliberately used locked Vitest 5.0.1 tooling for cookie. During preparation,
native upstream Vitest 4.1.9 passed while alpha.5's Vitest wrapper was incomplete.
That failure remains archived; the tooling override was declared before review.
The later adapter fix was validated separately and was not substituted into the
published runtime used by this trial.

Sixteen separately recorded reference executions covered direct native checks and
separately implemented behavioral validators. These were curator-authored with
known repair labels, independent of the native suite rather than blind discoveries
of the labels. Native selections passed; behavioral validators distinguished the
affected and repaired cases. Their commands mounted
curated source outside the harness snapshot, so a supplemental audit verified every
actual mounted file against frozen hashes before and after execution. The harness's
temporary-snapshot hash alone would not establish that binding.

Both judges produced the following raw accounting. “Matched” includes supported
claims from incomplete receipts; it is not a count of eligible completed detections.

| Reviewer    | Arm          | Raw labeled matches | Raw scorer complete | Strict audit complete |
| ----------- | ------------ | ------------------- | ------------------- | --------------------- |
| Sonnet 5    | Native-only  | 2 / 2               | 0 / 4               | 0 / 4                 |
| Sonnet 5    | MCP-assisted | 2 / 2               | 0 / 4               | 0 / 4                 |
| GPT-6-Astra | Native-only  | 2 / 2               | 3 / 4               | 1 / 4                 |
| GPT-6-Astra | MCP-assisted | 2 / 2               | 3 / 4               | 3 / 4                 |

The stricter audit preserves these overlapping failures:

- Five original receipts failed citation binding, covering eight inaccurate citation
  records. Separate reconstruction used unique full-line matches in the same frozen
  file; one quote also required restoring literal Unicode-escape spelling. All
  reconstructed lines had been disclosed by the gateway. Original responses stayed
  unchanged, and every reconstructed receipt remained incomplete.
- Six Sonnet reviews exceeded the declared output-token budget. One also omitted the
  required direct native comparator, although its MCP validation ran.
- Astra's repaired Python MCP review ended with an actual model-capacity error. Its
  missing response and unknown usage remain incomplete.
- Two Astra native-only reviews sealed as completed but lack a gateway end record.
  Later checks found neither a matching process nor a remaining review container.
  Final lifecycle integrity remains unverified; their raw scorer status does not
  override the stricter incomplete status.

No finding was adjudicated false or unresolved. Additional supported behaviors were
classified outside the predeclared defect labels rather than added retrospectively
to detection credit. Missing controls, incomplete reviews and this small sample do
not establish a false-positive rate or comparative effectiveness.

## Judging audit

Both judges saw identical presentation copies. The audit verified all sixteen
items, 144 source files against reviewer manifests, 32 presented reference records,
and 520 copied presentation/source/reference files across the two judges. Uniform
redactions removed identity and arm terms from limitations while preserving findings,
labels, substantive limitations and original evidence. Writing style, source familiarity
and process details can still partly reveal the origin of an assessment.

Across eighteen actual judge probes, all 42 finding verdicts had corresponding-source
support for their core observed behavior. All four score files were independently
recomputed; the judges agreed on every verdict and label status, and produced
byte-identical score files for each reviewer family. Intended API contract judgments,
including newly identified behaviors, remain distinct from proving an observed output.

Neither judge completed the declared protocol:

- Sonnet emitted 23,015 output tokens against the 16,000 limit and omitted required
  probe citations from two accepted-label rationales. Those controls were executed
  elsewhere in its trace. One cited probe demonstrated ignored size accounting but
  did not insert an individually oversized value as the prose claimed. Another
  demonstrated NaN after deletion but did not execute the subsequent capacity
  behavior needed to demonstrate the broader persistence claim.
- Sol omitted required probe citations from nine accepted-label rationales. For one
  repaired Python item, it executed the reported falsey-callback and NaN findings
  but never executed that item's repaired replacement control. Its gateway end
  record is also missing after process termination. Other automated flags were
  false alarms caused by checking for literal paths in probes that constructed
  and imported the correct paths dynamically; manual audit verified those bindings.

Correct core verdicts do not repair these delivery, budget or lifecycle failures.
The public record retains the raw scores and the stricter audit separately.

## Separate development follow-up

The Vitest compatibility change was tested outside the frozen alpha.5 trial: its
focused Vitest 4 run passed ten tests, and both real cookie snapshots passed their
96 selected assertions without source changes. This is adapter development evidence,
not a rerun or an improvement attributed to the trial. The fix is committed in the
checkout but has not been released to npm; published alpha.5 remains unchanged.

Later synthetic lifecycle experiments reproduced interruption during delayed final
hashing and an audit-reservation conflict during modern MCP discovery. They establish
possible mechanisms, not the cause of the three missing end records observed in the
reviews and judging: `historicalTrialCauseProven` remains `false`.

The subsequent gateway separates per-execution mounted-tree integrity from cleanup
completion. A separate tracked boundary verification recorded eight verified execution
calls, one cancelled call with unverified integrity, and four cleanup end records
with source snapshots removed. That verification performed no model inference and
does not upgrade any historical attempt. See [evaluation isolation](EVALUATION-ISOLATION.md)
for the current gateway contract; the measurement retains both the frozen gateway
hash and separate follow-up evidence hashes.

Future trials still need reliable aggregate budgets, source line labels and early
citation checks, explicit per-label reproduction bindings, and fresh issue groups
after changes. The [evaluation workflow](AGENT-EVALUATION.md) and
[cross-family guide](CROSS-FAMILY-EVALUATION.md) describe the next declaration boundary.
