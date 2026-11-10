# Prospective evaluation configuration bytes

The operator can check the actual files behind an evaluation protocol's declared
configuration and procedure hashes before opening evaluation cases. This is a
separate readiness check; the declaration inspector continues to report
configurationBytesVerified as false.

The library exports inspectReviewEvaluationConfiguration(projectRoot,
configurationRoot, declaration, files, expectedProtocolSha256). It first requires
a complete declaration with the operator-pinned protocol digest. The dedicated
configuration directory must be outside the project, private to the operator,
and contain only the selected flat files. Each file must be private, regular
and singly linked. POSIX directories use mode 0700 and files 0600; Windows uses
the existing private-storage ACL checks.

The strict files object contains two maps:

- configurations: reference, priorWorkflow and verifier.
- procedures: acquisition, answerSeparation, hostIsolation, independentJudgment,
  commonDefectMatching, externalMetering and stopRules.

Each role selects { file, bytes }, with a distinct portable filename and an
exact byte count. Each file is bounded to 1 MiB and their declared total to
8 MiB. Expected SHA-256 values come from the pinned protocol, rather than another
operator-supplied hash list. Empty bytes are allowed when their exact length and
hash match; this does not certify a meaningful configuration.

The inspector reads only these explicit files. After storage admission it retains every role when a
file is missing, unsafe or mismatched, and rechecks all observed file identities
after the last read. The directory identity and namespace are checked again too.
Identity comparisons include device, inode, mode, owner, group, link count,
size and nanosecond modification/change times; access times are ignored.

The report binds each role's byte count and digest to the protocol. Its
configurationBytesVerified flag is true only when all roles match and storage
remained stable during inspection. This is a current observation, not a durable
freeze or a promise about later edits. Reinspect before using the configuration.

## Operator setup command

After building, pass { declaration, files } on stdin:

```sh
node scripts/check-evaluation-configuration.mjs \
  --project /absolute/project \
  --configuration-root /absolute/private-configurations \
  --expected-protocol-sha256 EXPECTED_HASH \
  < /absolute/private-input.json
```

The command is repository setup tooling, separate from the installed CLI and MCP
tool catalogue. An MCP argument cannot select files to read. Exit 0 means all
configuration bytes match, 2 means incomplete file observations, and 1 means
invalid input or unavailable storage. Stdout contains only the projected summary;
errors are generic and omit filenames, contents and private identities. Counts
describe individual roles; storageChanged independently invalidates the whole
observation.

The check does not recurse into configuration references, open source cases or
answer labels, execute project code or models, verify license grants, establish
configuration semantics or fresh sessions, or close Gate A. In particular,
matching the baseline configuration's bytes does not establish that it is a
plain review without Checktrail: that procedure and its observed isolation still
need their own acceptance. The prospective baseline remains the plain
Codex/Claude review described in [the comparison protocol](PRIOR-WORKFLOW-EVALUATION.md).

Original synthetic regression tests cover each role's mismatched and missing
bytes, unsafe selections and file types, permission refusal, stale protocol
binding, replacement of an earlier file during the final read, empty-file
near misses, and summary/error privacy. No evaluation trial is started.

## Matched declared settings

`inspectReviewEvaluationPair(input, expectedProtocolSha256)` checks a narrower
structured baseline/verifier pair. Input contains the existing `protocol` and
`configurations: { priorWorkflow, verifier }`, where each configuration is its exact
JSON text, bounded to 1 MiB of UTF-8. Both raw hashes must match the pinned
protocol. The configuration profile is `prospective-review-arm-configuration-v1`.
Its strict fields are `schemaVersion`, `profile`, `role`, `host`, `context`,
`native`, `budgets`, `isolation` and `treatment`; the exported
`reviewEvaluationArmConfigurationSchema` describes the field shapes.

The two arms must declare identical host client/version/executable, requested
model/effort and shared settings digest, task and repository-instruction digests,
native tools/environment digests, and all five budgets. `settingsSha256` identifies
the shared sampling/context settings, excluding the separately represented
treatment; keep that projection with the private configuration record. Native and budget values must
also match the protocol; equal but foreign settings are refused. Both arms must
declare fresh sessions without shared history or outputs. The baseline must
have `checktrailEnabled: false` with no treatment fields. The verifier requires
`checktrailEnabled: true`, the protocol's engine digest and a usage-instruction
digest. Different hosts require separate pairs and protocols.

After building, pass the input on stdin:

```sh
node scripts/check-evaluation-pair.mjs --expected-protocol-sha256 EXPECTED_HASH   < /absolute/private-pair-input.json
```

Exit 0 means declared settings match, 2 means an incomplete or mismatched pair,
and 1 means invalid input. Output contains hashes, issue codes and explicit
unverified claims, without client/model names or configuration contents. The
setup command reads no referenced files and runs no models or native commands.
A matching declaration does not establish effective host configuration, model
availability, actual isolation, native readiness, cohort readiness, a frozen
experiment or Gate A completion. Keep the private-file byte inspector and actual
host/native preflight as separate requirements; this check does not replace them.

`node scripts/verify-evaluation-native-package.mjs --pair-settings` repeats the
matched-pair controls and setup command from an external harness against a fresh
offline production install. It requires each named control exactly once without
skips and binds harness and installed engine bytes before and after execution.
This remains synthetic setup acceptance, not an observed host comparison.
