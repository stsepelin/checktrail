import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { dotnetBuildPacketSchema } from "../src/dotnet-build-evidence.js";
import { native, run } from "./dotnet-build-controls.js";
import { dotnetBuildFixture } from "./dotnet-build-fixture.js";

test(
  "native .NET classifies an enabled SDK analyzer's source error and preserves its repair",
  native,
  async (t) => {
    const { root } = await dotnetBuildFixture(t),
      source = path.join(root, "CSharp/OriginalCandidate.cs"),
      configuration = path.join(root, "checktrail.dotnet-build.json"),
      config = JSON.parse(await readFile(configuration, "utf8"));
    config.projects[0].sources.push("CSharp/OriginalCandidate.cs");
    await writeFile(configuration, JSON.stringify(config));
    await writeFile(
      path.join(root, ".editorconfig"),
      "root = true\n[*.cs]\ndotnet_diagnostic.CA1822.severity = error\n",
    );
    await writeFile(
      source,
      "namespace Example; public class OriginalCandidate { public int OriginalValue() => 1; }\n",
    );
    const failed = (await run(root)).checks[0]!;
    assert.equal(
      failed.status,
      "failed",
      JSON.stringify({ status: failed.status, reason: failed.reason }),
    );
    assert.equal(failed.findingsComplete, false);
    const packet = dotnetBuildPacketSchema.parse(
      JSON.parse(failed.processes[0]!.stdout),
    );
    assert.ok(
      packet.events.some(
        (e) =>
          e.type === "diagnostic" &&
          e.code === "CA1822" &&
          e.severity === "error" &&
          String(e.file).endsWith("OriginalCandidate.cs"),
      ),
      "Selected native analyzer emitted the intended source error",
    );
    await writeFile(
      source,
      "namespace Example; public class OriginalCandidate { public static int OriginalValue() => 1; }\n",
    );
    assert.equal((await run(root)).checks[0]!.status, "passed");
    await writeFile(
      path.join(root, ".editorconfig"),
      "root = true\n[*.cs]\ndotnet_diagnostic.CA1822.severity = warning\n",
    );
    await writeFile(
      source,
      "namespace Example; public class OriginalCandidate { public int OriginalValue() => 1; }\n",
    );
    const warning = (await run(root)).checks[0]!;
    assert.equal(warning.status, "passed");
    assert.equal(warning.findingsComplete, true);
    assert.ok(
      warning.findings?.some(
        (finding) =>
          finding.ruleId === "dotnet-build/CA1822" &&
          finding.file === "CSharp/OriginalCandidate.cs" &&
          finding.level === "warning",
      ),
      "Native enabled warning retains its exact source address",
    );
  },
);
