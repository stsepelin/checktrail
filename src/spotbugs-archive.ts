import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { spotbugsArtifacts } from "./spotbugs-artifacts.js";
// This parser accepts only the hash-pinned official archive, and retains only the
// enumerated runtime JARs. It does not extract scripts, project plugins or links.
export function spotbugsLibraries(archive: Buffer): Map<string, Buffer> {
  if (
    archive.length !== 15831983 ||
    createHash("sha256").update(archive).digest("hex") !==
      spotbugsArtifacts.archiveSha256
  )
    throw Error("SpotBugs archive integrity mismatch");
  const tar = gunzipSync(archive, { maxOutputLength: 32 * 1024 * 1024 });
  const outputs = new Map<string, Buffer>();
  const seen = new Set<string>();
  let offset = 0;
  for (; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, end: number) =>
      header.subarray(start, end).toString("ascii").split("\0")[0]!.trim();
    const name = field(0, 100),
      prefix = field(345, 500),
      type = field(156, 157),
      sizeField = field(124, 136),
      checksum = field(148, 156);
    if (
      prefix ||
      !/^[0-7]+$/.test(sizeField) ||
      !/^[0-7]+$/.test(checksum) ||
      !["0", "5"].includes(type) ||
      !name.startsWith("spotbugs-4.10.4/") ||
      name.split("/").some((part) => part === ".." || part === ".") ||
      seen.has(name)
    )
      throw Error("Unsupported pinned SpotBugs archive structure");
    seen.add(name);
    if (seen.size > 128) throw Error("SpotBugs archive entry bound");
    let sum = 0;
    for (let index = 0; index < 512; index++)
      sum += index >= 148 && index < 156 ? 32 : header[index]!;
    const size = Number.parseInt(sizeField, 8);
    if (
      sum !== Number.parseInt(checksum, 8) ||
      offset + 512 + size > tar.length ||
      (type === "5" && size)
    )
      throw Error("Malformed SpotBugs archive");
    const declaration = spotbugsArtifacts.libraries.find(
      (item) => name === `spotbugs-4.10.4/lib/${item.name}`,
    );
    if (declaration) {
      const bytes = tar.subarray(offset + 512, offset + 512 + size);
      if (
        type !== "0" ||
        size !== declaration.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== declaration.sha256
      )
        throw Error("SpotBugs library integrity mismatch");
      outputs.set(declaration.name, bytes);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (
    outputs.size !== spotbugsArtifacts.libraries.length ||
    offset + 1024 > tar.length ||
    !tar.subarray(offset).every((byte) => byte === 0)
  )
    throw Error("Incomplete SpotBugs archive");
  return outputs;
}
