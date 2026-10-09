# Captured Python bindings

Opt-in selection/context version 8 adds `python-selected-bindings-v1` to the shared library, CLI and MCP context engine. Versions 1–7 retain their previous behavior. Version 8 uses version 7's 32 selected paths, 64 KiB UTF-8 bytes per file, 1 MiB combined base/current source, 64 revision views and independent 8 MiB context ceiling.

```json
{
  "schemaVersion": 8,
  "track": "snapshot",
  "currentSource": "working-tree",
  "files": ["pkg/policy.py"],
  "supportFiles": ["pkg/consumer.py"],
  "moduleRoots": ["."],
  "topics": []
}
```

One to sixteen explicit, disjoint, relative module roots identify selected `.py` files. Root order does not choose between duplicate module names: those imports remain ambiguous. The collector loads fixed packaged parser bytes and reads captured strings. It never imports Python source, invokes Python, reads project parser configuration or discovers unselected consumers. Native witness execution in the synthetic acceptance suite is separate trusted execution.

Whole selected function, declaration/default and decision ranges retain exact revision-bound source addresses. Literal direct and `from` imports, aliases and relative package imports can resolve to captured modules in the same revision. Undecorated named functions can resolve through lexical scopes, selected import bindings and bounded reexports. Parameter, assignment and destructuring bindings mask outer names; method lookup skips the enclosing class namespace; default expressions use the enclosing scope. Member calls resolve only through an exact selected module receiver, never an arbitrary object or a same-prefix identifier.

The reverse caller closure starts at selected primary Python functions, follows retained lexical calls and stops at depth eight or its edge ceiling. Calls with no enclosing function remain in the call inventory without becoming function caller edges. The closure does not prove execution or identify every changed consumer. Deleted base callers and current/index callers remain separate, bound to their source revisions.

Runtime rebinding, dispatch and unselected source always remain explicit omissions and force full impact fallback. Wildcard imports, global/nonlocal/delete or pattern scope mutation, decorated bindings, unresolved imports, object calls, lambdas/comprehensions, generic type scopes and other unsupported bindings remain unresolved or partial. Unicode identifier normalization is not inferred. Namespace packages, installed packages, Python import hooks and broader node forms are outside this profile. Validation plans remain unchanged; runtime reachability and findings remain unverified.

Syntax retains its independent node, depth, record and 256 KiB metadata bounds. Missing or changed parser assets, malformed input and exhausted syntax cannot become collected views. Additional Python metadata exceeding its ceiling rejects capture rather than producing a complete context. Reconstructed contexts reconcile module roots, derived call/import counts, omission states and caller edges; a recomputed digest cannot bypass these checks. Summaries withhold source and binding metadata. MCP tool arguments grant neither source disclosure nor native execution.

The original `context-python` controls cover broken/fixed/native near misses, moved and shadowed callers, default scopes, immutable base/current/index bindings, parser-byte prerequisites, exact source/root/caller bounds, coherent reconstruction forgeries, empty/exhausted syntax and shared CLI/MCP trust boundaries. Reached native cancellation, timeout and output exhaustion verify the parent and reaped child disappear. Fresh offline installation executes the same compiled callbacks against the installed production engine. Compiling binding guard mutations must fail original assertions and pass again after restoration.

Revision-specific receipts are recorded in [python-context-2026-10-08.json](measurements/python-context-2026-10-08.json). Wider language/assembly profiles, the complete runtime matrix, artifact and notice closure, independent evaluation protocol and the rest of Gate A remain open. These synthetic controls invoke no AI inference or field evaluation and establish no review-quality comparison.
