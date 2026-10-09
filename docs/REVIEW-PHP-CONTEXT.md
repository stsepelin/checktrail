# Captured PHP bindings

Opt-in selection/context version 10 adds `php-selected-bindings-v1` through the shared library, CLI and MCP engine. Versions 1–9 retain their previous behavior. Version 10 retains the expanded bounds: 32 selected paths, 64 KiB UTF-8 bytes per source, 1 MiB combined immutable-base/current bytes, 64 revision views and an independent 8 MiB context ceiling.

```json
{
  "schemaVersion": 10,
  "track": "snapshot",
  "currentSource": "working-tree",
  "files": ["policy/policy.php"],
  "supportFiles": ["consumer/consumer.php"],
  "moduleRoots": ["."],
  "topics": []
}
```

One to sixteen explicit disjoint relative roots select captured PHP source. The collector reads pinned parser assets and captured strings; it never loads PHP, Composer, project configuration, includes or autoloaders. Whole selected function, declaration/default and decision ranges retain revision-bound addresses. Deleted/moved base consumers and working/index consumers remain separate.

Literal names use separate function, constant and namespace import tables in their file and namespace block. Grouped imports retain each member's kind and alias. Fully qualified names bypass aliases; relative namespace names use the current namespace; qualified names consult namespace aliases. Function names and aliases are case insensitive within the ASCII identifier subset; constant aliases and final constant identifiers are case sensitive. Imports apply after their declaration rather than retroactively to earlier function bodies. A variable named like a function alias does not mask an ordinary named function call; a variable call remains unresolved. These distinctions follow PHP's [name resolution rules](https://www.php.net/manual/en/language.namespaces.rules.php) and [import rules](https://www.php.net/manual/en/language.namespaces.importing.php), with original trusted native controls for the implemented subset.

Only unconditional selected named functions and namespace constants introduce supported declaration bindings. Conditional/nested function declarations, duplicate definitions, class constants, object/static/variable calls and parenthesized callable expressions retain unknown or partial metadata. A missing selected namespaced function is not proof that runtime global fallback wins. Namespace imports spread over several selected files retain an ambiguous file address; an exact function name can still have a unique selected declaration. Namespace prefix boundaries are exact. Labels and named-argument keys are not constant references.

A literal `__DIR__ . '/relative/path.php'` include/require can identify another selected same-revision file under the declared roots. Single-quoted literals and double-quoted non-interpolating literals with the supported PHP escape subset can resolve. Unsupported escapes, plain relative paths, include-path lookup, dynamic expressions, loading order and Composer/autoload behavior remain unknown. A selected file address never proves that PHP loaded it. Imports in one file or namespace block do not supply aliases to another.

Reverse caller closure starts at primary PHP functions, follows selected named calls and stops at eight levels or its edge ceiling. Captured source does not establish runtime reachability, native name resolution, loading or finding truth. Full impact fallback and unchanged validation planning remain explicit. Other languages retain their existing syntax metadata with unresolved language-specific bindings.

Syntax has independent node/depth/record and 256 KiB metadata bounds. Additional binding metadata exceeding its ceiling rejects capture. Missing or changed parsers, malformed syntax and exhausted records cannot become collected views. Context intake reconciles roots, derived call/import counters, canonical omission states and caller closure; a recomputed context digest cannot bypass those checks. Summaries withhold source and binding metadata. MCP arguments grant neither source disclosure nor execution trust.

The original `context-php` callbacks cover broken/fixed predicate witnesses, declaration/default and complete decision ranges, moved and dynamic consumers, base/current/index bindings, alias ordering and case boundaries, grouped imports, conditional/duplicate definitions, literal loading anchors, parser prerequisites, empty/exhausted capture, source/root/caller bounds and CLI/MCP privacy. Reached trusted native cancellation, timeout and output exhaustion require the parent and reaped child to disappear. Atomic identity publication prevents partial JSON reads. Owned native artifacts are removed. Fresh locked offline production installation runs the same compiled callbacks against the installed engine. Compiling guard mutations must fail original assertions and pass again after restoration.

The native PHP interpreter is unavailable on the measured host PATH; those optional host callbacks are reported skipped. The required pinned Linux ARM64 profile and its installed controls remain separate acceptance. Exact evidence is recorded in [php-context-2026-10-08.json](measurements/php-context-2026-10-08.json). These synthetic controls invoke no AI inference or field evaluation and establish no accuracy comparison. The remaining language/assembly profiles, runtime matrix, artifact/notice closure and independent protocol remain Gate A obligations.

The shared [nested-call identity repair](REVIEW-CALL-IDENTITY.md) adds fresh original source and installed-package controls for calls that share a start offset. Its supplemental record binds the changed resolver and callback bytes.
