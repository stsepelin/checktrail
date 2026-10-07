import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createPlan } from "../src/engine.js";
import { native } from "./dotnet-build-controls.js";
import { dotnetBuildFixture } from "./dotnet-build-fixture.js";

test(
  ".NET planning rejects incomplete source, project, role and dependency identities",
  native,
  async (t) => {
    const { root, config } = await dotnetBuildFixture(t),
      target = path.join(root, "checktrail.dotnet-build.json");
    const controls: Array<[string, (data: typeof config) => void]> = [
      [
        "source omitted",
        (d) => {
          d.projects[0]!.sources = [];
        },
      ],
      [
        "project omitted",
        (d) => {
          d.projects.pop();
        },
      ],
      [
        "duplicate project",
        (d) => {
          d.projects.push(structuredClone(d.projects[0]!));
        },
      ],
      [
        "unbound test class",
        (d) => {
          d.projects[1]!.testClasses[0]!.file = "CSharp/Counter.cs";
        },
      ],
      [
        "source assigned twice",
        (d) => {
          d.projects[0]!.sources.push(d.projects[1]!.sources[0]!);
        },
      ],
      [
        "generated outside fresh obj",
        (d) => {
          d.projects[0]!.generatedSources = ["original/Generated.cs"];
        },
      ],
      [
        "wrong manifest",
        (d) => {
          d.repositorySha256 = "0".repeat(64);
        },
      ],
    ];
    for (const [name, change] of controls) {
      const data = structuredClone(config);
      change(data);
      await writeFile(target, JSON.stringify(data));
      const check = (await createPlan(root)).plan.checks[0]!;
      assert.equal(check.commands.length, 0, name);
      assert.ok(check.unavailableReason, name);
    }
    await writeFile(target, JSON.stringify(config));
    assert.equal((await createPlan(root)).plan.checks[0]!.commands.length, 1);
    await writeFile(path.join(root, "Hidden.csproj"), "<Project/>");
    assert.equal((await createPlan(root)).plan.checks[0]!.commands.length, 0);
  },
);
