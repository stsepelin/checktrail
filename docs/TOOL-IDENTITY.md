# Tool identity evidence

Detailed plans include how selected tool identities will be obtained. Planning
does not execute a version command or import project code. Validation captures
identities only after operator trust, before running checks. Detailed reports
retain the version, evidence method, native probe result or package metadata path.
Summaries omit this information along with other tool/environment details.

Native probes use the same bounded process runner, environment filtering,
cancellation signal, overall deadline and output budget as validation commands.
Each probe has an 8 KiB output limit. Identical probes under the same declared environment fingerprint are reused within one run;
there is no persistent version cache. Missing, nonzero, truncated, cancelled or
unrecognized version output is not identified. A successful check with an
unidentified required tool becomes incomplete; an actual check failure stays a
failure.

Node uses the running engine's version because JavaScript child commands use that
same executable path. Installed JavaScript tools use their package metadata,
resolved within the configured root; both package name and version are checked.
Python, Go, PHP and Ruff use version commands. Pytest and mypy use Python's installed
distribution metadata through the same selected `python3` runtime.

These methods identify the engine runtime and primary tools. Go's recorded version
identifies the `go` command, not an independently replaced `gofmt` binary. JavaScript
transitive tools, language plugins, compilers loaded behind another wrapper,
dependency trees, executable hashes and service versions are not fully fingerprinted.
Package metadata can be changed independently of code and is labeled accordingly.
This is not binary attestation, hermetic reproducibility, or proof that any version
is compatible. Native fixture results and the support matrix remain the evidence
for compatibility.
