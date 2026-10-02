# Pyright profile

`python.pyright` is an explicitly selected native analysis check. Discovery and
planning read file names and local installation paths; they do not run Pyright,
parse a Python package by importing it, or execute `setup.py`. Execution requires
operator trust through the shared library, CLI or MCP startup grant.

The current CLI and file-selection contract is pinned to Pyright **1.1.414**.
Other package versions are unavailable. Install the operator-selected compiler in
the project or an ancestor `node_modules` inside the configured root; an external
symlink or global installation does not satisfy this profile. Checktrail does not
install it. Node and Python interpreter identities accompany the compiler's local
package metadata. The comment-token helper uses Python's standard library with
`-I -S`; native Pyright also uses its own interpreter and environment resolution.
Those native tool/interpreter processes remain trusted execution.

```json
{
  "schemaVersion": 1,
  "projects": [{ "path": ".", "checks": ["python.pyright"] }]
}
```

A project-local `pyrightconfig.json` takes precedence over `pyproject.toml`.
JSON comments and trailing commas are parsed by the bundled TypeScript parser;
TOML is parsed by the pinned `smol-toml` dependency. The original configuration is
passed to Pyright, preserving relative import, interpreter, namespace-package,
stub and execution-environment settings. Config inheritance is inspected without
evaluation, stays inside the configured root, has no cycles and is limited to
16 documents of at most 1 MiB each. Malformed or escaping configuration is an
error. Only documented JSON/TOML inheritance is included in this profile.

Every inventoried `.py` and `.pyi` file in the selected project is an explicit
native argument. Filenames with newlines or native glob metacharacters are
unavailable. Pyright runs twice: verbose dependency/file-selection evidence,
then JSON diagnostics with warnings treated as failure. The planned source set,
native dependency entries, analyzed-file total, diagnostic severity counts and
both exit statuses must reconcile. Known entries in that exact compiler's
bundled standard-library stub directory, and exact `site-packages` directories
listed in native search-path sections, are accounted for separately. Other
unexpected project/dependency entries prevent clean completion. This does not
claim an exhaustive runtime import graph.

Suppression handling is deliberately conservative. An `ignore` list, disabled
type checking or unannotated-function analysis, an explicitly disabled
`report...` diagnostic in any inspected configuration or execution environment,
or a real source comment containing a suppression prevents a clean pass, including
a directive following another `#` in that comment.
Configuration inheritance containing such a setting remains incomplete even
when a later document may override it; effective-rule exceptions are not yet
verified. Python comment tokens distinguish a directive from text in a string.
Only plain `# pyright: basic`, `standard` or `strict` mode comments pass this
control; other Pyright directives and `# type: ignore` comments require further
suppression evidence. This profile does not certify a suppression's necessity or
staleness. Suppressed or excluded files, missing native names, an empty analysis,
malformed output and irreconcilable counts never count as passing.

Native errors and warnings become findings at their actual source and line.
Information remains a note and does not fail a check. A failure can retain
diagnostics while marking their set incomplete. This is native type/syntax
evidence; it does not verify an advisory model claim or assign calibrated
review confidence.

The runner bounds each native output at 1 MiB and each inner invocation at 60
seconds; the enclosing operator-selected validation timeout/output budget can
stop it earlier. It requests neither emitting code, stub installation, watches
nor worker threads. Existing source and cache files are preserved in the named
acceptance controls. Interpreter/tool initialization and third-party code
selected by configuration are executable, so this is not an OS containment
guarantee. Native Windows cancellation remains a separate required gate.

The `pyright` required-test profile contains original synthetic controls for
planning/trust, exact file accounting, JSON/TOML settings, namespace modules and
stubs, broken/fixed types and syntax, suppressions, exclusions, missing imports,
virtual-environment resolution, invalid/cyclic/escaping configuration, unsupported
compiler versions and matching library/CLI/MCP findings. Run the compiled suite
with `node scripts/verify-required-native-tests.mjs pyright` after preparing the
pinned compiler. `CHECKTRAIL_PYRIGHT_PACKAGE` selects that prepared package only
for acceptance fixtures; it does not configure the product's tool selection.

`scripts/pyright-tools.Dockerfile` pins the Linux Node/Python runtime images.
`scripts/verify-pyright-container.mjs` requires an already prepared image and
compiler, mounts the checkout and compiler read-only and uses no container
network. The test fixtures themselves are writable, temporary and removed.
Installed production-package smoke explicitly reports an unavailable Pyright
profile when no prepared tool is supplied; it never silently reports that check
as passing.

The [dated synthetic measurement](measurements/pyright-native-2026-10-01.json) binds
the tested source, compiler integrity, named macOS/Linux profiles, restored guard
mutations and offline installed-package surfaces. It does not establish reviewer
quality or promote other platform/tool configurations.

The contract follows the primary [Pyright CLI documentation](https://github.com/microsoft/pyright/blob/1.1.414/docs/command-line.md)
and [configuration documentation](https://github.com/microsoft/pyright/blob/1.1.414/docs/configuration.md).
The CLI's [versioned implementation](https://github.com/microsoft/pyright/blob/1.1.414/packages/pyright-internal/src/pyright.ts)
defines the native JSON fields and exit codes; these controls check both.
