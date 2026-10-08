# Selected Ruby source bindings

Opt-in context version 17 adds `ruby-selected-bindings-v1` through the shared library, CLI and MCP engine. Earlier versions retain their profiles. The expanded limits remain 32 paths, 64 KiB per file, 1 MiB combined base/current source, 64 views and a separate 8 MiB context limit.

```json
{
  "schemaVersion": 17,
  "track": "snapshot",
  "currentSource": "working-tree",
  "files": ["src/policy/Policy.rb"],
  "supportFiles": ["src/consumer/Consumer.rb"],
  "moduleRoots": ["src"],
  "topics": []
}
```

One to sixteen disjoint canonical relative roots select immutable captured strings. Fixed pinned parsers receive those strings; capture invokes no Ruby interpreter, require, initializer, gem, project configuration or test. It retains whole singleton method and literal constant/default-parameter ranges, touched Ruby decisions and bounded callers with base/current/index identities, including deleted consumers. Selected candidates do not certify actual Ruby loading or runtime exports.

The bounded subset accepts one plain ASCII, flat top-level module per selected `.rb` file, ordinary `def self.method` definitions with plain positional and default parameters, literal module constants, exact module receivers, absolute `::Module` receivers, implicit/self calls inside known singleton methods and literal `require_relative` file candidates. Selected module names and methods must be unique. Duplicate definitions and reopening remain ambiguous rather than asserting Ruby's runtime definition order. Import file candidates are normalized within the selected roots; unknown or outside files keep full impact fallback.

Ruby's [assignment rules](https://docs.ruby-lang.org/en/3.3/syntax/assignment_rdoc.html) distinguish bare identifiers from explicit method calls. Parameters mask bare reads. A local assignment becomes visible when the parser encounters its left side, including its own initializer; a bare name before that assignment can remain a method candidate. Explicit parentheses and `self` retain method calls despite a same-name local. Original pinned Ruby 4.0.7 witnesses exercise these behaviors and default-parameter reads. Local variable receivers remain unresolved. Constant aliases are not treated as modules, and a module-local constant can shadow an unqualified module receiver; an absolute receiver bypasses that local spelling. An absolute root constant does not inherit a module's literal binding.

Calls use complete start/end identities so an outer `factory().call` cannot inherit the inner named method's target. Declaration, parameter and method names and inert literal/comment contents are not call or constant-read evidence. Literal constants retain reference provenance; nonliteral values do not. Ruby `if`/`elsif`/`unless`, binary expressions, conditionals, case/loop forms and modifier decisions retain their whole captured ranges even where binding resolution remains unsupported.

Classes, instance/dynamic methods, nested modules/methods, mixins, visibility changes, metaprogramming, dynamic imports, unsupported parameters, blocks/lambdas, loops and loop modifiers, case patterns, rescue/ensure, yield/super and destructured/operator assignments remain unresolved or partial. Unsupported method scopes propagate to their exported candidates. Module initialization other than a literal require-relative edge makes the module unknown, including constant-visibility changes. Source encoding markers other than UTF-8 and `__END__` data tails remain unknown; intake derives those omissions again from both captured revisions. These are conservative source boundaries, not evaluation of Ruby encodings or data sections.

Reverse callers start at selected primary `.rb` functions and stop after eight levels or the edge ceiling. Syntax and metadata are bounded. Missing/changed parser bytes, empty, malformed or exhausted capture and outside roots cannot establish complete coverage. Intake reconciles roots, call/import counts, canonical omission state and caller closure. Full impact fallback and unchanged planning remain mandatory. Native name-resolution, module-loading and runtime-reachability flags stay false. Summary projections withhold source and bindings; MCP arguments grant neither disclosure nor operator execution trust.

The required `context-ruby` profile uses original broken/fixed/near-miss native outcomes, parser-order and exact-name controls, revision/index/deleted-consumer cases, missing and valid-but-altered parser bytes, exact source limits, shared CLI/MCP privacy and a fresh locked offline production installation. Capture-side initializer markers must remain absent. Trusted native lifecycle controls use a waiting parent that reaps its child; reached cancellation, timeout and output exhaustion require both identities to disappear and owned worker artifacts to be removed. They do not certify every possible Ruby child lifecycle or kernel containment.

Compiling guard mutations must fail original assertions, preserve callback bytes and restore each source immediately before a final baseline run. [ruby-context-2026-10-09.json](measurements/ruby-context-2026-10-09.json) records the measured profile. Tested package hashes precede that record and are not final release acceptance. Optional host-native callbacks are explicitly skipped without the pinned runtime; every required Linux ARM64 callback must pass. Wider context, assembly, runtime-matrix, artifact/license and independent-evaluation obligations keep Gate A open. No inference, field evaluation or comparative accuracy is measured here.
