import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  readFile,
  writeFile,
  readdir,
  mkdtemp,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { validate } from "../src/engine.js";
import { rubyToolsFixture } from "./ruby-tools-fixture.js";
const available =
  process.platform === "linux" &&
  !!process.env.CHECKTRAIL_RUBY_TOOLS_CACHE &&
  /^ruby 4\.0\.7 /.test(
    spawnSync("ruby", ["--disable-gems", "--version"], { encoding: "utf8" })
      .stdout || "",
  );
const native = {
  skip: available
    ? false
    : "Pinned Linux Ruby runtime and dependency cache not selected",
  timeout: 600000,
};
test(
  "native Ruby cancellation reaches RSpec and Minitest bodies and reaps Ruby helper descendants and owned outputs",
  native,
  async (t) => {
    for (const mode of ["rspec", "minitest"]) {
      const { root } = await rubyToolsFixture(t, [`ruby.${mode}`]),
        marker = path.join(root, ".checktrail/started"),
        control = path.join(root, "original-wait.cjs");
      await writeFile(
        control,
        'const fs=require("node:fs");const helper=process.ppid;const args=fs.readFileSync("/proc/"+helper+"/cmdline","utf8").split("\\0");const record={pid:process.pid,helper,owned:args.some(a=>a.endsWith("/observer.rb"))&&args.includes(process.env.CHECKTRAIL_RUBY_MODE),scratch:process.env.TMPDIR,owner:process.env.CHECKTRAIL_TEMP};const marker=process.env.CHECKTRAIL_RUBY_STARTED;fs.writeFileSync(marker+".prepared",JSON.stringify(record));fs.renameSync(marker+".prepared",marker);setTimeout(()=>{},60000);',
      );
      const body =
        'child = Process.spawn("node", ENV.fetch("CHECKTRAIL_RUBY_CONTROL")); Process.wait(child)';
      const source =
        mode === "rspec"
          ? 'RSpec.describe("Original cancellation") { it("reaches a native body") { ' +
            body +
            " } }\n"
          : 'require "minitest/autorun"\nclass OriginalCancellationTest < Minitest::Test\n def test_reaches_body\n ' +
            body +
            "\n end\nend\n";
      await writeFile(
        path.join(
          root,
          mode === "rspec" ? "spec/quantity_spec.rb" : "test/quantity_test.rb",
        ),
        source,
      );
      await writeFile(
        path.join(root, "checktrail.json"),
        JSON.stringify({
          schemaVersion: 1,
          projects: [
            {
              path: ".",
              checks: [`ruby.${mode}`],
              environment: [
                "CHECKTRAIL_RUBY_CONTROL",
                "CHECKTRAIL_RUBY_STARTED",
                "CHECKTRAIL_RUBY_MODE",
              ],
            },
          ],
        }),
      );
      const temporary = await mkdtemp(
          path.join(tmpdir(), "checktrail-ruby-cancel-"),
        ),
        previous = process.env.TMPDIR;
      process.env.TMPDIR = temporary;
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const controller = new AbortController();
      let record:
        | {
            pid: number;
            helper: number;
            owned: boolean;
            scratch: string;
            owner: string;
          }
        | undefined;
      const running = validate(root, {
        trusted: true,
        timeoutMs: 120000,
        signal: controller.signal,
        environment: {
          CHECKTRAIL_RUBY_CONTROL: control,
          CHECKTRAIL_RUBY_STARTED: marker,
          CHECKTRAIL_RUBY_MODE: mode,
        },
      });
      try {
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
          try {
            record = JSON.parse(await readFile(marker, "utf8"));
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.ok(record, "Actual native test body was reached");
        assert.equal(
          record.owned,
          true,
          "Child belongs to the exact owned Ruby observer and mode",
        );
        assert.ok(
          record.scratch.startsWith(record.owner + path.sep) &&
            record.owner.startsWith(temporary + path.sep),
        );
      } finally {
        controller.abort();
        await running;
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
      }
      try {
        const report = await running;
        assert.equal(report.outcome, "incomplete");
        assert.ok(report.checks[0]!.processes.some((p) => p.cancelled));
        assert.deepEqual(await readdir(temporary), []);
        await assert.rejects(access(record!.scratch));
        for (const pid of [record!.pid, record!.helper]) {
          assert.ok(Number.isSafeInteger(pid) && pid > 1);
          let alive = true;
          for (let n = 0; n < 100; n++) {
            try {
              process.kill(pid, 0);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") {
                alive = false;
                break;
              }
              throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.equal(alive, false, "Owned native process reaped: " + pid);
        }
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  },
);
