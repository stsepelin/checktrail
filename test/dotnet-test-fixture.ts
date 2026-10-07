import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { dotnetBuildFixture } from "./dotnet-build-fixture.js";
export async function dotnetTestFixture(t: TestContext) {
  const data = await dotnetBuildFixture(t);
  await writeFile(
    path.join(data.root, "checktrail.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["dotnet.test"] }],
    }),
  );
  return data;
}
