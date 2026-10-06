import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { dotnetBuildProtectedEnvironment } from "../src/dotnet-build.js";
import { createPlan } from "../src/engine.js";
import { native } from "./dotnet-build-controls.js";
import { dotnetBuildFixture } from "./dotnet-build-fixture.js";

test(
  ".NET protected environment cannot be overridden by project requirements",
  native,
  async (t) => {
    const { root } = await dotnetBuildFixture(t);
    for (const name of dotnetBuildProtectedEnvironment) {
      await writeFile(
        path.join(root, "checktrail.json"),
        JSON.stringify({
          schemaVersion: 1,
          projects: [
            { path: ".", checks: ["dotnet.build"], environment: [name] },
          ],
        }),
      );
      await assert.rejects(
        createPlan(root, { environment: { [name]: "original-value" } }),
        /^[A-Z_][A-Z0-9_]*$/.test(name)
          ? /conflicts with protected adapter settings/
          : /invalid/i,
        name,
      );
    }
  },
);
