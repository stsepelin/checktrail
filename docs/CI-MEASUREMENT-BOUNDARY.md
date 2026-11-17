# Documentary measurement CI boundary

The CI selector treats these reviewed public JSON records as documentary data:

- `docs/measurements/glibc-u13-original-producer-2026-11-17.json`
- `docs/measurements/sdk4-fork-original-notice-preservation-2026-11-17.json`
- `docs/measurements/temurin25-original-producer-2026-11-17.json`

Changes to these exact paths retain complete shared control tests. Any native
jobs recorded as consumers in the generated input contract are also required.
Input traversal follows literal references to these records, so a native harness
that begins consuming one must regenerate the contract and retains its job on
later record changes. The records do not grant execution trust or qualify an
upstream build, test result, or Gate A by being classified as data.

This is an explicit file boundary, not an exemption for documentation JSON.
Unknown records, execution inventories, adjacent names, invalid paths, stale
contracts and unsupported events retain full verification. The existing
artifact-identities directory keeps its complete artifact audit and native
signature-input consumers. Adding another documentary record requires a reviewed
selector change and regression cases.
