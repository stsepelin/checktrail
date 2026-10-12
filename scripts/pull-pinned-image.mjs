import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
const transient = (error) => {
  if (
    error?.signal ||
    error?.code === "ETIMEDOUT" ||
    error?.code === "ABORT_ERR"
  )
    return false;
  const text = String(error?.stderr ?? "");
  return (
    /^Error response from daemon: Get "https:\/\/public\.ecr\.aws\/v2\/": net\/http: request canceled while waiting for connection \(Client\.Timeout exceeded while awaiting headers\)$/.test(
      text.trim(),
    ) ||
    /(?:^|\s)toomanyrequests:\s*Rate exceeded(?:\s|$)/i.test(text) ||
    /(?:unexpected (?:HTTP )?status(?: code)?|HTTP response code|received status)[^\n]{0,200}\b(?:429|500|502|503|504)\b/i.test(
      text,
    )
  );
};
// Operator setup only. An exact image digest remains mandatory on every attempt.
export async function pullPinnedImage(
  reference,
  {
    signal = globalThis.AbortSignal.timeout(180000),
    timeoutMs = 180000,
    nowImpl = () => performance.now(),
    runImpl = (image, remainingMs) =>
      execFileSync("docker", ["pull", image], {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: Math.min(120000, remainingMs),
        signal,
      }),
    delayImpl = (ms) => setTimeout(ms, undefined, { signal }),
    onRetry = (event) =>
      process.stderr.write(
        JSON.stringify({ pinnedImageDeliveryRetry: event }) + "\n",
      ),
  } = {},
) {
  assert.equal(typeof reference, "string");
  const match =
    /^public\.ecr\.aws\/docker\/library\/[a-z][a-z0-9-]*@sha256:[a-f0-9]{64}$/.exec(
      reference,
    );
  const frozenMicrosoftSdk =
    "mcr.microsoft.com/dotnet/sdk@sha256:3cc3bbbbf93d82104892f42aa9106b6be4d120346dea0649643a97c801525256";
  assert.ok(
    (match && match[0] === reference) || reference === frozenMicrosoftSdk,
    "Select an exact pinned official public image reference",
  );
  assert.ok(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 180000,
    "Pinned image delivery wall limit is invalid",
  );
  const deadline = nowImpl() + timeoutMs;
  const remaining = () => {
    const budget = Math.ceil(deadline - nowImpl());
    if (budget <= 0) throw Error("Pinned image delivery wall limit exhausted");
    return budget;
  };
  const checkCompletion = () => {
    if (nowImpl() > deadline)
      throw Error("Pinned image delivery wall limit exhausted");
  };
  const waits = [2000, 5000, 15000, 30000];
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    try {
      await runImpl(reference, remaining());
      checkCompletion();
      signal.throwIfAborted();
      return { reference, attempts: attempt, deliveryComplete: true };
    } catch (error) {
      signal.throwIfAborted();
      if (!transient(error) || attempt > waits.length) throw error;
      await onRetry({ attempt, waitMs: waits[attempt - 1] });
      if (remaining() <= waits[attempt - 1])
        throw Error("Pinned image delivery wall limit exhausted", {
          cause: error,
        });
      await delayImpl(waits[attempt - 1]);
    }
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  assert.equal(
    process.argv.length,
    3,
    "Usage: pull-pinned-image.mjs EXACT_REFERENCE",
  );
  process.stdout.write(
    JSON.stringify(await pullPinnedImage(process.argv[2])) + "\n",
  );
}
