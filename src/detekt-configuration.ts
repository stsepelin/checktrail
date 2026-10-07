import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { parseDocument, stringify } from "yaml";
import { detektArtifacts } from "./detekt-artifacts.js";

export const detektHash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

/** Extract one fixed data resource only from the byte-verified pinned JAR. */
export function detektConfiguration(archive: Buffer): string {
  if (
    archive.length !== detektArtifacts.jarBytes ||
    detektHash(archive) !== detektArtifacts.jarSha256
  )
    throw Error("The pinned detekt JAR bytes disagree");
  let end = -1;
  for (
    let offset = archive.length - 22;
    offset >= Math.max(0, archive.length - 65557);
    offset--
  ) {
    if (
      archive.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + archive.readUInt16LE(offset + 20) === archive.length
    ) {
      end = offset;
      break;
    }
  }
  if (end < 0 || archive.readUInt16LE(end + 4) || archive.readUInt16LE(end + 6))
    throw Error("Unsupported pinned JAR directory");
  const entries = archive.readUInt16LE(end + 10),
    directorySize = archive.readUInt32LE(end + 12),
    directoryOffset = archive.readUInt32LE(end + 16);
  if (
    archive.readUInt16LE(end + 8) !== entries ||
    directoryOffset + directorySize !== end
  )
    throw Error("Pinned JAR directory bounds disagree");
  let cursor = directoryOffset;
  let resource: Buffer | undefined;
  for (let i = 0; i < entries; i++) {
    if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50)
      throw Error("Malformed pinned JAR entry");
    const nameBytes = archive.readUInt16LE(cursor + 28),
      extra = archive.readUInt16LE(cursor + 30),
      comment = archive.readUInt16LE(cursor + 32),
      next = cursor + 46 + nameBytes + extra + comment;
    if (next > end) throw Error("Pinned JAR entry exceeds its directory");
    const name = archive.subarray(cursor + 46, cursor + 46 + nameBytes);
    if (name.equals(Buffer.from("default-detekt-config.yml"))) {
      if (resource) throw Error("Duplicate pinned detekt configuration");
      const flags = archive.readUInt16LE(cursor + 8),
        method = archive.readUInt16LE(cursor + 10),
        compressed = archive.readUInt32LE(cursor + 20),
        expanded = archive.readUInt32LE(cursor + 24),
        local = archive.readUInt32LE(cursor + 42);
      if (
        flags & 1 ||
        ![0, 8].includes(method) ||
        expanded !== detektArtifacts.defaultConfigBytes ||
        compressed > 65536 ||
        local + 30 > directoryOffset ||
        archive.readUInt32LE(local) !== 0x04034b50
      )
        throw Error("Pinned detekt configuration header disagrees");
      const localName = archive.readUInt16LE(local + 26),
        localExtra = archive.readUInt16LE(local + 28),
        data = local + 30 + localName + localExtra;
      if (
        !archive.subarray(local + 30, local + 30 + localName).equals(name) ||
        archive.readUInt16LE(local + 8) !== method ||
        data + compressed > directoryOffset
      )
        throw Error("Pinned detekt configuration data bounds disagree");
      const bytes = archive.subarray(data, data + compressed);
      resource =
        method === 8
          ? inflateRawSync(bytes, { maxOutputLength: 65536 })
          : bytes;
    }
    cursor = next;
  }
  if (
    cursor !== end ||
    !resource ||
    resource.length !== detektArtifacts.defaultConfigBytes ||
    detektHash(resource) !== detektArtifacts.defaultConfigSha256
  )
    throw Error("Pinned detekt default configuration disagrees");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(resource),
    document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length)
    throw Error("Pinned detekt YAML could not be read");
  const config = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
  const settings = config.config as Record<string, unknown>;
  settings.warningsAsErrors = true;
  for (const set of detektArtifacts.ruleSets) {
    const group = config[set] as Record<string, unknown>;
    if (typeof group?.active !== "boolean")
      throw Error("Pinned detekt built-in rule set disagrees");
    for (const value of Object.values(group)) {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !Object.hasOwn(value, "active")
      )
        continue;
      const rule = value as Record<string, unknown>;
      for (const key of [
        "includes",
        "excludes",
        "ignoreAnnotated",
        "ignoreFunction",
      ])
        if (Object.hasOwn(rule, key)) rule[key] = [];
    }
  }
  const result = stringify(config);
  if (
    Buffer.byteLength(result) !== detektArtifacts.configurationBytes ||
    detektHash(result) !== detektArtifacts.configurationSha256
  )
    throw Error("Fixed detekt configuration transformation disagrees");
  return result;
}
