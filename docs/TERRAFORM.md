# Bounded offline Terraform JSON module validation

The opt-in `infrastructure.terraform-validate` profile uses the shared CLI/library/MCP engine. Its [measurement receipt](measurements/terraform-native-2026-10-06.json) records original native and fresh offline installed-package controls and compiling guard proofs. E16 and Gate A remain open.

Declare every root module file in `checktrail.terraform.json`, using the published [configuration schema](../schemas/terraform-config.schema.json). Select the check in `checktrail.json`. The original [two-file example](../examples/terraform) has a variable, locals and an output, including an unused local whose invalid reference is detected by native validation.

## Pinned scope and passive planning

The accepted tool profile is the official Terraform 1.16.5 Linux ARM64 binary with its exact SHA-256 pin. Files are canonical flat `.tf.json` paths in a dedicated project. Every declared file must contain nonempty variable/local/output declarations; empty projects cannot pass even though native validation returns valid for an empty directory. Exactly one `terraform.required_version` constraint pins `=1.16.5`. All inventoried Terraform/JSON inputs must match the declaration. File, declaration, expression, serialized-input and native-output bounds remain explicit.

This profile accepts scalar variables with `number`, `string` or `bool` types and scalar defaults, locals and outputs. Expressions are whole `var.NAME` or `local.NAME` interpolations with an optional integer addition, subtraction or multiplication. Literal strings remain literal. Provider, resource, data, module, backend, provisioner, function, HCL-text and other expression/block profiles require separate acceptance. Duplicate JSON keys, omitted files, unsupported declarations and empty file scope make planning unavailable. Planning only reads data and never starts Terraform or project code.

[Native validation](https://docs.hashicorp.com/terraform/cli/commands/validate) checks configuration syntax and internal consistency; it does not validate remote services or establish a particular plan's values. The measured provider-free profile validates fresh copied files without `init`, fetching plugins/modules, a backend, state reuse, `plan` or `apply`. Its JSON files follow the [native JSON syntax](https://docs.hashicorp.com/terraform/language/syntax/json). Broader provider/module and live infrastructure contracts remain pending.

## Native collection and evidence

Execution requires operator trust through the CLI or MCP startup. A model argument cannot grant it. The collector resolves and hashes the selected binary before and after execution. Fresh owned source, module, HOME, temporary and data directories prevent source/output/cache reuse. It checks the exact copied module filenames and bytes before and after validation, and separately checks original and frozen-source bytes. An actual empty CLI configuration avoids the warning produced by a nonexistent configuration path. Native subprocesses receive only fixed execution settings and the snapshotted PATH, including disabled checkpoint checks and no ambient Terraform flags, variables, credentials, logging or provider reattachment settings. This is trusted execution, not hostile-project attestation or an OS sandbox.

Native version JSON must match the tool/platform and an empty provider selection. Validation uses exactly `validate -json -no-color`. Its `1.0` JSON format, every error/warning count, validity and exit status must agree. Unknown or malformed output, native stderr, missing tool identity, truncated output, cancellation and stale source are incomplete. Warnings remain incomplete in this bounded warning-free profile. A structured native unavailable receipt is distinguished from a failed version command; malformed or interrupted receipts remain inconclusive.

Source findings require declared filenames and coherent native ranges and snippets. Byte offsets, native grapheme columns, physical line numbers, UTF-8 byte highlight offsets and snippet text must reconcile with the exact original source. Missing or unsupported diagnostic locations remain inconclusive. Native errors establish module validation defects; they do not prove production reachability, infrastructure effects, reviewer severity or a remedy.

## Required acceptance and preparation

Use the explicit infrastructure runtime preparer documented in [KUBECONFORM.md](KUBECONFORM.md), then run:

```sh
npm run build
node scripts/prepare-package-cache.mjs
node scripts/verify-terraform-container.mjs
```

The original required controls cover multi-file reference/type defects and repair, valid zero/default conversion cases, unused locals, malformed scope, forged tool/module/config/command/counter/diagnostic receipts, real CLI/MCP privacy and startup-only trust, missing tools, protected settings, concurrency cleanup, frozen-plan changes, and cancellation/source/copied-module changes after observing the actual native validator. Version-command cancellation separately observes its real native process and cleanup. Compiling guard proofs require one original callback and its intended assertion failure, with zero skips. Setup failures do not count.

Source and a fresh offline production installation use the same prepared runtime with networking disabled and bounded CPU/memory. Lifecycle scripts are disabled. Tests, the example and official MCP client are acceptance-harness material outside the installed package; internal imports and CLI/MCP exercise shipped bytes. On this Mac, agents use the shared foreground dev-env lifecycle. Stop/status and owned-image cleanup occur at task end; preparation artifacts and branches are preserved.

Prepared-artifact runtime acquisition was measured. Default network fetching, release signatures, complete publisher/SDK/license closure, hosted CI for this revision, other OS/architecture profiles, wider Terraform projects, full attempt archives and representative-project performance remain unverified. No inference, real-project field evaluation or infrastructure apply is part of these controls.
