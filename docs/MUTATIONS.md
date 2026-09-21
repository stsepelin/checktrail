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
tests do not yet have the required identity accounting. Other languages and
framework runners remain separate work.

Recipes use `schemas/mutation-recipe.schema.json`. Each mutation names an
inventoried `.js`, `.mjs` or `.cjs` source file outside the selected test files,
one literal `expected` string and different `replacement` text. Exactly one
occurrence must match, including overlapping occurrences. Targets require valid
UTF-8. Missing, ambiguous, unchanged and test-file targets are recorded invalid;
malformed recipes, duplicate IDs and escaping paths are rejected before execution.
Helpers can indirectly alter test behavior, so recipe review is still necessary.

## Execution and evidence

The engine snapshots only its bounded inventory and copies those files. Excluded
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
mode adds bounded native run IDs, fingerprints, durations and counters without
raw process output. No model is invoked and no source is uploaded by the engine.

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
review-quality evaluation. Broader language support, mutation generation, impact
selection and comparison with the prior review workflow remain pending.
