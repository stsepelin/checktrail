import assert from "node:assert/strict";
import {
  access,
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validate, createPlan } from "../src/engine.js";
import { cppToolsFixture, cppToolsNative } from "./cpp-tools-fixture.js";
import { cppToolsPacketSchema } from "../src/cpp-tools-evidence.js";
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
test(
  "native C/C++ concurrent checks use distinct fresh workspaces and clean every owned build artifact",
  cppToolsNative,
  async (t) => {
    const { root } = await cppToolsFixture(t, ["cpp.build", "cpp.ctest"]);
    const reports = await Promise.all([run(root), run(root)]);
    const directories: string[] = [];
    for (const report of reports) {
      assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
      assert.equal(report.sourceChanged, false);
      for (const check of report.checks) {
        const packet = cppToolsPacketSchema.parse(
          JSON.parse(check.processes[0]!.stdout),
        );
        directories.push(packet.temporary);
        await assert.rejects(access(packet.temporary), { code: "ENOENT" });
      }
    }
    assert.equal(directories.length, 4);
    assert.equal(new Set(directories).size, 4);
  },
);
test(
  "native C/C++ missing tools remain unavailable and protected environment cannot replace selected PATH or compiler options",
  cppToolsNative,
  async (t) => {
    const { root } = await cppToolsFixture(t, ["cpp.build"]);
    const missing = await mkdtemp(
        path.join(tmpdir(), "original-cpp-no-tools-"),
      ),
      previous = process.env.PATH;
    try {
      process.env.PATH = missing;
      const result = await run(root);
      assert.equal(result.outcome, "incomplete");
      assert.equal(
        result.checks[0]!.status,
        "unavailable",
        JSON.stringify(result.checks),
      );
      assert.ok(
        result.checks[0]!.tools?.some((t) => t.status === "unavailable"),
      );
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
      await rm(missing, { recursive: true, force: true });
    }
    for (const name of [
      "PATH",
      "CCC_OVERRIDE_OPTIONS",
      "CMAKE_TOOLCHAIN_FILE",
      "LD_PRELOAD",
      "CFLAGS",
    ]) {
      await writeFile(
        path.join(root, "checktrail.json"),
        JSON.stringify({
          schemaVersion: 1,
          projects: [{ path: ".", checks: ["cpp.build"], environment: [name] }],
        }),
      );
      await assert.rejects(
        createPlan(root, { environment: { [name]: "original-value" } }),
        /protected adapter settings/,
        name,
      );
    }
  },
);
test(
  "native C/C++ source change after a compiled CTest body starts invalidates the completed execution",
  cppToolsNative,
  async (t) => {
    const { root } = await cppToolsFixture(t, ["cpp.ctest"]),
      marker = path.join(root, ".checktrail/started"),
      control = path.join(root, "original-record.cjs");
    await mkdir(path.dirname(marker));
    await writeFile(
      control,
      `const fs=require("node:fs");const exe=fs.readlinkSync("/proc/"+process.ppid+"/exe");fs.writeFileSync(process.env.CHECKTRAIL_CPP_STARTED,exe);setTimeout(()=>{},1500);`,
    );
    await writeFile(
      path.join(root, "tests/c_boundary.c"),
      `#include "range.h"\n#include <stdlib.h>\n#include <unistd.h>\n#include <sys/wait.h>\nint main(void) {\n (void)original_c_next(0);\n pid_t child=fork();\n if(child==0){execl(getenv("CHECKTRAIL_CPP_NODE"),"node",getenv("CHECKTRAIL_CPP_CONTROL"),(char*)0);_exit(127);}\n if(child<0)return 2;\n int status;waitpid(child,&status,0);return 0;\n}\n`,
    );
    await writeFile(
      path.join(root, "checktrail.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          {
            path: ".",
            checks: ["cpp.ctest"],
            environment: [
              "CHECKTRAIL_CPP_NODE",
              "CHECKTRAIL_CPP_CONTROL",
              "CHECKTRAIL_CPP_STARTED",
            ],
          },
        ],
      }),
    );
    const controller = new AbortController();
    const running = validate(root, {
      trusted: true,
      timeoutMs: 120000,
      signal: controller.signal,
      environment: {
        CHECKTRAIL_CPP_NODE: process.execPath,
        CHECKTRAIL_CPP_CONTROL: control,
        CHECKTRAIL_CPP_STARTED: marker,
      },
    });
    try {
      let native = "";
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        try {
          native = await readFile(marker, "utf8");
          if (native.endsWith("/build/original_c_boundary")) break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(
        native.endsWith("/build/original_c_boundary"),
        "Real compiled executable reached before changing source",
      );
      const file = path.join(root, "src/range.c");
      await writeFile(
        file,
        (await readFile(file, "utf8")) +
          "// changed after native compilation\n",
      );
      const report = await running;
      assert.equal(report.outcome, "incomplete");
      assert.equal(report.sourceChanged, true);
      assert.notEqual(report.checks[0]!.status, "passed");
    } finally {
      controller.abort();
      await running;
    }
  },
);

test(
  "native C/C++ callback mutations of generated headers or linked binaries invalidate unchanged original source",
  cppToolsNative,
  async (t) => {
    for (const target of [
      "generated/original_step.h",
      "original_cpp_boundary",
    ]) {
      const { root } = await cppToolsFixture(t, ["cpp.ctest"]);
      await writeFile(
        path.join(root, "tests/c_boundary.c"),
        `#include "range.h"\n#include <stdio.h>\nint main(void) {\n FILE *artifact=fopen("${target}","ab");\n if (!artifact) return 3;\n fputs("\\noriginal_mutation",artifact);fclose(artifact);\n return original_c_next(0)==1 ? 0 : 1;\n}\n`,
      );
      const report = await run(root);
      assert.equal(report.outcome, "incomplete", JSON.stringify(report.checks));
      assert.equal(report.sourceChanged, false);
      assert.notEqual(report.checks[0]!.status, "passed", target);
    }
  },
);
