# Local Terraform module and pinned provider validation

The opt-in `infrastructure.terraform-extensions` check shares the library, CLI and
MCP engine. It validates a finite local HCL/JSON module graph with Terraform
1.16.5 and the `hashicorp/random` 3.9.1 Linux ARM64 provider. The provider-free
`infrastructure.terraform-validate` check retains its separate contract.

## Declaration and planning

Declare `checktrail.terraform-extensions.json` using the published
[configuration schema](../schemas/terraform-extensions-config.schema.json).
Its `declared-local-modules-random-v1` profile describes three to sixteen distinct
physical modules, including a root with at least two calls, both HCL and JSON
source, a transitive module call and at least two declared resource instances.
Repeated callers may use the same physical child module. The expanded graph is
bounded at 64 instances with no cycles or unreachable declarations.

Each directory has exactly one generated `main.tf` or `main.tf.json`. The
collector requires those physical source bytes to match the declaration's fixed
renderer, plus the fixed root dependency lock. Variables have scalar number,
string or Boolean types and optional scalar defaults. Locals, outputs, resource
attributes and call arguments accept literals or bounded references with an
optional integer offset. The resource family is `random_integer`. Terraform
performs native type, argument and reference validation; Checktrail does not
compute infrastructure values.

Functions, interpolation directives in literals, remote modules, other providers
or resources, executable provisioners, provider overrides, state, backends,
variable files and resource/module meta-arguments require another profile.
Reserved identifiers are checked exactly; adjacent names such as `source_name`
remain ordinary argument names. Selected Terraform files and all inventoried
metadata must fit the physical file/byte/depth bounds. Undeclared native files,
changed rendered files, duplicate policy keys and aliases make planning
unavailable. Terraform-only child directories belong to the declared graph;
other infrastructure markers keep independent project boundaries.

Planning reads bounded data and executes nothing. Execution requires operator
trust through CLI invocation or MCP startup. Repository policy and MCP arguments
cannot supply that trust or override protected runtime settings.

## Preparation and execution

Build Checktrail, explicitly prepare the infrastructure runtime, and prepare the
provider archive through `scripts/prepare-terraform-extensions-runtime.mjs`.
Operators may set `CHECKTRAIL_TERRAFORM_RANDOM_ARCHIVE` to an already downloaded
canonical archive. Otherwise this preparation command fetches the pinned official
release. It verifies archive size/hash, the exact two-member inventory and each
member's size/hash before publishing the cache. Native engine execution never
fetches artifacts.

The operator selects `CHECKTRAIL_TERRAFORM_EXTENSIONS_PROVIDER_ROOT`; its default
is `.checktrail/terraform-extensions-tools` under the configured root. The cache
contains the archive, provider executable, license member and exact preparation
metadata. Unknown, absent, changed or incompatible prerequisites remain
unavailable before initialization. Preparation records that release signatures
and complete publisher/license closure have not been verified.

The collector copies declared source, the lock and archive into fresh owned
storage. A filesystem-only provider mirror includes exactly the selected provider;
there is no direct installation method. Fixed arguments disable the backend,
interactive input and upgrades, and require a readonly lock. Version collection,
local initialization, selected version, complete native provider schema and native
validation each produce a bound receipt. No `plan`, `apply`, remote module download
or state reuse is performed. Child settings exclude ambient Terraform flags,
credentials, logging and provider reattachment.

`version -json` reports the selection already declared in the seed lock; it does
not prove provider execution. The full native schema's pinned bytes and completed
validation are separate observations. Installed module metadata and initialization
logs must reconcile every expanded local module instance. Prepared archive,
executable, license and metadata; installed provider members; mirror, CLI policy,
lock, original source, copied source and tool bytes are checked before and after
collection. Native source/data cohorts must contain exactly their expected files.
The collector bounds tree traversal and aggregate native output.

The collector opens its owned scratch directory and gives native processes a
short Linux `/proc/<collector-pid>/fd/<directory-fd>` temporary path. This alias
resolves into the same owned physical directory before and after collection;
it avoids the provider startup failure observed with longer nested temporary
paths. The descriptor closes at completion and physical tree removal still runs
if closing fails. Engine cancellation stops descendants and removes the enclosing
owned tree. Tool, source and installed-provider files retain their strict physical
path rules. Trusted execution and coherent receipts do not establish a hostile
project sandbox or whole-machine attestation.

## Evidence and limits

Importing a receipt requires the current canonical root and rechecks the current
physical inputs, tool and prepared artifact bytes. Missing roots, changed cohorts,
omitted phases, malformed/duplicate JSON, unexpected native stderr, cancellation,
timeout and truncated output remain inconclusive. Warnings remain incomplete in
this selected warning-free profile.

Native validity, exit status and complete diagnostic/error/warning counts must
agree. Every finding requires a declared physical source, UTF-8 byte range,
grapheme columns, exact source snippet and coherent highlight offsets. Repeated
module instances can produce the same physical diagnostic twice; both native
observations remain accounted. Native value annotations are bounded observations,
not independently evaluated semantic values.

Validation establishes the selected configuration's internal consistency. It does
not establish resource execution, eventual random values, service access or
runtime ordering of `min` and `max`. Native validation accepted the measured
`min > max` near miss; this check does not claim to reject it.

## Acceptance

The controller runs the preserved provider-free profile, extension source and
fresh offline production-install callbacks, and paired controls in separate
`baseline`, `acceptance`, `guards-1` and `guards-2` phases. Each phase uses a
read-only Linux ARM64 container without networking, UID 1000, two CPUs, 3 GiB and
256 PIDs. Engine invocation deadlines remain 120 seconds. CI runs the four phases
as a matrix with fail-fast disabled.

Original controls cover repeated HCL/JSON modules, type/required-argument and
reference defects, repair, numeric conversion, direct/transitive near misses,
prerequisites, current source, diagnostic ranges/counters, privacy and installed
identity. Lifecycle controls observe the pinned provider's executable and
positive nanosecond CPU scheduling before cancellation, timeout, output limits,
source/copy/module/provider/mirror/policy changes and concurrent cancellation.
They verify observed process disappearance and owned-directory removal. Paired
controls require unchanged callbacks/fixtures, a passing original, the intended
assertion failure under a syntax-checked mutation and a passing restored run.
The altered native input-flag control separately requires completed initialization,
the full provider schema and native validation.

[The measurement](measurements/terraform-extensions-2026-10-11.json) records the exact tested inputs and package. Historical receipts
do not certify later changes. Full artifact/license provenance, wider providers,
languages and platforms, attempt archives, representative project performance and
final Gate A acceptance remain separate. These controls execute no inference or
real-project MCP field evaluation and establish no independent AI host sessions.
