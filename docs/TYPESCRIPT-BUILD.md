# TypeScript project-reference validation

Select `javascript.typescript-build` on a solution root with `tsconfig.json` and
an installed TypeScript compiler inside the configured repository. Unlike the
single-project `javascript.typescript` check, this check inventories TypeScript
source throughout the solution directory, including nested package boundaries.
Every inventoried source must appear in a native compiler program. Unrelated or
excluded source beneath that directory therefore makes the check incomplete.

The adapter uses TypeScript's solution-builder API to follow references in native
dependency order. It forces a fresh build, enables checking even when `noCheck`
is configured, and supplies an in-memory output filesystem. Declarations flow
from producers to consumers without writing JavaScript, declarations or build
state to disk. `noEmit` is overridden for this virtual build; emission happens
only in memory. Existing build state is not read, and virtual outputs shadow
existing declarations. Other type-checking options remain project policy.

Compiler/configuration diagnostics fail and retain native TS rule IDs and source
locations where available. Missing runtime integration, unsupported compiler
version, malformed evidence or omitted source is incomplete. Cyclic references
produce the native compiler diagnostic. Empty solutions cannot pass.

The integration is verified and version-gated to TypeScript 6.0.3. It uses the
compiler API rather than replacing TypeScript semantics. It does not run custom
build scripts, verify emitted bundles, install dependencies or validate Vue SFCs.
Those require their corresponding separate checks. Installed compiler code runs
only with operator trust and is not sandboxed.

Compiler reads are constrained to the configured root, including canonical
symlink targets. Missing/outside referenced configuration is rejected. Virtual
outputs must stay within that root and are bounded to 64 MiB and 20,000 entries.
References can cross the selected solution directory while staying inside the
configured repository; source outside the selected directory is not thereby
claimed as completely inventoried or validated. Select its own project or a
common solution root when that coverage is required.

## Evidence

Synthetic native tests cover nested package boundaries, producer errors, changed
producer types breaking consumers, the corrected consumer, excluded source,
stale on-disk declarations/build state, cyclic references, escaped configuration
and output destinations, and planning without compiler execution. Preservation
assertions check original bytes and absent output paths. Parser tests cover
missing programs, duplicate/outside paths and partial evidence.

```sh
npm run build
node --test dist/test/typescript-build.test.js
```

Current native evidence is TypeScript 6.0.3 on macOS. Hosted platform runs remain
separate verification gates.

References: [project references](https://www.typescriptlang.org/docs/handbook/project-references.html),
[compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API).
