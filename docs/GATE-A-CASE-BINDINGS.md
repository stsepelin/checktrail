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
- its dedicated selector would reject the rows (`selector-rows-differ`). These
  profiles do not use the generic verifier: `cpp-extensions`,
  `dotnet-generator-extensions`, `scala-extensions`, `ruby-extensions`,
  `consumer-impact`, `multi-candidate-workflow`, `confidence-provenance`,
  `attempt-archives`, `lifecycle-platforms`, `tasks-matrix`,
  `native-license-provenance`, `resource-release-readiness` and
  `independent-evaluation-protocol`. Each selector requires exactly the selected
  cases at their bound files. The C++ selector also requires the unselected
  `cpp-extensions compiler formatter analyzer acceptance` row. It ignores row
  order but compares each row's JSON text, so `file` must precede `name`.
  The .NET generator selector ignores order. The others require the selected
  order;
- the Tasks selector's preserved `mcp-tasks` cohort is not exactly 10 distinct
  rows outside the Tasks acceptance file (`companion-cohort-differs`).

The audit reproduces these rules from data and never imports a controller. A test
runs each exported selector against the same manifest variants and requires the
same verdict. For the two inline checks it pins the source text instead.
`--require-frozen` exits 2 on any admission refusal.

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
