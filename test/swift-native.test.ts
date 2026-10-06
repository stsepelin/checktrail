import assert from "node:assert/strict";
import { test } from "node:test";
import { swiftWords, swiftCompiled } from "../src/swift-native.js";
import { swiftXmlText } from "../src/swift-testing.js";
import { swiftToolsConfigSchema } from "../src/swift-tools.js";
test("Swift native compiler arguments bind exact primary files platform and target and decode quoted paths without execution", () => {
  assert.deepEqual(
    swiftWords(
      "\"/tool path/frontend\" -primary-file '/owned workspace/Original File.swift' escaped\\ path",
    ),
    [
      "/tool path/frontend",
      "-primary-file",
      "/owned workspace/Original File.swift",
      "escaped path",
    ],
  );
  for (const text of ['"unfinished', "escape\\", "line\nother", "\0"])
    assert.throws(() => swiftWords(text));
  const config = swiftToolsConfigSchema.parse({
      schemaVersion: 1,
      swiftVersion: "6.2.3",
      toolsVersion: "6.2.0",
      platform: "aarch64-unknown-linux-gnu",
      packageName: "Original",
      products: [{ name: "Original", type: "library", targets: ["Original"] }],
      targets: [
        {
          name: "Original",
          type: "regular",
          path: "Sources/Original",
          sources: ["Sources/Original/Original File.swift"],
          dependencies: [],
        },
      ],
      tests: { framework: "xctest", files: [], support: [] },
      swiftlintVersion: "0.65.1",
      rules: ["force_try"],
    }),
    command =
      '/tool/frontend -frontend -c -primary-file "/owned workspace/Sources/Original/Original File.swift" -target aarch64-unknown-linux-gnu -module-name Original';
  assert.deepEqual(
    swiftCompiled(config, "/owned workspace", "/tool/frontend", command),
    ["Sources/Original/Original File.swift"],
  );
  for (const changed of [
    command + "\n" + command,
    command.replace("-primary-file", "-input-file"),
    command.replace("aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"),
    command.replace("-module-name Original", "-module-name OriginalNearMiss"),
    command.replace("/owned workspace/Sources", "/foreign/Sources"),
    command.replace("/tool/frontend", "/tool/frontend-near-miss"),
  ])
    assert.throws(() =>
      swiftCompiled(config, "/owned workspace", "/tool/frontend", changed),
    );
});

test("Swift Testing XML character references decode once with Unicode and literal reference near misses", () => {
  assert.equal(
    swiftXmlText(
      "value &#8594; next &#x1F340; &quot;original&quot; &amp; &lt;&gt; &apos;",
    ),
    'value → next 🍀 "original" & <> \'',
  );
  assert.equal(swiftXmlText("&amp;#8594;"), "&#8594;");
  for (const value of [
    "&#0;",
    "&#55296;",
    "&#x110000;",
    "&unknown;",
    "&unterminated",
  ])
    assert.throws(() => swiftXmlText(value));
});
