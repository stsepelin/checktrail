import { setTimeout as delay } from "node:timers/promises";

// Explicit operator acquisition only. Validation never invokes this helper.
// Admit only the checksum-service tile transport failure, never integrity,
// compiler, mixed diagnostic, process-budget, or killed-process failures.
const checksumTileStreamError =
  /^[^\r\n]+: verifying module: [^ \r\n]+: reading https:\/\/sum\.golang\.org\/tile\/[0-9]+\/[0-9]+\/(?:x[0-9]{3}\/)*[0-9]{3}(?:\.p\/[0-9]+)?: stream error: stream ID [1-9][0-9]*; INTERNAL_ERROR; received from peer$/;
const downloadNotice = /^go: downloading [^ \t\r\n]+ v[^ \t\r\n]+$/;

export async function acquirePinnedGoAnalyzer({
  invoke,
  onRetry,
  delayImpl = delay,
}) {
  const waits = [1000, 3000];
  for (let attempt = 1; ; attempt++) {
    try {
      return { output: await invoke(), attempts: attempt };
    } catch (failure) {
      const lines = String(failure?.stderr ?? "")
        .trim()
        .split(/\r?\n/);
      const retryable =
        failure?.status === 1 &&
        failure.signal == null &&
        failure.code == null &&
        !String(failure.stdout ?? "").trim() &&
        lines.some((line) => checksumTileStreamError.test(line)) &&
        lines.every(
          (line) =>
            checksumTileStreamError.test(line) || downloadNotice.test(line),
        );
      if (!retryable || attempt > waits.length) throw failure;
      onRetry?.({ attempt, delayMs: waits[attempt - 1] });
      await delayImpl(waits[attempt - 1]);
    }
  }
}
