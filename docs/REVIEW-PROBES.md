# Source-bound native review probes

The experimental `node-export-boolean-v1` profile binds an operator-pinned recipe
to a captured version 4/5 context and an exactly quoted advisory candidate. It
executes original baseline, trigger and near-miss cases in separate Node processes.
Each case receives fresh copies of the assigned current files. No previous case's
module cache or source edits are carried forward. This is a state boundary;
executed project code is operator-trusted and **not sandboxed**.

Only selected plain ESM `.js`/`.mjs` files, selected module dependencies and one
named function export are supported. TypeScript, external or dynamic dependencies,
Windows, methods and arrow exports are unresolved or rejected by this profile.
The engine does not infer callers, business policy or a production fixture from
an advisory claim. A Boolean counterexample under operator expectations cannot
verify the claim's mechanism, reachability, severity or proposed fix.

## Operator registration

A recipe uses `review-probe-recipe.schema.json`. It declares a hypothesis family,
selected file and export, distinct case IDs and all three control roles. Expected
Boolean values stay in the parent engine. `minimumTriggerScale` is checked against
the largest actual nested input array; it does not infer database row counts or
application scale. An optional `guard` names a UTF-16 source interval inside the
selected function. Cases are bounded in number, JSON depth and recipe bytes.

Register the exact raw recipe digest, with execution trust, at CLI invocation or
MCP server startup:

```sh
node dist/src/cli.js review-probe --root PROJECT --context .checktrail/context.json \
  --input .checktrail/candidate.json --probe /operator/probe.json#sha256=DIGEST \
  --trust-project
node dist/src/cli.js serve --root PROJECT --allow-execution \
  --probe /operator/probe.json#sha256=DIGEST
```

`DIGEST` is a placeholder for SHA-256 of the recipe's exact bytes. Startup permits
at most eight distinct registered recipes. `review_probe` accepts only context,
candidate and registered probe ID; tool arguments cannot grant trust, register
code or change a budget. The native execution slot is shared with other native
checks. Provider inference/source grants remain separate from native trust.

## Run-wide native budgets

Every new probe run uses one native call/output ledger across its cases. Library
`nativeBudget` and MCP startup `probeLimits.nativeBudget` accept `maxCalls`
(0–16) and `maxOutputBytes` (0–16 MiB). CLI `review-probe`, `review-verify` and
`serve` expose `--native-max-calls` and `--native-max-output-bytes`. Defaults are
16 runner calls and 65,536 bytes for the whole probe; a library per-call output
limit also supplies the default aggregate output limit. These ceilings cannot be
changed by tool arguments or provider output. A zero ceiling starts no project
process and creates no case directory. It retains every selected case as unrun.

Each runner invocation spends a call, including an unsuccessful launch or a
cancellation race. Actual delivered stdout and stderr bytes debit the same
output allowance. The next case receives the smaller of its per-call output
limit and the remaining run allowance. Exhausted admission or output truncation
stops further cases. All source copies and case starts share the probe wall
allowance; verification additionally shares its cancellation deadline across
provider and native stages. Cleanup completes before execution slots are released.
Cleanup and filesystem work can outlast a deadline; this is not a hard elapsed
time guarantee.

Version 2 and 3 probe receipts retain limits, calls, total bytes, stop reason and each
case's invocation/byte accounting. Imports reconstruct every admission and total;
version 1 receipts remain readable with no claim that they contain a run budget.
A raw output chunk may arrive beyond the allowance before process-group termination.
The entire delivered chunk is charged even though retained buffers are bounded;
`outputByteCeilingGuaranteed` is false. These are trusted-process lifecycle controls,
not an OS sandbox or a quota for descendant processes or future language/tool/streaming/subscription profiles.

## Native evidence and unresolved states

V8 precise coverage must show the selected current function actually executed.
The debugger's compiled source must hash to the captured source digest, and
native ranges must lie inside its captured function. Reports bind the source,
context, candidate, recipe and engine worker digests and Node version.

A selected guard requires an exact native block boundary in at least one trial.
V8 compresses equal-count blocks into their enclosing range; other trials may
inherit that range's count only when overlapping native ranges do not contradict
it. Trigger coverage must show the guard executed. An N=1 input below the declared
scale, an unexecuted guard, and full-function coverage without the selected guard
stay unresolved. This does not establish that an arbitrary interval represents
the application's relevant guard; the operator must choose and justify it.

Behavior is `violated` only when all cases were observed, both control roles agree
with their pinned expectations and a trigger disagrees. `satisfied` means these
particular cases agreed, not that a claim was independently refuted. Controls that
disagree, runtime errors, non-Boolean returns, malformed evidence, truncated output,
unsupported scope, stale source, cancellation or exhausted time retain unresolved
accounting. Cleanup failure prevents completed evidence. Temporary case trees are
removed after each case and the owned trial directory is removed at completion.

`claimsVerified`, `mechanismVerified` and `fixVerified` remain false;
`callerReachability` remains `not-established`. Normal output hides case IDs,
arguments, paths, quotations and candidate prose. Detailed output requires the
existing operator source-output permission. Neither outcome changes deterministic
validation results or approves a source change.

## Development acceptance

`review-probe.test.ts` uses authored synthetic broken/fixed/near-miss decisions,
measured N=2 versus inert N=1 guards, per-case module/source reset, altered native
source identity, source changes during execution, output/time bounds, cancellation,
cleanup and shared CLI/MCP startup permissions. The installed-package smoke test
executes the packaged worker without development dependencies. Required native
profiles pass on macOS arm64 Node 26.9.0 and Linux arm64 Node 22.23.2;
the Linux fixture runs with container networking disabled. Guard mutations for
trust, compiled-source identity and executed guards fail their intended regression
tests, then the restored required profile passes. Installed Codex 0.159.0 and Claude
Code 2.1.284 clients discover the updated MCP inventory without inference.

This implements a bounded first probe profile. Broader languages, framework
fixtures, native tool adapters, caller/default evidence, independent refutation
and all-family detection acceptance remain required. These development tests do
not close the finish-first gate or establish review quality.

[Verification](REVIEW-VERIFICATION.md) runs this probe between independent
refutation and raw-evidence adjudication. Failed or incomplete controls cannot
advance; no imported tool-argument report is used as native proof.

The [native budget measurement](measurements/review-native-budget-2026-10-02.json)
records the version 2 call/output/wall/cancellation/cleanup controls and their exact
source/runtime bindings. Wider R7 profiles and Gate A remain open.

## Physical evidence receipts

New Boolean executions produce version 3 receipts, retaining the exact bounded physical
stdout/stderr of every reached worker attempt with canonical bytes, hashes and
process status. The parser reconciles the artifact with admission accounting and
replays valid worker observations. Unstarted cases contain no invented attempt.
Versions 1 and 2 remain readable as historical contracts. Raw artifacts stay out
of summaries and independent model packets. See
[NATIVE-RAW-EVIDENCE.md](NATIVE-RAW-EVIDENCE.md) for privacy, limits and acceptance.

## Structured results

The separate [structured Node profile](NATIVE-JSON-PROBES.md) uses version 2
recipes and version 4 physical receipts for arrays, objects, scalar values and
null. It shares the same source/coverage bindings, budgets, startup trust, CLI/MCP
and independent workflow. Existing Boolean recipes and historical receipts retain
their own contracts. Structured results widen the observed values, without
verifying a free-text claim or production policy.
