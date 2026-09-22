# Cross-family subscription-backed evaluation

The local Claude Code and Codex clients can supply separate model families to the
[agent evaluation workflow](AGENT-EVALUATION.md). Authentication stays with the
installed clients. The [first cross-family pilot](CROSS-FAMILY-PILOT.md) records
actual attempts and their protocol failures. Checktrail's engine does not call a model or acquire credentials.
The clients send the deliberately selected public-source packets to their providers;
local orchestration does not mean local model inference.
The later [isolated pilot report](ISOLATED-CROSS-FAMILY-PILOT.md) records the
gateway-restricted follow-up, with raw scores separated from independently audited
completion and judging limitations.

## Experimental design

Use one frozen run per reviewer model because `reviewerProfile` is run-wide. Keep
source, labels, native commands, tool access within each arm and declared budgets
matched. Run both native-only and MCP-assisted reviews for every case in every
family, with fresh sessions and separate source copies. Preserve the actual model
identifier and client version; an alias alone cannot identify a repeatable model.

Have fresh judges from both families independently grade both anonymous sets. Keep
both score sets and disagreements. Having Claude judge only Codex and Codex judge
only Claude confounds reviewer differences with judge differences. Separate judge
sessions must not inherit the reviews they are grading.

This is a comparison of model **and client configurations**. Different system
instructions, tools, reasoning settings and token accounting prevent attributing
all differences to the underlying model. A setting named `medium` does not establish
equal reasoning compute across providers. Subscription access does not establish
zero marginal billing: keep billed cost unknown unless verified separately.

## Local client preparation

Check installed capabilities and authentication using `claude --help`,
`claude auth status`, `codex exec --help` and `codex login status`. Do not publish
raw authentication output, which can include account identifiers. Test the exact
structured-output handoff before freezing a trial, not just a plain-text reply.

Claude Code supports subscription login. An `ANTHROPIC_API_KEY` can select API
billing instead; see the [official subscription guidance](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan).
The [Agent SDK billing update](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan),
checked for this trial, says `claude -p` still draws from subscription usage limits
after the previously announced change was paused.
Use an invocation-specific environment to omit API-key/provider overrides when
subscription authentication is intended. Do not rewrite the user's settings or
copy credentials into a run archive. Record authentication mode without secrets.

For the tested clients, Claude's safe mode retains subscription authentication;
its bare mode explicitly skips OAuth/keychain authentication and therefore is not
an equivalent choice. Codex's `--ignore-user-config` retains authentication while
omitting user configuration. Verify these flags against the installed versions,
not an assumed cross-version contract. Client help and the
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference) describe the
available modes.

Use fresh temporary packet directories outside the project hierarchy. Disable
unrelated skills, hooks, plugins, connectors and persistent memory where supported.
Inspect actual transcripts: a requested setting is not evidence that no metadata
was exposed. Allow only the assigned source, prepared native helper programs and
frozen MCP bridge. Source, comments and tool output remain untrusted task data.
Separate source copies are not filesystem access controls for a shell tool.
Keep prepared helper programs in a dedicated disclosure directory whose listing
and ancestors do not reveal labels, patch names or counterpart sources. Merely
instructing an agent not to list the adjacent curation directory is insufficient.
Stronger trials need an enforced file-access boundary and a negative access test.
The checkout now includes an [evaluation gateway](EVALUATION-ISOLATION.md) with
captured-file access and fresh offline execution containers. Its version-specific
client recipes remove native host tools and are checked against actual advertised
tool inventories; the earlier safe-mode pilot configuration is not sufficient.

## Evidence and accounting

Retain raw client event streams, terminal responses, process exit status, timeouts,
usage breakdowns, model identifiers and complete MCP traces outside the public
repository. Seal a receipt only after validating its source bindings and quotations.
Keep client setup failures and invalid receipts visible. A retry needs an explicit
reason and a new declaration when it changes the experimental protocol. Audit
actual access before making detection claims: a reviewer can fail to report its
own exposure. Preserve contaminated findings for semantic adjudication, but do
not count them as independent unexposed discoveries. Keep this eligibility
decision separate from whether the claimed behavior is reproducible.

Check all captured source bytes after execution. Run native commands and MCP
validation sequentially within each packet. Count actual tool calls; an instruction
limiting calls does not enforce the limit. Check output-token and wall-time budgets
against measured telemetry, preserving any overrun. Provider token counters and
list-price estimates are not interchangeable with subscription bills or equal
compute budgets. Auxiliary-model usage belongs in the record too.

Create presentation copies for judging after sealing the reviews. Uniformly remove
identity/process disclosures that would reveal treatment, preserve the originals
and record every redaction. Retain completion status and any substantive uncertainty
needed to judge a claim. Check a judge's claimed executions against its transcript;
a correct verdict can still contain invented reproduction evidence. Finding style and content can still identify a family or
arm; describe residual blinding limits.

Historical cases already inspected during development remain historical evidence.
Use the results to select development reproductions and regression work, then
freeze different issue groups for an effectiveness holdout. Do not turn repeated
reviews of the same defect into independent defect samples.
