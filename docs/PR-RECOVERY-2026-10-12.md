# Main recovery audit — 2026-10-12

The audit started with `main` at `6669f1cbc20b8e66b5c9efb1d2ee3064cfada997`, the merge of PR #87. PRs #88–97 had not reached main. Their implementation was preserved in #97’s head, `98ddf37183bfa3f412f53718ad717a87c3de413e`; every listed head is an ancestor of that commit.

This recovery merges the preserved batch onto main and backports shared CI repairs. It does not include the unmerged #98–118 feature batch, change selected dependency versions, close Gate A, run inference, or acquire evaluation cases.

| PR                                                     | Recorded state | Recorded base                       | Present in original main | Recovered |
| ------------------------------------------------------ | -------------- | ----------------------------------- | ------------------------ | --------- |
| [#88](https://github.com/stsepelin/checktrail/pull/88) | closed         | `pr/gate-a-jvm-wrappers`            | no                       | yes       |
| [#89](https://github.com/stsepelin/checktrail/pull/89) | merged         | `pr/gate-a-kotlin-extensions`       | no                       | yes       |
| [#90](https://github.com/stsepelin/checktrail/pull/90) | closed         | `pr/gate-a-scala-feature-phases`    | no                       | yes       |
| [#91](https://github.com/stsepelin/checktrail/pull/91) | merged         | `pr/gate-a-scala-extensions`        | no                       | yes       |
| [#92](https://github.com/stsepelin/checktrail/pull/92) | closed         | `pr/mixed-jvm-java-warning-policy`  | no                       | yes       |
| [#93](https://github.com/stsepelin/checktrail/pull/93) | merged         | `pr/gate-a-jvm-analyzer-extensions` | no                       | yes       |
| [#94](https://github.com/stsepelin/checktrail/pull/94) | closed         | `pr/gate-a-kubernetes-extensions`   | no                       | yes       |
| [#95](https://github.com/stsepelin/checktrail/pull/95) | merged         | `pr/gate-a-kustomize-extensions`    | no                       | yes       |
| [#96](https://github.com/stsepelin/checktrail/pull/96) | closed         | `pr/gate-a-confidence-provenance`   | no                       | yes       |
| [#97](https://github.com/stsepelin/checktrail/pull/97) | merged         | `pr/gate-a-fsharp-format`           | no                       | yes       |

A merged status records a merge into that PR’s base, which was often a feature branch. The five closed feature PRs have no merge timestamp. The timeline records closure but does not establish its cause. The recovery relies on Git ancestry and final files, rather than assuming that either state means the work reached main.

## Review and merge order

Merge this recovery PR into main after its required checks pass. Use **Create a merge commit** for the recovery and #98 so the preserved shared ancestry lets downstream diffs shrink after each merge. PR #98 and then PR #99 follow, both targeting main. Until the recovery is merged, their main-based diffs will include recovered prerequisites. Until #98 is merged, #99 will also include #98’s changes. Existing branches are preserved; no force push or remote merge is part of this repair.

Leave #100–118 as unmerged backlog while this baseline is repaired. Their historical cancelled checks are incomplete evidence. The aggregate mutation job fails when its required jobs were cancelled; that is not a mutation-test result. Do not interpret it as passing or as proof of a source regression.

The seven dependency-update PRs are separate. The audit found SDK and JavaScript-tool updates that disagree with selected exact acceptance versions, and an XML-parser update that invalidates a retained production-notice entry. Those need coordinated acceptance/provenance updates before merging; this recovery keeps the existing pins.

## Shared CI fixes

The recovery retains physical capture validation before framework report normalization, named Laravel supplemental completion, separate startup/shutdown deadlines, pinned archive mirrors and retained signed APK bytes, and exact official image references. Ruby’s official Docker Hub index was fetched and its SHA-256 matched the already selected immutable digest; the version and digest are unchanged. The actual Maven installer now calls the bounded requester and still rejects invalid archive bytes before extraction or publication.

Local checks and hosted checks cover different scopes. Skipped, cancelled and unavailable native checks do not count as passes. Old measurement receipts retain their original scope; this recovery does not turn them into acceptance for this revision.
