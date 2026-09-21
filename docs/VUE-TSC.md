# Vue type checking

Select `javascript.vue-tsc` explicitly. A project-local `tsconfig.json` and an
installed `vue-tsc` with TypeScript are required. Installations may be hoisted
within the configured root; escaping symlinks are rejected. Planning does not
load compiler code or execute configuration. Execution requires operator trust.

The adapter calls the installed Vue compiler with no emit, no incremental state,
`noCheck` disabled and a compiler file list. Every inventoried `.vue`, `.ts`,
`.tsx`, `.mts` and `.cts` file must appear in that list. A zero exit with excluded
source is incomplete. Compilation errors fail the check. Vue compiler options
are resolved through the installed language core, including inherited options;
`skipTemplateCodegen` is rejected. Other strictness and suppression choices follow
project configuration and are not a guarantee of complete semantic coverage.

Verified native versions: vue-tsc 3.3.11, Vue 3.5.43 and TypeScript 6.0.3. Fixtures
exercise script and template type errors, a valid SFC, excluded source, inherited
template disabling, filenames with spaces, and no emitted or incremental output.
Project references/composite builds, Nuxt-generated configuration, custom Vue
language plugins, custom file extensions and alternate loaders require separate
verification. A library check does not start Nuxt or generate its application
types. Missing generated configuration remains a compiler failure.

The installed compiler and project plugins run with the user's privileges.
See the official [Vue TypeScript guide](https://vuejs.org/guide/typescript/overview.html)
for the distinction between transpilation and SFC type checking.
