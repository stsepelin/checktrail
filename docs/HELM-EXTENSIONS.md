# Local Helm application and subchart validation

The opt-in `infrastructure.helm-extensions` check shares the library, CLI and MCP engine. It validates a declared local application-chart graph with Helm 4.3.0 on Linux ARM64. The original root-chart check keeps its separate contract.

## Declaration and planning

Declare `checktrail.helm-extensions.json` using the published [configuration schema](../schemas/helm-extensions-config.schema.json). The `local-application-subcharts-v1` profile selects three to sixteen physical application charts, a root with at least two dependency instances, and a transitive dependency. Repeated aliases may use the same physical child. Every dependency names an immediate declared `charts/<name>` directory with fixed local `file://` metadata. Cycles, unreachable charts and graphs exceeding 64 instances or depth sixteen are unsupported.

Each chart declares scalar integer, string or Boolean properties, default values and resource-template lines. Integer bounds, selected ASCII string length/pattern/enum constraints and required properties become exact native JSON schemas. Dependency value overrides may nest only through declared aliases. Empty Helm-injected `global` values are admitted explicitly; operator declarations cannot set global values. The collector accounts for physical default charts as well as root-coalesced alias instances, including a broken child default masked by a valid root override.

Physical Chart.yaml, values.yaml, values.schema.json and templates must exactly match the fixed renderer. Alternating source-line comments preserve authored resource-line addresses through rendering. The selected Go-template expressions allow scalar `.Values` paths, selected Chart/Release properties and bounded quote/default/string/comparison/Boolean operations. Control flow, helpers, library charts, hooks, CRDs, archives, locks, ignores, remote dependencies and dynamic lookup/tpl require another profile. Bare `{{ if }}` is admitted only as an original native parse-error control. Source/document marker spoofing is rejected before execution.

Physical files are bounded at 128 files including policy and inventoried metadata, 256 KiB per file, 8 MiB total, 4096 entries and traversal depth 32. These combined bounds can reject a graph below an individual chart/template limit. All metadata in the inventory contributes to freshness. Chart-only descendants collapse into the declared project; unrelated project markers retain their own boundaries. Discovery and planning execute no project code.

## Native execution and admission

Tools must be prepared explicitly with `scripts/prepare-infra-tools-runtime.mjs`. Engine execution performs no installation, dependency fetching or cluster access. Execution requires operator trust at CLI invocation or MCP startup. Repository configuration and MCP arguments cannot grant trust or change protected runtime settings.

The first executable selected from operator PATH must resolve to the pinned Helm bytes. Fresh owned storage separates frozen inventoried source, the exact native chart closure, home and scratch roles. Fixed arguments collect version, strict lint with all physical subcharts, client-only render and debug render. Native settings exclude ambient cluster, credentials, plugin and repository configuration. Original/copy/native inventories and tool bytes are reconciled before and after collection; aggregate native output is bounded at 1 MiB and engine deadlines at 120 seconds.

Receipt admission requires the current canonical project root, current source/policy and physical tool bytes, exact command and input/output digests, all four native phase roles and complete chart participation. Debug output must contain each aliased chart, its full schema and dependency count. Rendered source headers, alternating line markers, literal source spines and unique resource identities must cover every declared template instance. Strict lint separately accounts for each physical default chart; a successful root render cannot erase a child lint failure.

Native values errors must reconcile the full current constraint-message cohort before mapping to physical value/schema origins. Native message ordering may differ between rendering modes; multiplicity remains exact. Coalesced alias origins are declared-data bindings, not independently observed native value evaluation. Repeated physical diagnostics remain separately accounted.

Go-template errors require a declared physical template and an action-bearing, bounded source line. Reported native byte columns are bounded; exact independent column attestation is not claimed. YAML parser lines refer to verified rendered lines linked to physical source markers, and can identify a continuation line rather than the first malformed token. First-error native aborts establish the observed diagnostic coverage, not an exhaustive semantic audit.

Missing or changed prerequisites remain unavailable. Stale source, omitted/unknown native output, malformed or contradictory receipts, truncation, cancellation and timeouts remain inconclusive. Trusted execution and coherent receipts do not establish a hostile-project sandbox or whole-machine attestation. Kubernetes API/schema compatibility, runtime cluster behavior and arbitrary Helm projects are not assessed.

## Acceptance

The controller runs preserved root-chart source and installed acceptance, extension source and fresh offline production-install callbacks, and paired evidence guards in `baseline`, `acceptance`, `guards-1` and `guards-2` phases. CI runs all four as a matrix with fail-fast disabled. Each phase uses a read-only, network-disabled Linux ARM64 container with UID 1000, two CPUs, 3 GiB, 256 PIDs and owned bounded scratch storage.

Original controls cover aliases, transitive charts, physical defaults, root/nested overrides, scalar constraint families, Go parsing/execution, rendered YAML, repair and valid adjacent values and identifiers. Privacy controls exercise CLI and negotiated MCP startup trust, summaries and detailed source output. Source and installed lifecycle controls observe the actual pinned Helm executable, process start identity and positive CPU scheduling in lint/render before cancellation, timeout, output exhaustion, original/policy/copied/native source changes and concurrent cancellation. They require process disappearance and owned-directory removal.

Paired guards retain unchanged callbacks and fixtures, require a passing original, a JavaScript syntax check, an assertion failure under mutation and a passing restored fresh process. The altered subchart-flag control separately requires real native lint, complete debug schema participation and successful rendering, while retaining the intended incomplete physical lint cohort.

[The measurement](measurements/helm-extensions-2026-10-11.json) binds the tested source and package. Historical receipts do not certify later changes. Full artifact/license closure, wider platforms, attempt archives, representative resource measurements and final Gate A acceptance remain separate. These checks run no AI inference or real-project MCP field evaluation and establish no independent AI host sessions.
