# TypeScript compiler compatibility

The source checkout's `javascript.typescript` profile now supports the exercised
TypeScript 4.9.5 and 6.0.3 configurations. This fix is published in
**0.1.0-alpha.3**. Published alpha.2 still passes an option that
TypeScript 4.9.5 rejects. The original
[public adoption record](PUBLIC-ADOPTION.md) remains unchanged as release evidence.
Other compiler versions require their own native verification.

## Invocation and boundaries

Planning locates the project-local or root-hoisted compiler without importing it.
During explicitly trusted execution, a runner loads the selected compiler API
and uses its public command-line parser to check support for `--noCheck false`.
Supported compilers receive that override, so `noCheck: true` cannot disable the
selected type check. Older compilers that reject this option receive the remaining
arguments; an unexpected capability response stops before the compiler CLI starts.
The probe parses fixed arguments and does not parse project configuration.

The compiler entry and API must resolve inside the configured root. They are
trusted executable dependencies; this check is not a sandbox. No compiler is
installed or downloaded during planning or execution. `doctor` remains static
and does not perform this runtime capability probe.

Checks still disable emitted output and incremental state and require every
inventoried TypeScript source in the native file list. A successful compiler exit
with omitted source is incomplete. A legacy compiler's unsupported project options
remain compiler errors; the runner does not rewrite `tsconfig.json`.

The Vue runner uses the same capability helper. Its separately tested Vue 3.5.43,
vue-tsc 3.3.11 and TypeScript 6.0.3 profile retains type-error detection and the
`skipTemplateCodegen` rejection. This does not establish legacy Vue compatibility.
The solution-build adapter remains gated to TypeScript 6.0.3; see
[TYPESCRIPT-BUILD.md](TYPESCRIPT-BUILD.md).

## Verification

The new 4.9.5 regression failed on the previous adapter's TS5023 error. With this
change it accepts valid code, rejects a real TS2322 error, accounts for excluded
source, identifies the actual tool version, supports a root-hoisted compiler and
paths with spaces, and leaves emitted/incremental files absent. Existing native
6.0.3 and Vue regressions still reject type errors even with `noCheck: true`.
Separate regressions reject an escaping compiler API and an ambiguous capability
response before the compiler CLI executes. Planning is checked against executable
traps in both the CLI and API files.

The [known-case replay](measurements/typescript-legacy-replay.json) uses mitt at
the same pinned revision and the same TypeScript 4.9.5 tool profile as the alpha.2
adoption exercise. After generating its required root declaration, native checking
and the packed fix pass; an original injected TS2322 error fails through the CLI,
library and MCP. The policy and tracked upstream files stay unchanged, and the
injected source and generated declaration are removed afterwards. This is a
regression replay after observing the failure, not a new independent holdout.
The record identifies the tested local tarball and adapter source hashes; it is
not the published alpha.2 artifact.

## Prepare the legacy regression

The old compiler has a separate locked installation so its `tsc` binary cannot
replace the compiler used to build Checktrail:

```sh
mkdir -p .checktrail/typescript-legacy-tools
cp scripts/typescript-legacy-tools/package.json scripts/typescript-legacy-tools/package-lock.json .checktrail/typescript-legacy-tools/
npm ci --prefix .checktrail/typescript-legacy-tools --ignore-scripts --no-audit --no-fund
npm run build
node --test dist/test/typescript.test.js dist/test/vue-tsc.test.js dist/test/typescript-build.test.js
```

The general suite explicitly skips the legacy native case when this installation
is absent. The hosted main matrix prepares it and the `javascript` required-native
profile rejects a skipped or missing legacy regression. A local pass does not
establish hosted CI results.

TypeScript introduced the public `noCheck` option in
[TypeScript 5.6](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-6.html#the--nocheck-option).
The runner checks actual parser behavior instead of assuming capabilities from a
package version string.
