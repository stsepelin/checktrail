# Optional stateless provider review

The shared library, CLI and MCP can send one captured version 4/5/6 assignment to
OpenAI Responses or Anthropic Messages. This is the bounded `stateless-inline-api-v1`
profile. It proposes advisory candidates with a family, trigger, consequence,
evidence gaps and exact source citations. It does not execute project code,
independently verify a defect, calibrate confidence or change a native result.
This optional engine-owned transport is separate from the required
[provider-neutral MCP workflow](REVIEW-MCP-WORKFLOW.md), whose AI host owns
authentication. [Native AI client orchestration](REVIEW-SUBSCRIPTIONS.md) is
optional and unimplemented. API credentials are not subscription credentials;
Checktrail never opens a client's credential store.

The nine versioned hypothesis families are planned with `review-hypotheses --context
context.json` or `review_hypotheses`. Their invariants and evidence requirements are
questions, not findings. Broken/fixed/near-miss packets currently verify catalogue
and transport behavior; they do not establish semantic detection. The bounded
[source-bound probe](REVIEW-PROBES.md) and [independent refutation attempt](REVIEW-REFUTATION.md)
profiles add native controls and fresh counterclaim requests; independent claim
resolution remains required.

## Operator configuration and disclosure

Select a bounded regular JSON file at CLI invocation or server startup with
`--provider-config /operator/provider.json`. Repository configuration and MCP tool
arguments cannot select a provider, endpoint, model, credential, retry count or
budget. The file uses `review-provider-config.schema.json`:

```json
{
  "schemaVersion": 1,
  "kind": "openai-responses",
  "model": "operator-selected-exact-model-id",
  "credentialEnv": "OPERATOR_REVIEW_API_KEY",
  "limits": {
    "wallMs": 30000,
    "maxAttempts": 1,
    "retryDelayMs": 1000,
    "maxRequestBytes": 524288,
    "maxResponseBytes": 131072,
    "maxOutputTokens": 4096,
    "admissionBudget": {
      "inputTokenAllowance": 12000,
      "maxTotalTokens": 20000,
      "maxEstimatedCostMicrousd": null
    }
  },
  "pricing": null
}
```

Choose the model and supply its API key through the named operator environment
variable. The example model is a placeholder, not a supported model claim.
`kind` can instead be `anthropic-messages`. Canonical HTTPS API endpoints are
fixed; redirects are rejected. An exact returned model identity is required;
resolved aliases and automatic fallback are not accepted by this profile.
No credential values, credential variable names, HTTP error bodies, raw provider
responses or transport error prose enter a report. The config digest binds the
selected non-secret configuration; retain that operator file for reproduction.

Two grants are required: `--allow-inference` authorizes optional provider calls,
and `--allow-provider-source` authorizes sending the assigned packet to that
provider. These are distinct from `--allow-review-source --detailed`, which allows
source quotations and reviewer prose in CLI/MCP output. The latter output grant
alone cannot start inference. Normal output retains counts, identities and terminal
accounting while hiding paths, citations and candidate prose.

```sh
node dist/src/cli.js review-run --root PROJECT --context .checktrail/context.json \
  --provider-config /operator/provider.json --allow-inference --allow-provider-source
node dist/src/cli.js serve --root PROJECT --provider-config /operator/provider.json \
  --allow-inference --allow-provider-source
```

For MCP, `review_run` accepts only the captured `context` artifact path. Source
freshness is reconstructed before disclosure and after inference. A changed,
missing or invalid current selection is stale; no provider call starts for a
stale packet. Source comments cannot add tools or change grants.

## Independence and incomplete work

Each attempt sends a single inline user assignment and fixed engine instructions.
It supplies no prior messages, conversation identifier, previous response,
retrieval, shared memory, tools or background job. Snapshots carry only assigned
current source; diffs carry their explicit assigned base/current context. Failed
retry outputs never enter the next request. Each attempt has a new opaque ID and
is retained in accounting. These local controls do not prove that public source
was unseen during provider training. Provider retention follows its policy;
OpenAI `store: false` is not a general zero-retention claim.

Wall time, request/response bytes, API output tokens and attempts are bounded.
Only capacity, rate limits and server unavailability are retried, up to the
operator limit. A disconnect or ambiguous transport failure is not retried;
its billed usage may be unknown. Body truncation, refusal, malformed JSON,
requested tools, omitted source, unmatched citations, timeout and cancellation
cannot become an empty successful review. Cancellation closes the body reader
and clears the timer. MCP disconnect and request cancellation use the SDK request
signal; numeric cancellation IDs retain the application's exact-ID guard.

Token usage is provider-reported when available. Anthropic input accounting
includes returned cache-read and cache-creation tokens. Aggregates are null if
any attempt has unknown relevant usage. `pricing`, when supplied, declares input
and output rates per million and a reference; cost is an operator-rate estimate,
not independently verified billing. Pricing defaults to null.

`limits.admissionBudget` is optional for version 1 configuration compatibility.
When supplied it controls this assignment, including all retries. The operator
reserves `inputTokenAllowance + maxOutputTokens` before each disclosure. A new
attempt requires that reservation to fit the remaining `maxTotalTokens` and,
when configured, `maxEstimatedCostMicrousd`. One dollar is one million microdollars;
ceilings are integer microdollars, and decimal rates are calculated exactly with
aggregate/reservation estimates rounded upward. A monetary ceiling requires
operator pricing; missing rates stop before disclosure. Token-only admission keeps
unpriced cost unknown. Explicit zero ceilings cannot grant an unfunded request.

The input allowance is an operator reservation, not verified tokenization. The
provider may report a larger input count, overrun output limits, omit usage or
charge differently from the declared rates. Reports explicitly retain
`inputAllowanceVerified: false` and `billingCeilingGuaranteed: false`. Unknown
usage stops additional attempts; reported allowance/token/cost breaches produce
`budget-exhausted`, with received candidates/receipts retained where valid. A
bounded HTTP error body may contribute numeric usage, but its text is never
retained. Error responses obey the same reported output allowance as successful
responses; overruns stop capacity retries even without an admission budget.
Cached Anthropic input counts consume the same allowance. Cancellation,
timeout and stale source retain their distinct terminal states.

This per-assignment profile is `reported-usage-admission-v1`. Old configurations
without admissionBudget retain their previous wall/byte/output/attempt controls.

`limits.aggregateBudget` optionally adds `reported-usage-run-admission-v1`:

```json
{
  "inputTokenAllowance": 12000,
  "maxTotalTokens": 40000,
  "maxEstimatedCostMicrousd": null,
  "maxCalls": 2,
  "maxRequestBodyBytes": 1048576,
  "maxResponseBodyBytes": 262144
}
```

In `review-verify` the same engine-owned accounting spans refutation, its retries,
adjudication and its retries. Standalone review/refutation uses one run budget for
that assignment. Every new invocation starts a new budget; this is not a server,
cohort or account-wide quota. Per-assignment and aggregate limits both apply when
configured. Limits come only from the operator provider file or library options.
No accounting state enters a model packet, conversation history or MCP argument.

Before each request the engine admits one call, the exact serialized JSON request
body, an input/output token reservation, the operator-rate monetary reservation
and the full per-attempt response byte allowance. Earlier observed usage and body
bytes consume that same run budget. The response reservation is conservative:
an expected small reply does not authorize a request whose maximum response
allowance no longer fits. Zero limits stop unfunded requests. Unknown or exceeded
usage stops further disclosure; cancellation, timeout and stale source retain
their distinct statuses. Monetary calculations use upward integer microdollars.

Receipts retain the shared opaque budget ID, prior attempt metadata, request body
bytes, consumed response body bytes, numeric totals and the admission decision.
Import checks reconstruct each admitted attempt and require verification stages
to share the exact earlier ledger. Consistency checks do not authenticate a
wholly manufactured external report. Prior ledger entries contain no source,
candidate prose, credential values or HTTP error text. Partial consumed response
bytes remain counted on decode failure, stream failure or cancellation.

These are admission controls, not verified tokenization or guaranteed billing.
Transport accounting covers JSON request and consumed response bodies, excluding
headers and protocol overhead; a delivered chunk can exceed the allowance before
the reader cancels it. `transportByteCeilingGuaranteed` therefore stays false,
alongside the existing false input-token and billing guarantees. Verified
pre-request token accounting, native/tool budgets, streaming-provider profiles
remain acceptance work for the optional engine-owned inference profile; broader
native/tool and neutral-stage lifecycle stay required in R7. An `advisory-completed` disposition
means the assigned paths and citations reconcile, not that the repository is clean
or the candidates are correct. Severity remains suggestion/concern; consequence
ranking, calibrated probability and independent evidence tiers remain pending.

## Development evidence

`review-provider.test.ts` exercises both API request contracts, strict output,
freshness, source grants, capacity/rate-limit retries, unknown usage, malformed
and partial bodies, stalled streams, cancellation, credential echoes, retained
accounting, operator admission (no-fit, unknown usage, all-attempt/cache accounting, exact
decimal microdollars, forged retained budgets), and offline shared CLI/MCP behavior. `review-hypotheses.test.ts` covers
catalogue limits, partial source profiles, forgery and shared surfaces.
Required macOS arm64 Node 26.9.0 and Linux arm64 Node 22.23.2 profiles pass,
with fresh offline installed-package library/CLI/MCP acceptance on macOS.
These original synthetic transport tests use an operator-injected offline fetch;
they do not spend inference tokens or claim native provider acceptance. Actual
operator-selected synthetic inference remains unverified for the advertised API
transport. Required R3 closure instead concerns provider-neutral MCP stages;
Checktrail-owned subscription client launchers are optional. No real-project field review is enabled by these tests.

The aggregate profile's exact source-bound development evidence is recorded in
[review-budget-native-2026-10-02.json](measurements/review-budget-native-2026-10-02.json).
`review-budget` requires the original boundary, retry, unknown/cache usage,
transport-body, retained-report, session-reset and shared CLI/MCP controls.
Targeted mutations exercise the shared ledger, call admission, stage identity
and partial-body accounting. `scripts/verify-review-budget-package.mjs` checks a
fresh offline production-only install through the library, CLI and MCP, using
injected synthetic transports. No real inference, field evaluation or held-out
quality measurement is performed by that helper.

Interfaces: [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs),
[Responses storage controls](https://developers.openai.com/api/docs/guides/migrate-to-responses),
[Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create).

The source is also rechecked before each capacity retry and after refused,
cancelled or otherwise unsuccessful attempts. The shared refuter uses those same
checks and never treats an empty or agreeing response as a verified claim.
