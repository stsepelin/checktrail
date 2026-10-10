import assert from "node:assert/strict";
import { test } from "node:test";
import {
  spotbugsPluginJar,
  verifySpotbugsPluginMetadata,
} from "../src/spotbugs-plugin-jar.js";
import { plugin, files, archive } from "./spotbugs-plugin-fixture.js";

test("SpotBugs plugin metadata is data-only and exact for stored identities with standard ZIP descriptors", () => {
  for (const descriptors of [false, true]) {
    const bytes = archive(files, descriptors);
    assert.deepEqual(verifySpotbugsPluginMetadata(bytes, plugin), {
      entries: 4,
      classes: ["original/Detector.class"],
    });
    assert.equal(
      spotbugsPluginJar(bytes).get("original/Detector.class")!.toString(),
      files["original/Detector.class"],
    );
  }
});
test("SpotBugs plugin metadata rejects hidden runtime inputs ambiguous providers corrupted bytes and incomplete message inventories", () => {
  const faults: Array<[string, Record<string, string>]> = [
    [
      "implicit classpath",
      {
        ...files,
        "META-INF/MANIFEST.MF":
          "Manifest-Version: 1.0\r\nClass-Path: undeclared.jar\r\n\r\n",
      },
    ],
    [
      "multi-release",
      {
        ...files,
        "META-INF/MANIFEST.MF":
          "Manifest-Version: 1.0\r\nMulti-Release: true\r\n\r\n",
      },
    ],
    ...[
      "implicit.jar",
      "native.so",
      "Source.java",
      "META-INF/services/original.Provider",
      "META-INF/versions/17/Original.class",
      "../foreign.class",
    ].map((file): [string, Record<string, string>] => [
      file,
      { ...files, [file]: "unselected" },
    ]),
    [
      "plugin prefix",
      {
        ...files,
        "findbugs.xml": files["findbugs.xml"].replace(
          "original.rules",
          "original.rules.extra",
        ),
      },
    ],
    [
      "rule prefix",
      {
        ...files,
        "findbugs.xml": files["findbugs.xml"].replaceAll(
          "ORIGINAL_EXACT",
          "ORIGINAL_EXACT_EXTRA",
        ),
      },
    ],
    [
      "unknown metadata",
      {
        ...files,
        "findbugs.xml": files["findbugs.xml"].replace(
          "<Detector ",
          '<Detector defaultenabled="false" ',
        ),
      },
    ],
    [
      "external entity",
      {
        ...files,
        "findbugs.xml":
          '<!DOCTYPE FindbugsPlugin SYSTEM "file:///unselected">' +
          files["findbugs.xml"],
      },
    ],
    [
      "missing class",
      Object.fromEntries(
        Object.entries(files).filter(([name]) => !name.endsWith(".class")),
      ),
    ],
    [
      "missing message",
      {
        ...files,
        "messages.xml": files["messages.xml"].replace(
          /<Detector.*?<\/Detector>/,
          "",
        ),
      },
    ],
    [
      "message rule prefix",
      {
        ...files,
        "messages.xml": files["messages.xml"].replace(
          "ORIGINAL_EXACT",
          "ORIGINAL_EXACT_EXTRA",
        ),
      },
    ],
  ];
  for (const [name, entries] of faults)
    assert.throws(
      () => verifySpotbugsPluginMetadata(archive(entries), plugin),
      (error: unknown) => error instanceof Error,
      name,
    );
  for (const descriptors of [false, true]) {
    const bytes = archive(files, descriptors),
      central = bytes.readUInt32LE(bytes.length - 6),
      mutated = Buffer.from(bytes);
    const wrongCrc = (mutated.readUInt32LE(central + 16) ^ 1) >>> 0;
    mutated.writeUInt32LE(wrongCrc, central + 16);
    if (descriptors) {
      const data = 30 + mutated.readUInt16LE(26) + mutated.readUInt16LE(28),
        descriptor = data + mutated.readUInt32LE(central + 20);
      mutated.writeUInt32LE(wrongCrc, descriptor + 4);
    } else mutated.writeUInt32LE(wrongCrc, 14);
    assert.throws(
      () => spotbugsPluginJar(mutated),
      /disagree/,
      "CRC inconsistency",
    );
    const duplicate = Buffer.from(bytes);
    const second = central + 46 + Buffer.byteLength(Object.keys(files)[0]!);
    duplicate.writeUInt32LE(0, second + 42);
    assert.throws(
      () => spotbugsPluginJar(duplicate),
      /disagree|overlap/,
      "Aliased local entries",
    );
  }
});
