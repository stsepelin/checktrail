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
    text.trim() ===
      'Error response from daemon: Get "https://public.ecr.aws/v2/": context deadline exceeded' ||
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
  const frozenOfficialMirrors = new Set([
    "docker.io/library/swift@sha256:6dd90eb2359663a2cde8f03e9951f488b23134b3b8fce20e9dcb6cada75dd803",
    "docker.io/library/node@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9",
    "docker.io/library/ruby@sha256:79bf10b28c9d98b7b3cffda01aba8190aa1c1c48513d205ec93372a0e2f010e3",
    "docker.io/library/eclipse-temurin@sha256:541729c21f9308a68cebbe5a0627e4cd465dfe8980fc03bac0b2feaee57daafd",
    "docker.io/library/node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",
  ]);
  assert.ok(
    (match && match[0] === reference) ||
      reference === frozenMicrosoftSdk ||
      frozenOfficialMirrors.has(reference),
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
