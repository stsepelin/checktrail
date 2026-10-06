import { setTimeout as delay } from "node:timers/promises";

// Explicit operator acquisition only. Validation never invokes this helper.
// Retry the observed Central artifact rate limit, never a compiler/test/checksum
// failure, a killed process, or a warning from a successful attempt.
export async function acquireMavenDependencies({
  invoke,
  beforeRetry,
  delayImpl = delay,
}) {
  const waits = [5000, 15000];
  for (let attempt = 1; ; attempt++) {
    try {
      return { output: await invoke(), attempts: attempt };
    } catch (failure) {
      const retryable =
        failure?.status === 1 &&
        failure?.signal == null &&
        failure?.code == null &&
        /^\[ERROR\].*Could not transfer artifact [^\r\n]+ from\/to central \(https:\/\/repo\.maven\.apache\.org\/maven2\): HTTP Status: 429[ \t]*$/m.test(
          String(failure.stdout ?? ""),
        );
      if (!retryable || attempt > waits.length) throw failure;
      await delayImpl(waits[attempt - 1]);
      await beforeRetry();
    }
  }
}
