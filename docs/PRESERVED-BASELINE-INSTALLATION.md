# Preserved baseline source and installed cohorts

`scripts/verify-preserved-baseline.mjs` collects the original callback addresses
in `docs/gate-a-native-baseline.v1.json`. It adds an installed-engine completion
binding to existing source environments; it does not replace their source
commands or create an obligation to run every baseline profile in every matrix
slot.

The finite applicability map is
`scripts/preserved-baseline-cohorts.v1.json`. Its source commands and selectors
describe the existing environments. Currently the shared collector implements
`host-core` and `packaged-review`. Other mapped native families refuse collection
until their existing controller adapter is implemented. Pyright remains owned
by its separate source/installed controller.

After building a clean recorded checkout and preparing the existing job's
dependencies, run one applicable cohort:

```sh
node scripts/verify-preserved-baseline.mjs host-core
node scripts/verify-preserved-baseline.mjs packaged-review
```

`host-core` requires the existing Linux Node 22 environment and pinned compiler
and analyzer selections. `packaged-review` uses the existing review image,
resolves its actual immutable image ID, and runs both phases with that ID.
The production package is packed and installed offline on the host because the
review image contains Node without npm. No image is pulled or built by this
collector.

Each phase runs in an independent process. The selected union of `(file, name)`
addresses executes once per phase; overlapping profile memberships remain in
the receipt. A separate external fixture harness retains original compiled
callback bytes and uses the real production installation for `dist/src`.
Fixture development dependencies remain external. Only tracked public inputs,
compiled tests, and explicitly named prepared tool directories enter the
harness; ignored private `.checktrail` output is not copied.

The collector checks callback and engine bytes before and after execution,
observes the Node executable and declared tool bytes and versions, and rejects
a source-engine fallback or a changed runtime. Source and fresh phases must both
retain complete terminal events. Missing tools, an inapplicable runtime, empty
selection, all-skipped cases, stale bytes, or an incomplete cohort fail
collection. Owned containers are removed even after a worker timeout.

The physical check binds the configured engine root. It is not a trace of all
modules loaded, a capture of every dependency byte, an upstream producer build,
or an image recipe attestation. A successful receipt qualifies only its
explicit profiles and observed environment. Unit controls using a synthetic
package do not qualify the native cohorts. This helper does not declare the
whole matrix or Gate A complete and performs no model calls or field reviews.
