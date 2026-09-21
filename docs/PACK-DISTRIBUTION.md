# Pinned policy pack downloads

`fetch-pack` explicitly downloads one data-only JSON policy pack from an
operator-supplied HTTPS endpoint. It verifies the exact bytes against a separately
trusted SHA-256 digest and validates the policy before making a local file
available. Planning, validation and MCP do not download packs automatically.

```sh
repo-verifier fetch-pack --root /path/to/project \
  --url https://policies.example.org/checks/core-1.0.0.json \
  --sha256 REPLACE_WITH_TRUSTED_64_CHARACTER_SHA256 \
  --output policies/core-1.0.0.json
```

This fictional URL and digest placeholder must be replaced. The parent directory
must already exist under the selected root. The destination must be a normalized
relative `.json` path; symbolic-link directories and existing destinations are
rejected. The command returns pack identity, byte count and a `reference` object
that can be added to a project's `packs` array in `repo-verifier.json`. It does not
edit project policy or activate the downloaded checks.

Library consumers can call:

```js
import { fetchPolicyPack } from "@stsepelin/repo-verifier";

const downloaded = await fetchPolicyPack(projectRoot, {
  url: endpoint,
  sha256: expectedDigest,
  output: "policies/core-1.0.0.json",
  timeoutMs: 30_000,
  signal: controller.signal,
});
```

The digest establishes content integrity, not authorship. Obtain it through a
trusted release or review process independent of the endpoint being checked.
Updates require a new download destination and an explicit policy reference
change. Unknown or inapplicable check IDs are rejected when the project resolves
the downloaded pack, since downloading alone has no execution context.

## Transport and storage

The downloader sends a GET to the exact configured HTTPS endpoint, without a
request body, authorization header, cookie, source file or project metadata.
It uses Node's certificate/hostname verification and supports the operator's
Node CA configuration. Certificate verification cannot be disabled by its options.
Only HTTP 200 is accepted. Redirects are not followed, so the endpoint must serve
the bytes directly. Encoded/compressed responses are rejected; the digest covers
the received representation. Bodies are bounded to 64 KiB and response headers
to 16 KiB. The total network deadline defaults to 30 seconds and permits at most
120 seconds. SIGINT/SIGTERM or a library abort signal cancels an active transfer.

URLs with user information or fragments are rejected. Signed query URLs can be
used for private distribution, but command arguments may be visible to other
local processes and URLs may appear in endpoint logs. The library avoids putting
such a URL in CLI arguments. Returned metadata and normal download errors omit
the endpoint and its response body. There is no credential store, token refresh,
registry lookup or publisher-signature system.

After transfer, the downloader checks the raw-byte digest, strict UTF-8, JSON
schema and duplicate requirements. A leading byte-order mark is rejected to match
the offline pack loader. It writes a private temporary file, syncs it and uses an
exclusive hard link to publish complete bytes. Existing files—including a file
created during the download—are never replaced. Temporary files are removed in
normal completion and handled failure/cancellation. The destination has mode 0600.

This requires a filesystem supporting hard links. Power-loss durability, cleanup
after a process crash and containment of hostile concurrent filesystem changes
are not guaranteed. The operator must trust the local destination environment.
No downloaded code is executed by this operation. Executable external adapter
distribution is separate; its local registration contract is documented in
`EXTERNAL-ADAPTERS.md`.

## Reproduce verification

```sh
npm run build
node --test dist/test/fetch-pack.test.js
```

The tests require an installed `openssl` command to generate an ephemeral original
certificate. They use an in-process loopback HTTPS server and explicitly trust
that certificate in child clients through `NODE_EXTRA_CA_CERTS`. The untrusted
certificate case must fail; production verification is never disabled. Tests
exercise exact bytes, offline composition, malformed UTF-8/JSON, duplicate
requirements, redirects, non-success status, body limits, truncated responses,
timeouts, cancellation, output boundaries and simultaneous publication. Manual
guard mutations confirmed that removing digest verification is caught, and replacing
exclusive publication with an overwriting rename causes both competing writers to
succeed and fails the race regression. The original guards were restored and the
tests passed again.

`scripts/verify-external-container.mjs` also runs these cases on Node 22 in the
pinned Linux PHP/OpenSSL container, with external networking disabled. It repeats
the CLI/library downloads against a fresh offline package installation. The local
server remains reachable over container loopback. Hosted CI and a production
private endpoint are separate, unverified deployment environments.
