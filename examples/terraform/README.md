# Original Terraform module validation example

This provider-free original JSON module declares a typed variable, locals in a second file and an output. It is data for the bounded [Terraform profile](../../docs/TERRAFORM.md). It has no provider, resource, module, backend or apply operation.

Use an explicitly prepared pinned Linux ARM64 Terraform binary, then plan or validate:

```sh
checktrail plan --root examples/terraform
checktrail run --root examples/terraform --trust-project
```

Planning reads files only. Native validation requires operator trust. Changing the output to `${local.original_missing}`, a numeric default to `"original-invalid"`, or the unused local to an undeclared reference gives a native source diagnostic. Restoring the original values repairs validation. Native validation accepts zero and the numeric string `"2"` as valid default controls. Broader Terraform/provider and runtime value behavior remains outside this example.
