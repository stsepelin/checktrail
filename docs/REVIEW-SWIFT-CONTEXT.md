# Selected Swift source bindings

Opt-in context version 18 adds `swift-selected-bindings-v1` through the shared library, CLI and MCP engine. Earlier context versions retain their selection shapes and profiles. The expanded limits remain 32 paths, 64 KiB per file, 1 MiB combined base/current source, 64 views and a separate 8 MiB context limit.

```json
{
  "schemaVersion": 18,
  "track": "snapshot",
  "currentSource": "working-tree",
  "files": ["src/policy/Policy.swift"],
  "supportFiles": ["src/consumer/Consumer.swift"],
  "moduleRoots": [
    { "directory": "src/policy", "module": "Policy" },
    { "directory": "src/consumer", "module": "Consumer" }
  ],
  "topics": []
}
```

Swift source files do not declare the compiler's module name. One to sixteen disjoint canonical relative directories therefore carry explicit operator-declared, unique plain ASCII module labels, bounded to 256 characters. These labels select source candidates; they do not certify a SwiftPM target, a native module or the compiler's build selection. A directory basename is never substituted for the declared label. Capture reads immutable strings with the fixed pinned parser and invokes no compiler, manifest, initializer or module loading.

The bounded subset retains plain top-level and local functions, plain positional/labelled/default parameters, immutable literal top-level lets, exact imports and same-module or exact module-qualified calls. Unqualified lexical parameters and earlier local values mask function candidates. Forward local function candidates are visible in their enclosing captured function. Default expressions use enclosing scope rather than the function's parameters, while retaining their function and parameter-initializer source ownership. Own-module qualification remains a selected candidate; a same-spelled lexical value makes that receiver unknown. Private/fileprivate declarations remain limited to their selected file, internal declarations to the declared selected module and public declarations to selected foreign import candidates.

Whole declaration, initializer, default and touched decision ranges retain base/current/index identities. Deleted and moved consumers remain separate revision inputs. Declaration names, parameter/type/argument labels, comments and literal text are not constant reads. Argument values and adjacent default expressions remain reads with exact ranges and owner identities. Only literal immutable constants receive provenance edges; a nonliteral global does not become a proven value. Duplicate/overloaded selected names remain ambiguous rather than claiming type-directed overload resolution. Calls use complete start/end identities so an outer `factory()()` cannot inherit the inner named target.

Classes, structs, enums, extensions, protocols, members, generics, attributes, concurrency, throwing functions, inout/ownership/variadic parameters, closures, loops, switch/guard/do/catch/defer and mutation scopes remain unknown. Unsupported exported function scopes also make their foreign candidates unknown. `Package.swift` is a manifest and conditional source directives remain unknown; intake reconstructs these omissions from both source revisions. A selected module import with several captured file candidates remains ambiguous in the single-file import ledger. Every unknown keeps full impact fallback and the validation plan unchanged. Caller depth is bounded to eight, counts reconcile with captured calls/imports, and native name resolution, module loading and runtime reachability stay false.

The required synthetic profile uses immutable official Swift 6.2.0 and Node 22.23.2 images. It is separate from the existing SwiftLint adapter runtime, whose pinned image reports Swift 6.2.3. Capture and native execution have separate authority: the latter requires operator trust. Original fixtures compile directly with fixed `swiftc` argument arrays and an explicitly owned module cache, without evaluating SwiftPM or project configuration. Required source and fresh locked offline production-install callbacks reject skipped, unavailable, empty and stale evidence. Trusted lifecycle controls compile an original waiting parent that reaps its child and require reached cancellation, timeout and output exhaustion to remove both identities and owned outputs. These witnesses do not certify universal compiler cancellation or kernel containment.

Compiling guard mutations must fail original assertions, preserve callback bytes and restore each source immediately before a final baseline run. Dedicated native containers have a read-only root, no network, read-only source/consumer mounts, two CPUs, 2 GiB memory, 256 PIDs and an explicitly executable owned temporary filesystem. The source harness uses 512 MiB and the installed harness 256 MiB. Other context profiles retain their mount policies. Host-native callbacks without the selected Linux compiler are explicitly skipped; those skips are not required acceptance. Wider context, assembly, artifact/license, exact runtime-matrix and independent-evaluation obligations keep Gate A open. No inference, field evaluation or comparative accuracy is measured here.
