import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { scala2Artifacts } from "./scala2-artifacts.js";
export const scala2Hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
export function scala2Libraries(archive: Buffer): Map<string, Buffer> {
  if (
    archive.length !== scala2Artifacts.archiveBytes ||
    scala2Hash(archive) !== scala2Artifacts.archiveSha256
  )
    throw Error("The pinned Scala 2 compiler archive bytes disagree");
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
    throw Error("Unsupported Scala 2 archive directory");
  const count = archive.readUInt16LE(end + 10),
    offset = archive.readUInt32LE(end + 16),
    size = archive.readUInt32LE(end + 12);
  if (
    archive.readUInt16LE(end + 8) !== count ||
    offset + size !== end ||
    count > 512
  )
    throw Error("Scala 2 archive directory bounds disagree");
  const result = new Map<string, Buffer>();
  let cursor = offset;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50)
      throw Error("Malformed Scala 2 archive entry");
    const nameSize = archive.readUInt16LE(cursor + 28),
      extra = archive.readUInt16LE(cursor + 30),
      comment = archive.readUInt16LE(cursor + 32),
      next = cursor + 46 + nameSize + extra + comment;
    if (next > end) throw Error("Scala 2 archive entry bounds disagree");
    const name = archive.subarray(cursor + 46, cursor + 46 + nameSize);
    const library = scala2Artifacts.runtimeLibraries.find((item) =>
      name.equals(Buffer.from("scala-2.13.18/" + item.path)),
    );
    if (library) {
      if (result.has(library.name))
        throw Error("Duplicate pinned Scala 2 library");
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
        throw Error("Scala 2 runtime library header disagrees");
      const localName = archive.readUInt16LE(local + 26),
        localExtra = archive.readUInt16LE(local + 28),
        data = local + 30 + localName + localExtra;
      if (
        !archive.subarray(local + 30, local + 30 + localName).equals(name) ||
        archive.readUInt16LE(local + 8) !== method ||
        data + compressed > offset
      )
        throw Error("Scala 2 runtime library data bounds disagree");
      const encoded = archive.subarray(data, data + compressed),
        bytes =
          method === 8
            ? inflateRawSync(encoded, { maxOutputLength: library.bytes + 1 })
            : encoded;
      if (
        bytes.length !== library.bytes ||
        scala2Hash(bytes) !== library.sha256
      )
        throw Error("Pinned Scala 2 runtime library bytes disagree");
      result.set(library.name, bytes);
    }
    cursor = next;
  }
  if (cursor !== end || result.size !== scala2Artifacts.runtimeLibraries.length)
    throw Error("Scala 2 runtime library inventory is incomplete");
  return result;
}
