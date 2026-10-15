# Targeted mutation experiments

`mutate`, `runMutations()` and MCP `mutation_experiment` execute an explicitly
authored replacement recipe in temporary copies. They use the shared validation
engine, require operator execution trust and return a separate advisory report.
They never change a validation report's outcome or edit the original source.
Executed project code retains the user's privileges and can access outside the
copy: this is not a sandbox. Do not run untrusted code through this feature.

```sh
node dist/src/cli.js mutate --root examples/mutations --input mutations.json --trust-project --detailed
```

The public example subtracts instead of adding (caught by its assertion) and
swaps addition operands (survives its integer test). A survivor is an observation,
not automatically a missing test or a defect: equivalent mutations can survive.
The engine does not generate mutations or decide their semantic validity.

## Initial profile

`node-flat-tests` accepts one JavaScript project at the root, with only
`javascript.node-test` selected. The manifest must have no dependencies,
development dependencies, optional dependencies or peer dependencies. Additional
checks/projects, environment requirements, Git selection and operator overlays
are unsupported. Only flat native Node tests are accepted; suites and nested
tests do not yet have the required identity accounting. The selected native runner profiles below have separate dependency and evidence contracts.

Recipes use `schemas/mutation-recipe.schema.json`. Each mutation names an
inventoried `.js`, `.mjs` or `.cjs` source file outside the selected test files,
one literal `expected` string and different `replacement` text. Exactly one
occurrence must match, including overlapping occurrences. Targets require valid
UTF-8. Missing, ambiguous, unchanged and test-file targets are recorded invalid;
malformed recipes, duplicate IDs and escaping paths are rejected before execution.
Helpers can indirectly alter test behavior, so recipe review is still necessary.

## Execution and evidence

For `node-flat-tests`, the engine snapshots only its bounded inventory and copies those files. Excluded
dependencies, symlinks, secrets, caches and generated outputs are not copied.
The report records original exclusions. File permissions, Git metadata and
external resources are not reproduced; a copy is not a hermetic build identity.
No tools or dependencies are installed. Original source is fingerprinted before
and after the experiment, and a change or unreadable final source prevents
`complete: true`.

A fresh copy must first pass a baseline with non-skipped tests and complete native
test identities. Every valid mutation receives another fresh copy, so no trial
inherits files written by an earlier trial. The copied source also receives the
engine's normal before/after fingerprint check.

- `killed`: the same observed test identities complete and native assertion
  failures occur. Node's error cause must identify `AssertionError` with
  `ERR_ASSERTION`; string matching an error message is insufficient.
- `survived`: the same observed tests pass with the changed source.
- `inconclusive`: compilation/import/runtime errors, changed test identities,
  partial evidence, skips, timeouts or copied-source changes prevent classification.
- `invalid`: the requested edit does not satisfy the target contract.
- `not-run`: baseline failure, cancellation or the total budget prevents execution.

Identities include source-relative test file, name, line and column; matching
counts alone are insufficient. Test assertions that deliberately catch errors
remain assertions. Malicious or customized test code can forge evidence, as with
ordinary trusted validation; this is not an attestation mechanism.

Reports reconcile every requested mutation. `complete` means all requested trials
were classified as killed or survived against unchanged original source; it does
not mean the tests are adequate. CLI exits `0` for a complete experiment, even with
survivors, and `2` for incomplete/error. There is no implicit mutation-score gate.
Summary mode omits mutation IDs, file paths, individual runs and logs. Detailed
mode for `node-flat-tests` adds bounded native run IDs, fingerprints, durations and counters without
raw process output. The native profiles below retain bounded physical output in detailed mode. No model is invoked and no source is uploaded by the engine.

## Bounds and lifecycle

Recipes are capped at 128 KiB, eight mutations and 4096 characters per expected
or replacement string. Existing inventory bounds apply: 20,000 entries, 8 MiB per
file, 64 MiB total. Copies run sequentially. The default total execution budget
is 30 seconds, configurable up to 120 seconds; file inspection/copying and cleanup
are cooperative filesystem operations rather than hard OS deadlines.

MCP execution is disabled unless enabled at startup, shares the validation
execution slot and responds to ordinary request cancellation. Library callers can
supply an `AbortSignal`. Process groups are terminated by the shared runner.
Normal completion, failure and cancellation remove copies in `finally`; abrupt
process or machine termination can leave a private temporary directory. Ordinary
async calls do not implement durable MCP Tasks.

The regression suite exercises the public example, error classifications, invalid
edits, failing/skipped/nested baselines, changed test identity, source preservation,
cancellation and cleanup. These synthetic cases are not an independently held-out
review-quality evaluation. Wider runner shapes, mutation generation, impact
selection and comparison with the prior review workflow remain pending.

## Selected native runner profiles

The separate `vitest-flat-tests`, `jest-flat-tests`, `pytest-flat-tests` and
`phpunit-flat-tests` recipes use the same library, CLI and MCP entry points.
They select one root project and only its registered test check, without
project environment grants. The measured runtime target is Linux ARM64 with
Node 22.23.2. Selected tool versions are Vitest 5.0.1, Jest 30.5.2,
Python 3.12.13 with pytest 9.1.1, and PHP 8.5.6 with PHPUnit 13.3.4.
No automatic tool download or project configuration evaluation occurs during
planning. Trusted test execution can execute source and imported dependencies.

Only flat tests in at most sixteen selected files and 256 observed cases are admitted. Nested suites,
parameterized cases, retries, expected failures, focused selections and
incomplete native accounting cannot produce a conclusive experiment. Targets
must be inventoried source outside selected tests, with one exact UTF-8
replacement. Existing recipes and the original Node profile keep their contracts.

The native profiles snapshot the complete selected physical dependency directory:
`node_modules`, `.checktrail/mutation-python-tools`, or `vendor`. Every baseline
and trial gets fresh source, dependencies, HOME and temporary directories from
that snapshot. Contained relative dependency symlinks are relocated; escaping
links, special files and incomplete closures are rejected. Original and copied
source/dependency fingerprints are inspected before and after native execution.
Excluded external resources and executable runtime libraries are not a complete
hermetic or licensed artifact closure.

Prepare dependencies as an explicit operator action before running recipes.
The acceptance harness derives Vitest/Jest packages from the existing npm lock
with `scripts/prepare-mutation-tools.mjs`, uses the pinned public Python tools
prepared by `scripts/prepare-python-extensions-tools.mjs`, and installs the
existing locked `scripts/php-tools` Composer tree. Consumer pytest projects must
place the selected dependencies at `.checktrail/mutation-python-tools`; PHP
projects supply `vendor`. The experiment never invokes a package manager.

The native report distinguishes:

- `killed`: the same file/name/line/column test cohort completes with typed body
  assertion failures and no skip or setup/execution error.
- `survived`: the same complete native cohort passes the changed source.
- `skipped`: the native cohort skips tests; this is incomplete, never a kill.
- `setup-error`: collection, import or setup failure prevents body admission.
- `execution-error`: a body runtime error or teardown failure prevents a kill,
  including a typed assertion raised from teardown.
- `inconclusive`: changed test identities, source/dependency writes, malformed or
  incomplete evidence, invalid UTF-8, cancellation, deadline or output exhaustion.
- `invalid` and `not-run`: the target contract rejects the edit, or a passing
  baseline/current inputs/budget is unavailable.

Native reporters retain assertion identity and lifecycle phase. Vitest records
hook start/completion; Jest records actual hook failures; pytest records setup,
call and teardown separately; PHPUnit records native hook-failure events rather
than inferring teardown from a final passed event. pytest capture is disabled
so descendant output reaches the shared physical process-output limit.
Observed case addresses must fall within the frozen selected source bytes;
this does not independently attest a runner's reported column.

A zero-test or all-skipped baseline cannot start trials. `complete` requires a
passing baseline, only killed/survived trials and unchanged final original
source/dependencies. Survivors remain advisory observations, including equivalent
mutations; no mutation-score or missing-test conclusion is implied.

Native source bounds are 8 MiB per file and 64 MiB total. Dependency bounds are
64 MiB per file, 384 MiB total, 32,000 entries and depth 32. Each native attempt
has a combined physical stdout/stderr limit of 1 MiB; at most one baseline plus
eight trials run sequentially. The 30-second default and 120-second maximum
cover preparation, copying and execution. Final inspection and cleanup use
cooperative bounded filesystem operations and can exceed the execution budget.

Detailed native reports contain physical base64 output, stream digests, byte
counts, process flags, observed test identities and current fingerprints.
Summary mode omits observations, individual trials, exclusions and raw output.
Operator trust remains a CLI invocation or MCP startup decision; a recipe or tool
argument cannot grant it. Native child processes retain operator privileges.
Fresh processes and copied directories do not prove independent AI host sessions.

CI runs each native family independently through
`scripts/verify-mutation-container.mjs`, including its frozen source callbacks,
fresh offline production-install callbacks and paired native guard controls.
`scripts/verify-mutation-guards.mjs passive` separately checks parser/copy guards
by removing one safeguard, requiring its named assertion to fail, and restoring
identical bytes. The completion job requires every matrix family and the passive
controls to succeed. Gate A's remaining profiles, full runtime/license closure,
final platform matrix and independent evaluation remain separate obligations.

The selected mutation-runner source and fresh installed-package cohorts passed for all four families. [The scoped measurement](measurements/mutation-runners-2026-10-11.json) retains the named receipts, paired native/parser controls and reached lifecycle witnesses. These receipts do not close the remaining Gate A profiles, artifact/license closure, final runtime bindings or independent evaluation.
