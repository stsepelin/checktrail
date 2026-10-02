# Independent refutation attempts

`review-refute`, `review_refute` and `runProviderRefutation` share the stateless
API transport and its startup-only inference/source grants. A fresh verifier
receives the sealed source assignment and one unverified hypothesis: family,
claim, trigger, consequence, evidence gaps and exact citations. Its original ID,
reviewer identity, severity, confidence, historical attribution, fix scope and
prior verdict are withheld. No previous request, sibling review, native probe
outcome, history retrieval, tools or shared local memory enters this request.
This controls the local request; provider training contamination remains unknown.

The fixed prompt asks the verifier to falsify the hypothesis, inspecting its current
address and mechanism, defaults, sibling family, caller reachability, trigger
scale, test adequacy, fix feasibility and change scope. It can return exactly cited
counterclaims using the existing candidate schema. An empty list does not support
the original claim. A counterclaim remains an advisory declaration too.

## Evidence boundary

Reports bind the original candidate digest, source context and canonical refutation
assignment digest to the retained verifier attempt. Every attempt, terminal state,
file disposition, quotation check and actual or unknown usage follows the shared
provider contract. Source is checked before retries and after unsuccessful as well
as successful attempts. Changed source cannot become current evidence just because
an HTTP error did not contain candidate output.

All nine verification dimensions retain `not-established`, and `resolution`
remains `unresolved`. `refutation-attempt-completed` means the advisory request,
source quotations and file accounting reconcile. It does not mean that the target
is supported or refuted. Model agreement, plausible mechanism, an exact quotation,
or a Boolean probe alone cannot establish the intended policy, complete causal
mechanism, production callers or reachable remedy. Native corroboration, independent
adjudication, defect deduplication and consequence-based severity remain required R5
work. Calibrated probabilities remain in R6.

Normal output hides both the original hypothesis and the counterclaim prose and
quotations. Detailed output requires the existing review-source output grant.
No refutation attempt changes a deterministic validation outcome.

## Use and development controls

```sh
node dist/src/cli.js review-refute --root PROJECT --context .checktrail/context.json \
  --input .checktrail/candidate.json --provider-config /operator/provider.json \
  --allow-inference --allow-provider-source
```

Configure MCP's provider and grants at server startup as described in
[REVIEW-PROVIDERS.md](REVIEW-PROVIDERS.md). `review_refute` accepts only context and
candidate artifact paths. It shares the provider execution slot and cancellation
handling with `review_run`; tool arguments cannot choose a model, grants, history,
native evidence or budget. Subscription clients remain pending.

`review-refutation.test.ts` uses original synthetic assignments and offline
transport responses for independent requests, hidden prior labels, forged source
addresses, seeded wrong mechanisms/locations/remedies, unverified agreement,
detached retained evidence, budget/capacity states, source changes before retries
and shared CLI/MCP permissions. The installed-package smoke check exercises the
same exported contract without development dependencies. These controls establish
request and evidence boundaries, not model reasoning quality or all-family
independent defect validation.

Required offline profiles pass on macOS arm64 Node 26.9.0 and Linux arm64
Node 22.23.2, along with fresh production-package acceptance and the updated
installed Codex/Claude MCP inventory without inference. Withholding prior severity,
binding the assignment, and rechecking retry source each have a guard mutation
that fails its intended regression; the restored required profile passes.

[Verification](REVIEW-VERIFICATION.md) can combine this blind attempt with a live
native probe and a separate raw-evidence adjudication assignment. The refuter
continues to receive no native evidence. Bounded observations and adjudicator
proposals do not establish the general claim or its consequence severity.
