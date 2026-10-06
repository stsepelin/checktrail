import { createHash } from "node:crypto";
import { link, lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { withinRoot } from "./inventory.js";
import { externalPathSchema } from "./external-schema.js";
import { parseExecutableBundle } from "./executable-bundle.js";
import { downloadPinnedArtifact } from "./pinned-download.js";
import type { ExternalReference } from "./external-adapter.js";
const optionsSchema = z.strictObject({
  url: z.string().min(1).max(8192),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  output: externalPathSchema.refine((s) => s.endsWith(".bundle.json")),
  timeoutMs: z.number().int().min(1).max(120000).default(30000),
});
export interface FetchAdapterOptions {
  url: string;
  sha256: string;
  output: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface FetchedAdapter {
  schemaVersion: 1;
  id: string;
  version: string;
  bytes: number;
  files: number;
  decodedBytes: number;
  manifestSha256: string;
  reference: ExternalReference;
  activated: false;
  codeExecuted: false;
}
export async function fetchExternalAdapter(
  root: string,
  input: FetchAdapterOptions,
): Promise<FetchedAdapter> {
  const { signal, ...provided } = input;
  const parsed = optionsSchema.safeParse(provided);
  if (!parsed.success)
    throw Error("Invalid executable bundle download options");
  const options = parsed.data;
  let url: URL;
  try {
    url = new URL(options.url);
  } catch {
    throw Error("Executable bundle endpoint must be an absolute HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw Error(
      "Executable bundle endpoint requires HTTPS without user information or a fragment",
    );
  const canonicalRoot = await realpath(root);
  const parent = await withinRoot(canonicalRoot, path.dirname(options.output));
  if (parent !== path.resolve(canonicalRoot, path.dirname(options.output)))
    throw Error(
      "Executable bundle output directories must not traverse symbolic links",
    );
  const destination = path.join(parent, path.basename(options.output));
  try {
    await lstat(destination);
    throw Error("Executable bundle output already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const bytes = await downloadPinnedArtifact(
    url,
    options.timeoutMs,
    signal,
    "external-bundle",
  );
  if (createHash("sha256").update(bytes).digest("hex") !== options.sha256)
    throw Error("Executable bundle integrity mismatch");
  const bundle = parseExecutableBundle(bytes);
  if (signal?.aborted) throw Error("Executable bundle download cancelled");
  const temporary = await mkdtemp(path.join(parent, ".checktrail-bundle-"));
  try {
    const staged = path.join(temporary, "bundle.json");
    const handle = await open(staged, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (signal?.aborted) throw Error("Executable bundle download cancelled");
    await link(staged, destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return {
    schemaVersion: 1,
    id: bundle.manifest.id,
    version: bundle.manifest.version,
    bytes: bytes.length,
    files: bundle.manifest.files.length,
    decodedBytes: bundle.decodedBytes,
    manifestSha256: bundle.manifestSha256,
    reference: { path: destination, sha256: options.sha256 },
    activated: false,
    codeExecuted: false,
  };
}
