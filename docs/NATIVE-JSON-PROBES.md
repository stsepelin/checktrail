# Structured source-bound native probes

The experimental `node-export-json-v1` profile returns a bounded JSON value from
one selected plain ESM function. An operator-pinned version 2 recipe binds the
captured current source, candidate address, family, export and baseline/trigger/
near-miss cases. Version 4 receipts retain the actual value, physical process
attempt and V8 coverage for each reached case. The existing Boolean profile keeps
version 1 recipes, version 3 current receipts and its unchanged worker.

Both profiles use `runReviewProbe`, CLI `review-probe`, MCP `review_probe` and the
provider-neutral workflow. Execution requires operator trust at invocation or
server startup. Discovery and planning execute no project code. Executed source
has the operator's privileges and is not sandboxed.

## Values and comparisons

The JSON profile accepts null, booleans, finite numbers other than negative zero,
strings, dense arrays and plain objects. Objects with a null prototype are copied
to ordinary JSON objects; repeated acyclic references are compared by value.
Object key order does not affect equality. Array order, missing versus null
properties, numeric versus string values and nested contents do affect equality.

The worker checks own property descriptors before reading values. Getters,
`toJSON` functions, symbol or non-enumerable properties, holes and extra array
properties, unsupported prototypes, undefined, functions, bigint, non-finite
numbers and cycles cannot supply usable observations. This controls the tested
serialization paths; project execution and proxy traps remain trusted code.

Each expected and actual value has a maximum depth of 16, 1,024 visited values
including containers and 16,384 UTF-8 bytes of its JSON representation. Boundaries
are inclusive. The native worker and parent importer enforce these separately.
The existing recipe-byte, argument-depth, case, combined output, call and wall
limits also apply. An overlarge native result retains a failed process attempt;
it does not become an empty, truncated or substituted successful value.

Every case starts with fresh source and module state. A native null result is an
observed value when function execution and complete physical evidence establish
it. The same null in an unstarted or failed trial supplies no observation.

## Evidence and independent stages

The engine compares each actual value to its operator expectation. Failed
controls keep behavior unresolved; a trigger mismatch with usable controls is
an expectation violation. Scale and optional branch-coverage requirements remain
unchanged. Physical replay checks the JSON worker profile, request/source digests,
values and coverage against the retained stdout bytes. Rehashing changed bytes
without reconciling the observation is rejected.

Independent stage packets receive the structured inputs, expected/actual values
and measured coverage. Their projection omits physical output, prior reviewer labels,
confidence, severity, session identity and aggregate verdicts. Retained private journals
include the complete version 4 receipt under the existing startup byte quotas.
Detailed CLI/MCP results require the operator's source-disclosure grant. Normal
summaries omit values, case inputs and physical output.

These observations do not establish intended production policy, caller
reachability, mechanism, a feasible remedy, severity or calibrated confidence.
Imported byte consistency does not authenticate a manufactured receipt. Claims
remain unverified and deterministic check outcomes remain separate.

## Required acceptance

`native-json-evidence` names the original synthetic controls for values and null,
serialization rejection, inclusive structural/physical bounds, physical replay,
all nine declared hypothesis families, CLI/MCP permissions and the audited neutral
workflow. Each family has an actual triggering consequence, a repaired source
control and a valid near miss. The atomic-artifact example writes an actual file
inside a fresh case tree. These are declared Node contracts, not framework
assembly acceptance or automatically inferred business policy.

Source and fresh offline production-package profiles must run the exact required
tests without skips. The acceptance client and fixtures stay outside the installed
product. Historical Boolean, budget, verification and audit tests remain required
preserved behavior. Exact revision/runtime/package pins and compiling guard
measurements belong in the dated measurement; wider languages, Windows, native
framework/tool contracts and the rest of Gate A remain open. No actual AI turn or
held-out/real-project field evaluation is started by these synthetic checks.
