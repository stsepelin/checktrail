# Alpha.5 public adoption known-case replay

The five original pinned public projects were replayed with the published alpha.5 artifact. This is a known-case regression replay, not an independent effectiveness holdout or replacement for upstream CI.

## Observations

| Project / selected capability | Native and wrapper evidence                                                                                                                                  | Negative control                                                                   | Full selected policy                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| nanoid / Node tests           | 79 passed, 0 failed, 0 skipped                                                                                                                               | 80 total; 79 passed and only sentinel failed                                       | Incomplete: actionlint preparation unavailable                                                      |
| mitt / TypeScript 4.9.5       | Unbuilt project: both report 13 diagnostics (TS2307 ×2, TS7006 ×1, TS2578 ×10). After generating the declaration: both pass with zero diagnostics            | Both add exactly one TS2322 diagnostic naming the injected file                    | Failed on unbuilt project, with actionlint also unavailable                                         |
| more-itertools / unittest     | 928 passed, 0 failed, 0 skipped                                                                                                                              | 929 total; 928 passed and only sentinel failed                                     | Incomplete: actionlint unavailable and discovered additional Python unit has no unittest candidates |
| uuid / gofmt, vet, tests      | Native and wrapper test counts agree: 213 total, 212 passed, 1 skipped. Seven existing formatting findings agree. Wrapper vet/test remain scope-inconclusive | 214 total; 212 passed, only sentinel failed, 1 skipped. Wrapper test status failed | Failed on formatting, vet/test inconclusive, actionlint unavailable                                 |
| psr-log / PHP syntax          | All 8 files pass syntax checks in both                                                                                                                       | 9 files; 8 pass and only injected file has a parse failure                         | Passed for selected syntax-only capability                                                          |

The historical alpha.2 TypeScript `TS5023`/`--noCheck` mismatch is absent: alpha.5 matches native diagnostics, detects the TS2322 negative control, and passes the declaration-prepared case. No other project outcome improved in this replay. A passing selected capability does not establish a whole-project pass.

## Identity and preservation

- Artifact SHA-256: `e75aa4b0ae652734a0356094e43805299c8b4ade0afd4cd54c0704f274469dc7`.
- Source commit: `832a044398bcc060c0d6b4c42e66c6eb94a9f5a6`.
- Every installed artifact file (408) was checked byte for byte against the archive.
- All five checkout HEADs match the original pinned commits; tracked fingerprints were unchanged and final tracked status was clean.
- Sentinel files and the temporary mitt declaration were removed. Generated untracked Checktrail policy files remain with the evidence.
- Original scripts, plan, parser and historical measurements were not edited. The local harness differs only in the prepared TypeScript expected result; local plan metadata selects alpha.5. Adaptation diffs are retained.

## Environment and limits

JavaScript, TypeScript and Go executed on macOS arm64 (Node v26.8.1, TypeScript 4.9.5, Go 1.27.1). Python 3.12.13 and PHP 8.4.24 used the existing digest-pinned Docker images with read-only source mounts, read-only container filesystems and disabled networking. Host execution is not a sandbox. No Docker images were rebuilt and no upstream dependencies were updated.

The retained Go outcome is incomplete scope coverage, even though native selected tests pass: this replay does not claim all build-tagged/platform source was exercised. Existing formatting findings remain in dce.go, hash.go, node_js.go, node_net.go, null.go, uuid.go and version4.go. PHP has syntax coverage only; full upstream tests/builds, unselected tools, integrations and efficacy on unseen defects are not measured.

## Evidence

The [public result](measurements/public-adoption-alpha5.json) records every selected
project and observed outcome. The [protocol record](measurements/public-adoption-alpha5-protocol.json)
retains exact harness/plan adaptations, source/tool identities and archive
verification. The original [alpha.2 measurement](PUBLIC-ADOPTION.md) remains unchanged.
Raw logs and prepared inputs remain under `.checktrail/adoption-alpha5` locally.

This is deterministic native-tool adoption evidence. The separate
[agent-review pilot](AGENT-EVALUATION-PILOT.md) measures advisory assessments and
has different cases, labels and limitations. Do not combine their denominators.
