import { inflateRawSync } from "node:zlib";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { kotlinJar } from "./kotlin-jar.js";
import type { SpotbugsExtensions } from "./spotbugs-extensions.js";
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
const crc32 = (bytes: Buffer) => {
  let value = 0xffffffff;
  for (const byte of bytes)
    value = (value >>> 8) ^ crcTable[(value ^ byte) & 255]!;
  return (value ^ 0xffffffff) >>> 0;
};
/** Bounded data inspection only. No plugin class loading, extraction or execution. */
export function spotbugsPluginJar(bytes: Buffer) {
  if (bytes.length > 32 * 1024 * 1024 || bytes.length < 22)
    throw Error("Plugin JAR byte bound");
  if (kotlinJar(bytes).classPath.length)
    throw Error("Plugin JAR cannot declare implicit dependency paths");
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  if (end < 0) throw Error("Plugin JAR directory unavailable");
  const count = bytes.readUInt16LE(end + 10),
    offset = bytes.readUInt32LE(end + 16);
  if (!count || count > 5000) throw Error("Plugin JAR entry bound");
  let cursor = offset,
    total = 0;
  const entries = new Map<string, Buffer>(),
    spans: Array<[number, number]> = [];
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw Error("Plugin JAR central header");
    const flags = bytes.readUInt16LE(cursor + 8),
      method = bytes.readUInt16LE(cursor + 10),
      crc = bytes.readUInt32LE(cursor + 16),
      compressed = bytes.readUInt32LE(cursor + 20),
      expanded = bytes.readUInt32LE(cursor + 24),
      length = bytes.readUInt16LE(cursor + 28),
      local = bytes.readUInt32LE(cursor + 42),
      next =
        cursor +
        46 +
        length +
        bytes.readUInt16LE(cursor + 30) +
        bytes.readUInt16LE(cursor + 32),
      nameBytes = bytes.subarray(cursor + 46, cursor + 46 + length),
      name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes),
      mode = bytes.readUInt32LE(cursor + 38) >>> 16;
    if (
      next > end ||
      flags & ~0x808 ||
      ![0, 8].includes(method) ||
      compressed > 32 * 1024 * 1024 ||
      expanded > 32 * 1024 * 1024 ||
      bytes.readUInt16LE(cursor + 34) ||
      local + 30 > offset ||
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      (mode & 0xf000 && ![0x8000, 0x4000].includes(mode & 0xf000))
    )
      throw Error("Unsupported plugin JAR entry");
    if (
      /\.(?:jar|zip|so|dll|dylib|exe|kt|kts|java|scala)$/i.test(name) ||
      /^META-INF\/(?:versions|services)\//i.test(name)
    )
      throw Error(
        "Plugin JAR contains an unsupported source, native, nested or implicit runtime entry",
      );
    const localLength = bytes.readUInt16LE(local + 26),
      data = local + 30 + localLength + bytes.readUInt16LE(local + 28);
    if (
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method ||
      !bytes.subarray(local + 30, local + 30 + localLength).equals(nameBytes) ||
      data + compressed > offset
    )
      throw Error("Plugin JAR local and central data disagree");
    let limit = data + compressed;
    if (flags & 8) {
      if (limit + 12 > offset) throw Error("Plugin JAR descriptor bound");
      if (bytes.readUInt32LE(limit) === 0x08074b50) limit += 4;
      if (
        limit + 12 > offset ||
        bytes.readUInt32LE(limit) !== crc ||
        bytes.readUInt32LE(limit + 4) !== compressed ||
        bytes.readUInt32LE(limit + 8) !== expanded
      )
        throw Error("Plugin JAR descriptor disagrees");
      limit += 12;
    } else if (
      bytes.readUInt32LE(local + 14) !== crc ||
      bytes.readUInt32LE(local + 18) !== compressed ||
      bytes.readUInt32LE(local + 22) !== expanded
    )
      throw Error("Plugin JAR local sizes disagree");
    total += expanded;
    if (total > 64 * 1024 * 1024) throw Error("Plugin JAR expanded byte bound");
    const encoded = bytes.subarray(data, data + compressed),
      decoded =
        method === 8
          ? inflateRawSync(encoded, { maxOutputLength: expanded + 1 })
          : encoded;
    if (
      decoded.length !== expanded ||
      crc32(decoded) !== crc ||
      (name.endsWith("/") && decoded.length)
    )
      throw Error("Plugin JAR content disagrees");
    entries.set(name, decoded);
    spans.push([local, limit]);
    cursor = next;
  }
  spans.sort((a, b) => a[0] - b[0]);
  if (
    cursor !== end ||
    spans[0]![0] !== 0 ||
    spans.some((span, i) => span[1] !== (spans[i + 1]?.[0] ?? offset))
  )
    throw Error("Plugin JAR local inventory is incomplete or overlaps");
  const manifest = entries.get("META-INF/MANIFEST.MF")?.toString("utf8") ?? "";
  if (
    /^Multi-Release:\s*true\s*$/im.test(
      manifest.replace(/\r\n/g, "\n").replace(/\n /g, ""),
    )
  )
    throw Error("Multi-release plugins need a separate profile");
  return entries;
}
function xml(bytes: Buffer | undefined) {
  if (!bytes || bytes.length > 1024 * 1024)
    throw Error("Plugin metadata byte bound");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (
    /<!DOCTYPE|<!ENTITY/i.test(text) ||
    /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(text) ||
    XMLValidator.validate(text) !== true
  )
    throw Error("Plugin metadata must be entity-free bounded valid XML");
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    parseTagValue: false,
    processEntities: true,
    isArray: (name) => ["Detector", "BugPattern", "BugCode"].includes(name),
  }).parse(text) as Record<string, unknown>;
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Plugin metadata shape");
  return value as Record<string, unknown>;
};
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw Error("Unsupported plugin metadata field");
}
export function verifySpotbugsPluginMetadata(
  bytes: Buffer,
  plugin: SpotbugsExtensions["plugins"][number],
) {
  const entries = spotbugsPluginJar(bytes),
    metadata = xml(entries.get("findbugs.xml"));
  keys(metadata, ["?xml", "FindbugsPlugin"]);
  const root = record(metadata.FindbugsPlugin);
  keys(root, ["@pluginid", "Detector", "BugPattern"]);
  if (root["@pluginid"] !== plugin.id) throw Error("Plugin identity disagrees");
  const detectors = root.Detector as unknown[],
    patterns = root.BugPattern as unknown[];
  if (
    !Array.isArray(detectors) ||
    !Array.isArray(patterns) ||
    detectors.length !== plugin.detectors.length ||
    patterns.length !== plugin.patterns.length
  )
    throw Error("Plugin rule inventory disagrees");
  for (const [i, raw] of detectors.entries()) {
    const value = record(raw),
      declared = plugin.detectors[i]!;
    keys(value, ["@class", "@reports", "@speed"]);
    if (
      value["@class"] !== declared.className ||
      value["@reports"] !== declared.reports.join(",") ||
      value["@speed"] !== "fast" ||
      !entries.has(declared.className.replaceAll(".", "/") + ".class")
    )
      throw Error("Plugin detector contract disagrees");
  }
  for (const [i, raw] of patterns.entries()) {
    const value = record(raw),
      declared = plugin.patterns[i]!;
    keys(value, ["@type", "@abbrev", "@category"]);
    if (
      value["@type"] !== declared.type ||
      value["@abbrev"] !== declared.abbreviation ||
      value["@category"] !== declared.category
    )
      throw Error("Plugin pattern contract disagrees");
  }
  const messages = xml(entries.get("messages.xml"));
  keys(messages, ["?xml", "MessageCollection"]);
  const collection = record(messages.MessageCollection);
  keys(collection, ["Plugin", "Detector", "BugPattern", "BugCode"]);
  const details = record(collection.Plugin);
  keys(details, ["ShortDescription", "Details"]);
  if (
    typeof details.ShortDescription !== "string" ||
    typeof details.Details !== "string"
  )
    throw Error("Plugin message contract disagrees");
  for (const [name, declared, attribute] of [
    ["Detector", plugin.detectors.map((v) => v.className), "class"],
    ["BugPattern", plugin.patterns.map((v) => v.type), "type"],
    [
      "BugCode",
      [...new Set(plugin.patterns.map((v) => v.abbreviation))],
      "abbrev",
    ],
  ] as const) {
    const rows = collection[name];
    if (!Array.isArray(rows) || rows.length !== declared.length)
      throw Error("Plugin message inventory disagrees");
    for (const [i, raw] of rows.entries()) {
      const row = record(raw);
      keys(
        row,
        name === "Detector"
          ? ["@class", "Details"]
          : name === "BugPattern"
            ? ["@type", "ShortDescription", "LongDescription", "Details"]
            : ["@abbrev", "#text"],
      );
      if (
        row["@" + attribute] !== declared[i] ||
        Object.values(row).some((value) => typeof value !== "string")
      )
        throw Error("Plugin message identity disagrees");
    }
  }
  return {
    entries: entries.size,
    classes: [...entries.keys()]
      .filter((name) => name.endsWith(".class"))
      .sort(),
  };
}
