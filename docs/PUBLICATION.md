# First public release

The maintainer authorizes publication separately from preparing this checkout.
Repository and package names in metadata are intended destinations, not claims
that those resources already exist.

Before release:

1. Confirm namespace availability and MIT licensing for the original contribution.
   Audit dependencies and any future imported rules under their own licenses.
2. Review all public files and history. Examples must be synthetic; private source,
   internal paths, customer data and raw validation reports must remain private.
   A keyword or secret scan is supporting evidence, not proof of anonymization.
3. Run the CI toolchain matrix and reconcile every skipped/unavailable check with
   the support matrix. Verify actual target clients in addition to SDK tests.
4. Build, inspect `npm pack --dry-run`, install the tarball into a fresh temporary
   project and run its CLI/MCP smoke tests. Inspect exported type declarations too.
5. Configure repository protections, required checks, dependency updates and private
   vulnerability reporting. Keep workflow permissions minimal; do not execute
   untrusted pull-request code with release credentials.
6. Set up scoped package publishing with provenance and restricted credentials,
   document the concrete release, then obtain maintainer authorization to publish.
7. Publish accurate capability and compatibility tables. Mark adapters experimental
   until their native toolchain evidence and supported platform matrix are complete.

Public issue examples should be independently reproducible without access to any
private organization. Private deployments may share aggregate quality measurements
without sharing repositories, findings or source fragments.
