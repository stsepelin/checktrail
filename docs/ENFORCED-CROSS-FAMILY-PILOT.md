# Enforced cross-family historical pilot

The frozen trial produced sixteen terminal review attempts: eight Python reviews
are protocol-complete and eight TypeScript reviews are incomplete. All four judge
attempts are protocol-incomplete, so there is no eligible adjudicated comparison.
The [public measurement](measurements/enforced-cross-family-v1.json) preserves
original deliveries, semantic verdicts, independent audits and development diagnostics
without promoting incomplete evidence.

The experiment compares targeted reviews through local Claude Code and Codex
subscriptions on two public libraries. It tests evidence delivery and a narrow
Checktrail planning/validation interface. It does not test the guidance or mutation
surface, rank model families, or establish whole-product effectiveness.

## Recorded outcomes

Each row contains four review attempts. Both independent judge families assigned
the same raw label and finding verdicts for each reviewer family. The raw matched
counts below include incomplete observations; they are not eligible detection
rates. All scorer observations are incomplete because their judge is incomplete.

| Reviewer    | Arm      | Original reviews protocol-complete | Raw matched labels (two declared) | Raw out-of-scope claims | Eligible adjudicated observations |
| ----------- | -------- | ---------------------------------: | --------------------------------: | ----------------------: | --------------------------------: |
| Sonnet 5    | Baseline |                                2/4 |                                 2 |                       1 |                                 0 |
| Sonnet 5    | MCP      |                                2/4 |                                 1 |                       2 |                                 0 |
| GPT-5.6 Sol | Baseline |                                2/4 |                                 2 |                       4 |                                 0 |
| GPT-5.6 Sol | MCP      |                                2/4 |                                 2 |                       5 |                                 0 |

All nineteen original findings remain in sealed receipts, including those retained
in operator-incomplete receipts. Neither judge assigned a false-positive, duplicate
or unresolved finding verdict. That agreement does not establish accuracy: execution
and control-coverage limitations remain, and the sample is small and purposive.

The Claude judge of Claude reviews omitted control evidence IDs for two accepted
labels despite having executed their controls. One finding cited a probe that read
two items but imported only the sibling item's byte-identical source; the claimed
own-item execution was not established. The Claude judge of Codex reviews executed
eight real own-item probes, but omitted `sourceEvidenceIds` on all eight calls,
leaving eight accepted labels and thirteen finding decisions without the required
formal source association. One accepted repaired cross-drive label also lacked an
executed distinct-drive check. These are evidence and coverage defects, not grounds
to relabel otherwise supported findings as false.

Both Codex judges returned `incomplete` with clean process telemetry and known
usage. The judge of Claude reviews gave no explicit overall reason. The judge of
Codex reviews explicitly treated incomplete reviewed receipts as requiring an
incomplete judge status. Their own-item probes included substantive positive and
negative controls; the latter missed one sibling-override scenario on one repaired
Python item. The Claude judges had additional positive-control and near-miss gaps,
recorded per probe in the audit. Failed exploratory probes remain retained alongside
later successful calls; they were not rewritten into submitted evidence.

## Design and evidence

The declared models are `claude-sonnet-5` through Claude Code 2.1.263 and
`gpt-5.6-sol` through Codex CLI 0.154.0, both at medium reasoning. Sol was chosen
before inference because earlier Astra attempts encountered capacity failures;
this trial does not substitute models or retry failed attempts. Each family
reviews the affected and repaired revision of each library once per arm. Case
order is fixed; arm order alternates and reverses between families. Each family
runs sequentially, while the two families can run concurrently.

Both arms receive the same captured sources and selected native test command.
The treatment additionally exposes Checktrail planning/validation and requires
actual MCP validation using the published `@stsepelin/checktrail` version
`0.1.0-alpha.5`. Each judge family independently grades both reviewer families,
using a fresh attempt for each set. A six-attempt live canary precedes the library
trial; its delivery success is a readiness check, not evidence about library review
quality.

| Attempt |   Wall time | Tool calls | Output tokens | Input tokens    |
| ------- | ----------: | ---------: | ------------: | --------------- |
| Review  | 360 seconds |         48 |        16,000 | No declared cap |
| Judge   | 600 seconds |        100 |        24,000 | No declared cap |

The controller meters client events and enforces the declared limits, but there is
no hard provider billing cap; delayed telemetry can produce an incomplete attempt.
Actual subscription billing is unknown. Authenticated clients remain host processes
with restricted capabilities, not processes enclosed by the execution container.
The gateway binds source reads and probes, verifies execution integrity, and
records cleanup. Codex's selected model is recorded in configuration, but its JSONL
does not expose an independent backend-model identity field.

The full original `judging.json` and source files are bound to the judge gateway.
The prompt overview replaces only reference stdout/stderr with their hashes;
every label, claim and instruction remains, and the full logs are available by
bounded reads or JSON-parsing probes. Labels and findings require executed,
source-bound evidence. Family/arm metadata is blinded, although claim prose may
reveal use of Checktrail. This is not a guarantee of perfect blinding.

## Curated task scope

These are purposively chosen historical development cases. They are new to this
local workflow, but may be familiar from training. The curator knew the repairs
when writing the behavioral references. Those references are separate
implementations from the native selections, not blind label discovery or
exhaustive correctness oracles.

| Library                                             | Affected revision                          | Repaired revision                          | Predeclared label                                                  |
| --------------------------------------------------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------ |
| [JMESPath](https://github.com/jmespath/jmespath.py) | `71f44854a35c5abcdb8fbd84e25d185d0ca53f92` | `03cef163a3082fee40c3dafe44cd62594aae8e36` | Shared inherited function registry                                 |
| [Pathe](https://github.com/unjs/pathe)              | `2fa8aaaa6fdf88eaf3713e016cc0a324b9ecc691` | `faa2b11f90a70befd6af6f58365391b6ec385fcc` | Cross-drive relative paths with non-root components in both inputs |

Captured package implementation files, licenses and parent-revision tests are
preserved. Each pair differs only in the implementation target; repair-added
regression tests, changelogs and repair history are withheld. Reviewers receive an
explicit task scope, so this is not blind discovery across entire repositories.

JMESPath's two failing reference assertions exercise one labeled cause: new custom
functions leak into default contexts, and sibling extension classes can overwrite
earlier overrides. Positive controls cover inherited extensions and built-ins.
Pathe's three differential assertions exercise its narrow cross-drive label; four
same-drive/POSIX controls pass in both states. An eighth drive-root assertion
remains failing after repair and is retained. The repaired snapshot is therefore
not globally clean, and the residual receives no additional narrow-label credit.
A nonzero reference exit on that snapshot does not mean its labeled repair failed.

Prepared native processes exited successfully and reported passing assertions, and
actual MCP checks passed, even on the affected snapshots. This did not establish
strict native report acceptance; the TypeScript framing failure is recorded below.
Python
executes nine tests and skips one unchanged Python-2-only `long` test. Before the
freeze, the entire lexer test module was excluded after its obsolete
`assertRaisesRegexp` use failed on Python 3.12; its implementation is still captured.
The selected comparator also excludes parser-specific tests and the nose-based
compliance generator. No source or assertion was changed to make it pass.
Pathe executes 310 tests using an explicit Vitest 5.0.1 tooling override of its
historical Vitest 1 range, while original package and lock bytes remain unchanged.
The original extensionless TypeScript import recipe is disclosed equally to both
arms. These are selected native checks, not complete upstream compatibility claims.

Reference commands mount the curated source directly. The reference binding audit
checks those actual mounted bytes against the frozen case maps before and after
execution, rather than relying on the harness's unused reference snapshot.

## Native report framing failure

The frozen TypeScript native command writes its JSON report to `/dev/stdout` and
then appends `JSON report written to /dev/stdout`. The strict parser rejects that
combined stdout as inconclusive even when the embedded report records all 310
assertions passing. The MCP wrapper emits a clean report, so its pass does not
satisfy the separately required native delivery. A diagnostic in-memory removal of
that exact trailing banner makes the native parser accept the report; original
evidence and protocol dispositions remain unchanged.

The live canary used only Python. Prepared native and MCP executions established
that the selected assertions ran, but did not validate strict native output framing
for every declared execution profile. The next trial must check each profile's
actual command through the strict completion parser before model calls. The separate diagnostics below do not retry, replace or promote incomplete
trial evidence.

Two no-inference development diagnostics preserve the failed approach as well as
the successful one. Removing only `--outputFile=/dev/stdout` fails on both
TypeScript snapshots because Vitest attempts to write its default report under the
read-only source tree; unchanged Python commands remain complete, with their skip.
A separately declared native Vitest API command using `JsonReporter` stdout mode,
the original configuration, exact test filters and awaited teardown then passes
strict parsing with 310 tests on each TypeScript snapshot. It does not invoke the
Checktrail runner. Both diagnostics retain source/configuration hashes and cleanup
evidence; neither changes a frozen attempt's status.

Native framing is not the only delivery defect. The Claude repaired-Pathe baseline
also omits `sourceEvidenceIds` from its source-importing probes, leaving its finding
without the required explicit source binding. The corresponding MCP attempt
records 18,085 output tokens against its 16,000-token limit; the controller stops
on that telemetry and retains an incomplete process disposition. These overlapping
problems remain separate in the attempt records.

The new [native preflight utility](../scripts/preflight-evaluation-native.mjs)
was also exercised separately through its actual CLI, without model inference.
Its four prepared profiles report ready: two TypeScript runs with 310 passing
assertions each and two Python runs with nine passes and one skip each. The original
TypeScript command remains a negative control: native exit zero produces CLI exit
one and not-ready because the complete stdout is invalid JSON. This development
evidence validates the readiness gate, without changing historical delivery.

The follow-up implementation requires source associations in bound probe requests
before execution, including the schema advertised to clients. Rejected requests
still consume the observed call budget; they do not become execution evidence.
Semantic inspection of which item the code actually imports remains necessary.
The judge prompt now distinguishes its own delivery completion from the status of
reviewed receipts. That clarification addresses an observed ambiguity; it is not
a proven remedy for every incomplete status or inadequate control.

A separate [scripted execution canary](measurements/enforced-delivery-followup-v1.json)
passes with the follow-up implementation: both review arms, the treatment's real
MCP validation and both judge controls complete. Tampered submissions, missing
cleanup and sibling control evidence remain rejected. This is real execution with
no model inference; it does not repair this trial or establish model-delivery success.

## Delivery and publication policy

Original invalid, missing or protocol-incomplete responses remain archived. There
are no citation repairs or replacement attempts. An operator-generated incomplete
receipt may retain already-valid original findings, without changing them; original
and sealed counts are reported separately. Semantic judgments and raw scorer output
must not silently promote an incomplete delivery into a valid completed attempt.

The public measurement contains field-whitelisted outcomes, metrics, source and
protocol hashes, score records and independent audit summaries. It excludes host
paths, account and session identifiers, credentials, source quotations, full sources
and client transcripts. The frozen harness implementation is commit
`dcd0e02fef7665b11b1e0407feffc447d3485c05`, before the separate readiness utility
and this publication. Replay must use those recorded implementation bytes rather
than assume the current checkout has identical support-code hashes. The frozen
launcher hash is
`f905164631a32260ce73f06c3e0bfe07840690974fbaea8a33e815bc1407af7c`.
