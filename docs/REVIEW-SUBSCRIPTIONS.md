# Subscription client acceptance

Codex and Claude subscription orchestration is required in R3/R7/R8 and is not
implemented or advertised. The existing application-client checks in CLIENTS.md
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
These requirements preserve the original finish-first gates; they do not enable
new real-project field trials.

## Native contract inspection

The installed Codex 0.159.0 CLI exposes `exec --ignore-user-config`,
`--ignore-rules`, `--ephemeral`, `--strict-config`, `--output-schema` and JSON events.
Its generated app-server contract exposes new-thread and turn parameters,
including `ephemeral`, instructions, selected workspace roots and permissions.
The ordinary `readOnly` policy has a network setting; it supplies no evidence by
itself that only the assigned source is readable. Named permission profiles need
separate actual containment tests. Inspection and a version probe do not close R3.

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
