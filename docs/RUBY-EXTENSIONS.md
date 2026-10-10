# Selected Ruby manifest and test extensions

`ruby.rubocop-extensions`, `ruby.rspec-extensions` and
`ruby.minitest-extensions` are explicit opt-ins using
`checktrail.ruby-tools.json` version 2. The original version-1 checks retain their
literal-manifest contract in [RUBY-TOOLS.md](RUBY-TOOLS.md). Neither discovery nor
planning evaluates Ruby. Before version-2 native restoration or manifest evaluation,
the runner checks the selected interpreter and exact Bundler version using only
standard runtime code. Missing or incompatible prerequisites are unavailable. Execution still requires operator trust; repository
configuration and MCP arguments cannot grant it.

The selected profile is `declared-manifests-shared-and-inherited-v1`. Its policy
lists every evaluated manifest, exact locked dependency requirement, native
inclusion/platform result, and project RSpec hook source with registration and
invocation counts. `Gemfile` is required. Manifest paths are relative, bounded,
regular inventoried source files; duplicates and escapes are rejected. The
complete frozen lockfile and checksummed offline gem repository remain required,
including dependencies used transitively when their direct declaration is
excluded. The three checker gems must be active.

Operator-trusted native execution observes grouped and platform declarations,
`install_if` and declared `eval_gemfile` paths through pinned Bundler. Both offline
restore and tool execution retain evaluated manifest byte hashes and actual
requirements, groups, platforms and inclusion results. Bundler's
`should_include?` combines its exclusion predicates; `current_platform?` is also
recorded. The evaluated source inventory must contain only the selected public
RubyGems remote. Git, path and plugin sources are unsupported. The recipe uses
`bundle install --local`, frozen checksums and a fresh owned install; it does not
fetch missing gems. A trusted manifest is executable project code, and Checktrail
does not turn that execution into an OS security sandbox.

RSpec receipts join each registered, started and finished example to its physical
block, selected receiver file, file-qualified native group ancestry and shared
example inclusion locations. Example descriptions must match the native case
rows. Project before, after and around hooks retain physical registration sources
and actual entry/return events. Counts include both example and context hooks;
the original fixture uses two receiver files so context identity and repeated
shared registrations are exercised. Suite hooks and around-context hooks are
unsupported. Repeated invocation of an indistinguishable hook for the same
case/kind/source is rejected rather than silently collapsed.

Minitest observes the actual `UnboundMethod` source and declaring owner, receiver
constant source file, ancestry and method identifier. A method declared in a
support class may run through a selected subclass. Discovery, starts, results,
assertion counts and summary must reconcile. Empty, skipped, outside-error,
omitted or interrupted cohorts cannot pass.

Version-2 receipt import requires the current project root. It checks the complete
current inventoried source set, captured file bytes, current policy, frozen
manifest/lock closure, repository manifest and complete archive tree. Restore and
native observer hashes, fresh installed artifact inventories, native tool entry
points, process flags and phase/output identities must also agree. These checks
establish coherence of bounded native observations, not cryptographic attestation
against an operator who can forge every receipt.

The named `ruby-extensions` acceptance profile requires all nine callbacks from
the frozen Gate A inventory. Its fresh package harness installs production
packages offline, with lifecycle scripts disabled, and executes the same nine
callbacks outside the installed package against shipped engine/CLI bytes. Thirteen
paired controls mutate importer or native observer behavior; native mutations
must reach real test bodies, fail assertions and pass again after byte restoration.
CI runs acceptance and three distinct guard groups in parallel. Required callbacks
use fresh processes and finite budgets; these are native test processes, not
independent AI host sessions.

The multi-tool broken, fixed and near-miss callbacks validate each selected tool
with a separate engine request and original fixture. This retains every tool and
assertion while giving each restore/check the engine's unchanged 120-second
aggregate request budget. The callback and guard-process envelopes allow up to
20 minutes for those sequential requests; deliberate lifecycle deadlines remain
unchanged. The original measurement binds its earlier tested callback bytes;
subsequent [CI repair evidence](measurements/ruby-extensions-ci-request-isolation-2026-10-10.json) is tracked separately.

The prepared runtime uses pinned MRI 4.0.7, Bundler 4.0.20, RuboCop 1.91.0,
RSpec Core 3.13.6 and Minitest 6.0.6, with signed/checksummed compiler archives.
Native package restoration compiles selected source gems in an owned directory.
Broader Ruby engines, Rails integration, binary-platform gems, arbitrary project
plugins, final operating-system/runtime acceptance and complete native artifact
license closure remain outside this selected profile. Gate A remains open. No
inference, held-out scoring or real-project field evaluation is invoked.
