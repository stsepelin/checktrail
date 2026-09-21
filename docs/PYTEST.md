# Pytest validation

Select `python.pytest` explicitly. The `python3` executable on the operator's
PATH must have pytest installed. Activate the prepared virtual environment before
starting the CLI or MCP server. Validation never installs packages or activates
an environment automatically. Planning does not import `conftest.py`.

Candidate files are `test_*.py` and `*_test.py`, assigned to their discovered
project. Each is passed explicitly to pytest. A verifier plugin records collected
IDs, their actual file paths, deselection and native setup/call/teardown reports.
Passing requires exact file accounting and completed lifecycle events for every
collected test, with at least one non-skipped pass. Empty files, deselection,
missing events, repeated phases, unknown IDs and malformed output are incomplete.
Assertion, collection/import, fixture and teardown failures fail. Unexpected
passes also fail, even with a local `xfail(strict=False)` marker.

Project `addopts` and inherited `PYTEST_ADDOPTS` are not applied: these can select
only part of the suite or collect without running it. Plugins and other native
configuration remain active. Configured addopts for coverage, distributed tests
or other options therefore need a future explicit adapter contract. Custom
filename conventions, retries, xdist, subtests and doctests are not verified.
The cache provider and bytecode writing are disabled. Trusted hooks and tests can
still write files and access the network; this is not a sandbox.

Native cases passed with pytest 9.1.1 and Python 3.12.13 in an official Linux
container, with network access disabled and synthetic source mounted read-only.
The host's default Python has no pytest, so the ordinary host suite explicitly
skips the native case; parser and planning tests still run. The CI definition
installs pinned development tools before tests. The hosted profile passed at
`52ba415`; see `NATIVE-CI.md`.

For the separate container check, prepare dependencies deliberately before
validation (requires an already installed `python:3.12-alpine` image):

```sh
mkdir -p .repo-verifier/python-tools
docker run --rm \
  --mount "type=bind,src=$PWD,target=/repo,readonly" \
  --mount "type=bind,src=$PWD/.repo-verifier/python-tools,target=/tools" \
  python:3.12-alpine python3 -m pip install --no-cache-dir --target /tools \
  -r /repo/scripts/python-tools.requirements.txt
npm run build
node scripts/verify-python-container.mjs
```

Preparation downloads development dependencies; the verification script only
uses those prepared files and an inspected local image digest. This shim is a
development check, not a Docker execution mode in the verifier. Top-level tool
versions are pinned; transitive Python dependency hashing remains release work.

The plugin uses documented [pytest hooks](https://docs.pytest.org/en/stable/reference/reference.html#hooks).
