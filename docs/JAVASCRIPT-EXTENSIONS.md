# Declared JavaScript extensions

`checktrail.javascript.json` selects three independent, strict data-only profiles.
Select their check IDs in `checktrail.json`. Discovery and planning read files and
resolve contained installed tools; they never import a loader, ESLint config or
Vite project configuration. Execution requires operator trust through the shared
library, CLI or MCP engine. These checks execute trusted project/tool code.

```json
{
  "schemaVersion": 1,
  "eslint": { "sourceParticipation": true },
  "nodeTest": {
    "loaders": [
      {
        "kind": "import",
        "path": "test-loader.mjs",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
      }
    ]
  },
  "library": {
    "sourceDirectory": "lib",
    "entry": "lib/index.ts",
    "consumers": ["consumer.ts"]
  }
}
```

The example hash is a placeholder. Compute the SHA-256 of the actual loader
bytes. At least one profile is required; omit unused profiles. Paths are contained
project-relative files/directories. The published contract is
`schemas/javascript-config.schema.json`.

## ESLint source participation

Select `javascript.eslint`. The opt-in contract requires ESLint 10.11.0 and
`@eslint/config-array` 0.23.5 with selected native API byte pins. Physical source
and flat configuration bytes are bound before importing configuration, and checked
again after linting. Every source is canonical UTF-8, including any BOM.

The observer wraps the actual selected native language and processor methods,
including recursively selected virtual-file configurations. It records ordered
preprocess, parse and postprocess events with path, byte length and SHA-256. Every
generated leaf must reach its native parser with effective enabled rules, even
when two leaves are identical. An unruled processor container can pass when its
parsed leaves have rules; an unruled leaf cannot borrow the container's rule count.
Empty, ignored, unconfigured, omitted, reordered or opaque leaves cannot pass.
Parser errors and ordinary native rule errors/warnings retain their diagnostics.
Processor diagnostics retain native messages and raw coordinates in detailed
process evidence. Structured findings omit an unverified physical line mapping
and remain findings-incomplete when processors report diagnostics.
Private language receivers retain their original state, and callbacks run once.
The original methods and configuration lookup are restored in `finally`.

Generated arrays must be dense plain arrays, and named blocks must expose own
string data properties for `filename` and `text`. Accessors, proxies, sparse
arrays, malformed Unicode and unsupported output representations remain
incomplete. The observer does not execute getters to describe their results.

Without this opt-in proof, a configured processor remains incomplete under the
legacy adapter: zero native diagnostics alone do not establish source checking.
Source participation establishes that native methods received source; it does not
establish arbitrary plugin/parser/rule correctness or resist hostile trusted code.
Whole plugin/dependency/license closure is a separate Gate A obligation.

## Declared Node loaders

Select `javascript.node-test`. Declared `import` and `require` hooks expand native
candidate discovery to `.test`/`.spec` files with JS/TS, ESM and CJS extensions.
Each hook must be inventoried, unique and match its declared SHA-256. Planning
imports nothing. The runner checks hooks and test bytes before launching tests,
and repeats those checks after native execution. Receipts bind the planned Node
version, ordered hooks and exact test-file collection.

Node's native preload order applies: `require` hooks precede `import` hooks, with
order retained within each kind. Tests use process isolation and the native test
runner; built-in type stripping is disabled with the compatible
`--no-experimental-strip-types` flag. The declared hooks must therefore handle
selected typed files themselves. Synchronous ESM/CJS hooks and an asynchronous
ESM hook have original native controls. Arbitrary hook combinations keep their
native behavior; incompatible combinations cannot pass by omitting summaries.

The bounded runner accepts Node 22.15+ within major 22, and majors 24 and 26.
That execution prerequisite does not certify every version/platform. Every
selected file must emit its own native case summary and a single global summary
must reconcile with those cases. Empty, skipped-only, cancelled, malformed or
partially loaded collections remain incomplete. Hooks may import dependencies;
the selected entry hash does not certify their entire transitive closure.
The undeclared JavaScript adapter retains its original explicit runner selection.

## Native library and downstream declarations

Select `javascript.vite-library`. The bounded profile requires Vite 8.3.0,
Rolldown 1.2.9 and TypeScript 6.0.3. Selected builder/compiler APIs and measured
ARM64 native bindings are checked before import and after execution. Current
binding selection covers macOS ARM64 and Linux ARM64 musl; other native platforms
remain unavailable. This does not close the final Gate A runtime matrix.

The source directory selects every inventoried `.js`, `.mjs`, `.cjs`, `.ts`,
`.mts` and `.cts` file beneath its exact directory boundary. JSX/TSX and other
source families are outside this profile. The entry must belong to that collection. Consumers
must be distinct inventoried files outside it and import `checktrail:library`.
Both ESM and CJS formats are built with the native programmatic Vite builder and
fixed library options. Project Vite configuration/plugins are not loaded by this
profile. Every selected library source must participate in the native module graph;
unreachable files cannot silently disappear from coverage.

TypeScript checks producer source with strict checking and creates fresh
in-memory declarations. Consumer programs resolve `checktrail:library` to that
fresh entry declaration and can reach its freshly emitted relative declarations.
Persisted build outputs and `.tsbuildinfo` cannot supply that declaration root.
The adapter reconciles native source collections, consumer resolutions, nonempty
declaration artifacts, two entry chunks and equal export collections. Type errors
retain native diagnostics. A failed producer/consumer program does not claim a
complete Vite build; its findings-completeness flag remains false.

External imports, dynamic/multiple chunks, assets, virtual modules, source outside
the declared directory, declaration-only libraries and other build profiles do
not meet this bounded contract. Build evidence does not claim runtime behavior
of published exports. Existing TypeScript solution/reference checking retains
its separate [contract](TYPESCRIPT-BUILD.md).

All declarations and bundle outputs are in memory. The shared runner owns the
temporary directory and bounded native phase marker and removes them on completion
or reached cancellation. Original controls cover config/hook cancellation, timeout
and output exhaustion with detached descendants, producer-phase cancellation,
normal owned-directory cleanup and library output exhaustion. Broader owner-loss,
hostile process behavior and Windows lifecycle certification remain separate.

Manifests are limited to 64 KiB; each source is at most 8 MiB. ESLint selects at
most 256 files and 3,072 events per file, with at most 1,024 processor blocks per
call and 64 MiB of described participation bytes. The library selects at most
256 producer files and 64 consumers, with 16 MiB of fresh declarations. The shared
process output/time limits still apply; exhaustion is incomplete evidence.
Summary output omits paths and native process details. Detailed output may expose
source identifiers and tool diagnostics; MCP arguments cannot elevate either
execution trust or disclosure.
