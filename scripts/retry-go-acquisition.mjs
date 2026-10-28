import { setTimeout as delay } from "node:timers/promises";

// Explicit operator acquisition only. Validation never invokes this helper.
// Admit only checksum-service tile and module-proxy zip stream failures, never integrity,
// compiler, mixed diagnostic, process-budget, or killed-process failures.
const checksumTileStreamError =
  /^[^\r\n]+: verifying module: [^ \r\n]+: reading https:\/\/sum\.golang\.org\/tile\/[0-9]+\/[0-9]+\/(?:x[0-9]{3}\/)*[0-9]{3}(?:\.p\/[0-9]+)?: stream error: stream ID [1-9][0-9]*; INTERNAL_ERROR; received from peer$/;
const moduleProxyStreamError =
  /^[^\r\n]+: [^ \r\n]+: read "https:\/\/proxy\.golang\.org\/(?:[a-zA-Z0-9!._~/-]|%21)+\/@v\/v[0-9][a-zA-Z0-9.+_-]*\.zip": stream error: stream ID [1-9][0-9]*; INTERNAL_ERROR; received from peer$/;
const transportFailure = (line) =>
  checksumTileStreamError.test(line) || moduleProxyStreamError.test(line);
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
        lines.some(transportFailure) &&
        lines.every(
          (line) => transportFailure(line) || downloadNotice.test(line),
        );
      if (!retryable || attempt > waits.length) throw failure;
      onRetry?.({ attempt, delayMs: waits[attempt - 1] });
      await delayImpl(waits[attempt - 1]);
    }
  }
}
