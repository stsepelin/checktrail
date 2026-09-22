# Enforced evaluation delivery

The checkout harness can require measured execution evidence before accepting a
completed review or scoring a completed assessment. This is an explicit new run
protocol, `executionProtocol.kind: "gateway-v1"`. Historical declarations and
measurements retain their original semantics; do not rerun an old declaration
with changed harness bytes.

The controls address delivery failures found in the
[isolated pilot](ISOLATED-CROSS-FAMILY-PILOT.md). They do not establish review
accuracy, honest model reasoning, independent training data, or an effectiveness
improvement. A recorded probe proves an execution occurred. Its source references
are checked declarations of scope, not proof that the code imported those files or
exercised the claimed behavior. Independent adjudication must still examine the
actual program and output.

## Declare the required evidence

The ordinary plan gains `executionProtocol`, containing `kind`, `judgeBudget` and
`judgeProfile`. Every case also needs `executionProfile` and `nativeEvidence`.
Profiles bind these exact fields:

```json
{
  "image": "sha256:REPLACE_WITH_64_HEXADECIMAL_CHARACTERS",
  "runtimeSha256": "REPLACE_WITH_RUNTIME_TREE_DIGEST",
  "dependenciesSha256": null,
  "native": {
    "executable": "python3",
    "args": ["-B", "-m", "unittest", "discover", "-s", "."]
  },
  "languages": ["python"],
  "timeoutMs": 30000,
  "maxOutputBytes": 1048576
}
```

Use the gateway's exported `treeDigest()` for runtime and dependency identities.
Prepare and verify the public runtime against its declared package archive before
freezing. The digest binds installed bytes; it does not itself establish package
origin. Use `dependenciesSha256: null` only when no dependency tree is mounted.
The judge profile is separate because a judge packet may need both languages and
a shared prepared dependency tree.

For a Python comparator, declare:

```json
{
  "parser": "unittest",
  "scope": ["test_value.py"]
}
```

`vitest-json` is also supported, with the exact captured test-file scope. The
native command must produce the parser's real output. Native comparator evidence
uses the shared Checktrail parsers and requires positive executed test counts;
zero tests, all-skipped tests, startup failures, truncation and cancellation cannot
satisfy it. A conclusive failing test run remains useful execution evidence.
Other native comparator formats need a separately implemented and tested profile;
this initial enforced gateway is limited to Python and JavaScript/TypeScript.

The MCP-assisted arm additionally requires a real validation response whose
retained report is equal, whose source is unchanged, and whose nonempty checks are
conclusive with positive test evidence. Analysis-only MCP profiles do not satisfy
this test-focused protocol. Native and MCP calls are separate requirements.

`judgeBudget` contains `wallSeconds`, `maxToolCalls`, nullable `maxInputTokens`, and
`maxOutputTokens`; it has no `repetitions` field. Reviewer budgets remain in the
plan's existing `budget`. The freeze records the gateway, worker, supervisor,
protocol verifier, compiled engine modules, dependency lock and prompt bytes.
Changing them requires a new declaration.

### Preflight every case before inference

Run each case's exact command against its captured source and prepared dependencies:

```sh
node scripts/preflight-evaluation-native.mjs CONFIG.json NEW_OUTPUT_DIR --trust-execution
```

The configuration has three fields: `gateway`, `profile`, and `nativeEvidence`.
`gateway` is the operator's normal gateway configuration with `treatment: false`
and without `audit` or `binding`; the script creates its own audit in the new output
directory. `profile` is the exact expected execution profile above, including runtime
and dependency tree digests. `nativeEvidence` is the declared parser and file scope.
The gateway's observed profile must match before the native command executes.

This checkout utility makes no model calls. It retains the input, complete raw
gateway audit and `preflight.json`; existing output directories are rejected.
Its `ready` result uses the same native completion function as the enforced
protocol, together with execution integrity and cleanup checks. It reads the raw
audit, not the bounded tool-display projection, and exits nonzero when not ready.
A conclusive failing test suite can be ready: readiness means usable comparator
evidence, not passing source. Zero-test, all-skipped, truncated and malformed
reports are not ready.

Compare the recorded source file hashes and profile with the case being frozen.
Repeat this preflight when source, command, scope, parser, runtime or dependencies
change. The script is an operator readiness check, not a model launcher or a
replacement for review/judge protocol verification. Its local artifacts can contain
paths and full test output; apply the publication policy before sharing them.

For Vitest 5, the historical pilot's `--outputFile=/dev/stdout` command appends a
banner after JSON, while removing that option tries to write a report into the
read-only source tree. Both fail the preflight. A separately measured native
Vitest API invocation using `new JsonReporter({ stdout: true, outputFile: "" })`
produces clean stdout; see the [pilot report](ENFORCED-CROSS-FAMILY-PILOT.md).
Do not strip banners from completed trial evidence or replace a failed attempt.

## Bind each process to its assignment

Set the gateway's optional `binding` for an enforced run:

```json
{
  "manifestSha256": "REPLACE_WITH_FROZEN_MANIFEST_HASH",
  "subjectId": "REPLACE_WITH_ASSIGNMENT_ID",
  "sessionId": "REPLACE_WITH_FRESH_REVIEWER_ID",
  "role": "reviewer"
}
```

The session supervisor receives the same binding. Judges use `role: "judge"`,
`subjectId: "judging"`, and their own declared session ID. Identity remains an
operator declaration; matching strings do not prove independence. Source maps,
arm, profile, implementation hashes and the entire audit chain are checked as
well, so a same-source sibling assignment cannot reuse the other's evidence.

Reserve each reviewer assignment before launching it, with a fresh session ID and
an evidence directory that does not yet exist:

```sh
node scripts/agent-evaluation.mjs begin RUN_DIR ASSIGNMENT_ID SESSION_ID EVIDENCE_DIR
```

The reservation binds the assignment to that session and directory. It is created
once and remains after failure; a replacement session or new evidence directory
cannot take over the assignment. The supervisor also creates its output directory
exclusively. A failed assignment can receive an incomplete disposition; a later
retry needs a new declaration. As with the rest of the protocol, a malicious host
operator can rewrite local artifacts; the reservation is not a cryptographic proof
of chronology.

Prepare each client's restricted tool configuration as described in
[EVALUATION-ISOLATION.md](EVALUATION-ISOLATION.md). Add `evaluation_citation` to the
explicit gateway allowlist. The enforced mode permits only that bound gateway's
tools and Claude's `StructuredOutput` delivery tool. Invoking a host tool, another
MCP server, or a resource wrapper prevents protocol completion. Recheck the actual
client capability inventory after client updates; the supervisor does not configure
or sandbox the client.

## Number, check and bind source evidence

`evaluation_read` keeps its exact `text` field and now returns `endLine` and a
`lines` array of `{line, text}` objects. Coordinates are one-based and inclusive;
line terminators, Unicode escape spelling and Unicode normalization are not repaired.
Use `evaluation_citation` with `{file, line, endLine, quote}` before submitting a
finding. It checks the in-memory snapshot without changing the assessment.

An enforced `evaluation_probe` supplies `sourceEvidenceIds`, containing earlier
successful `evaluation_read` result IDs. The gateway rejects listing, citation,
unknown and duplicate IDs before execution. Its result records the referenced
source filenames and hashes. A finding then supplies `probeEvidenceIds`, containing
usable probe result IDs, covering every cited file. The cited line ranges must have
actually been disclosed by recorded source reads. Adjacent or overlapping reads may
cover a citation together; a gap in the disclosed lines cannot.

Bound gateway clients now receive a schema requiring those source IDs; direct
gateway calls enforce the same requirement. Missing or empty IDs cannot start a
probe. Schema-rejected calls remain metered tool attempts, and an agent may correct
its request within the same bounded session. Unbound legacy gateways keep their
optional source association. Neither mode verifies that a program actually imports
the declared source; independent inspection remains required.

Judgments use `status: "completed" | "incomplete"`. Each accepted label, including
a valid control with no findings, needs its own `probeEvidenceIds`. Resolved finding
decisions also need them. Judge probes must reference source reads beneath that
item's exact `<blindId>/source/` prefix. This verifies the declared association and
execution provenance; it cannot verify the semantic adequacy of a control. There
is no substring search for source paths inside executable code, so dynamically
constructed imports are not rejected by a textual heuristic.

The judgment's top-level status describes the judge's own work. A judge can finish
assessing an incomplete reviewer receipt and return `status: "completed"` if all
of its own requirements were met. The scorer still keeps that reviewer receipt
incomplete; completing adjudication does not repair the reviewed attempt. Omit no
required label or decision evidence merely because the reviewer was incomplete.

Use the exact directory produced by `blind` as the judge gateway source, including
`judging.json` and every captured source file. Verification binds that complete
file inventory and the packet bytes: changed labels, claims, references or
instructions invalidate the evidence even if the source files are unchanged.

## Supervise a client

`runSession()` in `scripts/agent-evaluation-session.mjs` starts an operator-selected
Claude or Codex CLI command. It requires explicit arguments, working directory,
environment, binding, budget and a new output directory. It does not acquire
credentials, copy authentication, change client configuration or install anything.
The operator is responsible for the subscription authentication and restricted
client configuration. Do not take executable arguments or environment settings
from a reviewer response or repository instruction.

The CLI requires an explicit execution flag:

```sh
node scripts/agent-evaluation-session.mjs CLIENT_CONFIG.json --trust-client
```

The configuration fields are `client` (`claude` or `codex`), `executable`, `args`,
`cwd`, `environment`, `outputDirectory`, `binding`, `budget`, and optional `stdin`.
Use a budget with the four fields described above. The gateway's `audit` path must
be `gateway-audit.jsonl` inside the new output directory, which the supervisor
creates before starting the client. Client output must be JSONL telemetry, with a
terminal structured receipt or judgment object. Exact CLI recipes and model choices
are version-specific operator inputs, not defaults of this runner.

The supervisor retains `events.jsonl`, stderr and `metering.json`. It bounds output,
meters observed tool attempts including failed calls, deduplicates repeated event
IDs, and terminates the process group on observed overruns or malformed telemetry.
It reconciles terminal provider usage, including Claude cache-token accounting.
Missing required usage, an unsuccessful process, contradictory late events or a
capacity failure remain incomplete. Unsupported telemetry event or work-item
shapes also remain incomplete until the parser is explicitly extended and tested.
Monetary cost is not inferred.

Token telemetry arrives after consumption and may arrive only at the end. The
supervisor can stop further work when it observes a breach; it cannot guarantee a
hard billed-token ceiling or equal compute across providers. Wall/output/process
limits are separate controls. Child cleanup has a bounded grace period; forced
termination can still prevent a gateway end record, which remains incomplete.

## Validate and seal

After the client and gateway terminate, run the non-writing preflight:

```sh
node scripts/agent-evaluation.mjs preflight RUN_DIR ASSIGNMENT_ID RECEIPT.json EVIDENCE_DIR
node scripts/agent-evaluation.mjs seal RUN_DIR ASSIGNMENT_ID RECEIPT.json EVIDENCE_DIR
node scripts/agent-evaluation.mjs blind RUN_DIR JUDGE_PACKET_DIR
node scripts/agent-evaluation.mjs score RUN_DIR JUDGMENTS.json SCORE.json JUDGE_EVIDENCE_DIR
```

The evidence directory contains the fixed gateway audit, session events and metering
filenames above. These are operator inputs, outside the model-visible source packet.
A completed receipt must match the client's original terminal JSON exactly, satisfy
citation checks, and pass execution, usage and cleanup gates. Completed judgments
also must match terminal JSON. Correcting a citation after delivery cannot turn
that original attempt into a completed one.

An operator may seal an explicit incomplete disposition when a model fails to
produce a usable receipt; preserve the raw events and explain any omitted or invalid
findings in its limitations. The operator copy remains incomplete. Never replace
a failed attempt with a retry under the same assignment. Exact citation rules still
apply to any findings retained in that copy.

Sealing stores the evidence and its digest together with the receipt in one new
artifact. Blinding and scoring recheck it. Unknown required budgets, missing or
invalid chain records, changed source/profile/assignment, absent required calls,
missing native assertions, interrupted execution and missing cleanup cannot be
promoted by an imported `complete: true` field. The `protocolComplete` result is true only for a fully completed enforced run;
legacy procedural `complete` accounting never sets it. Scoring retains raw semantic
matches and protocol failure reasons separately; an incomplete judgment cannot establish a
completed miss.

Hash chains establish consistency under a trusted operator. They are not signatures
against a malicious host rewriting all artifacts. Measured elapsed time and process
exit are supervisor observations; the verifier replays provider telemetry and checks
bindings but cannot independently reconstruct a host clock from JSONL bytes.

## Reproduce the execution canary

With an operator-prepared immutable image, installed package runtime and matching
release archive, run:

```sh
node scripts/verify-enforced-evaluation.mjs IMAGE_DIGEST RUNTIME_DIR PACKAGE.tgz VERSION OUTPUT.json --trust-execution
```

The output and its adjacent `.artifacts` directory must be new. The script checks
installed package bytes against the archive, freezes original synthetic Python
source, runs both review arms and the judge through a scripted JSONL client, and
verifies actual MCP/container execution and terminal cleanup. It copies evidence
before applying negative controls, preserving the original completed traces.

The [recorded local canary](measurements/enforced-evaluation-live-v1.json) completed
both review arms, the treatment's retained MCP validation, and both judge controls.
Changed claims, changed declared usage, missing cleanup and a sibling item's probe
were rejected. This exercised real execution with the published alpha.5 runtime;
no model inference occurred, and it provides no review-effectiveness evidence.
The subsequent [cross-family historical cohort](ENFORCED-CROSS-FAMILY-PILOT.md)
records live model attempts, independent audits and a native report framing
failure missed by the Python-only canary. A synthetic canary cannot establish
readiness for every execution profile: verify each case's actual native command
and complete raw output against the declared parser and scope before inference.
