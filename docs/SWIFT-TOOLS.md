# Bounded Swift native tools

The bounded SwiftPM build, XCTest, Swift Testing and SwiftLint profile has native
source and offline installed-package evidence. The
[measurement receipt](measurements/swift-tools-native-2026-10-06.json) pins the
implementation, runtime, harness and controls. Broader E14 profiles and Gate A
remain open.

`swift.build`, `swift.test` and `swift.swiftlint` share the CLI/library/MCP engine.
Select checks in `checktrail.json` and declare complete scope in
`checktrail.swift-tools.json`, using the published
[configuration schema](../schemas/swift-tools-config.schema.json). The original
[example](../examples/swift-tools) includes complete configurations. Without that
configuration, an explicitly selected check is unavailable. Existing
`swift.syntax` is independent and does not evaluate Package.swift.

## Declared native scope

The measured profile uses Swift and SwiftPM 6.2.3, package tools version 6.2.0,
`aarch64-unknown-linux-gnu`, and SwiftLint 0.65.1. Declare library/executable
products, regular/executable/test targets, target dependencies and every
inventoried Swift source exactly once. Every test-target source is either a test
file or an explicit support file. Planning reads data without evaluating the
manifest or invoking a tool. Execution evaluates Package.swift and executes
compiler, test and lint code under operator trust; MCP arguments cannot grant it.

The native manifest and describe output must match the declaration. External
package dependencies, plugins, resources, build settings, exclusions, platform
conditions and wider manifest formats are unsupported in this profile. Inputs
are bounded canonical regular files; changing original or copied inputs invalidates
the collection. Fresh owned HOME, temporary, configuration, cache and build output
directories prevent project-local output reuse. The engine installs or fetches no
dependencies. Protected host options cannot select a different SDK, compiler,
filter or lint configuration through an environment override.

A successful build requires actual frontend participation across the complete
declared source set, with the declared module and target. Source diagnostics must
agree with native exit status. Infrastructure errors do not become source findings.
A filename in stdout alone is not compiler participation.

## Tests and lint

For XCTest, native discovery and compiler AST declarations bind callback names to
physical source methods. Every declared test file receives an AST collection,
including its target's support sources. The sequential native lifecycle must
reconcile started/ended callbacks, every nested suite's totals, failures and skips.
Direct XCTestCase subclasses and unambiguous no-argument test methods are the
measured grammar; other inheritance and discovery forms remain unsupported.

Swift Testing uses physical compiler macro attributes, unfiltered native discovery,
V0 event declarations and method/case lifecycles. Native test IDs and source points
must agree with the compiler. Parameter cases are counted separately from methods;
XML method totals and issue counts are reconciled without substituting them for
executed-case totals. Numeric XML references are decoded once. The measured profile
covers top-level Test macros; Suite/nested tests and wider traits need separate
acceptance. Unsupported events, known issues and ambiguous locations stay incomplete.

Native failures yield source-bound findings. Those locations identify the failing
callback or diagnostic; they do not establish a production mechanism, severity or
remedy. Empty, skipped, filtered, interrupted, stale and malformed collections
cannot pass. An unavailable toolchain is incomplete rather than a source defect.

SwiftLint uses an owned config with the explicit `force_try` and
`force_unwrapping` rules, explicit source arguments, strict error severity and no
cache. Native progress and final inspection counters must account for every source,
and diagnostics must use the exact enabled rule identifiers. Progress counters
may arrive out of order; the validator requires a unique complete set within the
declared bound. An observed native `1, 3, 2` ordering exposed the former sequential
assumption. The pinned [concurrent visitor](https://github.com/realm/SwiftLint/blob/0.65.1/Source/SwiftLintFramework/Configuration%2BCommandLine.swift)
allocates counters before queuing output; reordered valid receipts pass, while
duplicates, omissions, out-of-range counters and wrong totals stay incomplete. Repository exclusions
cannot narrow the owned invocation. This profile rejects any `swiftlint:` source
marker, including one inside a literal; it does not yet parse audited suppressions.
Repeated source basenames and wider rules/configuration need another profile.

## Evidence and cancellation

Receipts bind raw output, artifacts, ordered native arguments, declared source and
options, before/after tool entry bytes and fresh owned output. This checks coherence
under trusted execution. It is not hostile-project attestation, complete SDK
provenance or an OS sandbox. The acceptance image and release archive are pinned;
full SDK, publisher and license closure remains E6 work.

The reached XCTest cancellation control starts a real compiled helper that enters
a separate process group. The shared POSIX runner now snapshots observed ownership,
checks identities before signaling descendants, stops descendants before waiting
parents, and then stops the original process group. Original-group membership preserves
actual ancestry depth; an in-group parent/child red control guards that ordering. This is measured cleanup of
observed descendants on Linux/macOS, not containment of arbitrary double-forking
or malicious processes. Windows execution remains unsupported.

## Required acceptance and preparation

The `swift-tools` required profile names original callbacks and requires each one
to pass without skips. It covers boundary regressions and repair, support sources,
forced-unwrap diagnostics and literal near misses, empty/skipped/lifecycle errors,
input changes, forged native scope/commands/compiler/case/counter/artifact evidence,
CLI/MCP privacy and startup trust, and reached native cancellation/output cleanup.
Compiling guard experiments select exactly one original callback and require a
failure at its intended assertion; unrelated setup failures are not acceptance.

From a prepared ARM64 checkout, explicitly prepare and verify the runtime:

```sh
npm run build
CHECKTRAIL_TEST_TASK=original-swift-task node scripts/prepare-swift-tools-runtime.mjs
node scripts/prepare-package-cache.mjs
node scripts/verify-swift-tools-container.mjs
```

The runtime preparer acquires pinned public Swift/Node images and the exact
SwiftLint release archive, verifies raw/extracted binary hashes, preserves the
archive's license files and builds with networking disabled. These are operator
preparation commands; the engine never runs them. `CHECKTRAIL_SWIFTLINT_ARCHIVE`
can select the exact already-acquired regular archive instead of downloading it.
Preparation refuses an existing destination or owned runtime tag.

Acceptance separately runs source and a fresh offline production installation,
with lifecycle scripts disabled and the harness/client/fixtures outside the
installed package. Containers use networking disabled, CPU/memory limits and
readonly source/consumer mounts. Container scratch is writable; this is not an
OS containment guarantee. Agents on this Mac use the shared foreground dev-env
lifecycle. At task end stop owned foreground work, verify status and run
`node scripts/cleanup-swift-tools-runtime.mjs`; cleanup verifies the owned tag and
refuses while an owned container remains, preserving code and artifacts.

No inference or real-project field evaluation is part of this acceptance.
Hosted CI for this revision, other native OS/architecture/SDK versions, broader
frameworks, full provenance and representative-project performance remain
unverified. The host macOS command-line SDK could not resolve XCTest/Testing;
that failed attempt is recorded rather than promoted as native test support.
