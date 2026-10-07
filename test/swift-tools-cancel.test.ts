import assert from "node:assert/strict";
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  mkdtemp,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validate } from "../src/engine.js";
import { swiftToolsFixture, swiftToolsNative } from "./swift-tools-fixture.js";
test(
  "native Swift cancellation reaches an XCTest body and reaps compiled helpers descendants and owned outputs",
  swiftToolsNative,
  async (t) => {
    const { root } = await swiftToolsFixture(t, ["swift.test"]),
      marker = path.join(root, ".checktrail/started"),
      control = path.join(root, "original-wait.cjs");
    await mkdir(path.dirname(marker));
    await writeFile(
      control,
      `const fs=require("node:fs"),path=require("node:path");const helper=process.ppid,scratch=process.env.TMPDIR,owner=process.env.CHECKTRAIL_TEMP,executable=fs.readlinkSync("/proc/"+helper+"/exe");const record={pid:process.pid,helper,scratch,owner,owned:executable.startsWith(path.resolve(scratch,"../scratch")+path.sep)&&path.basename(executable)==="OriginalQuantityPackageTests.xctest"};const marker=process.env.CHECKTRAIL_SWIFT_STARTED;fs.writeFileSync(marker+".prepared",JSON.stringify(record));fs.renameSync(marker+".prepared",marker);setTimeout(()=>{},60000);`,
    );
    await writeFile(
      path.join(root, "Tests/OriginalQuantityTests/QuantityTests.swift"),
      `import XCTest\nimport Foundation\nfinal class OriginalCancellationTests: XCTestCase {\n    func testReachesNativeBody() throws {\n        let child = Process()\n        child.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["CHECKTRAIL_SWIFT_NODE"]!)\n        child.arguments = [ProcessInfo.processInfo.environment["CHECKTRAIL_SWIFT_CONTROL"]!]\n        try child.run()\n        child.waitUntilExit()\n    }\n}\n`,
    );
    await writeFile(
      path.join(root, "checktrail.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          {
            path: ".",
            checks: ["swift.test"],
            environment: [
              "CHECKTRAIL_SWIFT_NODE",
              "CHECKTRAIL_SWIFT_CONTROL",
              "CHECKTRAIL_SWIFT_STARTED",
            ],
          },
        ],
      }),
    );
    const temporary = await mkdtemp(
        path.join(tmpdir(), "checktrail-swift-cancel-"),
      ),
      previous = process.env.TMPDIR;
    t.after(() => rm(temporary, { recursive: true, force: true }));
    process.env.TMPDIR = temporary;
    const controller = new AbortController();
    let record:
      | {
          pid: number;
          helper: number;
          scratch: string;
          owner: string;
          owned: boolean;
        }
      | undefined;
    const running = validate(root, {
      trusted: true,
      timeoutMs: 120000,
      signal: controller.signal,
      environment: {
        CHECKTRAIL_SWIFT_NODE: process.execPath,
        CHECKTRAIL_SWIFT_CONTROL: control,
        CHECKTRAIL_SWIFT_STARTED: marker,
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
      assert.ok(record, "Actual compiled XCTest body reached");
      assert.equal(record.owned, true);
      assert.ok(
        record.scratch.startsWith(record.owner + path.sep) &&
          record.owner.startsWith(temporary + path.sep),
      );
    } finally {
      try {
        controller.abort();
        await running;
      } finally {
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
      }
    }
    try {
      const report = await running;
      assert.equal(report.outcome, "incomplete");
      assert.ok(report.checks[0]!.processes.some((p) => p.cancelled));
      assert.deepEqual(await readdir(temporary), []);
      await assert.rejects(access(record!.scratch), { code: "ENOENT" });
      for (const pid of [record!.pid, record!.helper]) {
        assert.ok(Number.isSafeInteger(pid) && pid > 1);
        let alive = true;
        for (let attempt = 0; attempt < 100; attempt++) {
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
  },
);
