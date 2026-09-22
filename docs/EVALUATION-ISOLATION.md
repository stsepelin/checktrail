# Evaluation capability boundary

The checkout-only `scripts/agent-evaluation-gateway.mjs` gives a reviewer access to
one captured source packet. File tools read an in-memory snapshot. Native tests
and reproduction snippets run in fresh, restricted Docker containers. This is
evaluation infrastructure; it does not change the execution privileges of the
published Checktrail CLI or MCP server.

Use it together with [frozen evaluation runs](AGENT-EVALUATION.md) and
[cross-family review and judging](CROSS-FAMILY-EVALUATION.md). A gateway alone is
insufficient if the client also exposes a host shell, filesystem tools, another
MCP server, browser, plugin or delegated agent. Verify the actual model-visible
tool inventory before inference and retain the client event stream afterwards.

See [enforced delivery](ENFORCED-EVALUATION.md) to make source, usage, execution
and cleanup evidence prerequisites for completed submissions.

## Operator preparation

Build the checkout, prepare an already-installed Linux image identified by its
`sha256:` image ID, and prepare dedicated public dependencies. Nothing in the
gateway pulls images or installs packages. The operator must inspect the image
and dependency directories: they must contain only disclosed public tooling,
with no credentials, private repositories, labels, sibling cases or repair files.
Never mount the working repository or the curation directory as a runtime.

Create a separate runtime directory containing the pinned Checktrail package and
`@modelcontextprotocol/client` 2.0.0 with a retained lockfile. Check the installed
package against the declared archive. The worker uses this SDK to launch the
package's real MCP server and pins its internal connection to `2026-07-28`.
It verifies equality between a validation response and its retained report.

Pass an operator-owned JSON configuration. All paths must be absolute; source,
runtime, dependencies and the audit parent must be canonical paths. For example,
with paths replaced by prepared local directories:

```json
{
  "schemaVersion": 1,
  "source": "/public-evaluation/packet/source",
  "files": ["pyproject.toml", "checktrail.json", "test_value.py"],
  "audit": "/public-evaluation/evidence/assignment.jsonl",
  "image": "sha256:REPLACE_WITH_64_HEXADECIMAL_DIGEST_CHARACTERS",
  "runtime": "/public-evaluation/public-runtime",
  "dependencies": null,
  "treatment": false,
  "native": {
    "executable": "python3",
    "args": ["-B", "-m", "unittest", "discover", "-s", "."]
  },
  "languages": ["python"],
  "timeoutMs": 30000,
  "maxOutputBytes": 1048576,
  "maxCalls": 40
}
```

Start it as the client's only MCP server:

```sh
node scripts/agent-evaluation-gateway.mjs CONFIG.json --trust-execution
```

The startup flag grants execution; a repository file or tool argument cannot.
SDK discovery and tool listing create no snapshot or audit file. The first actual
tool call captures the source and reserves the audit, so a disposable protocol
discovery subprocess cannot claim the serving process's exclusive audit path.
`native` is a fixed executable/argument array chosen by the operator. No shell
interpolation is used. The prototype accepts Node and Python native commands and
JavaScript/Python reproduction snippets. Other Checktrail language adapters remain
available outside this evaluation gateway; adding a probe language needs its own
runtime preparation and boundary tests.

## Reviewer capabilities

| Tool                  | Access                                                  |
| --------------------- | ------------------------------------------------------- |
| `evaluation_files`    | Captured source filenames only                          |
| `evaluation_read`     | Exact captured path and numbered bounded line range     |
| `evaluation_citation` | Exact captured quotation and line-range preflight       |
| `evaluation_native`   | Fixed selected native suite                             |
| `evaluation_probe`    | Bounded JavaScript/Python code in a fresh container     |
| `checktrail_plan`     | Treatment only: real pinned MCP planning                |
| `checktrail_validate` | Treatment only: real MCP validation and retained report |

Snapshots reject symlinks, traversal, duplicate paths, binary/non-UTF-8 files and
oversized inputs. The gateway copies only the declared source files; changing the
original directory afterwards does not change what a reviewer reads or executes.
No directory traversal endpoint exists. Dependencies, if configured, are mounted
at `/source/node_modules` and are deliberately accessible to code in the packet.

Containers run without networking, as UID/GID 65532, with a read-only root and
read-only source/dependency mounts, dropped capabilities, no-new-privileges,
bounded memory/CPU/process count and a 64MiB `/tmp`. Scratch disappears between
calls. No host home, credentials, Docker socket or curator directory is mounted.
Only the two explicit Checktrail tools receive the engine runtime and MCP worker;
ordinary probes cannot invoke them to bypass assignment to the native-only arm.

The host gateway holds the audit file outside disclosed mounts. Calls are
serialized, executions have output/time limits, and shutdown cancels an active
process. Every container is removed after execution, including timeout, output
overflow and cancellation. Docker's asynchronous auto-removal race is retried
within a bounded cleanup loop. An unexpected cleanup failure fails the tool call.
Abrupt termination of the host process or Docker daemon still needs operator
reconciliation; this is not a guarantee against host/kernel compromise.

## Evidence

Each result includes an `evidenceId`. Require that ID in a finding's reproduction
and in a judge's claim of having executed a check. Audit records retain full
bounded process output, raw MCP responses, rejected requests reaching the gateway,
and a hash chain linking calls and results. They are not model-written receipts.
Tool responses project duplicate MCP content away and cap displayed stdout/stderr,
with explicit omitted-character counts. Display omission is different from
execution truncation: a truncated execution remains marked `truncated`.

The start record binds source bytes, worker bytes, runtime/dependency tree hashes
and image ID. Audit version 2 verifies each execution's mounted dependency and
engine trees before execution and before returning its result. Native tests and
probes verify dependencies only: the engine is not mounted. A mismatch or an
unreadable tree fails the call; a cancelled call retains unverified integrity.
The result audit persists these identities before delivery to the client.

Closing cancels active execution, removes its container and source snapshot, then
records cleanup and execution counters. It does not rescan dependencies or claim
whole-session immutability. This keeps completed-call evidence independent of a
client's short shutdown grace period. A missing end record still means cleanup is
unverified, even when completed calls have verified identities. Abrupt termination
can still interrupt cleanup. Operators must not modify mounts during a run;
before/after hashes cannot detect a transient change restored between captures,
or protect against an operator who rewrites the audit.

The call budget prevents additional work; it does not prevent a client from
issuing repeated denied requests. The launcher must also enforce a wall deadline,
retain over-budget attempts and audit total client tool calls and token usage.
SDK schema rejections before dispatch belong in the client transcript.

## Client configurations actually checked

Local non-inference request captures on Claude Code 2.1.263 and Codex 0.154.0
verified the following. Treat these as version-specific research, not durable CLI
interfaces; rerun the captures after a client update.

Claude uses `--restricted --tools "" --disable-slash-commands`, a strict single
MCP configuration, an exact gateway-tool allowlist, empty setting sources, disabled
hooks/plugins and no session persistence. `--bare` disables subscription OAuth;
`--safe-mode` disables custom MCP configuration. Neither substitutes for this
tested configuration.
Structured JSON output additionally advertises Claude's `StructuredOutput`
delivery tool; it grants no source or execution access. Include it explicitly in
the audited inventory rather than claiming the gateway names are the entire list.

Codex needs more than disabled feature flags: the tested model catalog forces
code-mode, patch and collaboration tools. A local copy of the selected model entry
sets `tool_mode`, `multi_agent_version` and `apply_patch_tool_type` to null,
`experimental_supported_tools` to an empty array, and `supports_search_tool` to
false. Native feature flags are also disabled. The captured tool inventory then
contains only the gateway and three MCP resource wrappers, which can access only
configured servers. The gateway advertises no resources.
Each permitted tool also needs the operator setting
`mcp_servers.eval.tools.TOOL_NAME.approval_mode="approve"` in this client version.
With the default tool policy and a noninteractive `never` approval policy, the
first live canary connected but denied every call. A local tool-execution capture
verified the per-tool setting without enabling any native host tool.

Codex uses a subprocess-specific temporary state directory with a symlink to the
existing authentication file, without copying credentials. Empty instructions,
ignored user config/rules, disabled web search, and explicit disabling of host and
automatically installed skills remove the observed global AGENTS/skill exposure.
Changing the catalog changes client tool configuration, not the provider model.
Retain that distinction when interpreting family comparisons.

The observed client initialization versions were `2025-11-25` for Claude and
`2025-06-18` for Codex. Both connected to SDK 2.0.0. The tested Codex feature flag
and protocol environment override did not change its initialization version.
Do not confuse these client connections with the worker's separately pinned
`2026-07-28` connection to Checktrail.

## Repeatable boundary checks

After building, run the synthetic live-container verification with prepared public
runtime and installed image ID:

```sh
node scripts/verify-evaluation-isolation.mjs IMAGE_DIGEST PUBLIC_RUNTIME NEW_OUTPUT.json
```

It verifies forbidden sibling/host access, source write rejection, network denial,
ephemeral scratch, nonroot execution, absence of the engine from probes, native
and real-MCP passing/failing controls, output overflow, timeouts and cancellation.
The normal unit suite checks snapshot immutability, path/schema rejection,
treatment gating, cleanup failure/races, audit binding and runtime mutation.
These checks establish the tested boundary, not review accuracy or a secure
sandbox around the authenticated client itself.
