# First cross-family CLI pilot

This follow-up exercised the installed Claude Code and Codex clients using their
existing subscription logins. It demonstrates that both model families can review
public-source packets and use the real Checktrail MCP bridge. It does not establish
a model ranking or an MCP effectiveness improvement.

The [setup guide](CROSS-FAMILY-EVALUATION.md) describes the protocol. The
[measurement record](measurements/cross-family-v1.json) retains source identities,
per-attempt outcomes, both judges' scores, execution audits and eligibility limits.

## Scope and clients

Each family received the same four historical JavaScript/Python snapshots used by
the [first pilot](AGENT-EVALUATION-PILOT.md), with Python CHANGELOG.md removed before
freezing both new runs. Expected labels remained unchanged. These are development
cases, not unseen holdouts. Every snapshot received a native-only and an
MCP-assisted review, yielding sixteen attempts in fresh CLI sessions.

| Role     | Client                                         | Primary model     |
| -------- | ---------------------------------------------- | ----------------- |
| Reviewer | Claude Code 2.1.263, Claude subscription login | `claude-sonnet-5` |
| Reviewer | Codex CLI 0.154.0, ChatGPT login               | `gpt-6-astra`     |
| Judge    | Fresh Claude Code session                      | `claude-sonnet-5` |
| Judge    | Fresh Codex CLI session                        | `gpt-5.6-sol`     |

Both judges independently received both anonymous review sets. The original Astra
judge failed with a model-capacity error; the separately declared Sol judge used
unchanged packets. The first Claude judging attempt exceeded its 5,000-token
per-response emission cap. A fresh attempt used a 16,000-token cap and a compact
output instruction. Failed attempts remain archived. No reviewer was silently
switched to another model.

Model identifiers are client/provider evidence, not exposed immutable backend
revisions. Claude reports auxiliary Haiku usage in addition to the primary Sonnet
reviewer. The clients have different system contexts, tools, accounting and
permission mechanisms. Equal setting names do not establish equal compute.

## Raw adjudicated observations

Both final judges agreed on all finding verdicts and expected-defect matches.
The table records semantic matches in the raw assessments; it is **not an
eligibility-adjusted effectiveness score**.

| Reviewer        | Native-only labeled matches | MCP-assisted labeled matches | Qualification                                                                                                 |
| --------------- | --------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Claude Sonnet 5 | 1 / 2                       | 1 / 2                        | The native-only match followed answer-bearing filename exposure and receives no independent-discovery credit. |
| GPT-6-Astra     | 2 / 2                       | 2 / 2                        | One native-only repaired-control review failed at model capacity.                                             |

Sonnet missed the Unicode-regexp defect in both arms. Both families reported
supported behaviors outside the original labels; these were not added to the
expected-defect numerator. No finding was adjudicated false or unresolved, but
missing/ineligible controls do not establish a false-positive rate. The raw score
retains over-budget and contaminated claims separately from completion and the
post-audit eligibility ledger.

The independent results audit also checks judges' evidence claims. Sol ran
reproductions importing the supplied snapshots. Claude used hand-transcribed
functions for some checks and claimed several executions absent from its own
transcript, including the keyword-only-default reproduction. Sol and the reference
validators corroborate the relevant behaviors; the unsupported Claude execution
claims remain recorded. Verdict agreement is not two verified reproductions.

## Execution and limits

Fifteen attempts returned completed assessments. The final Astra native-only
review of the repaired Python snapshot failed with a capacity error and remains
incomplete. One completed Claude control review exceeded the declared total
output-token budget; the scorer retains its claims but marks that observation
and its pair incomplete.

All eight MCP validation calls returned **incomplete**, with unavailable checks.
Their retained reports matched, and none reported source changes. Direct native
reference commands passed; separately authored behavior validators distinguished
both affected/repaired pairs. These measurements do not establish that Checktrail
successfully ran the projects' native checks through MCP.

The independent execution audit verified captured source files, quotations,
receipt/manifest identities, complete bridge traces and provider usage. The most
material protocol deviation was **answer-bearing filename exposure**: the Claude
native-only reviewer for the affected Python case listed the curation directory
and saw `copy-function-keyword-defaults-upstream.patch` before inspecting the API.
Its raw supported finding must not count as an independent unexposed discovery.
The reviewer did not report that exposure itself; the transcript audit found it.

Other recorded deviations include off-packet temporary scratch files in review
and judging, replacing a
failed MCP plan trace after a server-path typo, and advertised plugin/skill metadata
despite Claude safe mode. Original failed commands remain in event logs. Metadata
advertisement is not evidence that plugin contents were loaded or invoked. Two
Codex receipts needed only the `source/` citation-path prefix removed before
sealing; every quotation, line range and other field was preserved.

The public raw scores and post-audit eligibility are separate. An accepted defect
claim does not make a contaminated, over-budget or incomplete assessment eligible
for a controlled comparison. Historical exposure, unequal client contexts and
these deviations preclude an effectiveness claim even where judges agree.

## Learning from this run

- Move native helper programs into a dedicated disclosure directory with no labels,
  patch names or counterpart source in adjacent listings. Enforce the read boundary
  and test forbidden access before starting a future holdout.
- Give reviewers and judges an explicit private scratch directory. Audit actual
  access; do not rely on self-reported compliance or a successful terminal response.
- Preflight the exact structured-output schema and a representative judging output
  size. Preserve capacity failures and configuration retries instead of replacing
  them with favorable attempts.
- Prepare supported native Checktrail profiles for evaluation cases. Keep unavailable
  validation separate from the agents' ability to reason about source.
- Use fresh issue groups after any implementation or guidance change. Preserve the
  old labels and judge disagreements; repeated historical findings are not new
  independent samples.

Raw client streams, source copies, failed attempts and transcripts remain in the
ignored local `.checktrail/cross-family-v1` archive and its recorded temporary
packet directories. Public records contain no account credentials or private
project source. This is checkout evaluation evidence; the published alpha.5
runtime and npm distribution are unchanged.
