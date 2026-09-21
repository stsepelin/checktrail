# Exact finding policy

Baselines and exceptions reconcile normalized source findings against a supplied
validation report. They do not change that report. `outcome` describes policy
reconciliation; `validationOutcome` retains native validation. A comparison can
pass while native analysis still fails on explicitly accepted findings.

```sh
repo-verifier create-baseline --root /path/to/project --input report.json \
  --owner maintainer --reason "Tracked compatibility work" --detailed > baseline.json
repo-verifier compare-findings --root /path/to/project --input report.json \
  --baseline baseline.json --previous-baseline prior-baseline.json
```

All input paths are relative to the configured root and use bounded reads with
path-escape rejection. These commands execute no project code and write only to
stdout. Baseline creation requires a detailed, internally consistent report with
conclusive checks and source evidence. The default creation output is a summary;
`--detailed` emits the artifact. Comparison exits 0 for passed, 1 for failed and
2 for incomplete. Preserve the validation command's own exit status separately.

The library exports `createFindingBaseline(report, {owner, reason, kind?,
expiresAt?})` and `compareFindings(report, baseline, {previousBaseline?, now?})`.
Use `kind: "exception"` for explicit exceptions and an ISO UTC `expiresAt` when
needed. Every entry requires an owner and reason. Expiration at or before the
comparison clock fails. The CLI currently creates baseline entries; use the
library or edit the schema-validated artifact to attach exception metadata.

An identity includes the exact check, project, native rule, repository-relative
file, line, severity and SHA-256 of the JSON-encoded diagnostic message. The ID
hashes that ordered identity. Patterns are never expanded: an asterisk matches
only a literal asterisk. Moving a finding or changing its message produces a new
identity and makes the previous entry stale. Identical repeated findings retain
an exact occurrence count. Forged IDs and duplicate entries are rejected.

Each baseline entry is matched, stale, expired, changed in occurrence count, or
unverified. Those five counts sum to the number of baseline entries. `current`
and `new` count finding occurrences; `expanded` and `modified` count entries
relative to a supplied previous baseline. Explicit maximum entry and exception
counts are enforced. With a previous baseline, added identities, changed review
metadata and raised limits fail. Removing an entry is allowed, but any surviving
finding then becomes new. The previous artifact is operator supplied; the engine
does not fetch it from Git or attest its provenance.

Only parsers that establish complete native analysis expose
`findingsComplete: true` for a failed check. Scope omissions, compile/loading
errors, unparsed failures and older reports without the marker cannot be waived.
Test failures cannot be converted into source exceptions. Missing checks and
unknown tool identities prevent reconciliation from passing. A known policy
failure takes precedence over incompleteness, while unverified counts remain
visible. Stale entries fail even when another finding still fails the same check.

`sourceVerified` means the supplied report records matching before/after source
fingerprints without a source error. It does **not** mean comparison inspected
current files, nor that an imported artifact is authentic. Obtain a fresh run
when freshness matters. Fingerprint exclusions still apply.

MCP `finding_comparison` accepts a retained `runId`, local `baseline` and optional
`previousBaseline`. It cannot change root, trust, detail mode or clock. Summary
output omits finding identities, paths and messages; detailed output includes
entry IDs and statuses. The bounded in-memory report store still expires on
restart. Baseline files are local policy artifacts and can contain project paths.

Synthetic tests cover native ESLint findings, partial repairs, near-miss IDs,
occurrence counts, stale/expired entries, limits, expansion, missing/partial
evidence, CLI artifacts and MCP boundaries. Baselines do not claim semantic
equivalence when source or native diagnostic wording changes.
