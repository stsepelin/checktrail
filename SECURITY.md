# Security and data handling

Checktrail is an experimental local tool, not an execution sandbox or a security
certification. Run project checks only on source you trust or inside a separately
configured isolated environment.

## Boundaries

- Discovery reads files within the configured root without importing project code.
- Known checks use executable/argument arrays rather than shell commands.
- Execution requires a CLI flag or a server startup flag, never a tool argument.
- Child processes receive a small environment allowlist (PATH, HOME, temporary
  directory and locale variables) plus fixed adapter settings. They still have
  access to the user's filesystem and any network permitted by the host.
- POSIX process groups are killed on timeout/cancellation. Malicious code can
  detach from a group; process groups are not a containment boundary.
- Inventory does not follow symlinks, and resolved working directories must remain
  under the configured root. Concurrent filesystem replacement can race inspection;
  only operating-system isolation can contain adversarial filesystem mutation.
- External adapters are trusted executable dependencies registered by the operator.
  SHA-256 pins verify declared bytes, not their author or correctness. Only listed
  files are copied; imported system dependencies and invoked tools are not thereby
  pinned. Adapter code retains filesystem/network privileges and can fabricate
  evidence. See `docs/EXTERNAL-ADAPTERS.md`.
- Source fingerprints cover the documented inventory, not the entire build world.

## Output

The engine contains no telemetry or upload client. The explicit `fetch-pack`
CLI/library operation sends a bounded HTTPS GET to an operator-selected endpoint;
validation and MCP never invoke it automatically. Signed endpoint URLs may carry
credentials, so avoid exposing them in shell history or shared process arguments. Invoked programs may contact
services or send data independently. Summary MCP output excludes paths, commands,
source excerpts and raw logs; it still reveals check IDs, status and test counts.
Detailed mode exposes diagnostics and may disclose source or secrets. An MCP client
may forward received output to a cloud provider.

There is no claim that secret-name exclusions identify every secret. Protect the
whole repository and report store. Public packages must contain only synthetic
examples and reviewed files. The package allowlist excludes local reports and tests.

## Reporting

Use [GitHub private vulnerability reporting](https://github.com/stsepelin/checktrail/security/advisories/new).
The reporting channel is enabled for this repository. Do not put secrets or
exploitable private deployment details in a public issue.
