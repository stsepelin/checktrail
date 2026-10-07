import { cp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { fixture } from "./helpers.js";
import { swiftToolsConfigSchema } from "../src/swift-tools.js";
export const swiftToolsNative = {
  skip:
    process.env.CHECKTRAIL_SWIFT_TOOLS_NATIVE === "1" &&
    /^Swift version 6\.2\.3 /.test(
      spawnSync("swiftc", ["--version"], { encoding: "utf8" }).stdout || "",
    )
      ? false
      : "Pinned Swift tools profile not selected",
  timeout: 600000,
};
export async function swiftToolsFixture(
  t: TestContext,
  checks = ["swift.build", "swift.test", "swift.swiftlint"],
) {
  const root = await fixture(t, {});
  await cp(
    fileURLToPath(new URL("../../examples/swift-tools/", import.meta.url)),
    root,
    { recursive: true },
  );
  const config = swiftToolsConfigSchema.parse({
    schemaVersion: 1,
    swiftVersion: "6.2.3",
    toolsVersion: "6.2.0",
    platform: "aarch64-unknown-linux-gnu",
    packageName: "OriginalQuantity",
    products: [
      {
        name: "OriginalQuantity",
        type: "library",
        targets: ["OriginalQuantity"],
      },
    ],
    targets: [
      {
        name: "OriginalQuantity",
        type: "regular",
        path: "Sources/OriginalQuantity",
        sources: ["Sources/OriginalQuantity/Quantity.swift"],
        dependencies: [],
      },
      {
        name: "OriginalQuantityTests",
        type: "test",
        path: "Tests/OriginalQuantityTests",
        sources: [
          "Tests/OriginalQuantityTests/QuantityTests.swift",
          "Tests/OriginalQuantityTests/TestSupport.swift",
        ],
        dependencies: ["OriginalQuantity"],
      },
    ],
    tests: {
      framework: "xctest",
      files: ["Tests/OriginalQuantityTests/QuantityTests.swift"],
      support: ["Tests/OriginalQuantityTests/TestSupport.swift"],
    },
    swiftlintVersion: "0.65.1",
    rules: ["force_try", "force_unwrapping"],
  });
  await writeFile(
    path.join(root, "checktrail.swift-tools.json"),
    JSON.stringify(config),
  );
  await writeFile(
    path.join(root, "checktrail.json"),
    JSON.stringify({ schemaVersion: 1, projects: [{ path: ".", checks }] }),
  );
  return { root, config };
}
