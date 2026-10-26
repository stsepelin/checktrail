import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fixture } from "./helpers.js";

test(
  "Laravel cache runtime admission binds every named case, supporting input and engine while retaining selected native identities",
  {
    skip:
      process.platform === "win32"
        ? "POSIX Laravel cache harness fixture"
        : false,
  },
  async (t) => {
    const repository = new URL("../../", import.meta.url);
    const { laravelCacheHarnessFiles, laravelCacheDigest } = await import(
      new URL("scripts/laravel-cache-runtime-evidence.mjs", repository).href
    );
    const root = await fixture(t, {});
    for (const file of laravelCacheHarnessFiles) {
      const target = path.join(root, file);
      await mkdir(path.dirname(target), { recursive: true });
      const bytes = file.startsWith(".checktrail/")
        ? "{}"
        : await readFile(new URL(file, repository));
      await writeFile(target, bytes, { flag: "wx" });
    }
    await mkdir(path.join(root, "dist/src"), { recursive: true });
    const selected = "Original synthetic selected runtime file.\n";
    await mkdir(path.join(root, ".checktrail/laravel-tools/vendor/original"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, ".checktrail/laravel-tools/vendor/original/runtime.php"),
      selected,
    );
    await writeFile(
      path.join(
        root,
        ".checktrail/laravel-tools/vendor/composer/installed.json",
      ),
      JSON.stringify({
        packages: [{ name: "original/framework", version: "1.0.0" }],
      }),
    );
    const pins = `export const laravelAssemblyVersions={"original/framework":"1.0.0"};export const laravelAssemblyRuntimePins=[${JSON.stringify({ package: "original/framework", directory: "original", file: "runtime.php", bytes: Buffer.byteLength(selected), sha256: laravelCacheDigest(selected) })}];\n`;
    await writeFile(
      path.join(root, "dist/src/laravel-assembly-runtime-pins.js"),
      pins,
    );
    const phpBinary = path.join(root, "original-php-binary");
    await writeFile(phpBinary, "Original synthetic executable identity.\n");
    // A controller-only double runs through Node so noexec fixture mounts cannot
    // silently fall through PATH to a host PHP interpreter. Native acceptance
    // separately invokes the unchanged observer with the pinned real PHP binary.
    const php = path.join(root, "original-php-observer.cjs");
    await writeFile(
      php,
      `console.log(${JSON.stringify(JSON.stringify({ version: "original", binary: phpBinary, sqlite: true }))});\n`,
    );
    const observer = path.join(
      root,
      "scripts/laravel-cache-runtime-evidence.mjs",
    );
    const observerBytes = await readFile(observer, "utf8");
    const from = 'execFileSync(\n      "php",\n      [';
    assert.equal(observerBytes.split(from).length, 2);
    await writeFile(
      observer,
      observerBytes.replace(
        from,
        `execFileSync(\n      process.execPath,\n      [${JSON.stringify(php)},`,
      ),
    );
    const profiles = JSON.parse(
      await readFile(
        path.join(root, "scripts/required-native-tests.json"),
        "utf8",
      ),
    ) as Record<string, Array<{ file: string; name: string }>>;
    const rows = [...profiles.laravel!, ...profiles["laravel-cache"]!];
    assert.equal(rows.length, 9);
    const marker = path.join(root, "reached.jsonl");
    for (const file of new Set(rows.map((row) => row.file)))
      await writeFile(
        path.join(root, file),
        "import{test}from'node:test';import{appendFileSync}from'node:fs';\n" +
          rows
            .filter((row) => row.file === file)
            .map(
              (row) =>
                `test(${JSON.stringify(row.name)},()=>appendFileSync(${JSON.stringify(marker)},${JSON.stringify(row.name + "\n")}));`,
            )
            .join("\n"),
      );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
    };
    delete env.NODE_OPTIONS;
    delete env.NODE_TEST_CONTEXT;
    const run = (cwd = root) =>
      spawnSync(
        process.execPath,
        [path.join(root, "scripts/verify-laravel-cache.mjs")],
        { cwd, env, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1048576 },
      );
    const passed = run();
    assert.equal(passed.error, undefined);
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    const packet = JSON.parse(passed.stdout);
    assert.equal(packet.required, 9);
    assert.equal(packet.passed, 9);
    assert.equal(packet.complete, true);
    assert.equal(packet.runtime.php, "original");
    assert.equal(packet.runtime.wholeDependencyClosureVerified, false);
    assert.equal(packet.harnessInputsUnchanged, true);
    assert.equal(packet.gateAComplete, false);
    assert.deepEqual(
      (await readFile(marker, "utf8")).trim().split("\n").sort(),
      rows.map((row) => row.name).sort(),
    );
    const shadow = await fixture(
      t,
      Object.fromEntries(
        [...new Set(rows.map((row) => row.file))].map((file) => [
          file,
          "throw Error('Original shadow callback');\n",
        ]),
      ),
    );
    const other = run(shadow);
    assert.equal(other.status, 0, other.stdout + other.stderr);
    assert.equal(JSON.parse(other.stdout).harnessSha256, packet.harnessSha256);

    const callback = path.join(root, rows[0]!.file),
      before = await readFile(callback, "utf8");
    await writeFile(
      callback,
      before.replace(
        JSON.stringify(rows[0]!.name),
        JSON.stringify(rows[0]!.name + " adjacent"),
      ),
    );
    try {
      const missing = run();
      assert.equal(missing.error, undefined);
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /required-test-not-passed/);
      assert.doesNotMatch(missing.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND/);
    } finally {
      await writeFile(callback, before);
    }
    const mutations = [
      {
        file: path.join(root, "examples/frameworks/laravel/wiring.php"),
        message: /Laravel cache harness bytes changed/,
      },
      {
        file: path.join(root, "dist/src/laravel-assembly-runtime-pins.js"),
        message: /Compiled engine bytes changed/,
      },
      { file: phpBinary, message: /Laravel cache runtime identity changed/ },
    ];
    for (const mutation of mutations) {
      const bytes = await readFile(mutation.file);
      const altered = before
        .replace(
          `()=>appendFileSync`,
          `()=>{appendFileSync(${JSON.stringify(mutation.file)},"\\n// original mutation\\n");return appendFileSync`,
        )
        .replace(
          `${JSON.stringify(rows[0]!.name + "\n")}));`,
          `${JSON.stringify(rows[0]!.name + "\n")});});`,
        );
      assert.notEqual(altered, before);
      try {
        await writeFile(callback, altered);
        const refused = run();
        assert.equal(refused.error, undefined);
        assert.equal(refused.status, 1, refused.stdout + refused.stderr);
        assert.match(refused.stderr, mutation.message);
        assert.doesNotMatch(refused.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND/);
      } finally {
        await writeFile(mutation.file, bytes);
        await writeFile(callback, before);
      }
    }
    const restored = run();
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  },
);
