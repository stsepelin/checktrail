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
binding. The selected inventory and its pinned scope remain unchanged.

The `controllerCaseBindings` report partitions every selected case into a
declared-file binding, an alternate-file binding or an unresolved binding.
`selectedCaseBindings` retains the earlier default-file-only visibility report
for compatibility; its outside count does not mean these controllers are absent.
`--require-frozen` also refuses unresolved bindings, even when selection metadata
declares the inventory frozen.

The existing C++, Terraform and Helm extension container controllers select
these manifest profiles through `verify-required-native-tests.mjs`; source and
offline installed acceptance retain their required callbacks. The historical
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
