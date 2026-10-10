import { deflateRawSync } from "node:zlib";
import { spotbugsExtensionsSchema } from "../src/spotbugs-extensions.js";
export const plugin = spotbugsExtensionsSchema.shape.plugins.element.parse({
  path: "rules.jar",
  sha256: "0".repeat(64),
  id: "original.rules",
  detectors: [{ className: "original.Detector", reports: ["ORIGINAL_EXACT"] }],
  patterns: [
    { type: "ORIGINAL_EXACT", abbreviation: "ORG", category: "CORRECTNESS" },
  ],
});
export const files = {
  "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\r\n\r\n",
  "original/Detector.class": "Synthetic data fixture; never loaded",
  "findbugs.xml":
    '<FindbugsPlugin pluginid="original.rules"><Detector class="original.Detector" reports="ORIGINAL_EXACT" speed="fast"/><BugPattern type="ORIGINAL_EXACT" abbrev="ORG" category="CORRECTNESS"/></FindbugsPlugin>',
  "messages.xml":
    '<MessageCollection><Plugin><ShortDescription>Original &amp; exact</ShortDescription><Details>Original rule</Details></Plugin><Detector class="original.Detector"><Details>Original detector</Details></Detector><BugPattern type="ORIGINAL_EXACT"><ShortDescription>Original</ShortDescription><LongDescription>Original</LongDescription><Details>Original</Details></BugPattern><BugCode abbrev="ORG">Original</BugCode></MessageCollection>',
};
export function archive(entries: Record<string, string>, descriptors = false) {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const plain = Buffer.from(text),
      encoded = deflateRawSync(plain),
      filename = Buffer.from(name);
    let crc = 0xffffffff;
    for (const byte of plain) {
      crc ^= byte;
      for (let i = 0; i < 8; i++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(descriptors ? 8 : 0, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(filename.length, 26);
    if (!descriptors) {
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(encoded.length, 18);
      header.writeUInt32LE(plain.length, 22);
    }
    const descriptor = descriptors ? Buffer.alloc(16) : Buffer.alloc(0);
    if (descriptors) {
      descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(encoded.length, 8);
      descriptor.writeUInt32LE(plain.length, 12);
    }
    const row = Buffer.alloc(46);
    row.writeUInt32LE(0x02014b50);
    row.writeUInt16LE(20, 4);
    row.writeUInt16LE(20, 6);
    row.writeUInt16LE(descriptors ? 8 : 0, 8);
    row.writeUInt16LE(8, 10);
    row.writeUInt32LE(crc, 16);
    row.writeUInt32LE(encoded.length, 20);
    row.writeUInt32LE(plain.length, 24);
    row.writeUInt16LE(filename.length, 28);
    row.writeUInt32LE(offset, 42);
    locals.push(header, filename, encoded, descriptor);
    central.push(row, filename);
    offset +=
      header.length + filename.length + encoded.length + descriptor.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
