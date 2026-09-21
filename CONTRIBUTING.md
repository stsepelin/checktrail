# Contributing

Read `docs/ARCHITECTURE.md` and `docs/LANGUAGES.md` before changing engine contracts.
Use Node 22+ and `npm ci --ignore-scripts`. Run `npm run check` and
`npm run format:check`; invoke the binaries in `node_modules/.bin` directly if a
package-manager wrapper cannot start. The local HTTPS distribution tests require
`openssl` to generate ephemeral test certificates. Report which native toolchains
were exercised. Run the corresponding [required native profile](docs/NATIVE-CI.md)
when its tools are prepared. Review the profile manifest when renaming or replacing
a required regression; skipped or missing native tests cannot satisfy CI.

## Rules and adapters

Propose the failure mechanism, applicability and expected evidence before adding
a matcher. Include broken/fixed/near-miss fixtures. Check normalized identifiers,
boundary values and unsupported output. Never let parse failures fall back to pass.
Document tool versions and platform coverage. Do not infer semantic support from
a manifest or extension. Update the language matrix and implementation status.

Keep native commands as argument arrays and use the shared runner. Do not execute
repository code during discovery. Treat plugins as executable code, not passive
configuration. Preserve operator-controlled trust and output settings.
The executable extension protocol and original example are documented in
`docs/EXTERNAL-ADAPTERS.md`; bundled files require explicit digests and license
review. A protocol-conforming adapter still needs native regression evidence.

## Public examples

Write small fictional examples from scratch. Do not copy private source and rename
identifiers. Do not submit credentials, internal hostnames, paths, incident reports,
customer data or proprietary repository snapshots. Verify fixture licensing and
provenance. Keep raw private test reports out of issues and pull requests.

## Scope and review

Separate behavior changes from dependency updates. Explain what a passing result
proves and what remains unverified. A test that merely matches the implementation
is insufficient: identify the regression it prevents. Changes to result semantics,
configuration schemas or protocol behavior require migration notes and tests.

The maintainer controls releases. Do not publish packages, register remote services
or create release tags as a side effect of development automation.
