# Evaluation cohort declarations

The shared library checks a bounded declaration before an operator acquires or
opens evaluation cases. This is partial setup for the independent evaluation
protocol. It does not freeze a reference or prior workflow, verify a license grant,
open source or labels, run inference, or close Gate A. Actual review trials still
wait for the implementation gates and the [evaluation protocol](AGENT-EVALUATION.md).

`inspectReviewCohortDeclaration` accepts the strict
`evaluation-cohort-declaration-v1` schema. A declaration contains opaque reference,
prior-workflow, repository, family, lineage and case identifiers, source/archive
hash declarations, split and exposure declarations, notice/license metadata,
private-service and distribution eligibility, and selected or excluded dispositions.
Unknown fields, including answer-bearing fields, are refused. Identifiers have
fixed kind prefixes and hexadecimal payloads. That syntax neither verifies their
provenance nor proves that a case is unseen by a reviewer or model.

All declared cases enter a transitive grouping by exact lineage and content
identities. Repository and family grouping are additional explicit holdout options.
A component spanning different splits is incomplete. Excluded cases remain in the
graph: excluding a linking variant cannot sever a development/reserved connection.
The total denominator retains every declared case, and selected plus excluded must
equal that total. Development, reserved and retired counts partition the same total.
A declaration with no selected cases is incomplete.

Selected cases must declare permitted distribution, no required private service,
applicable scope, an active split, notice metadata and a license other than missing,
`NONE`, `NOASSERTION` or `UNLICENSED`. This checks metadata presence, not SPDX
expression validity or whether a license legally authorizes use. Unknown exposure
is incomplete for selected cases. Reserved cases must declare uninspected exposure,
including excluded reserved cases. Each exclusion reason must still match the
corresponding declared field, so a stale suppression is incomplete. Multiple reasons
are allowed but duplicates are refused. Undeclared exclusions cannot be counted.

The declaration has at most 256 cases. Its SHA-256 binds the parsed schema's JSON
representation, including array order; it is not a raw-file hash or an append-only
chronology attestation. An optional expected digest refuses a changed declaration.
The detailed report identifies affected cases. `projectReviewCohortDeclaration`
emits aggregate counts and issue kinds/counts without case, source, reference or
workflow identifiers. Its digest and counts can still reveal equality or activity;
this projection is not a confidentiality guarantee.

The library is shipped through the package's main export. The repository setup
script is separate from the installed CLI and MCP tool catalogue:

```sh
npm run build
node scripts/check-evaluation-cohort.mjs < /path/to/private-declaration.json
node scripts/check-evaluation-cohort.mjs --expected-declaration-sha256 HASH < /path/to/private-declaration.json
```

The script reads bounded UTF-8 JSON from stdin (at most 1 MiB), writes only the
projected report, and emits a generic error without echoing invalid input. Exit 0
means the declared metadata is internally admissible, 2 means incomplete, and 1
means invalid or unavailable. Even a complete declaration explicitly reports
`acceptanceClaim`, `gateAClosed`, `inferenceExecuted`, `fieldEvaluationExecuted`,
`licenseGrantVerified` and `sessionIndependenceVerified` as false. A development-only
selection can be internally admissible; that is not a ready held-out experiment.

The original synthetic controls exercise transitive linking, excluded variants,
exact identifiers, optional holdouts, stale dispositions, empty selections,
metadata/exposure failures, digest changes, bounds and summary/error privacy. They
are development controls, not evaluation cases or independent agent assessments.
Private identities, case packets, labels and workflow configuration stay outside Git.

The [dated synthetic measurement](measurements/evaluation-cohort-declarations-2026-10-11.json) records actual source and fresh offline installed main-export controls on macOS Node 24/26 and Linux Node 22, along with paired failing/restored controls. Raw execution records stay private. These controls establish declaration behavior only, with no Windows, release, license-grant or independent-session acceptance.
