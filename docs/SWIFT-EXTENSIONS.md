# Selected Swift local package and SDK extensions

`swift.build-extensions`, `swift.xctest-extensions`,
`swift.testing-extensions` and `swift.swiftlint-extensions` are explicit opt-ins
using `checktrail.swift-extensions.json`. The original checks retain their contract
in [SWIFT-TOOLS.md](SWIFT-TOOLS.md). Discovery and planning only read declared data;
they never evaluate `Package.swift`, compile a generator or execute a plugin.
Execution requires operator trust at CLI invocation or MCP startup. A project
configuration or tool argument cannot grant that trust.

The selected `declared-local-packages-build-tool-generated-sdk-v1` profile requires
Swift 6.2.3, Swift tools 6.2.0, SwiftLint 0.65.1 and
`aarch64-unknown-linux-gnu`. Its [schema](../schemas/swift-extensions-config.schema.json)
declares every in-root local package, product, target, dependency, build-tool plugin,
generator, generated source and test/support source. The root package has identity
`project` in the owned copy. SDK pins contain bounded relative physical paths,
byte counts and SHA-256 identities. Package and target cycles, repeated identities,
omitted source, outside paths and conflicting source roles are unsupported.

Trusted execution first probes exact runtime versions and verifies every selected
SDK file before any project manifest evaluation. Protected compiler, package-manager,
linter, loader and temporary-directory settings are removed before native probes
and execution. Missing or changed prerequisites return unavailable. The runner
copies the complete inventoried input cohort to an owned directory and uses fresh
HOME, temporary, cache and build paths. It does not certify arbitrary project code
as sandboxed.

Native `dump-package` and `describe` observations must agree with each declared
local dependency, product, target and plugin. The original fixture exercises a
Linux conditional manifest, local producer library and build-tool-generated source.
Implicit generator products and transitive product membership are reconciled.
Native build commands must account for every physical compiler primary-file role,
including the generator's tool and destination compilations, plugin and generated
consumer source. SwiftPM may repeat its plugin compilation in the verbose stream;
other repeated or missing role claims are rejected. Complete bounded generated
trees and artifact bytes are checked before and after execution.

Direct native frontend dependency scans bind every target to selected SDK modules,
headers and macro plugins. Swift 6.2.3 redirects the virtual GNU Glibc header and
module-map addresses to its physical SDK files. The importer requires both actual
native mapping observations and hashes the physical files, even when an unrelated
file exists at the virtual address. Selected Clang directory aliases are resolved
within declared roots. Interface-only modules may have no compiled-module
candidates; when candidates exist, they must match the physical pinned cohort.
Swift, Foundation and Testing macro-plugin participation is required where those
modules are observed. This selected closure is separate from the entire operating
system, runtime loader, publisher and license closure.

Both XCTest and Swift Testing sources are compiled. Their checks separately join
native discovery, typed compiler declarations, complete source/support cohorts,
callback lifecycles, failure addresses and counters. Swift Testing events and XML
must agree while preserving the difference between declarations and parameter
cases. Collection assertion failures may have one native difference message;
unknown or repeated issue-message shapes are rejected. Missing, skipped, stale,
empty, truncated, cancelled or inconsistent evidence cannot pass. SwiftLint checks
every declared original Swift source using explicit `force_try`/`force_unwrapping`
rules and requires complete per-file native participation.

Receipt import requires the current canonical project root and complete inventoried
physical byte cohort, current policy, generated-tree identity, selected tool/SDK
before-and-after hashes and ordered command/artifact accounting. These checks
establish coherence under trusted execution; they do not attest against an operator
who can forge the whole receipt.

The [measurement](measurements/swift-extensions-2026-10-10.json) records all ten
preserved Swift callbacks, nine required source callbacks and the same nine from a
fresh offline production installation. Fifteen paired controls preserve the original
callbacks and fixtures, require assertion failure, restore exact bytes and pass
again. Three mutate native compiler/test invocation code and prove the original
compiled test bodies were reached; they are not mutations of Swift observer source.
Reached cancellation, timeout and output exhaustion check native descendants and
owned temporary cleanup. CI separates acceptance and three guard shards.
The public SDK handoff uses explicit directory traversal and manifest read modes
before atomic publication, so the read-only UID 1000 container can read it. The
[CI handoff repair](measurements/swift-extensions-ci-sdk-handoff-2026-10-10.json)
records a Linux before/after permission check separately from native Swift acceptance.

The mandatory project check passed with optional native skips reported separately.
Subsequent schema generation and strict public-schema parity checks preserved the
configuration's JSON meaning and runtime inputs; the measurement distinguishes
those bytes from the tested pre-publication tarball. Broader Swift/Apple platforms,
arbitrary package settings and remote dependencies, final artifact/license closure,
the complete runtime matrix and Gate A remain open. Fresh native processes do not
prove independent AI host sessions. No inference, held-out scoring or real-project
field evaluation was invoked.
