# Trusted external adapters

An operator can register a local executable bundle without modifying the engine.
The bundle declares discovery markers, scoped checks and SHA-256 hashes for each
file it needs. Registration reads and verifies metadata without executing the
adapter. Running it requires the same trust permission as built-in checks.

This is a local extension protocol, not a plugin marketplace or sandbox. A digest
identifies bytes; it does not authenticate an author, prove an analysis correct or
pin system libraries and tools. A trusted adapter can fabricate protocol evidence.
Review its implementation, licenses and native regression cases before using it.

## Try the original example

From a built checkout, compute the digest of the exact manifest bytes:

```sh
adapter_manifest="$PWD/examples/external-adapter/bundle/adapter.json"
adapter_digest=$(shasum -a 256 "$adapter_manifest" | cut -d ' ' -f 1)
node dist/src/cli.js plan --root examples/external-adapter/project \
  --adapter "$adapter_manifest#sha256=$adapter_digest" --detailed
node dist/src/cli.js run --root examples/external-adapter/project \
  --adapter "$adapter_manifest#sha256=$adapter_digest" --trust-project --detailed
node dist/src/cli.js serve --root examples/external-adapter/project \
  --adapter "$adapter_manifest#sha256=$adapter_digest" --allow-execution
```

The example checks trailing spaces and tabs in text files. Its manifest includes
the original implementation and its MIT license. These examples are checkout
assets, not files installed by the npm package. For an independently obtained
bundle, compare its digest against a separately trusted value; computing a hash
of an unreviewed download does not establish trust.

`--adapter` can be repeated. Library callers pass
`externalAdapters: [{ path: absoluteManifestPath, sha256: expectedDigest }]` to
`createPlan` or `validate`; validation also needs `trusted: true`. MCP registration
is startup-only. A tool argument or repository configuration cannot add adapters
or grant execution permission. Project policy may select already registered check
IDs such as `external.example-lines.whitespace`. The registered manifest identities
contribute to the policy fingerprint. External registration conservatively disables
Git narrowing because the engine cannot establish an external tool's impact model.

## Bundle contract

The generated schemas are `schemas/external-manifest.schema.json`,
`external-reference.schema.json`, `external-request.schema.json` and
`external-result.schema.json`. Runtime validation also enforces cross-field
constraints such as uniqueness, test accounting and exact scope matching.

Manifest version 1 declares:

- `id`: `external.` followed by a lowercase name; `version`: a version string.
- `runtime`: `node`, `python3`, `php` or `native`; `entry`: a listed relative file.
- `files`: normalized relative paths and lowercase SHA-256 digests.
- `markers`: exact file basenames identifying project roots.
- `checks`: unique IDs, descriptions, kind (`analysis`, `syntax`, `format`, `test`),
  failure level (`error` or `warning`), and filename/suffix scope selectors.

Check IDs are the adapter ID plus `.` plus the declared check ID. Scope selectors
form a union over inventoried files assigned to the closest detected project root.
They are case-sensitive exact basenames or literal suffixes, not glob patterns.
The shared inventory exclusions apply. An empty selected scope is unavailable.

Manifest and declared files must be regular files. Bundle file paths cannot escape
the canonical bundle directory or traverse symbolic links. The manifest cannot
include itself. Only declared, verified bytes are copied into a temporary bundle;
unlisted files are neither hashed nor copied. Relative imports must refer to files
included in the bundle. Python isolated mode does not automatically put the bundle
directory on the import path; adapters needing bundled modules must load them
explicitly. Nothing prevents trusted code from reading additional external files.

## Invocation and evidence

The adapter runs with the discovered project as its working directory. Its sole
application argument is the path to a JSON request. Node uses the current Node
executable; Python uses `python3 -I -B`; PHP uses `php -n`; native execution uses
the copied entry with executable permissions. Python's
[isolated mode](https://docs.python.org/3/using/cmdline.html#cmdoption-I) controls
startup/import behavior and is not operating-system isolation.

The request contains `protocolVersion: 1`, canonical `root`, relative `project`,
adapter `identity`, `runtime`, `checkId`, `kind`, `failOn`, project-relative `scope`
and `sourceFingerprint`. stdout must contain exactly one result JSON object:

```json
{
  "protocolVersion": 1,
  "identity": {
    "id": "external.example",
    "version": "1.0.0",
    "sha256": "<manifest digest>"
  },
  "checkId": "external.example.whitespace",
  "sourceFingerprint": "<request fingerprint>",
  "files": [{ "path": "value.txt", "status": "checked" }],
  "findingsComplete": true,
  "findings": [],
  "tools": [{ "name": "example-checker", "version": "1.0.0" }]
}
```

The placeholders above must be replaced with the request's actual digests. Results
must echo the identity, check ID and source fingerprint and account for every
planned file exactly once. File statuses are `checked`, `skipped` and `unavailable`.
Diagnostics have `ruleId`, `level`, `message` and optional scoped `file`/`line`.
The engine prefixes rule IDs with the full check ID and converts finding paths to
root-relative paths. Unknown fields, unplanned files, omissions, duplicates and
contradictory evidence cannot pass.

Test checks require per-file `tests: { total, passed, failed, skipped }`. Counts
must reconcile; empty, all-skipped or partly skipped files are incomplete. Other
check kinds must not include test counts. Exit 1 must agree with failed tests or
diagnostics at the declared failure level. Exit 0 must agree with their absence.
Other exits are errors. A known failure can coexist with incomplete coverage;
`findingsComplete` preserves that distinction. stderr is retained as bounded
detailed process evidence and is not itself a diagnostic protocol.

Delegated tool identities have `source: "adapter-reported"` in detailed reports.
They are not independently attested. The engine separately probes supported
interpreter versions and reads the pinned manifest version without executing the
adapter for its version probe. Default summaries omit bundle paths, delegated
metadata, raw output and source paths; check IDs and outcomes remain visible.

## Execution limits and cleanup

Registration allows at most eight bundles. Each manifest is at most 256 KiB;
each bundle lists at most 512 files, 32 MiB per file and 128 MiB combined. A manifest
has at most 32 markers and 32 checks. A check has at most 20,000 scoped files and a
100 KiB serialized invocation. Results have at most 2,000 findings and 32 tools;
combined child stdout/stderr is bounded to 1 MiB. Shared runner limits can make a
large encoded result incomplete before these individual maxima are reached.

The shared runner applies its timeout, output bound and POSIX process-group
cancellation. It owns the temporary directory and removes it after the child closes,
including after cancellation kills the wrapper. This does not guarantee cleanup
after an engine crash or prevent malicious processes from detaching. The engine
checks inventoried source and pinned bundle contents before and after execution.
Ignored dependencies, transient restored modifications and external services remain
outside that fingerprint. Concurrent adversarial changes require OS isolation.

External code inherits the narrow runner environment plus operator-authorized
variables. `PATH`, `NODE_OPTIONS` and the owned temporary-directory setting are
protected from project environment overrides. No dependency installation, download
or network isolation is supplied by this protocol.

## Reproduce verification

```sh
npm run check
docker build --file scripts/external-tools.Dockerfile \
  --tag checktrail-external-test:1 scripts
node scripts/verify-external-container.mjs
```

The helper requires Docker and an npm cache prepared by dependency installation.
Image preparation may access the network; verification containers use
`--network none` and read-only checkout/installed-package mounts. The separate
PHP image and the build stages are pinned by digest in the helper/Dockerfile.

Verified profiles are macOS Node 26.8.1, Python 3.9.6 and compiled Go 1.27.1, and
Linux arm64 Node 22.23.2, Python 3.12.13, Go 1.26.5 and PHP 8.5.6. The native fixture
is compiled from the original `examples/external-adapter/native/adapter.go`.
Tests exercise actual broken/fixed whitespace, a CRLF near miss, bundle tampering,
scope/result contradictions, trust boundaries, startup-only MCP registration and
child cancellation with cleanup. Removing the file-count reconciliation guards
was manually verified to produce a false pass caught by the accounting regression;
the guards were restored before the final passing runs. The helper also verifies a fresh offline package
through the library, CLI and MCP. These checks establish this protocol's behavior;
they do not establish arbitrary adapter correctness or Windows support. The
separate hosted Linux job passed at `52ba415`; see `NATIVE-CI.md`.
