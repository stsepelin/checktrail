# External review capture declarations

`inspectReviewEvaluationCaptures` binds externally supplied review-output metadata
to the [prospective protocol](EVALUATION-PROTOCOL-DECLARATIONS.md) and
[attempt meter](EVALUATION-METERING.md). The baseline can remain a plain host
review: this intake requires no Checktrail review workflow, native probe or audit
journal from that arm. It starts no model and opens no source, output blob or answer.

The strict input extends the metering envelope with one capture per selected case,
repetition and role. `reviewEvaluationCaptureAssignments` derives exact protocol,
configuration and source commitments for all selected slots. These operator
addresses contain no source or peer output; they are not the execution schedule.
Missing cluster declarations never shrink the planned denominator.

Each capture binds its assignment, both source digests, configuration, terminal
status and every ordered attempt-record digest, including failed retries. Its
`captureSha256` identifies the complete private capture record, not the review
body: reusing a complete record invalidates every affected planned slot. Independent
reviews may have identical body bytes. A changed unverified capture digest changes
the input commitment but does not prove that corresponding bytes exist.

A completed capture requires a nonempty output descriptor. Declared output bytes
must fit the protocol ceiling and the known terminal attempt's physical-output
count. Unknown usage remains unknown. Partial, cancelled, refused, exhausted and
unrun slots retain their planned addresses; complete accounting does not make them
completed reviews. Missing, duplicate and foreign records remain visible and the
reported count categories reconcile to the complete supplied and planned totals.

The library accepts at most 1,536 captures, sixteen attempt references each and
4 MiB per output descriptor. The checkout script reads at most 4 MiB of valid
UTF-8 JSON; a maximum-size library input need not fit that separate stdin bound:

```sh
node scripts/check-evaluation-captures.mjs < /path/to/private-captures.json
```

Exit 0 means internally complete declared outputs and measurement accounting;
2 means incomplete/inconsistent metadata; 1 means invalid or unavailable input.
Errors omit supplied input. Returned reports expose aggregate categories and
digests, with no case/session IDs, raw output, source or private identity mapping.
Hashes and counts can still reveal equality and activity.

The required `evaluation-capture-declarations` controls run against source and a
fresh locked offline production installation through an external harness.
Before/after engine, executable and harness identities are checked. The private physical sealing component below verifies retained blob bytes.
Independent host containment, actual all-attempt completeness, collector
authenticity, judgment/matching intake and final protocol acceptance remain
separate requirements. This component neither assesses review quality nor
closes the independent-evaluation profile or Gate A.

## Private physical sealing and replay

`sealReviewEvaluationCaptures(projectRoot, storageRoot, input)` reads incoming
content-addressed files from `storageRoot/blobs/SHA256.blob`. Storage must be an
absolute operator-owned private POSIX directory outside the project, with a
private `blobs` directory. Files must be private regular singly linked files;
symlinks, hardlinks, special files, changing files and digest mismatches fail
before an archive is written. This storage component currently rejects Windows.
It does not narrow the required engine/runtime profile or claim Windows storage
acceptance.

The exported strict artifact schemas describe complete capture records and
attempt records. Their record digests hash `encodeReviewEvaluationArtifact(record)`,
which emits UTF-8 JSON plus one newline. Capture records contain the declaration
fields except the self digest, with schema version 1 and profile
`external-review-capture-artifact-v1`. Attempt records contain the meter fields
except the self digest, their exact assignment digest, schema version 1, profile
`external-review-attempt-artifact-v1`, and separate stdout/stderr retention
metadata. Each stream records a retained digest/byte count, nullable observed byte
count and explicit truncation flag. Transport authentication and credential
fields are outside these strict contracts; collectors must never supply them.
Raw review/tool text remains private and may itself contain sensitive content.

Every reached meter attempt is inspected even when its review capture is absent.
Validating retained bytes does not make a malformed record, truncated stream,
unknown physical count, output-size discrepancy or missing artifact complete.
Those states retain their bytes/counts and remain gaps. Byte validity and declared
review completeness are separate: neither proves collector authenticity, real
all-attempt completeness, host independence, source truth or label correctness.

The component reads all referenced inputs before exclusively creating one
`captures.sealed.json` file. A preexisting seal is never replaced. The archive
retains the parsed input, unique physical blob bytes and missing inventory;
replay rederives the report from those retained bytes and requires the exact
archive digest. Incoming files can then change or disappear without rewriting
history. Archive edits, invalid base64, missing/unused/duplicate blobs and
inconsistent missing inventories are rejected even if supplied with a new digest.
There is no automatic resume, model invocation, source read or answer read.

Limits are 4 MiB per raw blob, 1 MiB per record, 16 MiB of unique retained blob
bytes, 8,192 referenced blob identities and 32 MiB for the encoded sealed archive.
The combined bound can reject a collection whose individual records fit; the
schema maxima do not promise every maximum-sized combination fits storage.
Summary reports omit blobs, source, case/session IDs and identity mappings.
The required `evaluation-physical-captures` controls repeat against source and a
fresh offline installed engine. This is a bounded physical intake component;
judging, common-defect matching, final runtime bindings and the full independent
evaluation acceptance remain open.
