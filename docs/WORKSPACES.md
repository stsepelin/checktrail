# Workspace and Git selection

Checks still cover whole configured projects. Optional `--base REVISION` selects
changed projects and their declared transitive consumers:

```json
{
  "schemaVersion": 1,
  "projects": [
    { "path": "library", "checks": ["javascript.node-test"] },
    { "path": "web", "checks": ["javascript.node-test"] }
  ],
  "workspace": {
    "complete": true,
    "dependencies": [{ "consumer": "web", "producer": "library" }]
  }
}
```

`complete` asserts that the maintainer has listed every relevant dependency
between configured projects. The engine does not infer imports or prove the
graph complete. Edges must name configured projects; duplicate and self edges
are rejected. Cycles terminate and include every reachable consumer.

```sh
node dist/src/cli.js plan --root /path/to/worktree --base main --detailed
node dist/src/cli.js run --root /path/to/worktree --base main --trust-project
```

The library accepts `base` in plan/validation options. For MCP, configure
`serve --base REVISION` at startup; tool calls cannot override it. Without a
base, the complete configured plan runs regardless of workspace declarations.

## Comparison and fallback

The reader resolves base and HEAD to immutable commit IDs, reads committed trees
and NUL-delimited index entries, and hashes inventoried working files directly.
This covers committed changes, staged changes, dirty or deleted files, untracked
inventoried files and executable modes. Renames include both old and new owners.
The longest configured project directory owns a changed file.

The full configured plan is retained for missing Git/history/base, an incomplete
graph, no changed paths, a root or hidden configuration change, an unowned path,
a root-project change, unsupported index entries, unresolved merges, submodules,
tracked excluded content, inspection limits or inconsistent Git metadata. The
configured root must be the worktree root. Fallback is a broader validation run,
not a passing empty selection. It does not add unconfigured checks.

Git inspection uses a host executable outside the project and bounded read-only
commands. It disables filesystem monitors, hooks, lazy fetch and replacement
objects, and does not invoke working-tree diff, clean or text conversion filters.
Raw content comparison can select additional files when Git attributes transform
content; it cannot establish a normalized checkout identity. `.gitignore` is not
interpreted. The inventory's fixed exclusions still apply.

Each Git inspection has a five-second/four-MiB process-output budget, separate
from native validation execution. Entries and working-file reads use the same
20,000-entry, eight-MiB-file and 64-MiB-total limits as inventory. Post-run Git
identity checks run in addition to the source snapshot. Changed HEAD/index or
unreadable metadata prevents an aggregate pass, even if source bytes stayed equal.

Detailed plans/reports record changed paths, selected projects, resolved commits,
Git version, an index fingerprint and a digest identifying the canonical worktree
root. Linked worktrees have distinct identities. Summaries retain selection mode,
reason and counts only. Neither identity is a hermetic build or dependency hash.

## Evidence

Native synthetic tests exercise committed/index/working changes, newline paths,
renames, modes, linked worktrees, unresolved merges, tracked exclusions and
project-configured filter commands that must never run. A changed library selects
its consumer and exposes a real assertion failure. CLI/MCP scope and strict MCP
startup ownership are covered. Current host evidence is macOS with Git 2.54.0;
the paired [impact measurement](IMPACT-MEASUREMENT.md) additionally exercises
its documented corpus on Linux arm64 with Git 2.52.0. That narrower corpus does
not establish the full Git edge-case matrix on Linux. Other Git/OS combinations
need their own integration runs.

References: [tree entries](https://git-scm.com/docs/git-ls-tree),
[index entries](https://git-scm.com/docs/git-ls-files),
[revision resolution](https://git-scm.com/docs/git-rev-parse).
