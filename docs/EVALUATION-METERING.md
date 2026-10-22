# External review usage accounting

`inspectReviewEvaluationMetering` reconciles externally supplied attempt metadata
against a pinned [prospective protocol declaration](EVALUATION-PROTOCOL-DECLARATIONS.md).
It starts no model, reads no source or credential files, and opens no holdout.
This is an operator accounting component; it does not authorize evaluation or
complete Gate A.

Input contains `declaration`, its `expectedProtocolSha256`, and a strict
`external-review-attempt-metering-v1` envelope. The envelope binds the same
protocol and external-metering procedure digests and declares the collector's
configuration digest. Actual collector configuration, records and identity
mappings stay in private operator storage. A digest identifies supplied metadata;
the inspector does not read the corresponding bytes or authenticate their origin.

Every selected case, repetition and role needs exactly one terminal slot. Omitted,
duplicated, excluded and foreign slots make coverage incomplete. The denominator
retains every selected case even when its cluster declaration is invalid. Slot
order does not change accounting. At most 256 cases, two repetitions and three
roles yield 1,536 slots, with at most sixteen ordered attempts per slot. These are
intake bounds, not a new retry policy or permission to retry selectively.

Attempts preserve successful and failed outcomes, including capacity errors,
rate limits, refusals, cancellation, deadlines and unavailable hosts. Ordinals must
be contiguous from zero. Success is terminal; a later attempt is inconsistent.
Declared session IDs and complete-record digests cannot be reused across arms,
cases or retries. The record digest is for the complete private attempt envelope,
including its slot, ordinal and session identity; it is not a response-body hash.
Unique strings do not prove that sessions or records were independent or complete.

Each attempt declares its measurement source as `operator-meter`,
`provider-reported` or `unknown`. Elapsed milliseconds, input/output tokens,
tool calls, output bytes and USD micro-units are nullable integers. Unknown sources
cannot carry invented numerical measurements. Provider-reported values remain
explicitly identified and unverified. Subscription charges that cannot be allocated
to an attempt stay unknown rather than becoming zero.

All failed retries contribute to each arm's known subtotals. Each metric reports
the observed subtotal and the number of unknown records separately. Missing slots
prevent a complete planned-slot total; unknown values never count as measured
zero. Duplicate and foreign attempts are counted as unattributed, excluded from
arm subtotals, and keep the batch incomplete. Their count plus attributed attempts
equals all received attempts.

Slot elapsed time includes the whole arm and must cover its sequential attempts'
known durations when all are present. The inspector compares known retry subtotals
and slot duration to the protocol's equal token/tool/output/wall ceilings. A known
subtotal can already exceed a ceiling even when another value is unknown. It
reports overages and unknown budget accounting; it does not enforce host budgets.
The protocol declares no monetary ceiling, so cost is retained without inventing
one. Durations, billing and timestamps are not independently verified.

Terminal coverage, measurement accounting and completed reviews are separate.
For example, an explicitly unrun slot with zero attempts and measured zero elapsed
time can be fully accounted for while contributing no completed review. A complete
accounting report is not a successful review, supported finding or quality result.
Every report retains explicit false flags for meter authenticity, actual all-attempt
completeness, host independence, verified billing, budget enforcement and Gate A.

The returned report contains aggregate counts, terminal/source categories, issue
kinds, arm subtotals and the protocol digest. It contains no case/session IDs,
attempt-record digests, collector configuration or model responses. Hashes and
activity counts can still reveal equality and usage. The shared library exports
the inspector, strict schema and types. The checkout script uses the same engine:

```sh
node scripts/check-evaluation-metering.mjs < /path/to/private-metering.json
```

It accepts at most 4 MiB of valid UTF-8 JSON. The byte bound applies independently
of the collection bounds; not every maximum-size library input fits stdin. Exit
0 means internally consistent supplied accounting, 2 means incomplete or
inconsistent accounting, and 1 means invalid/unavailable input. Errors never echo
the private input. This setup script is outside the installed CLI/MCP catalogue.

The required `evaluation-protocol-metering` cohort covers original synthetic retry,
terminal, unknown-usage, budget, identity, inventory, scale and privacy cases.
`verify-evaluation-protocol-package.mjs --metering` repeats the same callbacks with
an external harness and a fresh locked offline production installation, with
before/after code, harness and executable bindings. It does not trace actual
module loads or attest every dependency. Integration with private collector
records, host containment, independent judgments, common-defect matching, real
cohort acquisition and final acceptance bindings remain separate work.
