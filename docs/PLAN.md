# Repo Verifier implementation plan

Status: working foundation implemented; native adapters and later milestones are in progress.
See EXECUTION.md for the implementation ledger and [ACCEPTANCE.md](ACCEPTANCE.md)
for milestone evidence, remaining work and external verification gates.
Intended public namespace: `stsepelin/repo-verifier`.
This document describes both the initial implementation and later milestones;
the support matrix in `LANGUAGES.md` records what actually works.

## 1. Purpose and success criteria

Give developers and coding agents a reproducible answer to: what was checked,
against which source, by which tools, and what remains unverified? Deliver one
engine through a CLI and a local MCP server. Required CI jobs provide enforcement;
MCP provides access and evidence, not control over an agent's other actions.

The public distribution must work without accounts, proprietary source,
organization-specific infrastructure, or an LLM provider. Source inspection,
planning and reporting must be useful before executing anything. Project-specific
policies remain local and use the same contracts as public policies.

Success is demonstrated by regressions caught, valid cases left alone, complete
execution accounting and measured cost. A green command alone is insufficient.
No promise of equivalent or improved review quality precedes measurement.

## 2. Product surfaces

- CLI: discover, plan, run, inspect adapter capabilities; JSON for automation.
- MCP: project context, validation plan, validation execution and report retrieval.
- Library: typed engine and adapter interfaces, independent of MCP.
- CI: run the same CLI, fail on failed or incomplete required checks.
- Public rule packs: versioned, documented, independently testable.
- Private overlays: commands, architecture, service requirements, contracts and
  dependency maps kept in the consumer's own repository or local configuration.

The first version runs locally over stdio. A hosted service, autonomous editing,
commit/deploy tools, a marketplace, a UI and remote execution are outside it.

## 3. Architecture and implementation choices

Use TypeScript with strict types and a supported Node runtime. Its ecosystem
supports JSON schema, process orchestration and the official MCP SDK without
requiring a custom protocol implementation. Language support comes from native
tools behind adapters; the engine does not attempt to parse every language itself.

Keep a single package initially, with separate engine, adapters, process runner,
CLI and MCP modules. Split packages only when independent release schedules or
external adapter distribution require it. Pin dependencies and commit the lockfile.

Use the official MCP v2 SDK and target the published 2026-07-28 protocol. Test
the installed SDK's actual wire behavior. Client compatibility is a separate
matrix: do not infer it from the protocol version. Older clients may need a later
compatibility bridge. Optional Tasks support follows only after bounded local
execution, cancellation and lifecycle tests are solid. These lifecycle checks
are now exercised; the installed SDK's Tasks routing limitation and the remaining
implementation gates are recorded in `MCP-COMPATIBILITY.md`.

Keep the complete report in versioned JSON. Add SARIF export for source findings
and JUnit import for test evidence without pretending either is a complete model
of execution, policy, provenance or incomplete work.

## 4. Language support model

Support is a set of capabilities, not a boolean. Record these independently:

1. Project discovery: manifests, package boundaries, workspace structure.
2. Planning: relevant tools, configuration, scope and prerequisites.
3. Execution: fixed argument arrays, supported platforms and bounded processes.
4. Evidence parsing: diagnostics, test counts, skips, tool errors and completeness.
5. Semantic rules: framework-specific checks and labeled fixtures.
6. Integration validation: affected consumers and services actually exercised.

Initial execution families: JavaScript/TypeScript, Python, Go and PHP. Expand to
Rust, JVM languages, .NET, Ruby, Swift, C/C++ and infrastructure through the same
contract. See `LANGUAGES.md` for tool families, edge cases and promotion gates.

Never infer a runner from an extension alone. JavaScript tests may require Node,
Vitest, Jest, Playwright or a framework. Type checking usually needs a whole
project even when linting can target files. Generated code and vendor directories
need explicit scope rules. Unsupported frameworks remain visible in the report.

## 5. Policy model

Separate executable rules, advisory review guidance and operator permissions.
An executable rule has an ID, version, category, applicability, required inputs,
severity, evidence contract, scope and positive/negative regression fixtures.
A guidance item has triggers and references, but cannot claim automated coverage.

Configuration is declarative JSON validated against a versioned schema. Initial
configuration selects registered checks only; it cannot inject shell commands.
Operator-registered custom adapters are explicitly trusted executable dependencies,
pinned by version and digest; see `EXTERNAL-ADAPTERS.md`. Reading a repository configuration never grants trust.

Future precedence: engine defaults < pinned public packs < checked-in project
policy < local operator policy. Protected execution/output settings belong to the
operator and cannot be weakened by repository files. Reject unknown keys, duplicate
identifiers, unresolved inheritance and conflicting required rules rather than
silently taking a plausible interpretation. Policy changes must appear in reports.

Exceptions require the narrow rule/path, reason, owner and optional expiration.
Verify staleness and reject broad suppression growth according to the configured
ratchet. New and existing findings remain separate when a baseline is available.

## 6. Trust and privacy

Discovery/planning only inspect files. Running a compiler, test runner, linter or
build system can execute project-controlled code. Require explicit operator trust
at CLI invocation or server startup, never through a model-supplied boolean.
An execution allowlist prevents arbitrary tool selection; it is not a sandbox.

Constrain MCP access to a startup-configured root. Resolve canonical paths and
reject escaping paths and symlinks. Bound inventory size, file reads, runtime,
output and retained reports. Do not install dependencies or fetch tools on demand.
Do not start infrastructure, apply migrations or access production by default.

Core code sends no telemetry or source uploads. Invoked tools may have their own
network behavior; offline defaults and an OS/container sandbox are distinct work.
Keep logs out of normal MCP output. Summary mode exposes rule IDs and counts;
detailed mode is an explicit operator choice. Findings passed to a cloud-backed
MCP client may reach that client's provider. Redaction is not a secrecy guarantee.

Public material is authored from scratch using fictional domains and data. Do not
copy private code and rename identifiers. Do not publish internal incident prose,
paths, commit history, reports or fixture snapshots. Keep private integration
results outside public assets. Review the package allowlist and packed contents.

## 7. Evidence and correctness

Every planned check must have exactly one terminal result. Distinguish passed,
failed, unavailable, skipped, error and inconclusive. An unknown test count is
unknown, not zero and not a successful test run. Require evidence of executed,
non-skipped tests before claiming test validation. Process exit status and parsed
diagnostic severity must agree; truncated or malformed evidence cannot yield pass.

Record source fingerprint, inventory exclusions, policy digest, engine/adapter
versions, command, relative working directory, timestamps, duration, process
status, output truncation and test evidence. Snapshot before and after execution;
changes make the result stale/inconclusive. Inventory fingerprinting has explicit
limits and must not be described as a complete hermetic build identity.

Implemented Git selection resolves base and HEAD to immutable commits, uses
NUL-delimited paths, compares committed/index/raw working content, and identifies
worktrees separately. Conservative fallback and limits are in `WORKSPACES.md`.
Future cache keys must include tools, config, dependencies,
environment inputs and source. Start without caching to avoid false green reuse.

## 8. Milestones and acceptance gates

### M0 — public project and contracts

Deliver this plan, architecture, language matrix, security model, contribution
guide, license, schemas, synthetic fixture policy and CI definition.

Gate: no private assets or copied history; claimed support matches implementation;
dependencies and packaging contents inspected. A local scaffold is not a release.

### M1 — executable foundation (current work)

Deliver recursive bounded project discovery, fixed check registry, inspect/plan/run
CLI, structured evidence, explicit execution trust, stdio MCP, and native checks
for selected JavaScript, Python, Go and PHP workflows. Other ecosystems are detected
and explicitly unsupported for execution. No automatic fixes or dependency installs.

Gate: real CLI and SDK client/server tests; positive and negative parser fixtures;
zero-test, all-skipped, missing-tool, timeout, malformed-config, path-escape,
output-limit and source-change tests. Demonstrate native tools that are available
locally; report unavailable toolchains honestly.

### M2 — practical multi-language validation

Implemented adapters and remaining work are recorded in `EXECUTION.md`,
`STATUS.md` and `LANGUAGES.md`. Each adapter document records its evidence and
known limits.

Extend ESLint and TypeScript support; add vue-tsc, Vitest/Jest/Playwright, Ruff/mypy/pytest,
PHPStan/Pint/Pest/PHPUnit and richer Go checks. Import structured outputs, detect
tool versions, support workspace configuration and project-specific environments.
Add SARIF export and JUnit test evidence. Add Git change selection with whole-project
fallback where dependency impact is unknown. Add checks for missing test coverage
of scope and baseline expansion. Detection alone never qualifies an adapter here.

Gate: adapter contract suite plus real toolchain CI per adapter; a deliberately
broken example fails for the intended reason, a fixed example passes, valid near
misses stay clean, and missing prerequisites fail completeness rather than code.

### M3 — framework and cross-project contracts

Add opt-in Laravel, Vue/Nuxt, Django/FastAPI and other packs as supported by
maintainers. Define architecture boundaries and dependency edges explicitly.
Compare runtime inventories for assembly changes (routes, listeners, middleware,
schedules, bindings) using isolated test environments. Contract checks cover
producer/consumer schemas and built package integration rather than source alone.

Gate: synthetic multi-project examples exercise both sides of each contract;
private integrations run privately and provide aggregate feedback only. Advisory
reasoning about authorization, numeric semantics or test adequacy remains advisory
until a validated deterministic implementation exists.

### M4 — additional ecosystems and distribution

Promote Rust, JVM, .NET, Ruby, Swift, C/C++ and infrastructure adapters as their
toolchain CI and evidence parsers satisfy the same gates. Add Windows execution
only after process-tree cancellation and executable-resolution tests pass.
Add trusted external adapters and private pack distribution with pinned integrity.

Gate: documented OS/tool/framework compatibility, license/provenance audit,
reproducible package contents, fresh-install CLI/MCP smoke tests, and measured
performance. Set up package publishing, GitHub releases and MCP registry metadata
only after the maintainer authorizes the concrete release.

### M5 — measured review assistance

Add relevant guidance retrieval, targeted mutation experiments, stronger test
impact analysis, optional local/model-assisted review and durable Tasks where useful.
Model output is a separate advisory channel and never changes deterministic check
results. No provider or source upload is required for the core product.

Gate: labeled held-out cases measure detection and false positives per rule family;
compare against native tools and the prior workflow; record tool/model versions,
token cost, latency and confidence intervals where sample sizes permit them.

## 9. Validation strategy

- Unit: policy resolution, scope selection, parsers, status aggregation, privacy.
- Integration: real child processes, bounded logs, failures, cancellation and cleanup.
- Protocol: stdio discovery, schemas, calls, invalid inputs, trust and output modes.
- End-to-end: packaged CLI against synthetic repositories using native toolchains.
- Regression corpus: broken/fixed/near-miss pairs, boundary cases and adversarial
  identifiers; mutation tests verify the rule actually depends on its intended guard.
- Privacy: no absolute paths or raw logs in summary output; no private fixtures in
  package contents; no unsolicited network calls in the engine.
- Compatibility: Linux/macOS initially, Node supported majors, pinned adapter tools;
  Windows and older MCP clients explicitly tracked until validated.

Avoid coverage percentages as the acceptance criterion. Every safety and evidence
invariant needs a named test that fails when that behavior is removed.

## 10. Delivery, maintenance and risks

Use MIT for the new original project; audit each dependency and imported rule's
license separately before redistribution. Prefer invoking existing tools over
copying their implementations or rule collections. Maintain source attribution.

Version report/config schemas separately from package versions. Breaking adapter
interpretation or policy semantics requires migration notes and compatibility tests.
Document false-positive reports with a minimal public reproducer. Maintain adapters
only when their toolchain matrix can be exercised. Keep unavailable checks visible.

Primary risks are weak parsers, overclaimed support, implicit project execution,
environment-dependent tests, stale evidence, and loss of private domain context.
Mitigations are explicit capabilities, complete result accounting, trust gates,
isolated execution profiles, source identity and private overlays respectively.

Revisit process isolation before accepting untrusted pull requests, a job queue
before long-running remote use, and package separation before third-party plugins.
Do not add those systems ahead of a demonstrated need.

## References

- [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28)
- [Official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html)

SDK installation and protocol conformance evidence belong in `STATUS.md`, since
website documentation and available packages can differ.
