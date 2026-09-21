# Checktrail

Read `docs/PLAN.md` for scope and `docs/ARCHITECTURE.md` for contracts.
Keep public fixtures synthetic. Do not import private source, reports, paths,
incident narratives, credentials, or repository history.

Use the shared engine for CLI and MCP behavior. Discovery and planning must
never execute project code. Execution requires operator-level trust; an MCP
tool argument cannot grant it. Do not call executed project code sandboxed.

Run `npm run check` after behavior changes. Tests must cover broken cases and
valid near misses. Never report skipped, unavailable, empty, or stale checks
as passing. Update the support matrix when capabilities change.

Do not commit, push, publish packages, or create remote repositories without
an explicit request for that action. Keep dependencies pinned in the lockfile.
