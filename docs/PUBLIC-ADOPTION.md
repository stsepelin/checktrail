# Public repository adoption: alpha.2

This exercise measures installation, policy setup and selected native checks on
public libraries. It uses the published alpha.2 artifact, not an edited engine.
The [selection plan](../scripts/public-adoption-plan.json) pins every upstream
commit. Upstream sources and their licenses remain in ignored local checkouts;
no upstream source is included in Checktrail's package or this report.

The projects were chosen for a small initial-language adoption sample, before
validation results were known. They were not replaced after failures. This is
not a randomized sample, an independent rule-effectiveness holdout, a replacement
for upstream CI, or a measurement of general false-positive rates.

## Observations

The [measurement record](measurements/public-adoption-alpha2.json) separates the
policy created by `init` from an explicitly narrowed, root-language-only policy.
`doctor` continues to identify omitted ecosystems in the narrower policy.
A passing selected check does not mean the entire repository was validated.

| Public project                                                                                                   | Selected language checks        | Native baseline and alpha.2 observation                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Nano ID](https://github.com/ai/nanoid/tree/57009b5eb8d757ae39bf5f4361dd30c9f23391b7)                            | Node tests                      | Both ran 79 tests successfully. The full policy remains incomplete without workflow configuration/tooling. Benchmark, browser tooling, size, prebuild, lint and declaration validation were not included.                                                   |
| [mitt](https://github.com/developit/mitt/tree/6b41670516ed8e8b738612f60491995470aa63b3)                          | TypeScript 4.9.5                | Initial native checking needs the generated root declaration. After generating it, native typechecking passes; alpha.2 still fails with TS5023 because this compiler does not support `--noCheck`. Mocha and other package scripts were not run.            |
| [more-itertools](https://github.com/more-itertools/more-itertools/tree/1da45ae4b61a832ed080f08a8833784aad0a9534) | unittest, Python 3.12           | Both ran 928 tests successfully. Full setup also discovers workflows and a separate documentation project; its selected unittest check has no candidate tests. Documentation builds, type stubs and workflow validation remain outside the narrowed result. |
| [google/uuid](https://github.com/google/uuid/tree/2d3c2a9cc518326daf99a383f07c4d3c44317e4d)                      | gofmt, vet and tests, Go 1.27.1 | Native test events report 212 passes and one skip. Both formatting checks report the same seven files. Checktrail marks vet/tests inconclusive because the native platform selection omits `node_js.go`; the formatting failure makes the aggregate failed. |
| [PSR Log](https://github.com/php-fig/log/tree/f16e1d5863e37f8d8c2a01719f5b34baa2b714d3)                          | PHP 8.4 syntax                  | All eight files pass native and Checktrail syntax checks. Host diagnosis reports PHP missing; prepared Linux execution succeeds. This provides no type, behavior or test evidence.                                                                          |

Counts above describe this pinned snapshot and are reconciled with the linked
record. Go's zero exit status from `gofmt -l` does not mean formatted source;
its listed paths are findings. Its skipped test and platform-excluded file are
retained instead of turning native exit zero into complete validation.

Each checkout received an original, temporary failing control. Node, Python, Go
and PHP detected the intended failure. Go retained its existing skip and formatting
findings. TypeScript's native run diagnosed the inserted TS2322 error, but alpha.2
stopped at the unsupported compiler option; that is not credited as detection.
Controls were removed in `finally`, and tracked upstream file hashes remained
unchanged. `init --write` preservation was checked byte for byte, and read-only
operations were checked against the project tree.

## What this changes in the roadmap

- TypeScript needs a capability/version preflight for older compilers, with a
  clear unavailable-tool explanation, or an explicitly tested compatible invocation.
  Alpha.2's existing native verification covers TypeScript 6.0.3; this exercise
  does not extend that support to 4.9.5.
- Setup guidance should distinguish an executable language profile from workflow
  tooling and documentation projects. Explicit narrowing must keep the omitted
  coverage visible.
- Go needs an explicit policy for platform/build-tag coverage before a developer
  can distinguish intentional target exclusions from accidentally missed source.
  This observation does not justify silently ignoring excluded files.

These are recorded adoption gaps, not fixes applied to the immutable alpha.2
package. No new engine version is published by this exercise.

## Unreleased follow-up

The [compiler compatibility fix](TYPESCRIPT.md) now passes a known-case mitt replay
with TypeScript 4.9.5 through a locally packed CLI, library and MCP. The observations
above still describe published alpha.2; they are not replaced by the fixed source
checkout's results. Workflow/documentation setup and Go platform coverage remain
separate work.

## Reproduce

Use macOS arm64 with Node 26.8.1 and Go 1.27.1 to reproduce the recorded host
profile. PHP and Python use the image identities in the measurement record;
Docker execution disables networking and mounts project inputs read-only.
The host does not impose an OS network sandbox. No Sail is used.

Download the tarball and `SHA256SUMS` from the
[alpha.2 GitHub release](https://github.com/stsepelin/checktrail/releases/tag/v0.1.0-alpha.2),
then verify SHA-256
`ffd0564f40a12a238a52fe25fe8c34fb36cf6f6480be7b6994bab82a3bd657fb`.
The original measurement installed the exact version from npm; reproduction
installs that same verified tarball with lifecycle scripts disabled.

```sh
node scripts/prepare-public-adoption.mjs /new/adoption-directory /absolute/release.tgz
```

Preparation downloads pinned public Git revisions and installs the engine and
explicit TypeScript tools. It does not run upstream package scripts. The TypeScript
tool profile is compiler 4.9.5 plus `@types/chai` 4.3.20, `@types/mocha` 7.0.2,
`@types/sinon` 9.0.11 and `@types/sinon-chai` 3.2.12. The preparation lockfile records
transitive dependency resolutions; it is not an upstream lockfile or a claim that
all upstream build/test dependencies were installed.

Prepare the Python/Node image using `scripts/external-tools.Dockerfile`, and the
PHP/Node image using `scripts/adoption-php.Dockerfile`. Compare local image IDs
with the record. A rebuilt image may have a different ID: a run with different
image bytes is a new environment observation, not a reproduction of that exact
runtime. The recorded Python image must already be present for this harness.

```sh
docker build --network=none --pull=false -f scripts/adoption-php.Dockerfile -t checktrail-adoption-php:alpha2 scripts
CHECKTRAIL_ADOPTION_PHP_IMAGE="$(docker image inspect checktrail-adoption-php:alpha2 --format '{{.Id}}')" \
  node scripts/measure-public-adoption.mjs /new/adoption-directory /absolute/release.tgz
```

Measurement downloads nothing. It verifies installed engine files against the
reviewed artifact, checks upstream revisions and tracked hashes, measures both
policy scopes, compares native accounting, and applies/removes the original
controls. mitt's generated declaration is prepared separately with the installed
compiler and removed afterwards. Fresh checkouts are required for another run;
the harness preserves detailed local evidence and created policies for inspection.

Raw process outputs stay under the prepared directory's `observations/` folder.
The committed record contains relative file names, counts, diagnostic codes,
versions, hashes, outcomes and timing observations, not source or raw tool prose.
Timings include CLI/process startup and, for containers, Docker invocation; cache
state, native/wrapper order and scheduling are uncontrolled. They do not support
a representative speed comparison. No model is invoked and no prior human/model
review workflow is compared.
