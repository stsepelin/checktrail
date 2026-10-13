# Declared .NET generators and compiled test methods

The opt-in `dotnet.generator-extensions` check combines fresh locked offline
builds, declared incremental generators, native NUnit execution and compiled
method provenance through the shared library, CLI and MCP engine. Planning reads
configuration and selected tool bytes; execution requires operator trust.

Declare the existing `checktrail.dotnet-build.json` project/source/dependency
contract and add `checktrail.dotnet-generator.json`:

```json
{
  "schemaVersion": 1,
  "profile": "compiled-method-and-project-reference-v1",
  "projectReferences": [
    {
      "consumer": "Tests/Tests.csproj",
      "producer": "Library/Library.csproj",
      "kind": "assembly"
    },
    {
      "consumer": "Library/Library.csproj",
      "producer": "Generator/Generator.csproj",
      "kind": "analyzer"
    }
  ],
  "incrementalGenerators": [
    {
      "project": "Generator/Generator.csproj",
      "className": "Example.OriginalGenerator"
    }
  ]
}
```

The example names describe a declaration shape. Each named file, generated role,
source, lockfile and dependency artifact must exist under the build contract.
Every observed project reference must match the complete declared acyclic graph.
Generator declarations must match the build's C#/VB generated-source roles and
analyzer project edges. The selected generator class must implement the compiled
`IIncrementalGenerator` contract, contain `Initialize` and participate in emitted
native outputs. An unknown property cannot grant trust or add an execution flag.

## Native bindings

The selected Linux ARM64 SDK is `10.0.401`, with runtime/reference pack `10.0.12`.
Selected SDK/compiler/runtime bytes are verified before a version invocation and
again during receipt import. Testhost patch resolution uses `LatestPatch` because
its net10.0 declaration requests `10.0.0`; the selected runtime inventory remains
exactly `10.0.12`. Engine-owned identity helpers request `10.0.12` with roll-forward
disabled. This is a selected component binding, not complete SDK/license closure.

An original PE/portable-PDB reader records method definition tokens, signatures,
source documents and visible sequence points for each declared module. A separate
pinned NUnit observer captures every leaf's actual reflected method and receiver,
module MVIDs, raw method signature, parameter signatures, scalar arguments and
complete base chain. Native loaded modules, assembly/PDB digests, helper/framework
bytes, arguments, working directory, launcher PID and raw output hashes must
reconcile with the build and phase ledger.

Overloaded methods bind to their complete compiled signature. Multiple parameter
cases may share that method token while retaining distinct native case identities.
Inherited methods bind to the declaring module and physical method source. That
module may be a declared producer assembly copied into the consumer's test output.
NUnit's declaring `ClassName` and receiver `TypeInfo` have separate roles; a custom
display name does not choose the source file. Every method's source must have one
declared physical document and a visible portable-symbol point. VSTest discovery,
native NUnit discovery/results and TRX identities/outcomes must agree for every
selected case, through the existing test evidence parser.

Native capture and internal receipt reconciliation do not authenticate imported
execution histories. They do not verify a test's assertion, production impact,
review finding, severity or confidence. Unused metadata remains descriptive;
method provenance requires an actual loaded receiver/declaring-module binding.

## Bounds and unsupported cases

The strict policy permits at most 64 generator roles and 256 project edges and
requires at least one test project. The estimated complete native call closure
must fit the runner's 80-call bound. Native discovery is limited to 20,000 cases
and nodes, an inheritance depth of 64, and bounded finite scalar argument values.
Complex argument objects, open generic methods/fixtures, unresolved or external
base classes, ambiguous source documents, unsupported signatures and incomplete
native trees remain inconclusive. Selected class names use the existing flat
namespace/class declaration contract. This does not implement arbitrary test
frameworks, project layouts, target frameworks or generator shapes.

Changed source, policy, dependency inventories/manifests or selected SDK bytes
invalidate saved passing and compiler-failure receipts. Empty, omitted, malformed,
all-skipped, cancelled, timed-out and truncated evidence cannot pass. Summaries
withhold native case/source prose and absolute paths unless the operator selects
detailed output. MCP arguments cannot grant execution or disclosure permission.

Public acceptance fixtures are original C#/F#/VB producers and consumers with
same-assembly and cross-assembly inherited methods, same-arity overloads, custom
names and parameterized boundaries. Reached lifecycle controls execute a real
NUnit method body before cancellation, timeout or bounded output capture, then
check its testhost/client/child processes and owned temporary storage.

The profile remains separate from whole artifact/license closure, the final
runtime matrix, independent AI review/evaluation and Gate A closure. No model
inference or real-project field evaluation is performed by native acceptance.
