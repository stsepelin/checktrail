import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { evaluate } from "../src/evidence.js";
import type { Check, ProcessResult } from "../src/types.js";
import { fixture } from "./helpers.js";
import { copyInstalledPackages } from "./tool-fixture.js";

const modules = fileURLToPath(new URL("../../node_modules", import.meta.url));
const reporter = fileURLToPath(
  new URL("../src/playwright-reporter.js", import.meta.url),
);
test(
  "current development Playwright CLI drives real reporter callbacks and distinguishes broken, fixed and valid near-miss Node tests",
  { timeout: 60000 },
  async (t) => {
    const manifest = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    );
    const lock = JSON.parse(
      await readFile(
        new URL("../../package-lock.json", import.meta.url),
        "utf8",
      ),
    );
    const expected = manifest.devDependencies["@playwright/test"];
    const root = await realpath(
      await fixture(t, {
        "package.json": '{"type":"module"}',
        "playwright.config.js": "export default {workers:1,retries:0};",
      }),
    );
    await copyInstalledPackages(
      root,
      ["@playwright/test"],
      modules,
      ({ relative, version }) => {
        assert.equal(
          version,
          lock.packages["node_modules/" + relative.split(path.sep).join("/")]
            .version,
        );
      },
    );
    const directMetadataFile = path.join(
      root,
      "node_modules/@playwright/test/package.json",
    );
    const directMetadata = JSON.parse(
      await readFile(directMetadataFile, "utf8"),
    );
    assert.equal(directMetadata.name, "@playwright/test");
    assert.equal(directMetadata.version, expected);
    const playwrightMetadataFile = createRequire(directMetadataFile).resolve(
      "playwright/package.json",
    );
    const coreMetadataFile = createRequire(playwrightMetadataFile).resolve(
      "playwright-core/package.json",
    );
    for (const [name, file] of [
      ["@playwright/test", directMetadataFile],
      ["playwright", playwrightMetadataFile],
      ["playwright-core", coreMetadataFile],
    ] as const) {
      const metadata = JSON.parse(await readFile(file, "utf8"));
      const relative = path.relative(
        path.join(root, "node_modules"),
        path.dirname(file),
      );
      assert.ok(
        relative !== ".." &&
          !relative.startsWith(".." + path.sep) &&
          !path.isAbsolute(relative),
      );
      assert.equal(metadata.name, name);
      assert.equal(
        metadata.version,
        lock.packages["node_modules/" + relative.split(path.sep).join("/")]
          .version,
      );
    }
    const declaredBin =
      typeof directMetadata.bin === "string"
        ? directMetadata.bin
        : directMetadata.bin.playwright;
    assert.equal(typeof declaredBin, "string");
    const command = {
      executable: process.execPath,
      args: [
        path.resolve(path.dirname(directMetadataFile), declaredBin),
        "test",
        "--reporter=" + reporter,
        "--workers=1",
        "--forbid-only",
        "--update-snapshots=none",
      ],
      cwd: ".",
    };
    const check: Check = {
      id: "javascript.playwright",
      adapter: "javascript",
      project: ".",
      scope: ["live.spec.js"],
      kind: "test",
      parser: "playwright-json",
      reason: "current public API regression",
      commands: [command],
    };
    const run = () =>
      spawnSync(command.executable, command.args, {
        cwd: root,
        encoding: "utf8",
        timeout: 15000,
        env: {
          ...process.env,
          CI: "1",
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
          PLAYWRIGHT_BROWSERS_PATH: path.join(root, "no-browsers"),
        },
      });
    for (const [name, expression, status] of [
      ["fixed assertion", "expect(2+3).toBe(5)", "passed"],
      ["broken assertion", "expect(2+3).toBe(6)", "failed"],
      [
        "ordinary test.only text is not focus",
        "expect({label:'test.only',value:-2+3}).toEqual({label:'test.only',value:1})",
        "passed",
      ],
    ] as const) {
      await writeFile(
        path.join(root, "live.spec.js"),
        `import {test,expect} from '@playwright/test';test(${JSON.stringify(name)},()=>{${expression}});`,
      );
      const result = run();
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, status === "passed" ? 0 : 1, result.stderr);
      const native = JSON.parse(result.stdout);
      assert.equal(native.status, status);
      assert.deepEqual(native.projects, [""]);
      assert.equal(native.tests.length, 1);
      assert.equal(native.tests[0].file, path.join(root, "live.spec.js"));
      assert.equal(native.tests[0].expectedStatus, "passed");
      assert.equal(native.tests[0].results.length, 1);
      assert.equal(native.tests[0].results[0].status, status);
      assert.equal(native.tests[0].results[0].retry, 0);
      if (status === "passed")
        assert.deepEqual(native.tests[0].results[0].errors, []);
      else
        assert.match(
          native.tests[0].results[0].errors.join("\n"),
          /Expected: 6[\s\S]*Received: 5/,
        );
      const processResult: ProcessResult = {
        command,
        exitCode: result.status,
        signal: null,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: 1,
        timedOut: false,
        cancelled: false,
        truncated: false,
      };
      const parsed = evaluate(check, [processResult], root);
      assert.equal(parsed.status, status, JSON.stringify({ parsed, native }));
      assert.deepEqual(parsed.tests, {
        total: 1,
        passed: status === "passed" ? 1 : 0,
        failed: status === "failed" ? 1 : 0,
        skipped: 0,
      });
    }
    await writeFile(
      path.join(root, "playwright.config.js"),
      "export default {testDir:42};",
    );
    const malformed = run();
    assert.equal(malformed.error, undefined);
    assert.equal(malformed.signal, null);
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /config\.testDir must be a string/);
    assert.equal(malformed.stdout, "");
  },
);
