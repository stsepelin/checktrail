# Java Checkstyle

`jvm.checkstyle` is an opt-in Java source audit using the pinned Checkstyle
14.3.0 all-in-one JAR and Temurin JDK 25.0.4+7. It uses the shared CLI/MCP engine.
It does not invoke Maven, Gradle, wrappers, dependency resolvers or application
initialization. Kotlin and Scala analysis, JVM tests, SpotBugs and detekt remain
separate E11 requirements.

Select it in the project policy:

```json
{
  "schemaVersion": 1,
  "projects": [{ "path": ".", "checks": ["jvm.checkstyle"] }]
}
```

Prepare this project-root `checktrail.checkstyle.json` and an inventoried UTF-8
`checkstyle.xml`:

```json
{
  "schemaVersion": 1,
  "jar": ".checktrail/checkstyle-14.3.0-all.jar",
  "sha256": "754e218ab1fcabb1e1c5f8530e9d3aa37636806c22987bb279dd907a6ee749b2",
  "config": "checkstyle.xml",
  "failOn": "error"
}
```

Paths resolve from the selected project, must remain inside the operator root
and cannot traverse symbolic links. The artifact may live in the excluded
`.checktrail/` directory. Its exact size and SHA-256 are checked during planning,
before native execution and after collection. Configuration identity includes
its exact original bytes; comments cannot hide a changed configuration from a
previously prepared invocation. Native configuration is a normalized copy of the
parsed declaration, including explicit Java extensions for file-set rules.

```xml
<module name="Checker">
  <module name="FileTabCharacter"/>
  <module name="TreeWalker">
    <module name="NeedBraces"/>
  </module>
</module>
```

The data parser accepts ordinary layout, comments, XML escapes and valid XML
character references. It supports the documented Checkstyle/Puppy Crawl 1.3
public declaration with the `https://checkstyle.org/dtds/configuration_1_3.dtd`
address. The native copy uses Checkstyle's packaged known DTD. Preparation and
analysis do not need network access once the artifact and runtime are installed.
Discovery and planning read data and hashes; neither runs Java nor project code.

## Supported configuration and accounting

The root is one `Checker`. Direct file-set modules are `FileTabCharacter`,
`NewlineAtEndOfFile`, `LineLength`, `RegexpSingleline` and `RegexpMultiline`.
A direct `TreeWalker` can contain pinned built-in `AbstractCheck` modules.
Native module resolution must return the exact Checkstyle package family and
valid check type; token metadata must not be empty. Module IDs and configured
rule order remain part of the evidence. Unknown classes, invalid properties or
unsupported assembly cannot produce a clean result.

Suppression filters/holders, ignored severity, caches, external input properties,
entity declarations and external property expansion are unsupported in this
profile. Explicit extensions must retain Java; other charset declarations and
skipping Java parse exceptions are rejected. Nested check assembly, duplicate
properties and empty rule trees are rejected. This finite configuration profile
does not establish correctness of every Checkstyle rule or configuration.

Every selected inventoried Java source must have one ordered native start/finish
pair inside one completed audit. Native configuration, rule classes/IDs, error
counts and diagnostic sources must reconcile with the planned scope. Empty files,
CRLF, paths with spaces and escaped tab literals can be valid input. Malformed,
missing, duplicate, foreign, stale, ignored, interrupted or incomplete evidence
cannot pass. A native Java parse exception can abort TreeWalker before a complete
packet exists; that collection remains an error with incomplete findings rather
than a fabricated source diagnostic.

The audit listener retains native rule class, optional ID, severity, message and
selected source address. `failOn: "error"` retains warning findings without failing;
`failOn: "warning"` fails on warnings too. Informational findings remain notes.
File audit events and module metadata establish configured processing. They do
not prove that every AST token, rule branch or framework guard was exercised.
Compilation, runtime behavior and project test coverage require their own checks.

## Trust, limits and cleanup

Execution needs CLI operator trust or MCP startup `--allow-execution`; a tool
argument cannot grant it. The native parser runs with the process user's
privileges. Project environment cannot replace planned JVM settings. `CLASSPATH`,
`JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS` and `_JAVA_OPTIONS` are removed before Java
runs. The fixed artifact's inspected manifest has no `Class-Path` attribute and
no annotation-processor service entry; this does not certify arbitrary JARs.

Configuration is bounded to 256 KiB, 512 modules, depth 16, 64 properties per
module and 128 children per module. Property values are at most 64 KiB. There are
at most 20,000 selected files and a 100 KiB invocation. The collector bounds audit
events to 40,002 and diagnostics/exceptions to 2,000 each. Native stdout/stderr is
bounded to 1 MiB, and Java receives a 256 MiB heap limit. Shared engine time/output
budgets can make a larger run incomplete sooner. These are separate bounds;
they are not a measured total-memory ceiling.

The owned helper and normalized configuration live beneath the shared runner's
fresh temporary directory. POSIX cancellation kills the process group; the runner
removes that directory after the child closes, including after a killed wrapper.
The Linux control waits for an observed native JVM before cancelling and requires
it to stop and the files to disappear. Engine-crash recovery, detached malicious
processes, hostile concurrent filesystem changes and native Windows remain
unverified. Source fingerprints and artifact rechecks do not provide OS containment.
Default CLI/MCP summaries omit source addresses and raw diagnostics; detailed
operator reports retain them.

## Reproduce the declared profile

```sh
npm run build
node scripts/prepare-java-review-tools.mjs
docker build --file scripts/java-review-tools.Dockerfile --tag checktrail-checkstyle-test:14.3.0 .checktrail/jvm-review-tools
node scripts/verify-checkstyle-container.mjs
```

The preparer reuses an already verified artifact or downloads the pinned public
release over HTTPS through bounded known-host redirects. It verifies byte size
and SHA-256 before exclusive publication and does not replace a different existing
file. This digest establishes identity; publisher signatures and the full bundled
component/license closure are not independently verified.

Use the shared foreground task runner for agent reproduction. The acceptance
helper uses a pinned Linux image, disabled container networking, resource limits,
an init process and a read-only repository mount. It requires exact named
Checkstyle controls plus the preserved Java compiler profile. It repeats the
Checkstyle controls against a fresh offline production install with lifecycle
scripts disabled; the SDK client and its locked dependency closure live only in
the external acceptance harness. The npm cache must already contain the production
dependencies. Configured hosted CI is not evidence that it ran.

[The dated measurement](measurements/checkstyle-native-2026-10-05.json) records the
original broken/fixed/near-miss cases, source/test pins, compiling guard mutations,
installed-package identity, runtime and limits. This closes the declared local
Checkstyle slice, not E11, Gate A, host-session independence or reviewer quality.
