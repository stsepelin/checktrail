# One-assignment synthetic host readiness

The library exports `ReviewHostAssignmentLease` and
`createReviewHostAssignmentServer`. An operator can bridge one already issued
workflow assignment to a separate MCP host process. The host still owns its AI
choice and subscription/API authentication. This server never calls an AI provider.

The lease requires `allowSourceDisclosure: true` at construction. It checks the
assignment schema and digest before retaining a cloned packet. Startup options
bound reads (default one), packet bytes (default 1 MiB), response bytes (default
128 KiB), and wall time (default 30 seconds). Options are strict and cannot be
changed by an MCP tool argument. Larger transports must independently support the
operator's selected packet limit; the lease is not a transport-frame override.

The isolated server exposes exactly three tools:

- `review_host_assignment`: read this assignment within the startup read budget.
- `review_host_submit`: submit one response, consuming the lease even when the
  response is malformed, too large, foreign, or arrives before delivery.
- `review_host_status`: obtain source-free accounting with unverified provenance.

Successful submission revokes source access. The operator can call
`takeSubmission()` once and forward the unchanged response to the owning
`ReviewWorkflowEngine`, which checks current source, citations, stage and quotas.
The lease does not approve claims or advance the owning workflow itself. Failed
submissions have no forwardable response; the operator must account for that
interruption in the workflow. Persistent complete attempt archives remain a
separate required profile.

An expired, exhausted or explicitly revoked lease cannot read or submit again.
Submission checks its deadline after synchronous validation as well as before
admission, because a wall timer cannot fire while that validation is running.
Closing a used server revokes an outstanding source lease. Closing metadata-only
discovery does not consume an assignment; its operator wall timer still applies.
A submitted response remains available for the operator's one-use handoff after
transport close. Calling `revoke()` removes any remaining response.

The original acceptance fixture starts distinct SDK host and assignment-server
processes for reviewer, refuter and adjudicator. The parent observes the worker
PID; the pinned SDK transport observes its child PID. Tests retain the raw stage
packet only inside synthetic acceptance, check prior identity/label withholding,
and reconcile native broken, repaired and valid adjacent witnesses. Separate
controls reach timeout, cancellation and output exhaustion after the SDK has
actually received source, then verify both process identities have exited.
Guard-removal controls check that these assertions defend their named behavior.

This establishes process and protocol readiness for the recorded synthetic
runtime. It does not establish an OS filesystem boundary for an arbitrary AI
host, remove other host tools or conversation history, authenticate a model
session, or measure review quality. Host-declared session IDs remain unverified;
`hostIsolationVerified`, `modelFreshnessVerified` and `claimsVerified` remain
false. No model inference or real-project field evaluation is included.

The public options and source-free accounting schemas are
`schemas/review-host-lease-options.schema.json` and
`schemas/review-host-lease-summary.schema.json`. See the byte-bound receipt in
`measurements/host-session-readiness-2026-10-08.json` for runtime evidence and
limits. Gate A remains open for its other required profiles and freeze bindings.
