# Ruff validation

Select `python.ruff` explicitly and provide `ruff` and `python3` on the operator's
PATH. The current identity profile probes both tools, even though the Ruff binary
itself does not need Python. The
adapter targets inventoried `.py` and `.pyi` files. It records native file
selection, resolved settings for each file, and JSON diagnostics. No dependencies
are installed. Planning does not execute Ruff or project configuration.

Execution forces exclusion rules to apply even to explicit filenames; any
excluded planned file prevents passing. Fixes, fix-only mode, unsafe fixes and
cache reuse are disabled. A pre-existing cache is preserved. Errors in native
configuration are execution errors, not successful checks. Diagnostics fail even
if the tool unexpectedly exits zero. Malformed or truncated output is incomplete.

The resolved settings must show at least one enabled rule not present in any
per-file ignore entry. This conservative bound does not implement Ruff's glob
matcher: a broad union of unrelated per-file ignores can make the result
incomplete even when the native tool has active rules for a particular file.
Inline suppression comments still follow native policy; suppression reconciliation
is distinct from exact normalized-finding reconciliation in `FINDING-POLICY.md`. This check does not certify rule sufficiency.

Native cases are verified with Ruff 0.16.8 in a prepared Linux container. They
cover valid source, unused imports, undefined names, invalid syntax, excluded
files, no enabled rules, broad per-file ignores, configured fix/fix-only settings,
filenames with spaces and cache preservation. Settings output is a versioned
text contract; unknown formats fail closed. Notebooks and other extensions are
not included. One settings command per source file consumes the shared time and
output budgets; large projects can require a future compact native integration.

The [Python container verification steps](PYTEST.md) also run these native Ruff
cases. Ruff absent from the host PATH causes an explicit native-test skip; it does
not count as verification. See the official [Ruff configuration reference](https://docs.astral.sh/ruff/configuration/)
for selection, exclusions and per-file settings.

An [external Ruff integration cohort](EXTERNAL-RUFF-EVALUATION.md) additionally
compares native and verifier diagnostics against pinned upstream snapshots on
macOS and Linux. It measures diagnostic preservation for those files, not general
review quality or a population false-positive rate.
