# Mypy validation

Select `python.mypy` explicitly. The operator's `python3` must have mypy 2.3.1
installed. Other versions are unavailable until verified: this adapter uses the
native options API to detect per-module `ignore_errors`, in addition to the
documented `mypy.api.run` entry point. Missing tools never trigger installation.
Planning does not import mypy, plugins or project modules.

The check passes all inventoried `.py` and `.pyi` files explicitly, records native
source resolution, and reconciles the success summary with the complete planned
file set. Global or effective per-module `ignore_errors` prevents passing. Errors
fail; incomplete or unfamiliar output cannot pass. Unused inline ignore comments
are reported, and untyped function bodies are checked. This is not strict mode:
other rule exclusions and valid inline ignores follow the native configuration.

Configuration is selected from project-local `mypy.ini`, `.mypy.ini`,
`pyproject.toml` or `setup.cfg` in that order; without one the adapter uses an
empty configuration. Parent/home settings are not loaded implicitly. Workspaces
requiring external configuration need a future explicit policy option. Paired
implementation/stub modules, namespace layouts and imported dependency coverage
need their own integration fixtures; a duplicate-module error is not waived.

Incremental reuse, cache writes and stub installation are disabled. Existing
cache files are preserved. Trusted plugins and explicitly configured report
generators can still have side effects. This is not a sandbox. Source mutation
remains subject to the engine's post-run fingerprint check.

Native tests passed with mypy 2.3.1 and Python 3.12.13 in a prepared Linux
container. They exercise valid annotations, incompatible assignments, global and
module-specific broad suppression, missing imports, unused ignores, configured
stub installation prevention and cache preservation. The host lacks this mypy
version, so its native test skips explicitly. The separate
[Python container checks](PYTEST.md) reproduce these cases with no network and
read-only synthetic source.

See the official [mypy command-line reference](https://mypy.readthedocs.io/en/stable/command_line.html)
for native checking and installation options.
