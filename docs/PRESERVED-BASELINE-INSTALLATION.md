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

Existing CI source commands should be wrapped with
captureBaselineSourceExecution, whose execution callback is called once.
It preserves the entire original source report and validates every broader
required case before projecting the frozen subset. The
fresh-from-original-source worker mode then validates that capture and runs
only the fresh installed subset. Its source expectation must come from the
controller's current selectors, independently of the receipt.

PR205 full-suite source fragments deliberately report complete: false,
fragmentComplete: true, and wholeSuiteComplete: false. Reuse validates those
flags and the actual partition, inventory, file and required-case bindings;
it does not rewrite a fragment as whole-suite success. All three original
source fragments and the full frozen callback union remain obligations.
The APIs provide the shared mechanism; each existing controller still needs
an explicit adapter and actual source/fresh observations before qualification.

The selected Linux/Node 22 host path wraps each existing full-suite source
fragment before it executes. It derives the frozen subset from the same closed
file partition independently of the observed result, validates the original
source ledger, then runs only that subset against one fresh offline installation.
Every fragment retains `complete: false`, `fragmentComplete: true` and
`wholeSuiteComplete: false`. All three existing rows remain required; no individual
receipt qualifies the host cohort. The selector verifies that the three expected
subsets preserve the entire frozen callback union and all profile memberships.
Full source/fresh receipts are retained separately on stderr while the original
source report remains on stdout.

The packaged-review path captures the existing broader source command inside its
original pinned image. It reuses the controller's existing fresh installation for
the frozen review subset, in a separate process using the same image ID and
observed runtime. The shared fresh coordinator never executes source callbacks;
it cleans its harness and private input even when admission or a worker fails.
The original package CLI and MCP checks continue against that installation.
