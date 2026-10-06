# Retained native process evidence

Version 3 Boolean Node probe receipts retain one process-attempt artifact for
every reached case. Unstarted cases retain no invented attempt. The artifact
records exit/signal, cancellation/timeout/truncation/error, the exact worker
request digest and bounded physical stdout/stderr bytes as canonical Base64 with
byte counts and SHA-256 hashes. Versions 1 and 2 remain readable as historical
contracts and contain no new raw evidence by implication.

Ordinary process runs retain the existing UTF-8 presentation. Raw capture is an
engine-selected option and grants no execution permission. Native probes require
the same operator trust as before. Trusted project execution is not sandboxed.

## Bytes and interpretation

The two streams share the existing physical retention limit. Delivered bytes can
exceed that limit before termination; the retained prefix is not complete output.
A cut UTF-8 sequence may render as a replacement character whose presentation
occupies more bytes. Its physical receipt still retains exactly the original
prefix. Invalid UTF-8 and NUL bytes remain recoverable from Base64. The artifact does
not record ordering between stdout and stderr events.

`completeForObservedStreams` means the received streams were retained without a
known truncation or forced drain. It does not prove completed source execution,
complete application logging or semantic correctness. An empty, failed,
cancelled or timed-out attempt cannot become a passing probe.

The receipt parser checks canonical bytes, counts and digests, reconciles them
with the existing per-call and aggregate budget, and replays retained valid worker
JSON against request/source/actual/range observations. A rehashed changed Boolean
cannot preserve the original parsed observation. JSON schema shape alone does
not establish that a kernel process ran; imported evidence needs its enclosing
source/artifact bindings and retains the existing unverified claim flags.

## Privacy and scope

Probe summaries omit trials and raw artifacts. Independent model packets keep
the existing explicit raw-observation projection and withhold private process
artifacts, aggregate prior verdicts and candidate confidence/severity. Private
workflow journals retain the complete reached native receipt under their existing
exclusive ownership and retention limits; failures remain incomplete.

The required `physical-process-output` controls cover binary data, zero/exact/
overrun limits, canonical/digest tampering, the maximum retained boundary and
pre-execution admission. `native-raw-evidence` additionally covers actual Boolean
worker output replay, malformed stdout/stderr, overrun, started-source
cancellation, legacy receipts and summary withholding. The seven required controls pass in source and fresh offline production
installations on macOS arm64 Node 26.9.0 and Linux arm64 Node 22.23.2. The Linux
profile uses an immutable prepared image with networking disabled. Three
compiling guards are killed by unchanged original assertions, with positive
baselines and restored runs. The receipt records exact code and artifact pins.
Windows and broader tool/model profiles remain pending.

This is the bounded Node receipt profile. Other native tool/model attempt
retention, general claim resolution, external session evidence and quality gates
remain required. No model inference or real-project field evaluation is enabled.
