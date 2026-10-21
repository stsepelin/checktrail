# Compiled engine byte observations

The generic required-native-test runner records a bounded inventory of its
configured `dist/src` artifact immediately before and after the selected cohort.
Fresh-package harnesses copy the same observer outside the installed package and
resolve their deliberate `dist/src` alias to that package’s engine. Every regular
file under that root, including generated declarations, contributes its relative
name, byte count and SHA-256 digest. A changed inventory prevents a successful
runner result even when every selected test callback passed.

The observer streams directory entries and file contents, rejects nested links
and nonregular entries, and checks file/handle/directory identities while reading.
It permits at most 4,096 files, 8,192 directory entries, depth 24, 8 MiB per file
and 128 MiB combined. Missing or empty artifacts, exhausted bounds and unavailable
filesystem observations fail closed. Root aliases are resolved for the installed
harness; this is not a general filesystem security boundary.

The separate `compiledEngine` object retains the file inventory, its digest and
the matching before/after identities. Its tree digest preserves the existing
Tasks observer’s relative-name/digest ordering. The terminal test ledger continues
to describe selected test files and named events; it does not acquire these wider
claims implicitly. Controllers that invoke the generic runner receive the new
object. Direct callers of the underlying test-evidence library and other custom
controllers need their own explicit integration.

These are inventories at two observation boundaries, not a continuous or atomic
view of execution. They do not trace which modules a worker actually loaded,
identify dependency bytes, verify source-to-compiler production, attest the host,
or cover other package assets. Those exclusions remain explicit in the emitted
object. Matching hashes alone do not complete native acceptance, the runtime
matrix, artifact provenance, Gate A or review quality. No additional project
execution or trust grant is provided by reading this metadata.
