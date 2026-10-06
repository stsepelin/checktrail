import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createPlan } from "../src/engine.js";
import { native, run } from "./dotnet-build-controls.js";
import { dotnetBuildFixture } from "./dotnet-build-fixture.js";

test(
  "native .NET rejects unavailable locked restore and corrupt dependency bytes before a source allegation",
  native,
  async (t) => {
    const { root } = await dotnetBuildFixture(t),
      lockFile = path.join(root, "CSharpTests/packages.lock.json"),
      lock = await readFile(lockFile, "utf8");
    await writeFile(lockFile, lock.replace(/4\.6\.1/g, "0.0.0"));
    const unavailable = (await run(root)).checks[0]!;
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.findingsComplete, false);
    assert.match(unavailable.reason, /locked offline/);
    await writeFile(lockFile, lock);
    const cache = path.join(
      root,
      ".checktrail/dependencies/artifacts/nunit/4.6.1/lib/net8.0/nunit.framework.dll",
    );
    await writeFile(cache, "original corrupt artifact");
    const planned = (await createPlan(root)).plan.checks[0]!;
    assert.equal(planned.commands.length, 0);
    assert.match(planned.unavailableReason!, /bounded regular .NET dependency/);
  },
);
