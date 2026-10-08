# Inventoried Go workspaces

Go module checks select the nearest inventoried `go.work` between the module and
the configured root. Without one, `GOWORK=off` continues to isolate a module from
ambient workspaces outside that root. Discovery and planning read data only; they
never invoke Go or project code.

The bounded workspace profile captures the workspace file's SHA-256, declared
member identities and manifests, and recursively referenced local replacement
manifests. It admits at most sixteen local modules. Each `use` target must name an
inventoried regular `go.mod`; local replacements must be relative to their
manifest and stay inside the configured root. Missing, excluded, duplicate,
outside-root or ambiguous declarations make the module checks unavailable before
execution. A module under a workspace must be a declared member to use that
workspace profile. Formatting remains a direct check of inventoried source.

The data lexer supports `//` comments, directive blocks, double-quoted paths,
JSON-compatible string escapes, `go`, `toolchain`, `godebug`, `use` and `replace`
workspace directives. Other escapes and workspace directives are unavailable.
Native Go still validates manifest syntax and module resolution. Static capture
does not establish that a dependency can be loaded or that project behavior is
correct.

All native commands for a selected module receive the same explicit `GOWORK`.
Existing build tags, declared exclusions, repetitions and host/foreign target
policies remain in effect. Native `go list` evidence must identify the selected
main module, module directory and `go.mod`, and exactly reconcile the selected
source files. Generated files are included unless an explicit profile excludes
them. Foreign compilation can pass; foreign tests require a separately configured
executor and remain unavailable here.

The whole-root source fingerprint includes local replacement source and
workspace/module policy files. Changes observed during validation make the report
incomplete. This is a local source binding, not an audit of external module-cache
contents. Summaries withhold workspace paths, module names and source. Detailed
plans and reports follow the existing source disclosure controls. Execution
requires operator trust through the shared CLI/library/MCP engine; a tool argument
cannot grant it.

`gate-go-extensions.test.ts` contains the nine finite original control names from
the required inventory: native broken/fixed behavior and generated diagnostics,
adjacent quoted paths/local replacements/ordinary and race tags, host and foreign
classification, prerequisites, stale capture, empty and forged accounting,
privacy/trust, reached lifecycle interruption and fresh offline installation.
The package harness installs only locked production dependencies without lifecycle
scripts and runs the same compiled assertions against the installed engine.
These are synthetic implementation controls; no model inference or field review
is involved. Required runtime receipts and broader Gate A obligations remain
separate from a source test pass.

Go workspace behavior is described in the
[official Go workspace tutorial](https://go.dev/doc/tutorial/workspaces) and
[module reference](https://go.dev/ref/mod#workspaces).

The finite required Linux ARM64 Node 22.23.2 source and fresh installed receipts,
exact image/tool identities and five original compiling mutation controls are
recorded in [go-workspaces-2026-10-08.json](measurements/go-workspaces-2026-10-08.json).
The inventory records this profile as implemented with declared receipts.
This does not freeze the inventory or close the broader runtime and provenance gates.
