import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validate } from "../src/engine.js";
import { fixture } from "./helpers.js";

for (const [framework, distribution, version, field, broken] of [
  ["fastapi", "fastapi", "0.141.1", "module", "broken"],
  ["django", "Django", "6.1.1", "settings", "broken_settings"],
]) {
  const available =
    spawnSync(
      "python3",
      [
        "-c",
        `from importlib.metadata import version; assert version(${JSON.stringify(distribution)}) == ${JSON.stringify(version)}`,
      ],
      { timeout: 10_000 },
    ).status === 0;
  test(
    `public ${framework} example passes and its duplicate-registration counterpart fails`,
    {
      skip: available ? false : `Pinned ${distribution} unavailable`,
      timeout: 60_000,
    },
    async (t) => {
      const root = await fixture(t, {});
      await cp(
        fileURLToPath(
          new URL(`../../examples/frameworks/${framework}`, import.meta.url),
        ),
        root,
        { recursive: true },
      );
      const passed = await validate(root, { trusted: true });
      assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
      const filename = path.join(root, `checktrail.${framework}.json`);
      const profile = JSON.parse(await readFile(filename, "utf8"));
      profile[field!] = broken;
      await writeFile(filename, JSON.stringify(profile));
      const failed = await validate(root, { trusted: true });
      assert.equal(failed.outcome, "failed", JSON.stringify(failed.checks));
      assert.match(failed.checks[0]!.reason, /duplicate/);
    },
  );
}
