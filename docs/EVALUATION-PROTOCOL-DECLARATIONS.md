# Prospective evaluation protocol declarations

`inspectReviewEvaluationProtocol` binds a prospective comparison declaration to
the existing [cohort declaration](EVALUATION-COHORT-DECLARATIONS.md). It opens no
case source, labels, configuration files, private reference, model or service.
The required independent evaluation profile and Gate A remain open.

The strict `prospective-review-protocol-declaration-v1` schema declares opaque
reference and baseline identities with configuration digests, a verifier
configuration digest, the cohort digest, source/engine/lock/tool/environment
identities, acquisition and answer-separation procedures, host isolation,
independent judging, common-defect matching, external metering and stop rules.
It also declares equal per-arm resource ceilings, repetitions, incident-cluster
assignments, scoring parameters and numerical acceptance thresholds. These
commitments identify supplied metadata; the preflight does not read or verify
the committed configuration bytes or execute those procedures. Keep actual
names, configuration bytes and identity mappings outside Git.

The baseline kind explicitly distinguishes a declared comparison control from a
claimed previous workflow. The legacy cohort field `priorWorkflowId` binds either
opaque identity; it does not make a declared control a reproduction of history.
The report retains that distinction while configuration authenticity remains
unverified for both kinds. No previous workflow is inferred or invented.

The cohort must be internally complete and match the declared cohort digest and
both opaque baseline identities. Every cohort case, including excluded cases,
needs exactly one cluster address. Shared lineage or content must use one cluster;
the cohort's optional repository/family holdouts impose the same restriction.
An excluded connecting variant therefore cannot split related incidents into
independent scoring units. Unrelated cases may share a conservative cluster.
The preflight cannot discover undeclared relationships or attest independence.

All selected cases must be reserved and declared uninspected. Declared license,
notice and distribution metadata must satisfy the cohort checker, with no selected
private-service dependency. This does not verify a license grant, exposure history
or statistical sampling. The declared minimum cluster count must be met; its
presence does not establish adequate statistical power or representative cases.

The schedule has three roles: baseline, verifier and reference. It sorts
opaque case IDs, then enumerates repetitions, and rotates through all six arm
permutations. Each block of six paired trials places each role in each position
twice. This is a deterministic declared rotation, not random selection or proof of
fresh sessions. The configured seed binds later cluster resampling; it does not
randomize this rotation. At most 256 cases and two repetitions yield at most 512
paired trials per comparison and 1,536 planned arm slots. Missing cluster addresses
make the declaration incomplete without reducing that planned denominator.

The returned digest binds parsed protocol JSON, including array order, with its
cohort digest. An expected digest rejects a later protocol revision. A changed
cohort is incomplete even when the protocol itself is unchanged. A digest does
not prove when a declaration was made: the operator still needs an immutable
dated private record before acquiring or exposing reserved case contents.

`projectReviewEvaluationProtocol` emits only aggregate counts, issue kinds and
digests. It withholds the private schedule and opaque case/cluster identities;
equality and activity can still be inferred from hashes and counts. The library
exports the schema, inspector, projection and protocol/report types. The checkout
setup script accepts bounded UTF-8 JSON through stdin:

```sh
node scripts/check-evaluation-protocol.mjs < /path/to/private-protocol.json
node scripts/check-evaluation-protocol.mjs --expected-protocol-sha256 HASH < /path/to/private-protocol.json
```

The input is `{ "protocol": ..., "cohort": ... }`. Exit 0 means internally
admissible declarations, 2 means incomplete declarations, and 1 means invalid or
unavailable input. The script emits only the projection and uses a generic error
without echoing private input. Its inclusive input bound is 1 MiB.

No field grants execution, source disclosure or inference. This checker does not
admit real evaluations, freeze the actual reference or previous workflow, seal
reviews or judgments, supply missing host cost records, compute quality results
or close Gate A. These declarations complement the existing isolated-session,
sealed synthetic judgment/matching and paired scoring controls. Their final
integration, actual private identity/configuration selection and acceptance
bindings remain required before the independent evaluation profile can complete.

The `evaluation-protocol-declarations` required cohort exercises original synthetic binding, contamination, scale, exclusion, scheduling, identity, schema and privacy controls. Its installed callback repeats the same controls through a fresh locked offline production installation and an external harness. The checkout setup script remains outside the installed CLI/MCP catalogue. Before/after compiled-tree, harness and executable hashes detect observed changes; they do not trace loaded modules or independently attest dependency bytes. These component controls are separate from the frozen nine-case whole evaluation profile.
