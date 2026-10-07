# Kotlin detekt light profile

The opt-in `jvm.detekt` check analyzes every selected `.kt` and `.kts` file using
pinned detekt 2.0.0-alpha.6 built-in light rules. This is a source analyzer profile:
Kotlin compilation, compiler diagnostics, type-dependent rules, classpaths, mixed
Kotlin/Java/Scala builds and whole-project correctness remain separate E11 work.
CLI and MCP use the shared engine. Planning reads configuration and verifies local
artifact bytes without running Java, Gradle, Kotlin or project code. Execution
requires operator trust and is not an OS sandbox.

Prepare the artifact explicitly; discovery does not download it:

```sh
npm run build
node scripts/prepare-detekt-tools.mjs
```

Copy the prepared `detekt-cli-2.0.0-alpha.6-all.jar` into the selected project's
`.checktrail` directory. Select `jvm.detekt` in `checktrail.json` and create this
inventoried `checktrail.detekt.json`:

```json
{
  "schemaVersion": 1,
  "jar": ".checktrail/detekt-cli-2.0.0-alpha.6-all.jar",
  "sha256": "d46ca62ea4d62769b5d5c3ba94d49fa9b80ba11c7dba74ddb6df7fcc2c19c5fd",
  "profile": "core-default-light-all-selected-v1"
}
```

The [official release](https://github.com/detekt/detekt/releases/tag/v2.0.0-alpha.6)
is the acquisition source. Preparation verifies exact length and SHA-256 before
publishing a complete file through a no-overwrite hard link. Linked cache targets,
unknown redirect hosts, oversized downloads and conflicting concurrent publication
are rejected. Publisher signatures are not independently verified. The npm package
ships the original collector and artifact metadata, rather than upstream JAR bytes.
The complete bundled component/license audit remains part of E6.

Execution checks Temurin 25.0.4+7-LTS, copies the pinned JAR and selected source bytes
into engine-owned temporary storage, and compiles an original listener with
annotation processing and implicit source compilation disabled. The helper's
runtime classpath contains the pinned analyzer and original listener. Project
plugins, Gradle scripts, Kotlin scripts, build hooks and application initialization
are not run. The analyzer receives no project compiler classpath or baseline.

The fixed profile derives its configuration from the hash-pinned default resource
inside the pinned JAR. It preserves default activation, severities and rule
parameters while clearing built-in file include/exclude and annotation/function
ignore lists. It makes configuration warnings fatal. The generated configuration
has its own pinned digest. Native light-mode rule membership must exactly match
the retained plan in `src/detekt-artifacts.ts`, including inactive rules. Inactive
rules and type-dependent analysis are not represented as checked.

The listener records native analysis start/finish and exactly one ordered
start/finish pair for each selected file. It binds physical snapshot hashes and
native PSI hashes to the original selected bytes. The wrapper rechecks original
source and artifact bytes after native execution, and result interpretation checks
source bytes again. CRLF normalization is explicit; analysis locations must fit
the observed source. Paths with unsupported file-list delimiters cannot pass.

The listener audits native file exclusions and exact file/nested annotation
suppressions, including native aliases and rule-family forms. Any active-rule
suppression makes the profile inconclusive, including a zero-finding run.
Prefix-looking identifiers are tested as near misses. Missing participation,
syntax-error PSI, notifications, changed bytes, incomplete lifecycle, unknown rule
membership, native errors and partial raw output cannot pass. A native analyzer
exception on malformed syntax is retained as incomplete analysis and is not
promoted to a verified compiler finding.

Physical native stdout/stderr bytes, byte counts and digests remain in detailed
local evidence. The known pinned JVM/Caffeine deprecation warning is accepted only
as the exact four-line diagnostic, with the copied analyzer URL. Unexpected logs
or disagreement between the native issue inventory, console locations and native
exit status make the result inconclusive. Native severity maps to diagnostic level;
it does not measure consequence severity, reviewer accuracy or confidence.

The profile bounds selected files, source bytes, PSI nodes, rules, findings,
notifications and receipts. The native JVM heap is capped at 512 MiB. It participates
in the shared command deadline, output budget and cancellation cleanup. Ordinary
summaries withhold raw paths and diagnostic details. A profile pass establishes
only completion of the declared light rules over the selected bytes.

Required synthetic callbacks are enumerated in
`scripts/required-native-tests.json`. Native and fresh-package harnesses exercise
broken/fixed/near-miss sources, multiple files, spaces, CRLF, test-directory defaults,
exact suppressions, syntax failures, stale/forged evidence, raw byte accounting and
CLI/MCP privacy and operator trust. Fresh installation uses locked production
dependencies offline without lifecycle scripts and a harness outside the package.

```sh
node scripts/prepare-package-cache.mjs
node scripts/prepare-detekt-tools.mjs
docker build --file scripts/detekt-tools.Dockerfile \
  --tag checktrail-detekt-test:2.0.0-alpha.6 .checktrail/detekt-tools
node scripts/verify-detekt-container.mjs
```

Agents use the shared managed environment for these commands. Exact revisions and
native measurements establish their own acceptance only. Wider Kotlin/Scala,
compiler/type, wrapper, generated/JPMS, analyzer and platform requirements remain
open; this profile does not close E11 or Gate A. These controls perform no AI
inference or real-project field evaluation.

The original Linux ARM64 source/compiling-guard/fresh-package acceptance is recorded
in [detekt-native-2026-10-07.json](measurements/detekt-native-2026-10-07.json).
Optional skips in the full host suite are kept separate from the required native
profile. The measurement does not certify later code or any other platform.
