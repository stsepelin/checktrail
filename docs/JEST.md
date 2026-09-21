# Jest validation

Select `javascript.jest` explicitly in `repo-verifier.json`. Install Jest in the
project or an ancestor `node_modules` directory inside the configured root.
Planning only reads files; operator trust is required before loading Jest or
project configuration. No package installation is attempted.

The adapter uses installed Jest's `runCLI` API with the standard `jest-runner`
and `jest-circus/runner`. It passes inventoried `.test`/`.spec` JS/TS files and
JS/TS files under `__tests__` by exact path. Native configuration still controls
matching and transformation; excluded planned files make the result incomplete.
Custom runners, multi-project duplicate execution, and other filename conventions
are outside the verified contract. TypeScript and ESM fixtures require their own
configured loader/transform support; current native fixtures exercise CommonJS.

Execution is serial and non-watching, with CI mode and snapshot updates disabled.
Collection-only, list-only, changed-only and failed-only execution are disabled.
Result processors are disabled so evidence comes from the native result, before
user postprocessing. Coverage configuration remains active. Cache reuse is
disabled; Jest and trusted project code may still create runtime cache files.
This is not a sandbox or a guarantee that project code will not modify files.

Evidence reconciles each file's assertion counters with aggregate counters and
the exact planned file set. Interrupted, malformed, duplicate, missing and
collection-only results cannot pass. Failures and import errors remain failures.
There must be at least one passing assertion. **Any pending test makes an otherwise
successful run incomplete**, including an intentional skip: Jest does not
distinguish skipped assertions from assertions omitted by `.only` in this result.
A `.only` that omits no assertions is not independently detected. Todo assertions
are counted as skipped; they do not supply passing evidence.

The native integration is verified with Jest 30.5.2. Compatibility with other
versions requires native fixture runs; package presence alone does not establish
support. See the official [Jest CLI documentation](https://jestjs.io/docs/cli)
for collection and execution options and [configuration reference](https://jestjs.io/docs/configuration)
for runners and transforms.
