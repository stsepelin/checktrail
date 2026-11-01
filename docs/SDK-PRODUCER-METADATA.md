# SDK producer source metadata

The operator-only preparation modules under `scripts/producer-qualification/`
retain public upstream metadata as inert bytes. They do not initialize an AI
client, run a project, evaluate upstream Python or JavaScript, import a DEPS file,
run Git hooks, install packages, or reproduce a producer build.

`emsdk-producer-metadata.v1.json` enumerates the permitted fixed source revisions,
exact HTTPS roles, limits, selected local archive members and references to
previously retained original artifacts. `validateCatalog` verifies the complete
catalog value before copying it; a later helper or source URL requires a new
reviewed catalog revision. The original-artifact references are expected
identities, not evidence that this collector rehashed those files or closed their
signer and producer-build chains.

The HTTPS transport is dormant on import and construction. The collector requires
an explicit transport function; its synthetic tests inject responses without
sockets. Operator review of the catalog and invocation is required before a live
transport is called. The direct adapter uses an isolated HTTPS agent, an empty
proxy environment, explicit bundled certificate authorities and TLS verification.
It sends no authentication headers, follows no redirects, and performs no retry.
The global and request deadlines, stream and disk limits, private output ownership,
exclusive file creation and no-overwrite manifest publication are enforced during
collection. Failed responses and incomplete receipts remain separate from admitted
source bytes. Crossing a bound fails preparation; it does not produce passing
evidence.

A Gitiles commit response names its tree, and the collector recomputes that tree
from every observed entry before admitting a selected blob by its Git object
hash. The commit response remains a publication claim: the raw commit object,
commit signature, real checkout, index and history have not been verified. The
complete selected LICENSE blob is retained without rewriting. Root Gitlink
commits are recorded, while module URL and nested-source closure remain open.
An optional `.gitmodules` file is considered absent only when the admitted root
tree does not declare it.

When an explicit local archive input is supplied, the reader checks the original
compressed archive size and SHA-256 before reading selected Emscripten metadata.
It validates tar checksums, paths, types, PAX overrides, member counts, inflated
bytes and deadlines. It retains the selected original bytes and LICENSE without
extracting archive members or following links. The archive and physical output
verification share a bounded file reader: capped chunks consume at most the
expected byte count plus one overflow sentinel, with deadline checks during reads
and stable file identity checks before acceptance. Missing, duplicate, linked,
growing, truncated or oversized files fail preparation. Supplying no archive
leaves that collection step explicitly incomplete.

The V8 clang updater and its actual helper closure must be resolved from admitted
fixed DEPS and tree metadata. The historical depot_tools revision, real Git
history and original tagged-DEPS transition are unresolved. The original native,
cross compilation, test and publisher recipes require separate preparation and
qualification. A source metadata manifest closes none of those build obligations
and never declares Gate A complete.
