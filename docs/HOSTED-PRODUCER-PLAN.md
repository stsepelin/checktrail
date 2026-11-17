# GitHub-hosted producer execution

Gate A producer work uses standard GitHub-hosted runners available to public
repositories. It does not depend on a dedicated host, a paid larger runner or an
operator supplying an old Apple SDK. Full selected producer, compiler, SDK,
bootstrap and original-notice closure remains required. Each completed build
qualifies its recorded inputs and environment; historical publisher binary
equality is a separate observation.

GitHub limits each hosted job to [six hours](https://docs.github.com/en/actions/reference/limits).
Preparation, stopping, retention, upload and runner finalization consume that same
budget. Long producer qualification stays in explicit maintenance workflows;
ordinary PR verification must not start these builds.

## GCC: implement bounded continuation

The existing profile selects Debian GCC 12.2.0-14+deb12u1 and
`dpkg-buildpackage -b -us -uc --jobs=4`. Its interrupted observation did not retain
a restorable native work tree or observe the original command's terminal result.
It cannot be resumed from the retained reports. The twelve-hour internal command
deadline does not extend a hosted job's six-hour limit.

The next implementation must use the original Debian recipe's configure, build,
JIT/offload, check, install and binary-package stamp dependencies as explicit
continuation boundaries. Preserve the selected languages, multilib, bootstrap,
conditional targets, checks and package outputs. Do not reduce them to fit a job.
The default package command cleans before building, so restarting that command
would discard a restored tree. Changed orchestration requires its own declared
profile and a phase ledger; it must not be reported as one uninterrupted original
`dpkg-buildpackage` invocation.

A single upstream target may itself exceed a job budget; these stamps are
candidate boundaries, not measured duration guarantees. The
[GCC 12 stage targets](https://gcc.gnu.org/onlinedocs/gcc-12.2.0/gccint/Makefile.html)
can provide finer bootstrap boundaries only under an explicit command plan that
preserves all original flags and subsequently re-enters the full Debian build
and default check dependencies. An unfinished target stays incomplete.

Before a production-length retry, validate stopped-state capture and restoration of the
complete work tree at the same absolute build paths, including source and package
identities, contents, modes, links and timestamps. Bind every checkpoint to its
completed and incomplete phases and verify it before starting the next job.
Stamps alone do not prove completion. Preserve original failures and upstream
test outcomes across jobs. An interrupted phase remains incomplete until its
safe re-entry and genuine completion have been demonstrated.

Replace the earlier dedicated-host capacity request with measured admission for
each hosted stage. Account for the expanded tree, inputs, checkpoint transport,
temporary copies and free-space reserve together. Recorded logical-file samples
are not a continuous physical disk or memory high-water measurement. Refuse
insufficient capacity and retain the failure rather than starting another
identical cutoff attempt. Checkpoint transport, storage fit and full staged
completion are still unqualified.

## Binaryen: use the hosted SDK selected explicitly

The selected source is Binaryen
[`79dfe6b412a3c22bfdb190ed6a4d79adf734db5d`](https://github.com/WebAssembly/binaryen/tree/79dfe6b412a3c22bfdb190ed6a4d79adf734db5d).
Its [release workflow](https://github.com/WebAssembly/binaryen/blob/79dfe6b412a3c22bfdb190ed6a4d79adf734db5d/.github/workflows/create_release.yml)
uses `macos-14`, which GitHub has
[retired](https://github.com/actions/runner-images/issues/13518), but does not pin
Xcode 15.4 or SDK 14.5. The root CMake declaration does not pin those versions
either. SDK 14.5 was observed in the historical delivered binary; requiring the
operator to provide it was an additional replay assumption.

Prepare the native ARM64 source build on standard `macos-15`, selecting
`/Applications/Xcode_16.4.app/Contents/Developer` explicitly. GitHub's
[ARM64 image inventory](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-arm64-Readme.md)
lists Xcode 16.4 and macOS SDK 15.5. Verify their actual identity, architecture,
physical tool/SDK inputs and capacity on the assigned runner before execution;
the runner label does not freeze its image. Keep the original ARM64 configure,
build/install, strip and local packaging commands and their selected defaults.
Invoke those selected ARM64 phases explicitly: the original workflow's ARM64
packaging condition admits `macos-14`, so changing only its runner label would
skip packaging. Do not treat that skipped phase as a successful release build.
Compiling test executables does not establish an upstream test run.

A successful observation can close the source-build facet for that recorded
hosted environment. It cannot establish reproduction of SDK 14.5, the old runner
or the historical binary bytes. Preserve those distinctions, original notices,
new output identities and consumer obligations. Source/Gitlink preparation,
controller validation, actual execution and capture remain required before any
completion claim.

## Acceptance remains open

These paths correct the infrastructure assumptions; they do not constitute build
receipts. Earlier interrupted runs and frozen plans remain unchanged historical
records. Complete the current producer evidence and final native acceptance
bindings before closing Gate A. No model review or real-project field trial is
enabled by this plan.
