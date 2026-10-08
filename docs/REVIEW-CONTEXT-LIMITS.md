# Expanded captured review contexts

Opt-in selection/context version 7 accepts at most 32 distinct primary and support
paths, 64 KiB of UTF-8 bytes per source file and 1 MiB of combined source. Diff
capture counts immutable base and selected working/index bytes together. At most
64 revision views are retained. Versions 1–6 keep their previous path and combined
source bounds.

Version 7 keeps version 6's fixed captured-string parser profile, explicit current
source selection, file modes, exact base/current ranges, digest bindings and
unresolved wider-language calls/imports. Syntax metadata still has its independent
node, depth, count and 256 KiB limits. A larger source budget does not turn
unsupported, malformed or exhausted syntax into collected evidence.

Version 7 has an independent 8 MiB serialized context bound. JSON escaping,
guidance, replacement ranges and syntax metadata count toward it; the source byte
budget alone does not guarantee that every payload fits. Summaries disclose counts
and the context digest while withholding paths, source and syntax details.

The neutral workflow and assessment contracts account for all selected paths.
Workflow packet size can be configured by the operator up to 8 MiB; existing
packet/retention defaults and total admission remain unchanged. A capture that
exceeds the selected startup quota becomes incomplete before assignment. Closing,
cancelling or reopening cannot grant additional budget or verify host isolation.
The MCP tools retain their artifact-path contracts; tool arguments cannot grant
source disclosure or native execution. No project code runs during capture.

The original `review-context-limits` controls exercise exact bounds, the first
extra byte/path, multibyte input, coherent reconstruction forgeries, 64 base/current
views, index accounting, old-version limits, neutral workflow quotas and large
library/CLI/MCP source-granted and summary output. Fresh offline installation runs
the same compiled controls outside the installed engine. The mutation harness
checks original assertions against compiling changes to reconstruction bounds and
selected-path accounting.

The selected syntax grammar and compiler notice gaps, wider-language lexical
callers/import consumers, assembly scope and complete runtime matrix remain Gate A
obligations. These synthetic implementation controls do not establish review
quality, actual host isolation or field readiness.

Revision-specific macOS and pinned Linux ARM64 source/fresh-install controls and
compiling mutations are recorded in
[review-context-limits-2026-10-08.json](measurements/review-context-limits-2026-10-08.json).
