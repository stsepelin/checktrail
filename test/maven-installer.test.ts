import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { fixture } from "./helpers.js";

for (const mode of ["mirror-bad-digest", "permanent-forbidden"] as const) {
  test(`Maven installer ${mode} reaches the actual bounded requester and cannot publish invalid bytes`, async (t) => {
    const root = await fixture(t, {
      "fetch.mjs": `import {appendFileSync} from 'node:fs';
let calls=0; globalThis.fetch=async (url,request)=>{
 appendFileSync('calls.jsonl',JSON.stringify({url,redirect:request.redirect})+String.fromCharCode(10));calls++;
 if (${JSON.stringify(mode)}==='permanent-forbidden') return new Response(null,{status:403});
 if(calls===1) return new Response(null,{status:503});
 return new Response(new Uint8Array(9979885));
};`,
    });
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        path.join(root, "fetch.mjs"),
        fileURLToPath(
          new URL("../../scripts/prepare-maven-tools.mjs", import.meta.url),
        ),
      ],
      { cwd: root, env, encoding: "utf8", timeout: 15000, maxBuffer: 65536 },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.error, undefined);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /ERR_ASSERTION/);
    const calls = (await readFile(path.join(root, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const primary =
      "https://downloads.apache.org/maven/maven-3/3.10.0/binaries/apache-maven-3.10.0-bin.tar.gz";
    assert.deepEqual(
      calls.map((r) => r.url),
      mode === "permanent-forbidden"
        ? [primary]
        : [
            primary,
            "https://dlcdn.apache.org/maven/maven-3/3.10.0/binaries/apache-maven-3.10.0-bin.tar.gz",
          ],
    );
    assert.ok(calls.every((r) => r.redirect === "error"));
    if (mode === "mirror-bad-digest")
      assert.ok(
        result.stderr.includes(
          "a46cc51bc74fa23fd267c7a0b9132b146dcf526da60d31aa5174e565632e9e0e",
        ),
      );
    assert.deepEqual(
      await readdir(path.join(root, ".checktrail/maven-review-tools")),
      [],
    );
  });
}
