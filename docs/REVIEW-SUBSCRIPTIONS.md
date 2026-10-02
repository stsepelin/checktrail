# Optional native AI client orchestration

The required reviewer interface is the local model-independent MCP workflow
(REVIEW-MCP-WORKFLOW.md). Its AI host owns subscription/API authentication.
Checktrail launching Codex or Claude itself is optional and is not implemented
or advertised; it is not a Gate A dependency. The existing application-client checks in CLIENTS.md
verify MCP integration without model inference. API transport acceptance in
REVIEW-PROVIDERS.md is a separate interface and does not authorize using a
subscription credential as an API key.

## Required profile

Use the documented native client authentication interface opaquely. Do not read,
copy, export or retain its credential store. Operator startup chooses the pinned
client executable/version, exact model, grants, protected limits and source
assignment. An MCP argument or repository file cannot make those choices.

Before a client profile can be advertised, its acceptance must establish:

1. Every assignment creates a new session; no resume, fork, prior response,
   previous messages, sibling case, answer label or shared review memory.
2. Snapshot inputs carry only assigned current bytes. Diff inputs carry exactly
   the assigned base/current pair. Original repository history, future revisions,
   root/parent/home instruction files and unrelated source do not enter context.
3. Source comments cannot change the grants, client configuration, hooks,
   plugins, tools, model, context or budgets. The active configuration and actual
   request must agree; a prompt asking for independence is insufficient.
4. Tools are absent or limited to the declared registered surfaces. Those
   surfaces cannot retrieve prior state or expand source disclosure. Arbitrary
   client tool execution cannot inherit project trust from a model argument.
5. A native-client offline request preflight checks the exact initial assignment,
   instruction sources, tools and history fields before real inference is used.
   Use original synthetic parent/home/project canaries, not private instruction
   copies. API stubs cannot stand in for the native client's prompt construction.
6. Separate original synthetic inference acceptance verifies opaque account
   access, exact observed model, output/citation/scope contracts and real usage.
   A fake provider response has no inference-quality or billing denominator.
7. Model/client retries, all attempts, token/cost/time/tool/native budgets,
   refusals, partial output, cancellation and owned-resource cleanup are tested.
   Missing usage and model metadata remain unknown; no silent fallback is allowed.
8. Two fresh assignments prove that session state, artifacts and accessible
   source do not cross over. Independently reviewed cases still require frozen
   instructions, labels and adjudication before quality measurement.

Ephemeral session storage, ignored user configuration, read-only execution and
source/session containment are separate properties. Each needs its own acceptance
case. Residual provider training and managed-policy uncertainty must remain visible.
These requirements apply if a native AI client launcher is introduced or chosen
for an evaluation host profile. They do not require such a launcher for MCP
feature completion and do not enable real-project field trials.

## Native contract inspection

The earlier Codex 0.159.0 inspection recorded `exec --ignore-user-config`,
`--ignore-rules`, `--ephemeral`, `--strict-config`, `--output-schema` and JSON events.
Its generated app-server contract exposes new-thread and turn parameters,
including `ephemeral`, instructions, selected workspace roots and permissions.
The ordinary `readOnly` policy has a network setting; it supplies no evidence by
itself that only the assigned source is readable. Named permission profiles need
separate actual containment tests. Inspection and a version probe do not establish
an accepted optional native client profile.

The CLI's ignored-rule switch concerns execution-policy rules. Do not infer that
it excludes every instruction source. An offline native-client preflight must
reject unexpected instruction input even if an ephemeral run finishes normally.
Do not work around failed isolation by copying authentication into a new home,
forwarding subscription credentials through an undocumented endpoint or changing
the user's global client configuration.

Claude's candidate profile must separately verify its tool, MCP, settings, hook,
plugin, instruction and persistence controls while preserving opaque subscription
authentication. API-only modes are not subscription acceptance. Neither client's
profile can be inferred from the other's behavior.

Primary interfaces: [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli),
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference),
[app-server contract](https://learn.chatgpt.com/docs/app-server).

## Original synthetic request diagnostic (2026-10-02)

The development probe `scripts/probe-review-client-isolation.mjs` runs two fresh
assignments per native client against a loopback transport fixture. Pin the
installed versions explicitly and run under a foreground managed lease whose
assigned `PORT` is available:

```sh
node scripts/probe-review-client-isolation.mjs \
  --codex-version 0.160.0 --claude-version 2.1.287 \
  --log-dir /private/tmp/checktrail-client-diagnostic
```

This is a source-checkout development command, not a packaged subscription
backend. Unknown or mismatched versions fail before assignment. Optional raw
native stdout/stderr logs remain in a distinct private directory per run; the
public receipt retains request digests, numeric counts and classified metadata,
without request prose or credentials. Do not publish those raw logs.

The recorded macOS arm64 diagnostic uses synthetic transport credentials and
original assigned, parent, project, hidden-answer and prior-case canaries. It
preserves the native authentication homes without reading or copying credential
stores, replacing a home, changing user configuration, or using resume/fork.
Actual requests, native session IDs, exact request models, declared Claude runtime
version/model, output contracts and owned temporary/socket cleanup are inspected.
A new session ID and absent canaries are bounded observations, not proof of
complete source containment.

Codex 0.160.0 completed both requests with the exact original assigned packet,
no tested parent/project/hidden/prior-case canary or response-history field, and
distinct session IDs. Despite ignored user configuration, zero project-document
bytes and disabled tool features, both requests contained unexpected host review
instructions and advertised `request_user_input`. Their origin was not established.
The synthetic model also produced a native fallback-metadata warning; no real
model capability was tested. The candidate instruction/tool scope is rejected.

Claude Code 2.1.287 completed both requests in safe/restricted mode with tools
empty, MCP configuration strict and empty, settings sources empty, an explicit
system prompt and session persistence disabled. The tested canaries, prior-case
markers, response-history fields and host review-rule markers were absent. The
requests contained five user text blocks each: one exact assigned packet and four
other blocks whose instruction scope remains unclassified. Its initialization
still listed built-in agents and plugins, although model tools and MCP servers
were empty. Declared owned messaging sockets were absent after child exit.

The overall diagnostic exits **2** because Codex's instruction/tool scope fails;
that expected rejection is retained rather than reported as passing acceptance.
Four pure metadata controls cover JSON source decoding, matching words inside
assigned source, leaked instructions/history/tools, malformed or duplicate input,
and native event/session/output/model/version inconsistencies. The measurement
is [review-client-isolation-2026-10-02.json](measurements/review-client-isolation-2026-10-02.json).

Neither profile is accepted. Synthetic response token counts and client-derived
costs are not real usage, billing or reviewer-quality evidence. Opaque subscription
authentication, actual inference, full containment/configuration classification,
all-attempt accounting and cancellation remain unverified for any future engine-owned native client profile. Host-session
independence remains required for evaluation, regardless of host. Gate A stays
open for the required MCP/native reviewer work and real-project field evaluation
remains disabled.

Native switches were inspected with the installed clients. Primary references:
[Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference),
[Codex instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md),
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference).
