# Gate A acceptance-case bindings

The selected inventory gives each extension profile a default acceptance file.
The following privacy and lifecycle cases use separate files in the existing
`scripts/required-native-tests.json` profile with the same profile ID:

| Profile                | Case      | Required controller file                           |
| ---------------------- | --------- | -------------------------------------------------- |
| `cpp-extensions`       | privacy   | `dist/test/cpp-extensions-surfaces.test.js`        |
| `cpp-extensions`       | lifecycle | `dist/test/cpp-extensions-cancel.test.js`          |
| `terraform-extensions` | privacy   | `dist/test/terraform-extensions-surfaces.test.js`  |
| `terraform-extensions` | lifecycle | `dist/test/terraform-extensions-lifecycle.test.js` |
| `helm-extensions`      | privacy   | `dist/test/helm-extensions-surfaces.test.js`       |
| `helm-extensions`      | lifecycle | `dist/test/helm-extensions-lifecycle.test.js`      |

`audit-gate-inventory.mjs` resolves these addresses explicitly. For each alternate
binding, its exact selected callback name must appear once in the same manifest
profile and point to the file above. A same-named entry in another profile, an
entry in the default file, duplicate entries or a different file leave that case
unresolved. An unrelated adjacent callback name does not invalidate a correct
binding, although the C++ selector refuses the profile because of it (see
controller admission below). The selected inventory and its pinned scope remain unchanged.

Declared-file bindings follow the same address rule: a case counts only when its
default file and name appear exactly once under each profile key that runs it.
For most profiles that is its own key. `mutation-runners` is an aggregate the
native verifier refuses to select, so its cases must appear in each of
`mutation-vitest`, `mutation-jest`, `mutation-pytest` and `mutation-phpunit`.
The same callback filed only under another profile, such as `core`, or repeated
within one profile, leaves the case unresolved; a copy kept in a second profile
still resolves.

The `controllerCaseBindings` report partitions every selected case into a
declared-file binding, an alternate-file binding or an unresolved binding.
`selectedCaseBindings` retains the earlier default-file-only visibility report
for compatibility; its outside count does not mean these controllers are absent.
`--require-frozen` also refuses unresolved bindings, even when selection metadata
declares the inventory frozen.

A controller checks a profile's whole row set, selected or not, before it runs any
callback, so a resolved binding is not enough. The `controllerAdmission` report
lists each controller profile that a selected case resolves to and refuses it
when:

- any file and name pair repeats within that profile (`duplicate-address`),
  which the native runner rejects for the whole profile. The same pair in a
  different profile, or in the `mutation-runners` aggregate, stays valid;
- it holds no rows or more than 256 (`row-limit`), the bound
  `resolveRequirements` in `required-test-evidence.mjs` applies to every
  profile it runs;
- its dedicated selector would reject the rows (`selector-rows-differ`). These
  profiles do not use the generic verifier: `cpp-extensions`,
  `dotnet-generator-extensions`, `scala-extensions`, `ruby-extensions`,
  `consumer-impact`, `multi-candidate-workflow`, `confidence-provenance`,
  `attempt-archives`, `lifecycle-platforms`, `tasks-matrix`,
  `native-license-provenance`, `resource-release-readiness`,
  `independent-evaluation-protocol` and the four mutation cohorts, which
  `verify-mutation-container.mjs` compares with the `mutation-runners`
  selection. Each selector requires exactly the selected cases at their bound
  files. The C++ selector also requires the unselected
  `cpp-extensions compiler formatter analyzer acceptance` row. It ignores row
  order but compares each row's JSON text, so `file` must precede `name`.
  The .NET generator selector ignores order. The others require the selected
  order;
- another profile the controller requires differs (`companion-cohort-differs`).
  Each cohort profile must hold 1 to 256 rows without a repeated pair, then:
  - the Tasks selector needs exactly 10 distinct `mcp-tasks` rows outside the
    Tasks acceptance file. Ten preserved rows fill that cohort, so a Tasks
    harness row can enter it only by replacing a preserved row, which the
    audit rejects, or as an eleventh row, which this rule refuses;
  - the .NET generator selector partitions `dotnet-build`, `dotnet-test`,
    `dotnet-generated` and `dotnet-method` across its shards. Each holds at
    most 128 rows, none shares a pair with another, and together they hold
    exactly their preserved baseline rows;
  - `consumer-foundation-evidence.mjs` and `attempt-foundation-evidence.mjs`
    compare `consumer-impact-foundation`, `attempt-journal-foundation` and
    `attempt-output-foundation` with exact ordered lists, pinned by digest;
  - the Python, PHP, Rust, Laravel, Django, FastAPI and Nuxt extension
    containers first run a baseline batch and require an exact count from it:
    `python` 5, `php-tools` with `php-review` 14, the five Rust baseline
    profiles 39, `laravel-cache-runtime-bindings` 1, `laravel` with
    `laravel-cache` 9 sharing no pair, `frameworks` 8 and `nuxt` 7. A batch
    counts a pair filed in two of its profiles once;
- a shared selector it calls would reject another profile
  (`shared-selector-rows-differ`). `selectConsumerWitnessRequirements` reads the
  broken, fixed and near-miss rows of `consumer-impact`,
  `javascript-extensions` and the 16 `context-*` profiles, and each of their
  controllers calls it. One missing row there refuses all 18;
- a controller requires an exact number of required callbacks after running
  the profile through the generic runner (`row-count-differs`). The runner
  admits extra rows, so an unselected row in, for example, `context-go` passes
  it and fails `verify-consumer-witness-profile.mjs`, which expects 9. The
  report lists these controllers under `rowCountControllers`.

The audit reproduces these rules from data and never imports a controller. A
test runs each exported selector against the same manifest variants and requires
the same verdict. For the inline checks, the runner bound and the container
counts, it pins their source text instead. Another test scans `scripts/` for
every script that reads the manifest, or is a selection or runtime-evidence
module, and applies an exact count or exact row set. Each must appear in the
audit's tables or in a short list of scripts whose rule concerns only profiles
no selected case runs under. A new selector outside both fails that test.
`--require-frozen` exits 2 on any admission refusal.

Rules the audit does not yet model: controllers that compare a batch's required
count with the sum of its profile lengths, such as the confidence-provenance
review baseline and the Swift tools baseline, also refuse a pair filed in two of
those profiles.

The existing Terraform and Helm extension container controllers select these
manifest profiles through `verify-required-native-tests.mjs`. The C++ container
runs source acceptance through `verify-selected-clang-consumers.mjs`, which takes
its rows from the dedicated C++ selector described above. Source and offline
installed acceptance retain their required callbacks. The historical
[C++](measurements/cpp-extensions-2026-10-10.json),
[Terraform](measurements/terraform-extensions-2026-10-11.json) and
[Helm](measurements/helm-extensions-2026-10-11.json) observations include passed
privacy and lifecycle terminal events in both source and installed cohorts.
Those records retain their original source, file and package identities. This
mapping does not requalify them for the current source.

This is the controller-address reconciliation required by A13. Current native
execution, installed acceptance, producer/notice closure and final Gate A
acceptance still require their own evidence. The structural audit continues to
report `nativeExecutionAssessed: false` and `gateAComplete: false`.
