import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { createPlan, validate } from "../src/engine.js";
import { cppToolsFixture, cppToolsNative } from "./cpp-tools-fixture.js";
import {
  cppToolsEvidence,
  cppToolsPacketSchema,
} from "../src/cpp-tools-evidence.js";
import { cppCmake } from "../src/cpp-tools.js";
import { mavenHash } from "../src/maven.js";
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
test(
  "native C/C++ packet guards reject stale scope commands metadata source checksums objects tools and CTest counters",
  cppToolsNative,
  async (t) => {
    const { root } = await cppToolsFixture(t, ["cpp.ctest"]);
    const result = await run(root);
    assert.equal(result.outcome, "passed", JSON.stringify(result.checks));
    const check = (await createPlan(root)).plan.checks[0]!,
      process = result.checks[0]!.processes[0]!;
    assert.equal(cppToolsEvidence(check, [process]).status, "passed");
    type Packet = z.infer<typeof cppToolsPacketSchema>;
    const mutation = (
      name: string,
      change: (p: Packet) => void,
      resignAfter = true,
    ) => {
      const packet = cppToolsPacketSchema.parse(JSON.parse(process.stdout));
      change(packet);
      for (const row of packet.receipts) {
        row.stdoutSha256 = mavenHash(row.stdout);
        row.stderrSha256 = mavenHash(row.stderr);
      }
      for (const a of packet.artifacts) {
        a.sha256 = mavenHash(Buffer.from(a.text, a.encoding));
        if (resignAfter) a.afterSha256 = a.sha256;
      }
      assert.equal(
        cppToolsEvidence(check, [
          { ...process, stdout: JSON.stringify(packet) },
        ]).status,
        "inconclusive",
        name,
      );
    };
    mutation("tool byte freshness", (p) => {
      p.tools[0]!.afterSha256 = "0".repeat(64);
    });
    mutation(
      "artifact freshness",
      (p) => {
        p.artifacts[0]!.afterSha256 = "0".repeat(64);
      },
      false,
    );
    mutation("input pin identity", (p) => {
      p.inputSha256 = "0".repeat(64);
    });
    mutation("phase command", (p) => {
      p.receipts.find((r) => r.phase === "build")!.args.push("--clean-first");
    });
    mutation("missing compiler receipt", (p) => {
      p.receipts.find((r) => r.phase === "build")!.stderr = "";
    });
    mutation("compile argument scope", (p) => {
      const a = p.artifacts.find((a) => a.path === "compile_commands.json")!;
      a.text = a.text.replace("-std=c17", "-std=c11");
    });
    mutation("native source checksum", (p) => {
      const row = p.receipts.find((r) => r.phase.startsWith("dwarf:"))!;
      row.stdout = row.stdout.replace(
        /md5_checksum: [a-f0-9]{32}/,
        "md5_checksum: " + "0".repeat(32),
      );
    });
    mutation("native consumed header checksum", (p) => {
      const row = p.receipts.find((r) => r.phase.startsWith("dwarf:"))!;
      row.stdout = row.stdout.replace(
        /(name: "project\/include\/range.h"\n\s+dir_index: \d+\n\s+md5_checksum: )[a-f0-9]{32}/,
        "$1" + "0".repeat(32),
      );
    });
    mutation("archive object byte identity", (p) => {
      const a = p.artifacts.find((a) => a.path.endsWith(".o"))!;
      const bytes = Buffer.from(a.text, "base64");
      bytes[10] = bytes[10] === 0 ? 1 : 0;
      a.text = bytes.toString("base64");
    });
    mutation("generated header binding", (p) => {
      p.artifacts.find((a) => a.path === "generated/original_step.h")!.text +=
        "\n";
    });
    mutation("native target scope", (p) => {
      const a = p.artifacts.find((a) =>
        /\/target-original_ranges-/.test(a.path),
      )!;
      const data = JSON.parse(a.text);
      data.sources.pop();
      a.text = JSON.stringify(data);
    });
    mutation("missing test callback", (p) => {
      const row = p.receipts.find((r) => r.phase === "list")!;
      const data = JSON.parse(row.stdout);
      data.tests.pop();
      row.stdout = JSON.stringify(data);
    });
    mutation("test command wrapper", (p) => {
      const row = p.receipts.find((r) => r.phase === "list")!;
      const data = JSON.parse(row.stdout);
      data.tests[0].command.unshift("wrapper");
      row.stdout = JSON.stringify(data);
    });
    mutation("native test registration", (p) => {
      const row = p.receipts.find((r) => r.phase === "list")!;
      const data = JSON.parse(row.stdout);
      data.backtraceGraph.nodes[data.tests[0].backtrace].line++;
      row.stdout = JSON.stringify(data);
    });
    mutation("XML test count", (p) => {
      const a = p.artifacts.find((a) => a.path === "results.xml")!;
      a.text = a.text.replace('tests="2"', 'tests="3"');
    });
    mutation("console summary", (p) => {
      p.receipts.find((r) => r.phase === "test")!.stdout = p.receipts
        .find((r) => r.phase === "test")!
        .stdout.replace("100%", "99%");
    });
    mutation("extra artifact", (p) => {
      p.artifacts.push({
        path: "stale.txt",
        encoding: "utf8",
        text: "stale",
        sha256: mavenHash("stale"),
        afterSha256: mavenHash("stale"),
      });
    });
    assert.equal(
      cppToolsEvidence(check, [{ ...process, truncated: true }]).status,
      "inconclusive",
    );
  },
);
test(
  "native C/C++ requires consumed headers and rejects empty registered test scope and source suppressions",
  cppToolsNative,
  async (t) => {
    const { root, config } = await cppToolsFixture(t, ["cpp.build"]);
    await writeFile(
      path.join(root, "include/unused.h"),
      "#define CT_UNUSED 7\n",
    );
    config.headers.push("include/unused.h");
    await writeFile(
      path.join(root, "checktrail.cpp-tools.json"),
      JSON.stringify(config),
    );
    const incomplete = await run(root);
    assert.equal(
      incomplete.checks[0]!.status,
      "inconclusive",
      JSON.stringify(incomplete.checks),
    );
    config.headers.pop();
    config.tests = [];
    await writeFile(
      path.join(root, "checktrail.cpp-tools.json"),
      JSON.stringify(config),
    );
    await writeFile(path.join(root, "CMakeLists.txt"), cppCmake(config));
    await writeFile(
      path.join(root, "checktrail.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: ".", checks: ["cpp.ctest"] }],
      }),
    );
    const empty = await createPlan(root);
    assert.ok(empty.plan.checks[0]!.unavailableReason);
    assert.deepEqual(empty.plan.checks[0]!.commands, []);
    const file = path.join(root, "src/range.c");
    await writeFile(file, (await readFile(file, "utf8")) + "// NOLINT\n");
    await writeFile(
      path.join(root, "checktrail.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: ".", checks: ["cpp.clang-tidy"] }],
      }),
    );
    assert.ok((await createPlan(root)).plan.checks[0]!.unavailableReason);
  },
);
