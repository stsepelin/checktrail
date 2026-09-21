import { createHash } from "node:crypto";
import { link, lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { request } from "node:https";
import path from "node:path";
import { z } from "zod";
import { withinRoot } from "./inventory.js";
import { parsePolicyPack, type PackReference } from "./policy-pack.js";

const optionsSchema = z.strictObject({
  url: z.string().min(1).max(8192),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  output: z.string().min(1).max(4096),
  timeoutMs: z.number().int().min(1).max(120_000).default(30_000),
});
export interface FetchPackOptions {
  url: string;
  sha256: string;
  output: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface FetchedPack {
  schemaVersion: 1;
  id: string;
  version: string;
  bytes: number;
  reference: PackReference;
}

async function download(
  url: URL,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (signal?.aborted) throw new Error("Policy pack download cancelled");
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
    const cancel = (): void =>
      finish(new Error("Policy pack download cancelled"));
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
          finish(new Error("Policy pack transfer failed")),
        );
        if (response.statusCode !== 200) {
          finish(
            new Error(
              "Policy pack endpoint must return HTTP 200; redirects are not followed",
            ),
          );
          return;
        }
        const length = response.headers["content-length"];
        if (
          (length && (!/^\d+$/.test(length) || Number(length) > 64 * 1024)) ||
          (response.headers["content-encoding"] &&
            response.headers["content-encoding"] !== "identity")
        ) {
          finish(
            new Error(
              "Policy pack response exceeds limits or uses content encoding",
            ),
          );
          return;
        }
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 64 * 1024)
            finish(new Error("Policy pack exceeds 64 KiB limit"));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          if (!response.complete)
            finish(new Error("Policy pack transfer is incomplete"));
          else finish();
        });
      },
    );
    const timer = setTimeout(
      () => finish(new Error("Policy pack download timed out")),
      timeoutMs,
    );
    req.on("error", () =>
      finish(new Error("Policy pack HTTPS connection failed")),
    );
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    else req.end();
  });
}

export async function fetchPolicyPack(
  root: string,
  input: FetchPackOptions,
): Promise<FetchedPack> {
  const { signal, ...provided } = input;
  const parsed = optionsSchema.safeParse(provided);
  if (!parsed.success) throw new Error("Invalid policy pack download options");
  const options = parsed.data;
  let url: URL;
  try {
    url = new URL(options.url);
  } catch {
    throw new Error("Policy pack endpoint must be an absolute HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error(
      "Policy pack endpoint requires HTTPS without user information or a fragment",
    );
  const output = options.output;
  if (
    path.isAbsolute(output) ||
    path.posix.normalize(output) !== output ||
    output.startsWith("../") ||
    output === ".." ||
    output === "." ||
    !output.endsWith(".json") ||
    [...output].some(
      (character) =>
        character === "\\" ||
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127,
    )
  )
    throw new Error(
      "Policy pack output must be a normalized relative JSON path",
    );
  const canonicalRoot = await realpath(root);
  const parent = await withinRoot(canonicalRoot, path.dirname(output));
  if (parent !== path.resolve(canonicalRoot, path.dirname(output)))
    throw new Error(
      "Policy pack output directories must not traverse symbolic links",
    );
  const destination = path.join(parent, path.basename(output));
  try {
    await lstat(destination);
    throw new Error("Policy pack output already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const bytes = await download(url, options.timeoutMs, signal);
  if (createHash("sha256").update(bytes).digest("hex") !== options.sha256)
    throw new Error("Policy pack integrity mismatch");
  let pack;
  try {
    pack = parsePolicyPack(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    );
  } catch {
    throw new Error("Downloaded policy pack is not valid UTF-8 policy JSON");
  }
  if (signal?.aborted) throw new Error("Policy pack download cancelled");
  const temporary = await mkdtemp(path.join(parent, ".checktrail-pack-"));
  try {
    const staged = path.join(temporary, "pack.json");
    const handle = await open(staged, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (signal?.aborted) throw new Error("Policy pack download cancelled");
    // A hard link publishes complete bytes without replacing a concurrently created destination.
    await link(staged, destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return {
    schemaVersion: 1,
    id: pack.id,
    version: pack.version,
    bytes: bytes.length,
    reference: { path: output, sha256: options.sha256 },
  };
}
