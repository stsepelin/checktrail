import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { kotlinArtifacts } from "./kotlin-artifacts.js";
export const kotlinHash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
export function kotlinLibraries(archive: Buffer): Map<string, Buffer> {
  if (
    archive.length !== kotlinArtifacts.archiveBytes ||
    kotlinHash(archive) !== kotlinArtifacts.archiveSha256
  )
    throw Error("The pinned Kotlin compiler archive bytes disagree");
  let end = -1;
  for (
    let i = archive.length - 22;
    i >= Math.max(0, archive.length - 65557);
    i--
  )
    if (
      archive.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + archive.readUInt16LE(i + 20) === archive.length
    ) {
      end = i;
      break;
    }
  if (end < 0 || archive.readUInt16LE(end + 4) || archive.readUInt16LE(end + 6))
    throw Error("Unsupported Kotlin archive directory");
  const count = archive.readUInt16LE(end + 10),
    offset = archive.readUInt32LE(end + 16),
    size = archive.readUInt32LE(end + 12);
  if (
    archive.readUInt16LE(end + 8) !== count ||
    offset + size !== end ||
    count > 512
  )
    throw Error("Kotlin archive directory bounds disagree");
  const result = new Map<string, Buffer>();
  let cursor = offset;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50)
      throw Error("Malformed Kotlin archive entry");
    const nameSize = archive.readUInt16LE(cursor + 28),
      extra = archive.readUInt16LE(cursor + 30),
      comment = archive.readUInt16LE(cursor + 32),
      next = cursor + 46 + nameSize + extra + comment;
    if (next > end) throw Error("Kotlin archive entry bounds disagree");
    const name = archive.subarray(cursor + 46, cursor + 46 + nameSize);
    const library = kotlinArtifacts.runtimeLibraries.find((item) =>
      name.equals(Buffer.from("kotlinc/lib/" + item.name)),
    );
    if (library) {
      if (result.has(library.name))
        throw Error("Duplicate pinned Kotlin library");
      const flags = archive.readUInt16LE(cursor + 8),
        method = archive.readUInt16LE(cursor + 10),
        compressed = archive.readUInt32LE(cursor + 20),
        expanded = archive.readUInt32LE(cursor + 24),
        local = archive.readUInt32LE(cursor + 42);
      if (
        flags & 1 ||
        ![0, 8].includes(method) ||
        expanded !== library.bytes ||
        compressed > 64 * 1024 * 1024 ||
        local + 30 > offset ||
        archive.readUInt32LE(local) !== 0x04034b50
      )
        throw Error("Kotlin runtime library header disagrees");
      const localName = archive.readUInt16LE(local + 26),
        localExtra = archive.readUInt16LE(local + 28),
        data = local + 30 + localName + localExtra;
      if (
        !archive.subarray(local + 30, local + 30 + localName).equals(name) ||
        archive.readUInt16LE(local + 8) !== method ||
        data + compressed > offset
      )
        throw Error("Kotlin runtime library data bounds disagree");
      const encoded = archive.subarray(data, data + compressed),
        bytes =
          method === 8
            ? inflateRawSync(encoded, { maxOutputLength: library.bytes + 1 })
            : encoded;
      if (
        bytes.length !== library.bytes ||
        kotlinHash(bytes) !== library.sha256
      )
        throw Error("Pinned Kotlin runtime library bytes disagree");
      result.set(library.name, bytes);
    }
    cursor = next;
  }
  if (cursor !== end || result.size !== kotlinArtifacts.runtimeLibraries.length)
    throw Error("Kotlin runtime library inventory is incomplete");
  return result;
}
