# Pinned executable bundle distribution

`fetch-adapter` and `fetchExternalAdapter` download one opaque executable bundle
over HTTPS. They check the separately supplied SHA-256 digest, embedded manifest
and every artifact before publishing one complete private file. Downloading does
not register checks, load modules, evaluate a manifest or execute an adapter.
Registration and trusted execution remain separate operator actions.

```sh
checktrail fetch-adapter --root /path/to/local/storage \
  --url https://adapters.example.org/releases/checks-1.0.0.bundle.json \
  --sha256 REPLACE_WITH_SEPARATELY_TRUSTED_64_CHARACTER_SHA256 \
  --output checks-1.0.0.bundle.json
```

The endpoint and digest above are placeholders. The storage directory and any
parent output directories must exist. Output is a normalized relative path ending
in `.bundle.json`; symbolic-link parents and existing destinations are rejected.
The command returns identity, encoded/decoded byte counts, artifact count, the
embedded manifest digest and an absolute `reference`. `activated` and
`codeExecuted` are false. It neither edits policy nor installs dependencies.

```js
import { fetchExternalAdapter } from "@stsepelin/checktrail";

const downloaded = await fetchExternalAdapter(storageRoot, {
  url: operatorEndpoint,
  sha256: separatelyTrustedDigest,
  output: "checks-1.0.0.bundle.json",
  timeoutMs: 30_000,
  signal: controller.signal,
});
```

Use the returned `reference.path` and `reference.sha256` only after reviewing the
adapter, its native acceptance and required tools/licenses. A digest identifies
bytes; it does not authenticate a publisher, establish correctness or grant
execution permission. There is no credential store, token refresh, publisher
signature, marketplace, registry lookup or automatic update.

## Format and identity

The strict version-1 `schemas/executable-bundle.schema.json` describes one JSON
object with `schemaVersion: 1`, `kind: "checktrail-executable-bundle"`,
`manifestBase64` and `files`. `manifestBase64` is canonical base64 of the exact
UTF-8 external-manifest JSON bytes. Each file is `{ path, base64 }`, with a
normalized relative path and canonical base64 of the exact artifact bytes.
Native binaries are opaque bytes; no text transformation is applied. The embedded
manifest uses the existing [external adapter contract](EXTERNAL-ADAPTERS.md).

Every declared artifact must occur exactly once, with no undeclared payloads.
Every decoded artifact must match its manifest SHA-256, including artifacts other
than the executable entry. Entry, markers, check IDs and scope declarations retain
the existing uniqueness/nonempty requirements. File/directory prefix collisions
such as `lib` and `lib/data` are rejected. Absolute, escaped, non-normalized,
control-character and backslash paths cannot enter the bundle. It contains no
archive link entries or extraction instructions.

The outer file is bounded to 192 MiB, the decoded manifest to 256 KiB, each artifact
to 32 MiB, all decoded artifacts to 128 MiB and the list to 512 files. These are
representation limits, not a measured heap-memory ceiling. Outer JSON requires
valid UTF-8 and rejects a leading byte-order mark. Invalid encoding, schema,
declarations and artifact integrity use a fixed diagnostic that omits private
manifest/body text.

The reference and reported adapter identity pin the **whole opaque bundle**.
`manifestSha256` separately identifies its embedded manifest. Neither is an
authentication proof. A `.bundle.json` registration first validates packed content;
an existing loose manifest using that suffix retains the original strict 256 KiB
manifest and per-file verification contract. Other filenames retain loose-manifest
registration. A packed bundle must therefore use `.bundle.json` when registered.

## Transport and publication

The shared pinned downloader sends a GET to the exact configured HTTPS URL, with
no request body, authorization header, cookie, source or project metadata. Node's
certificate/hostname verification stays enabled and accepts operator CA settings.
Only HTTP 200 and identity content encoding are accepted; redirects are rejected.
Response headers are bounded to 16 KiB. The deadline defaults to 30 seconds and
permits at most 120 seconds. SIGINT/SIGTERM or a library abort signal cancels the
transfer. User information and fragments are rejected. Query URLs are supported;
the operator must account for endpoint logs and visibility of CLI arguments.
Returned metadata and normal errors omit URLs and response bodies.

Only after complete transfer and all verification does the downloader create a
private temporary file under the destination's parent, write/sync/close it and
publish with an exclusive hard link. The destination has mode 0600. A destination
created during transfer is preserved. Simultaneous publishers admit at most one
complete result. Handled failures and cancellation remove owned staging files.

This requires a filesystem supporting hard links. Power-loss durability, cleanup
after a process crash and hostile concurrent filesystem containment are not
guaranteed. Local filesystem privileges remain the operator's responsibility.
No multi-file loose installation or partial dependency resolution is performed.

## Explicit registration and execution

```sh
checktrail plan --root /path/to/project \
  --adapter /path/to/local/storage/checks-1.0.0.bundle.json#sha256=TRUSTED_DIGEST
checktrail run --root /path/to/project --trust-project \
  --adapter /path/to/local/storage/checks-1.0.0.bundle.json#sha256=TRUSTED_DIGEST
checktrail serve --root /path/to/project --allow-execution \
  --adapter /path/to/local/storage/checks-1.0.0.bundle.json#sha256=TRUSTED_DIGEST
```

Replace the placeholders with the verified reference. CLI startup or library
`externalAdapters` registers checks. Planning reads and verifies bytes without
executing code. MCP registration and execution permissions remain startup-only;
tool arguments and repository configuration cannot grant either. There is no MCP
download tool. `fetch-adapter` rejects execution and registration flags.

Trusted execution reuses the existing shared external runner. It verifies bundle
bytes again, materializes verified copies into owned temporary storage and invokes
the declared Node/Python/PHP/native runtime. Existing scope, findings, native test
accounting, summaries, source invalidation, cancellation and cleanup contracts
apply. The adapter runs with the process user's privileges; this is not a sandbox.
Installed runtime/tool dependencies and adapter correctness remain separate.

## Acceptance and limits

The [source-bound local measurement](measurements/executable-bundle-2026-10-05.json)
records original synthetic native Node, Python, PHP and compiled Go controls on a
pinned Linux arm64 image, with external networking disabled and read-only source
or consumer mounts. Required cases cover broken/fixed/CRLF inputs, no automatic
activation or trust, exact binary bytes, CLI/MCP agreement, tampering, duplicates,
path/link/overwrite boundaries, endpoint/body privacy and concurrent publication.
Cancellation is armed only after the loopback HTTPS request reaches the server;
the control requires a cancellation diagnostic rather than accepting a timeout.
The existing loose-manifest and data-only policy-download profiles are also required.

A fresh offline production installation repeats packed runtime and CLI/MCP cases
against shipped bytes. Its official SDK client and locked dependency closure are
separate acceptance-harness material; production dependencies are not expanded.
Compiling guard mutations test integrity, collisions, duplication, private parsing,
exclusive publication, cancellation and certificate verification before restoration.

```sh
npm run check
docker build --file scripts/executable-bundle-tools.Dockerfile \
  --tag checktrail-executable-bundle-test:1 scripts
docker run --rm --network none --cpus 2 --memory 2g \
  --mount "type=bind,src=$PWD,target=/workspace,readonly" --workdir /workspace \
  checktrail-executable-bundle-test:1 node scripts/verify-required-native-tests.mjs executable-bundle
docker run --rm --network none --cpus 2 --memory 2g \
  --mount "type=bind,src=$PWD,target=/workspace,readonly" --workdir /workspace \
  checktrail-executable-bundle-test:1 node scripts/verify-required-native-tests.mjs executable-bundle-interpreters
CHECKTRAIL_EXECUTABLE_BUNDLE_IMAGE=checktrail-executable-bundle-test:1 \
  node scripts/verify-executable-bundle-package.mjs
```

Image preparation may access the network; acceptance uses only synthetic loopback
HTTPS. `openssl` generates an ephemeral original certificate explicitly trusted by
the test clients; the untrusted certificate must fail. Hosted CI, Windows, other
runtime/platform profiles, a real private endpoint, full component artifact/license
audit and peak memory have not been established by this slice. Gate A remains open;
no inference, real-project MCP field review or reviewer-quality result is claimed.
