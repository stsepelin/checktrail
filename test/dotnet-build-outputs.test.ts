import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { native, run } from "./dotnet-build-controls.js";
import { dotnetBuildFixture } from "./dotnet-build-fixture.js";

test(
  "native .NET preserves inventoried near misses and caller-owned output trees",
  native,
  async (t) => {
    const { root } = await dotnetBuildFixture(t);
    await writeFile(
      path.join(root, ".editorconfig"),
      "root = true\n[*.{cs,vb}]\nindent_style = space\nindent_size = 4\n",
    );
    await mkdir(path.join(root, "CSharp/bin"));
    await writeFile(
      path.join(root, "CSharp/bin/original.txt"),
      "caller-owned output\n",
    );
    const check = (await run(root)).checks[0]!;
    assert.equal(check.status, "passed", JSON.stringify(check));
    assert.equal(
      await readFile(path.join(root, "CSharp/bin/original.txt"), "utf8"),
      "caller-owned output\n",
    );
  },
);
