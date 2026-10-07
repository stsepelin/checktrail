import assert from "node:assert/strict";
import {
  access,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { createHash } from "node:crypto";
import { spotbugsLibraries } from "../src/spotbugs-archive.js";
import { spotbugsEvidence } from "../src/spotbugs-evidence.js";
import { fixture } from "./helpers.js";
import {
  spotbugsFixture,
  nativeOptions,
  spotbugsPolicy,
  spotbugsConfig,
  javaConfig,
  brokenJava,
  goodJava,
} from "./spotbugs-fixture.js";

test("SpotBugs planning is inert explicit and unavailable without pinned prerequisites", async (t) => {
  const root = await fixture(t, {
    "pom.xml": "<project/>",
    "build.gradle": 'throw new Error("never execute")',
    "First.java": goodJava,
    "checktrail.json": spotbugsPolicy,
    "checktrail.java.json": JSON.stringify(javaConfig),
    "checktrail.spotbugs.json": JSON.stringify(spotbugsConfig),
  });
  const check = (await createPlan(root)).plan.checks[0]!;
  assert.equal(check.id, "jvm.spotbugs");
  assert.ok(check.unavailableReason);
  assert.equal(check.commands.length, 0);
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
  await assert.rejects(access(path.join(root, "executed")), { code: "ENOENT" });
  await rm(path.join(root, "checktrail.json"));
  assert.deepEqual(
    (await createPlan(root)).plan.checks.map((c) => c.id),
    ["jvm.javac"],
  );
});

test(
  "native SpotBugs catches null defects repairs and near misses across freshly compiled nested classes without initialization",
  nativeOptions,
  async (t) => {
    const root = await spotbugsFixture(t, {
      "First.java": brokenJava,
      "NeverRun.java":
        'class NeverRun { static { System.out.println("project initialized"); } }\n',
    });
    let report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.equal(report.sourceChanged, false);
    assert.equal(report.checks[0]!.findingsComplete, true);
    const defects = report.checks[0]!.findings!.filter((f) =>
      f.ruleId.startsWith("spotbugs/"),
    );
    assert.deepEqual(
      defects.map((f) => [f.ruleId, f.file, f.line]),
      [
        ["spotbugs/NP_ALWAYS_NULL", "First.java", 2],
        ["spotbugs/NP_LOAD_OF_KNOWN_NULL_VALUE", "First.java", 2],
      ],
    );
    assert.equal(
      report.checks[0]!.tools!.find((tool) => tool.name === "spotbugs")!
        .version,
      "4.10.4",
    );
    const data = JSON.parse(report.checks[0]!.processes[0]!.stdout);
    assert.ok(
      data.compiler.classes.some(
        (c: { name: string }) => c.name === "Second$Nested",
      ),
    );
    assert.ok(
      data.analysis.passes.every((p: { classes: string[] }) =>
        p.classes.includes("Second$Nested"),
      ),
    );
    assert.equal(
      await readFile(path.join(root, "First.java"), "utf8"),
      brokenJava,
    );
    assert.ok(!(await readdir(root)).some((name) => name.endsWith(".class")));
    await writeFile(
      path.join(root, "First.java"),
      goodJava.replaceAll("\n", "\r\n"),
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.findingsComplete, true);
    const annotations = spotbugsLibraries(
      await readFile(path.join(root, spotbugsConfig.archive)),
    ).get("spotbugs-annotations.jar")!;
    await writeFile(
      path.join(root, ".checktrail/annotations.jar"),
      annotations,
    );
    await writeFile(
      path.join(root, "checktrail.java.json"),
      JSON.stringify({
        ...javaConfig,
        classPath: [
          {
            path: ".checktrail/annotations.jar",
            sha256: createHash("sha256").update(annotations).digest("hex"),
          },
        ],
      }),
    );
    await writeFile(
      path.join(root, "First.java"),
      brokenJava.replace(
        "public static int size",
        '@edu.umd.cs.findbugs.annotations.SuppressFBWarnings({"NP_ALWAYS_NULL", "NP_LOAD_OF_KNOWN_NULL_VALUE"}) public static int size',
      ),
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.deepEqual(
      report.checks[0]!.findings!.map((f) => f.ruleId),
      ["spotbugs/NP_ALWAYS_NULL", "spotbugs/NP_LOAD_OF_KNOWN_NULL_VALUE"],
    );
    await writeFile(
      path.join(root, "checktrail.java.json"),
      JSON.stringify(javaConfig),
    );
    await rm(path.join(root, "First.java"));
    await writeFile(
      path.join(root, "a.First.java"),
      "package a; class First { public static int size(String value) { return value == null ? 0 : value.length(); } }\n",
    );
    await writeFile(
      path.join(root, "b.First.java"),
      "package b; class First { public static int size(String value) { if(value == null) return value.length(); return value.length(); } }\n",
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.findingsComplete, true);
    assert.deepEqual(
      report.checks[0]!.findings!.map((f) => f.file),
      ["b.First.java", "b.First.java"],
    );
  },
);

test(
  "native SpotBugs rejects empty incomplete skipped foreign stale and forged class pass detector and source evidence",
  nativeOptions,
  async (t) => {
    const root = await spotbugsFixture(t);
    const check = (await createPlan(root)).plan.checks[0]!;
    const report = await validate(root, { trusted: true });
    const process = report.checks[0]!.processes[0]!;
    assert.equal(
      spotbugsEvidence(check, [process], root).status,
      "passed",
      process.stdout + process.stderr,
    );
    const good = JSON.parse(process.stdout);
    assert.equal(good.sources.length, check.scope.length);
    const mutations: [string, (data: typeof good) => void][] = [
      ["source digest", (d) => (d.sources[0].sha256 = "0".repeat(64))],
      ["line count", (d) => d.sources[0].lines++],
      ["empty sources", (d) => (d.sources = [])],
      ["empty classes", (d) => (d.compiler.classes = [])],
      ["missing source", (d) => d.compiler.sources.pop()],
      ["empty passes", (d) => (d.analysis.passes = [])],
      ["missing class", (d) => d.analysis.passes.at(-1).classes.pop()],
      [
        "duplicate class",
        (d) =>
          (d.analysis.passes.at(-1).classes[0] =
            d.analysis.passes.at(-1).classes[1]),
      ],
      ["missing finish", (d) => d.analysis.passes.at(-1).finished--],
      ["wrong predicted", (d) => d.analysis.predicted[0]++],
      ["unfinished", (d) => (d.analysis.completed = false)],
      ["missing stats", (d) => d.analysis.stats.pop()],
      ["foreign stats", (d) => (d.analysis.stats[0].name = "Foreign")],
      ["foreign source", (d) => (d.compiler.classes[0].file = "/foreign.java")],
      [
        "foreign effective detector",
        (d) => d.analysis.effective[0].push("org.example.Foreign"),
      ],
      ["missing effective detector", (d) => d.analysis.effective[0].pop()],
      ["missing effective plan", (d) => (d.analysis.effective = [])],
      [
        "active suppression collector",
        (d) =>
          d.analysis.effective[0].push(
            "edu.umd.cs.findbugs.detect.NoteSuppressedWarnings",
          ),
      ],
      ["missing detectors", (d) => d.analysis.detectors.pop()],
      [
        "disabled detector",
        (d) => d.analysis.detectors.push("edu.umd.cs.findbugs.detect.Noise"),
      ],
      ["wrong runtime", (d) => (d.analysis.runtime = "25.0.3")],
      ["wrong version", (d) => (d.analysis.spotbugs = "4.10.3")],
      ["wrong request", (d) => (d.requestDigest = "0".repeat(64))],
      ["oversized class", (d) => d.analysis.oversized.push("First")],
      ["skipped method", (d) => d.analysis.skipped.push("method")],
      ["missing class native", (d) => (d.analysis.missing = 1)],
      ["analysis error", (d) => d.analysis.errorMessages.push("error")],
      ["messages", (d) => (d.analysis.messages = "partial")],
      [
        "stats source mismatch",
        (d) => (d.analysis.stats[0].source = "Foreign.java"),
      ],
      ["unknown extra", (d) => (d.analysis.extra = true)],
    ];
    for (const [name, mutate] of mutations) {
      const data = structuredClone(good);
      mutate(data);
      const result = spotbugsEvidence(
        check,
        [{ ...process, stdout: JSON.stringify(data) }],
        root,
      );
      assert.notEqual(result.status, "passed", name);
      assert.equal(result.findingsComplete, false, name);
    }
    for (const flag of ["cancelled", "timedOut", "truncated"] as const)
      assert.equal(
        spotbugsEvidence(check, [{ ...process, [flag]: true }], root)
          .findingsComplete,
        false,
        flag,
      );
    assert.equal(
      spotbugsEvidence(check, [{ ...process, signal: "SIGKILL" }], root)
        .findingsComplete,
      false,
    );
    assert.equal(
      spotbugsEvidence(check, [{ ...process, stdout: "{}" }], root).status,
      "inconclusive",
    );
    assert.equal(
      spotbugsEvidence(
        check,
        [
          {
            ...process,
            exitCode: 3,
            stdout: '{"unavailable":"spotbugs-toolchain"}',
          },
        ],
        root,
      ).status,
      "unavailable",
    );
    assert.equal(
      spotbugsEvidence(check, [process, process], root).status,
      "inconclusive",
    );
    await writeFile(
      path.join(root, "First.java"),
      goodJava + "// changed bytes\n",
    );
    assert.equal(
      spotbugsEvidence(check, [process], root).status,
      "inconclusive",
      "A semantically unchanged but stale source cannot reuse the receipt",
    );
    await writeFile(path.join(root, "First.java"), brokenJava);
    const broken = (await validate(root, { trusted: true })).checks[0]!
      .processes[0]!;
    assert.equal(spotbugsEvidence(check, [broken], root).status, "failed");
    for (const [name, mutation] of [
      [
        "line outside source",
        (d: typeof good) => (d.analysis.bugs[0].endLine = 999999),
      ],
      [
        "foreign bug class",
        (d: typeof good) => (d.analysis.bugs[0].className = "Foreign"),
      ],
      [
        "wrong bug source",
        (d: typeof good) =>
          (d.analysis.bugs[0].source = "Second with spaces.java"),
      ],
      [
        "skipped class",
        (d: typeof good) => (d.analysis.bugs[0].type = "SKIPPED_CLASS_TOO_BIG"),
      ],
    ] as const) {
      const data = JSON.parse(broken.stdout);
      mutation(data);
      const result = spotbugsEvidence(
        check,
        [{ ...broken, stdout: JSON.stringify(data) }],
        root,
      );
      assert.equal(result.status, "inconclusive", name);
      assert.equal(result.findingsComplete, false, name);
    }
  },
);

test(
  "native SpotBugs rejects tool checksum drift symbolic links unsupported profiles mixed languages and empty compiler scope",
  nativeOptions,
  async (t) => {
    const root = await spotbugsFixture(t);
    const planned = (await createPlan(root)).plan.checks[0]!;
    assert.equal(planned.commands.length, 1);
    const jar = path.join(root, spotbugsConfig.archive);
    const bytes = await readFile(jar);
    await writeFile(jar, Buffer.concat([bytes, Buffer.from("x")]));
    assert.equal((await createPlan(root)).plan.checks[0]!.commands.length, 0);
    await writeFile(jar, bytes);
    await rm(jar);
    await writeFile(path.join(root, ".checktrail/same.tgz"), bytes);
    await symlink(path.join(root, ".checktrail/same.tgz"), jar);
    assert.equal((await createPlan(root)).plan.checks[0]!.commands.length, 0);
    await rm(jar);
    await writeFile(jar, bytes);
    for (const config of [
      { ...spotbugsConfig, profile: "core-default-max-v1-evil" },
      { ...spotbugsConfig, exclude: "First" },
      { ...spotbugsConfig, sha256: "0".repeat(64) },
    ]) {
      await writeFile(
        path.join(root, "checktrail.spotbugs.json"),
        JSON.stringify(config),
      );
      assert.equal((await createPlan(root)).plan.checks[0]!.commands.length, 0);
    }
    await writeFile(
      path.join(root, "checktrail.spotbugs.json"),
      JSON.stringify(spotbugsConfig),
    );
    await writeFile(path.join(root, "First.kt"), "class First");
    assert.equal((await createPlan(root)).plan.checks[0]!.commands.length, 0);
    await rm(path.join(root, "First.kt"));
    await writeFile(
      path.join(root, "First.java"),
      "class First { missing symbol; }\n",
    );
    let report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.findingsComplete, false);
    await writeFile(path.join(root, "First.java"), "// no class\n");
    await writeFile(
      path.join(root, "Second with spaces.java"),
      "// no class\n",
    );
    report = await validate(root, { trusted: true });
    assert.notEqual(report.outcome, "passed");
    assert.equal(report.checks[0]!.findingsComplete, false);
  },
);

test(
  "native SpotBugs cancellation kills its active analyzer JVM and removes engine-owned classes and tool bytes",
  nativeOptions,
  async (t) => {
    const root = await spotbugsFixture(
      t,
      Object.fromEntries(
        Array.from({ length: 200 }, (_, index) => [
          `Extra${index}.java`,
          `class Extra${index} { public int size(String input) { return input == null ? 0 : input.length(); } }\n`,
        ]),
      ),
    );
    const controller = new AbortController();
    const pending = validate(root, {
      trusted: true,
      signal: controller.signal,
      timeoutMs: 60000,
    });
    let owned: string | undefined;
    let jvm: string | undefined;
    try {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && !owned) {
        for (const name of await readdir(tmpdir())) {
          if (!name.startsWith("checktrail-command-")) continue;
          const candidate = path.join(tmpdir(), name);
          try {
            for (const child of await readdir(candidate)) {
              if (!child.startsWith("checktrail-spotbugs-")) continue;
              const text = await readFile(
                path.join(candidate, child, "inputs.txt"),
                "utf8",
              );
              if (
                text
                  .split("\n")
                  .slice(3)
                  .some((value) =>
                    Buffer.from(value, "base64")
                      .toString("utf8")
                      .startsWith(root + path.sep),
                  )
              )
                owned = candidate;
            }
          } catch {
            /* Another bounded process may have already cleaned its own temporary directory. */
          }
        }
        if (!owned) await setTimeout(25);
      }
      assert.ok(owned, "Native input readiness must precede cancellation");
      while (Date.now() < deadline && !jvm) {
        for (const pid of await readdir("/proc")) {
          if (!/^\d+$/.test(pid)) continue;
          try {
            const cmd = await readFile(`/proc/${pid}/cmdline`, "utf8");
            if (
              cmd.includes(owned + path.sep) &&
              cmd.includes("VerifierSpotbugs.java")
            )
              jvm = `/proc/${pid}`;
          } catch {
            /* A native process may exit between the inventory and read. */
          }
        }
        if (!jvm) await setTimeout(10);
      }
      assert.ok(jvm, "An active native JVM must precede cancellation");
      controller.abort();
      const report = await pending;
      assert.equal(report.outcome, "incomplete");
      assert.equal(report.checks[0]!.processes[0]!.cancelled, true);
      assert.equal(report.checks[0]!.processes[0]!.timedOut, false);
      assert.notEqual(report.checks[0]!.findingsComplete, true);
      await assert.rejects(access(owned), { code: "ENOENT" });
      let stopped = false;
      const stopDeadline = Date.now() + 2000;
      while (Date.now() < stopDeadline && !stopped) {
        try {
          const state = await readFile(path.join(jvm, "stat"), "utf8");
          stopped = state.slice(state.lastIndexOf(")") + 2).startsWith("Z ");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          stopped = true;
        }
        if (!stopped) await setTimeout(10);
      }
      assert.equal(
        stopped,
        true,
        "The observed native JVM must be gone or terminated, never running",
      );
    } finally {
      controller.abort();
      await pending;
    }
  },
);

test(
  "native SpotBugs scale guard observes the implicit constructor boundary and cannot hide skipped analysis in an empty bug list",
  nativeOptions,
  async (t) => {
    const source = (methods: number) =>
      "public class Large {\n" +
      Array.from(
        { length: methods },
        (_, index) =>
          ` public int value${index}(int input) { return input + ${index}; }`,
      ).join("\n") +
      "\n}\n";
    const root = await spotbugsFixture(t, { "Large.java": source(1000) });
    let report = await validate(root, { trusted: true, timeoutMs: 60000 });
    assert.equal(report.outcome, "incomplete", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.findingsComplete, false);
    const process = report.checks[0]!.processes[0]!;
    const data = JSON.parse(process.stdout);
    assert.deepEqual(data.analysis.oversized, ["Large"]);
    const check = (await createPlan(root)).plan.checks[0]!;
    data.analysis.bugs = [];
    assert.equal(
      spotbugsEvidence(
        check,
        [{ ...process, stdout: JSON.stringify(data) }],
        root,
      ).status,
      "inconclusive",
      "Filtering the skipped-class bug does not establish analysis",
    );
    await writeFile(path.join(root, "Large.java"), source(999));
    report = await validate(root, { trusted: true, timeoutMs: 60000 });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.findingsComplete, true);
    assert.deepEqual(
      JSON.parse(report.checks[0]!.processes[0]!.stdout).analysis.oversized,
      [],
    );
  },
);
