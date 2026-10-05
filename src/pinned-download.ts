import { request } from "node:https";
export async function downloadPinnedArtifact(
  url: URL,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  profile: "policy-pack" | "external-bundle",
): Promise<Buffer> {
  const label = profile === "policy-pack" ? "Policy pack" : "Executable bundle";
  const limit = profile === "policy-pack" ? 64 * 1024 : 192 * 1024 * 1024;
  const limitLabel = profile === "policy-pack" ? "64 KiB" : "192 MiB";
  if (signal?.aborted) throw new Error(`${label} download cancelled`);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (error) {
        req.destroy();
        reject(error);
      } else resolve(Buffer.concat(chunks));
    };
    const cancel = (): void => finish(new Error(`${label} download cancelled`));
    const req = request(
      url,
      {
        method: "GET",
        agent: false,
        rejectUnauthorized: true,
        maxHeaderSize: 16 * 1024,
        headers: { Accept: "application/json", "Accept-Encoding": "identity" },
      },
      (response) => {
        response.on("error", () =>
          finish(new Error(`${label} transfer failed`)),
        );
        if (response.statusCode !== 200) {
          finish(
            new Error(
              `${label} endpoint must return HTTP 200; redirects are not followed`,
            ),
          );
          return;
        }
        const length = response.headers["content-length"];
        if (
          (length && (!/^\d+$/.test(length) || Number(length) > limit)) ||
          (response.headers["content-encoding"] &&
            response.headers["content-encoding"] !== "identity")
        ) {
          finish(
            new Error(
              `${label} response exceeds limits or uses content encoding`,
            ),
          );
          return;
        }
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > limit)
            finish(new Error(`${label} exceeds ${limitLabel} limit`));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          if (!response.complete)
            finish(new Error(`${label} transfer is incomplete`));
          else finish();
        });
      },
    );
    const timer = setTimeout(
      () => finish(new Error(`${label} download timed out`)),
      timeoutMs,
    );
    req.on("error", () =>
      finish(new Error(`${label} HTTPS connection failed`)),
    );
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    else req.end();
  });
}
