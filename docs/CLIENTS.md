# Application client compatibility

The [alpha.4 release record](measurements/release-alpha4.json) repeats the named
profiles below against the exact published artifact. The original standalone
snapshots predate the Checktrail rename and retain their original identities.
A future release needs its own checks; see [RENAMING.md](RENAMING.md).

The local package was installed offline into a fresh temporary consumer and tested
with Claude Code 2.1.263 and Codex CLI 0.154.0 on macOS arm64, Node 26.8.1. These
are specific client surfaces and versions; they do not establish compatibility
with every editor or with model-driven tool selection.

| Client surface                  | Observed protocol | Verified behavior                                                                                                                                                                                               |
| ------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code `mcp list`          | `2025-11-25`      | Successful connection and discovery of every advertised tool                                                                                                                                                    |
| Codex app-server direct MCP API | `2025-06-18`      | Tool discovery, inspection, planning, HTTPS guidance results, default execution denial, rejection of tool-supplied trust, trusted native passing/failing/skipped-only runs, and exact retained report retrieval |

Both clients use the SDK's existing legacy negotiation path. The separate SDK
integration suite exercises `2026-07-28`; these application observations do not
establish modern protocol or standard Tasks support. See
[MCP compatibility](MCP-COMPATIBILITY.md).

The initial Claude Code check exposed an ignored `starts_with` format in the
guidance-reference URL output schema. That observation is retained in the
[pre-fix snapshot](measurements/client-claude-before-schema-fix-darwin-arm64-node26.json).
Guidance and exported Vue/Nuxt path constraints now use standard patterns, with
URI format metadata for guidance links. The current health check requires empty
stderr, rather than accepting that warning. It still does not call a tool or
establish full client-side validation of tool results.

Published schemas are also compiled with strict Ajv 2020-12 and standard formats.
Runtime and JSON Schema regressions cover valid HTTPS links, wrong schemes/prefixes,
length boundaries, route prefixes, authority-style probe paths, and Nuxt fragments
and newlines. The latter probe restrictions previously existed only in runtime
refinements; the exported schemas now express them too. This corrects the schema
representation without permitting values the runtime previously rejected. Zod's
[JSON Schema metadata](https://zod.dev/json-schema#metadata) carries the standard
URI format; [JSON Schema validation](https://json-schema.org/draft/2020-12/json-schema-validation)
defines the pattern and format vocabulary. Runtime-only refinements elsewhere are
not thereby proven equivalent to every exported schema.

Codex tests call its real app-server MCP API directly, without starting a model
turn. A synthetic Node assertion passes, is changed to fail, and is replaced by a
skipped test. The helper checks exact executed-test counters, result categories,
unchanged source during each run, and equality of retained reports. Summary
responses must not contain the temporary project path. This does not test an
editor UI, model reasoning, every tool, or cancellation of active native work.

## Reproduce

The client executables must already be installed. The helper does not install or
update clients, authenticate, invoke a model, register a persistent user server,
or publish a package. Run from the source checkout after building:

```sh
node scripts/verify-mcp-clients.mjs claude
node scripts/verify-mcp-clients.mjs codex
```

Each run packs the current checkout, installs the tarball with npm offline and
lifecycle scripts disabled, creates an original synthetic fixture, and removes
its temporary installation afterward. A transparent stdio observer records only
protocol versions, methods, advertised tool names and process lifecycle metadata;
it forwards protocol bytes unchanged. Tool calls go through the actual client.
No custom MCP compatibility implementation is introduced.

Claude Code uses a fresh `CLAUDE_CONFIG_DIR`, bare mode, user settings from that
directory, and disabled nonessential traffic/marketplace auto-installation.
Its own `mcp add-json` writes only that temporary configuration. See the official
[configuration directory](https://code.claude.com/docs/en/claude-directory) and
[environment settings](https://code.claude.com/docs/en/env-vars) references.

Codex receives process-local configuration overrides. Existing named MCP servers
are individually disabled, and a preflight requires only the two synthetic
servers to be enabled. Apps, plugins and hooks are disabled for this invocation;
its ephemeral thread uses temporary state/log directories. Existing configuration
files and home-directory variables are not rewritten. Client policy constraints
can still prevent this profile from running; such failures are not passes.

The configured Codex provider points to a temporary loopback endpoint. It answers
only the observed model-catalog GET request; any inference request fails the
measurement. No model turn is submitted and no provider credentials are inherited
from the invoking environment. This is a direct client-integration check, not a
network-sandbox or client-telemetry attestation. The API schema was generated by
the installed CLI; the official [app-server reference](https://developers.openai.com/codex/app-server)
and [configuration reference](https://developers.openai.com/codex/config-reference)
describe those interfaces.

The observer checks that its own process and each observed server process have
stopped before deleting the temporary directory. Client shutdown can terminate an
observer before it records the server's exit event; recorded exit counts are
therefore separate from the process-liveness check. Neither establishes cleanup
of an active validation's descendants. That behavior has separate engine/SDK
lifecycle tests.

## Recorded evidence

- [Claude Code observation](measurements/client-claude-darwin-arm64-node26.json)
- [Codex app-server observation](measurements/client-codex-darwin-arm64-node26.json)

Snapshots include the client/runtime versions, package and installed runtime
hashes, harness hash, observed protocols, outcomes and available exit records.
They omit source, raw client logs, configured personal server names and absolute
paths. The package digest identifies the measured tarball, not every later
checkout: changing documentation or adding these snapshots changes package bytes.
The runtime digest identifies the installed `dist/src` tree independently.

These local checks satisfy only the named client profiles. Claude Desktop,
Cursor, VS Code integrations, other client versions and target operating systems
remain unverified. These original snapshots do not establish public installation or hosted CI;
alpha.4 publication and hosted evidence are recorded separately in [RELEASE.md](RELEASE.md).
