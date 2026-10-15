import { inflateRawSync } from "node:zlib";
/** Inspect bounded ZIP directory data; never load classes or invoke project tools. */
export function kotlinJar(
  bytes: Buffer,
  maximumManifestBytes = 65536,
): {
  classPath: string[];
  entries: number;
} {
  if (
    !Number.isSafeInteger(maximumManifestBytes) ||
    maximumManifestBytes < 1 ||
    maximumManifestBytes > 1024 * 1024
  )
    throw Error("JAR manifest limit is invalid");
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6))
    throw Error("Unsupported Kotlin JAR directory");
  const count = bytes.readUInt16LE(end + 10),
    offset = bytes.readUInt32LE(end + 16),
    size = bytes.readUInt32LE(end + 12);
  if (
    count === 65535 ||
    bytes.readUInt16LE(end + 8) !== count ||
    offset + size !== end
  )
    throw Error("Kotlin JAR directory bounds disagree");
  let cursor = offset,
    manifest: string | undefined;
  const names = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw Error("Malformed Kotlin JAR entry");
    const n = bytes.readUInt16LE(cursor + 28),
      next =
        cursor +
        46 +
        n +
        bytes.readUInt16LE(cursor + 30) +
        bytes.readUInt16LE(cursor + 32);
    if (next > end) throw Error("Kotlin JAR entry bounds disagree");
    const encodedName = bytes.subarray(cursor + 46, cursor + 46 + n),
      name = new TextDecoder("utf-8", { fatal: true }).decode(encodedName);
    if (
      names.has(name) ||
      !name ||
      /[\\\0\r\n]/.test(name) ||
      name.startsWith("/") ||
      name.split("/").some((p) => p === "." || p === "..")
    )
      throw Error("Ambiguous Kotlin JAR entry");
    names.add(name);
    if (/\.(?:kt|kts|java|scala)$/.test(name))
      throw Error("Kotlin dependency JAR contains unselected source");
    if (name.toLowerCase() === "meta-inf/manifest.mf") {
      if (name !== "META-INF/MANIFEST.MF" || manifest !== undefined)
        throw Error("Ambiguous Kotlin JAR manifest");
      const method = bytes.readUInt16LE(cursor + 10),
        compressed = bytes.readUInt32LE(cursor + 20),
        expanded = bytes.readUInt32LE(cursor + 24),
        local = bytes.readUInt32LE(cursor + 42);
      if (
        bytes.readUInt16LE(cursor + 8) & 1 ||
        ![0, 8].includes(method) ||
        expanded > maximumManifestBytes ||
        compressed > maximumManifestBytes ||
        local + 30 > offset ||
        bytes.readUInt32LE(local) !== 0x04034b50
      )
        throw Error("Kotlin JAR manifest header disagrees");
      const localName = bytes.readUInt16LE(local + 26),
        data = local + 30 + localName + bytes.readUInt16LE(local + 28);
      if (
        !bytes
          .subarray(local + 30, local + 30 + localName)
          .equals(encodedName) ||
        bytes.readUInt16LE(local + 8) !== method ||
        data + compressed > offset
      )
        throw Error("Kotlin JAR manifest data bounds disagree");
      const encoded = bytes.subarray(data, data + compressed),
        decoded =
          method === 8
            ? inflateRawSync(encoded, {
                maxOutputLength: maximumManifestBytes + 1,
              })
            : encoded;
      if (decoded.length !== expanded)
        throw Error("Kotlin JAR manifest length disagrees");
      manifest = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    }
    cursor = next;
  }
  if (cursor !== end) throw Error("Kotlin JAR inventory is incomplete");
  if (!manifest) return { classPath: [], entries: count };
  const lines = manifest.replace(/\r\n/g, "\n").replace(/\n /g, "").split("\n"),
    fields = new Map<string, string>();
  for (const line of lines) {
    if (line === "") break;
    const match = /^([A-Za-z0-9_-]+): (.*)$/.exec(line);
    if (!match || fields.has(match[1]!.toLowerCase()))
      throw Error("Malformed Kotlin JAR main manifest");
    fields.set(match[1]!.toLowerCase(), match[2]!);
  }
  const declared = fields.get("class-path");
  return { classPath: declared ? declared.split(/ +/) : [], entries: count };
}
