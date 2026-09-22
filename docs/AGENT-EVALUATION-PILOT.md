# First agent-review pilot

The [recorded pilot](measurements/agent-pilot-v1.json) exercised the
[agent evaluation workflow](AGENT-EVALUATION.md) with actual separate agent
sessions and Checktrail alpha.5 over MCP. Both review arms identified both
predeclared defects. This does not establish that MCP improves review quality.

## Frozen scope

The curator selected two historical upstream API fixes, retaining exact source
revisions and licenses. Each affected and repaired pair stayed in one development
group. Four snapshots produced eight reviewer assignments: native-only and
MCP-assisted review for each. Reviewers received a neutral API review task and
source, without labels, history or counterpart answers. The complete snapshot was
available, but the assigned API scope was narrow; this was not a repository-wide
review or change-diff benchmark.

| Library                                                                      | Scope                                                     | Affected revision                          | Repaired revision                          |
| ---------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| [escape-string-regexp](https://github.com/sindresorhus/escape-string-regexp) | Literal escaping under Unicode regular-expression parsing | `5085b257c801507460270b747f645276fbc1d937` | `732905da074f0220487ad6a27590f89bd0819374` |
| [boltons](https://github.com/mahmoud/boltons)                                | Function copying with keyword-only defaults               | `0341ab3d79e6430c0e6a4149df9c92679988a534` | `c2b04b4cb16410d7bf9ff781c78dee3ca908dc32` |

The public record contains source fingerprints, scope, artifact identities,
budgets and role declarations. Source snapshots, complete license notices, raw
assessments, transcripts and command output remain in the local ignored run
archive. No private project source or rules were used. Public upstream history
may already be known to the model, so opaque case IDs do not make these cases an
unseen benchmark.

Reviewers used fresh conversations with the same inherited GPT-6 model family.
The precise backend version and sampling settings were not exposed; identity is
an orchestrator declaration. The operator allowed five minutes, thirty tool
calls and five thousand output tokens per assignment. Token usage, actual billed
cost and complete tool-budget enforcement were not available. Reported durations
remain reviewer-declared; they are not controlled latency measurements. Agents
shared a host and filesystem, with procedural access restrictions rather than
independent containers or providers.

## Observations

| Observation                          | Native-only reviewers | MCP-assisted reviewers |
| ------------------------------------ | --------------------: | ---------------------: |
| Completed, adjudicated reviews       |                     4 |                      4 |
| Predeclared defects matched          |                 2 / 2 |                  2 / 2 |
| Confirmed misses                     |                     0 |                      0 |
| Adjudicated false claims             |                     0 |                      0 |
| Findings outside the original labels |                     2 |                      3 |
| Reviews with unknown token cost      |                     4 |                      4 |

The additional findings are supported historical behaviors outside the declared
labels. They are finding instances across reviews, not unique new defects, and
were not added to the detection numerator. A repaired control was valid only for
its labeled behavior; neither control was declared globally defect-free.

All four scoped upstream native test commands passed. Separately authored
behavioral validators reproduced the expected distinction between affected and
repaired versions. A separate adjudicator examined every claim and corroborated
the behaviors with its own reproductions. Native/reference process completion
was not treated as semantic proof by itself.

All four MCP validations reported **incomplete**, with an unavailable native
check. The reviewer still had the prepared direct native test commands available.
MCP planning and validation used the actual published alpha.5 package, and each
run's retained report matched. These observations identify setup/adapter coverage
friction; they do not establish successful native coverage through MCP.

One reviewer ran a native helper concurrently with MCP and received
`sourceChanged: true`. Captured source-file identity and the MCP inventory flag
are separate observations. The causal mechanism was not isolated. Preserve the
flag and serialize source-affecting preparation/checks in the next protocol;
do not rewrite this run as a clean validation.

All eight assessments were sealed before adjudication. A presentation copy
removed the limitations field from every assessment because tool/process prose
could identify the treatment. Findings, source and labels were unchanged; the
original receipts and redaction record were retained. The adjudicator reported
no treatment or reviewer-identity exposure. Procedural blinding is not proof that
no identifying clue existed in source or finding prose.

The [independent results audit](measurements/agent-pilot-v1-audit.json) recomputed
the scores without invoking the scorer and reproduced both expected behaviors
and both additional behavior families. It verified every captured source file
and the installed alpha.5 artifact. Generated JavaScript cache files are separate
from the unchanged captured-source claim.

Reviewers disclosed prior API/semantic familiarity and incidental documentation
or CHANGELOG exposure; one explicitly read source API documentation. The audit
found no disclosed expected-answer content in those reads, but this is not a
clean holdout claim. Tighten history filtering and make permitted source-document
scope unambiguous in the next declaration. `complete` in the score means complete
review/reference/adjudication accounting, not full protocol compliance or native
validation success.

The separate [five-language alpha.5 adoption replay](PUBLIC-ADOPTION-ALPHA5.md)
compares selected native checks and injected failures on pinned JavaScript,
TypeScript, Python, Go and PHP projects. It is complementary deterministic
evidence, not five additional independently reviewed agent cases.

## Learning and next experiment

1. Diagnose the unavailable-check cases using original, minimal development
   fixtures. Prepare the supported project profile and native tool environment
   explicitly; do not make unsupported checks pass merely to improve this score.
2. Add the supported out-of-scope behaviors to a separately declared development
   corpus with their own labels and reproductions. Do not relabel this pilot or
   count repeated finding instances as independent new defects.
3. Run native and MCP operations sequentially within each assignment, retain
   complete execution transcripts, and obtain provider usage when available.
4. After reviewing any implementation or guidance changes, freeze a new protocol
   and use different issue groups. Expand to Go, TypeScript and PHP with language-
   appropriate references before making cross-language claims. Additional model
   providers and an independent human spot-check remain separate evidence gates.

The harness emits a learning queue for misses, false alarms, incomplete work and
out-of-scope claims. It does not retrain a model, rewrite guidance or change the
engine automatically. A proposed lesson must survive reproduction, an original
regression, implementation review and a fresh holdout.

## Harness audit and preservation

An independent implementation reviewer reproduced two harness defects during the
pilot: dotted case/validator IDs could collide in reference filenames, and excluded
cases could accept receipts and count completed misses. Regression tests failed
before the fixes and passed after them. New runs use separate reference directories
and reject excluded receipts at both import and scoring.

This pilot has no exclusions or colliding reference identities. Its original
frozen evaluator produced the recorded scores; the corrected evaluator was not
silently substituted. The [original protocol bytes](measurements/agent-pilot-v1-protocol.json)
are preserved with their hashes and known limitations. They are archival evidence,
not the recommended harness for new runs. Runtime support-file hashes identify the
alpha.5 implementation used with those scripts. Historical measurements from earlier
releases and evaluation cohorts remain unchanged.
