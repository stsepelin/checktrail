import assert from "node:assert/strict";
import { test } from "node:test";
import {
  access,
  readFile,
  writeFile,
  open,
  mkdir,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { reportSchema } from "../src/schemas.js";
import { createPlan, validate } from "../src/engine.js";
import { evaluate } from "../src/evidence.js";
import { scalaExtensionEvidenceSchema } from "../src/scala-extension-evidence.js";

import type { CheckResult } from "../src/types.js";
import type { z } from "zod";
import {
  mixedScalaFixture,
  scala2Fixture,
  options,
  mixedScalaConfig,
  javaProducer,
  consumer,
  scalaGenerator,
  generatedScala,
  waitingScalaGenerator,
} from "./scala-extensions-fixture.js";
import { nativeCheck, coherent } from "./scala-extension-evidence-fixture.js";
type Packet = z.infer<typeof scalaExtensionEvidenceSchema>;
const changed = (c: CheckResult, root: string, mutate: (p: Packet) => void) =>
  evaluate(nativeCheck(c), [coherent(c.processes[0]!, mutate)], root);
test("scala-extensions fixed acceptance", options, async (t) => {
  const f = await mixedScalaFixture(t);
  assert.equal((await createPlan(f.root)).plan.checks[0]!.commands.length, 1);
  const c = (await validate(f.root, { trusted: true, timeoutMs: 120000 }))
    .checks[0]!;
  assert.equal(c.status, "passed", JSON.stringify(c));
  assert.equal(c.findingsComplete, true);
  const p = scalaExtensionEvidenceSchema.parse(
    JSON.parse(c.processes[0]!.stdout),
  );
  assert.equal(p.stages.length, 2);
  assert.equal(p.generatedClasses.length, 1);
  assert.equal(p.java!.success, true);
  assert.equal(p.java!.sources[0]!.parsed, 1);
  assert.equal(p.java!.classes.length, 1);
  assert.ok(
    p.stages[0]!.evidence.native!.sources.some((s) => s.inline && s.macro),
  );
  assert.equal(
    p.stages.reduce((n, s) => n + s.evidence.native!.sources.length, 0),
    4,
  );
  assert.ok(
    p.stages.every(
      (s) =>
        s.evidence.native!.featureStages === 1 &&
        s.evidence.native!.outputs.some((o) => o.file.endsWith(".tasty")),
    ),
  );
  assert.equal(await readFile(f.macroMarker, "utf8"), "compile-time");
  await assert.rejects(access(f.marker), { code: "ENOENT" });
  assert.equal(
    await readFile(path.join(f.root, "build/classes/preserve"), "utf8"),
    "keep",
  );
  const root = await scala2Fixture(t);
  const c2 = (await validate(root, { trusted: true })).checks[0]!;
  assert.equal(c2.status, "passed", JSON.stringify(c2));
  assert.equal(c2.findingsComplete, true);
  const p2 = JSON.parse(c2.processes[0]!.stdout);
  assert.equal(p2.native.sources[0].frontend, 1);
  assert.equal(p2.native.sources[0].complete, 1);
  assert.ok(p2.native.outputs.length > 0);
});
test("scala-extensions broken acceptance", options, async (t) => {
  for (const [file, text] of [
    [
      "producer/Producer.java",
      javaProducer.replace("return 4;", 'return "wrong";'),
    ],
    [
      "consumer/Consumer.scala",
      consumer.replace("result:Int", "result:String"),
    ],
    ["consumer/compile only.sc", 'val answer:Int="wrong"\n'],
    [
      "generators/BuildScalaGenerator.java",
      scalaGenerator(generatedScala.replace("=4", "=unknown")),
    ],
  ] as const) {
    const f = await mixedScalaFixture(t, { [file]: text });
    const c = (await validate(f.root, { trusted: true, timeoutMs: 120000 }))
      .checks[0]!;
    assert.equal(c.status, "failed", file + JSON.stringify(c));
    assert.equal(c.findingsComplete, false);
    assert.ok(
      c.findings!.some((x) => x.file === file && x.level === "error"),
      file,
    );
    if (file.endsWith(".sc"))
      assert.ok(c.findings!.some((x) => x.file === file && x.line === 1));
    if (file.startsWith("generators/"))
      assert.ok(
        c.findings!.some((x) =>
          x.message.includes("src/main/scala/policy/Rules.scala:"),
        ),
      );
    await assert.rejects(access(f.marker), { code: "ENOENT" });
  }
  const root = await scala2Fixture(
    t,
    'object Original { val answer:Int="wrong" }\n',
  );
  const c = (await validate(root, { trusted: true })).checks[0]!;
  assert.equal(c.status, "failed", JSON.stringify(c));
  assert.ok(
    c.findings!.some((x) => x.file === "Original.scala" && x.level === "error"),
  );
});
test("scala-extensions near-miss acceptance", options, async (t) => {
  const f = await mixedScalaFixture(t, {
    "producer/Producer.java": javaProducer.replace(
      "public class",
      "@interface SuppressWarningsExtra {} @SuppressWarningsExtra public class",
    ),
    "consumer/Consumer.scala": consumer
      .replace(
        "object Consumer",
        "class nowarnExtra extends scala.annotation.StaticAnnotation\nobject Consumer",
      )
      .replace("val result:Int", "@nowarnExtra val result:Int"),
    "consumer/compile only.sc":
      'val answer:Int=policy.Rules.answer\nval literal="""\n//> using dep data:latest\npackage payload\n"""\n',
  });
  const config = {
    ...mixedScalaConfig,
    extensions: {
      ...mixedScalaConfig.extensions,
      scripts: [{ file: "consumer/compile only.sc", className: "type.object" }],
    },
  };
  await writeFile(
    path.join(f.root, "checktrail.scala.json"),
    JSON.stringify(config),
  );
  const c = (await validate(f.root, { trusted: true, timeoutMs: 120000 }))
    .checks[0]!;
  assert.equal(c.status, "passed", JSON.stringify(c));
  assert.equal(c.findingsComplete, true);
  const p = JSON.parse(c.processes[0]!.stdout);
  assert.ok(
    p.java.sources[0].annotations.includes("demo.SuppressWarningsExtra"),
  );
  assert.ok(
    p.stages[1].evidence.native.sources.some((s: { annotations: string[] }) =>
      s.annotations.includes("demo.nowarnExtra"),
    ),
  );
  const root = await scala2Fixture(
    t,
    "package demo\nclass `Original+` {def number:Int=4}\nclass nowarnExtra extends scala.annotation.StaticAnnotation\nobject Original { @nowarnExtra val answer:Int=new `Original+`().number }\n",
  );
  const c2 = (await validate(root, { trusted: true })).checks[0]!;
  assert.equal(c2.status, "passed", JSON.stringify(c2));
  assert.ok(
    JSON.parse(c2.processes[0]!.stdout).native.outputs.some(
      (o: { binaryName: string }) => o.binaryName === "demo.Original$plus",
    ),
  );
  await writeFile(
    path.join(f.root, "checktrail.scala.json"),
    JSON.stringify({
      ...config,
      extensions: { ...config.extensions, executeScripts: true },
    }),
  );
  assert.equal((await createPlan(f.root)).plan.checks[0]!.commands.length, 0);
});
test("scala-extensions prerequisite acceptance", options, async (t) => {
  for (const f of [
    await mixedScalaFixture(t),
    { root: await scala2Fixture(t) },
  ]) {
    const file = path.join(f.root, "checktrail.scala.json"),
      config = JSON.parse(await readFile(file, "utf8"));
    await writeFile(
      file,
      JSON.stringify({ ...config, sha256: "0".repeat(64) }),
    );
    assert.equal((await createPlan(f.root)).plan.checks[0]!.commands.length, 0);
    assert.equal(
      (await validate(f.root, { trusted: true })).checks[0]!.status,
      "unavailable",
    );
    await writeFile(file, JSON.stringify(config));
  }
  const f = await mixedScalaFixture(t);
  const previous = process.env.PATH,
    directory = path.join(f.root, ".checktrail/foreign-toolchain");
  await mkdir(directory);
  const marker = path.join(directory, "executed");
  await writeFile(
    path.join(directory, "java"),
    "#!/bin/sh\ntouch " + JSON.stringify(marker) + "\n",
    { mode: 0o755 },
  );
  try {
    process.env.PATH = directory + path.delimiter + previous;
    assert.equal((await createPlan(f.root)).plan.checks[0]!.commands.length, 0);
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
  await writeFile(path.join(f.root, "foreign.kt"), "object Foreign");
  assert.equal((await createPlan(f.root)).plan.checks[0]!.commands.length, 0);
  await rm(path.join(f.root, "foreign.kt"));
  await writeFile(
    path.join(f.root, "consumer/compile only.sc"),
    "//> using dep unselected:latest\nval value=1\n",
  );
  assert.equal((await createPlan(f.root)).plan.checks[0]!.commands.length, 0);
  await writeFile(
    path.join(f.root, "checktrail.scala.json"),
    JSON.stringify({
      ...mixedScalaConfig,
      extensions: {
        ...mixedScalaConfig.extensions,
        stages: mixedScalaConfig.extensions.stages.slice(0, 1),
      },
    }),
  );
  assert.equal((await createPlan(f.root)).plan.checks[0]!.commands.length, 0);
});
test("scala-extensions stale acceptance", options, async (t) => {
  const f = await mixedScalaFixture(t),
    c = (await validate(f.root, { trusted: true, timeoutMs: 120000 }))
      .checks[0]!;
  assert.equal(c.status, "passed", JSON.stringify(c));
  assert.equal(evaluate(nativeCheck(c), c.processes, f.root).status, "passed");
  for (const file of [
    "producer/Producer.java",
    "producer/Macros.scala",
    "consumer/Consumer.scala",
    "consumer/compile only.sc",
    "generators/BuildScalaGenerator.java",
    "checktrail.scala.json",
  ]) {
    const absolute = path.join(f.root, file),
      original = await readFile(absolute);
    try {
      await writeFile(
        absolute,
        file.endsWith(".json")
          ? JSON.stringify({ ...mixedScalaConfig, warningsAsErrors: true })
          : Buffer.concat([original, Buffer.from("\n// changed\n")]),
      );
      assert.equal(
        evaluate(nativeCheck(c), c.processes, f.root).status,
        "inconclusive",
        file,
      );
    } finally {
      await writeFile(absolute, original);
    }
  }
  for (const mutate of [
    (p: Packet) => {
      p.requestDigest = "0".repeat(64);
    },
    (p: Packet) => {
      p.sources[0]!.sha256 = "0".repeat(64);
    },
    (p: Packet) => {
      p.generated[0]!.sourceSha256 = "0".repeat(64);
    },
    (p: Packet) => {
      p.stages[0]!.evidence.native!.sources[0]!.sha256 = "0".repeat(64);
    },
  ])
    assert.equal(changed(c, f.root, mutate).status, "inconclusive");
  const archive = await open(path.join(f.root, mixedScalaConfig.archive), "r+"),
    byte = Buffer.alloc(1);
  try {
    await archive.read(byte, 0, 1, 0);
    await archive.write(Buffer.from([byte[0]! ^ 1]), 0, 1, 0);
    assert.equal(
      evaluate(nativeCheck(c), c.processes, f.root).status,
      "inconclusive",
    );
  } finally {
    await archive.write(byte, 0, 1, 0);
    await archive.close();
  }
  const root = await scala2Fixture(t),
    c2 = (await validate(root, { trusted: true })).checks[0]!;
  assert.equal(c2.status, "passed", JSON.stringify(c2));
  await writeFile(
    path.join(root, "Original.scala"),
    "object Original { val changed=5 }\n",
  );
  assert.equal(
    evaluate(nativeCheck(c2), c2.processes, root).status,
    "inconclusive",
  );
});
test("scala-extensions empty acceptance", options, async (t) => {
  const f = await mixedScalaFixture(t),
    c = (await validate(f.root, { trusted: true, timeoutMs: 120000 }))
      .checks[0]!;
  assert.equal(c.status, "passed", JSON.stringify(c));
  for (const mutate of [
    (p: Packet) => {
      p.generated = [];
    },
    (p: Packet) => {
      p.payloads = [];
    },
    (p: Packet) => {
      p.generatedClasses = [];
    },
    (p: Packet) => {
      p.generatedClasses[0]!.className = "policy.Foreign";
    },
    (p: Packet) => {
      p.stages[0]!.evidence.native!.featureStages = 0;
    },
    (p: Packet) => {
      p.stages[0]!.evidence.native!.sources[0]!.featureVisits = 0;
    },
    (p: Packet) => {
      p.stages[0]!.evidence.outputAfter = [];
    },
    (p: Packet) => {
      p.java = null;
    },
    (p: Packet) => {
      p.java!.sources[0]!.analyzed = [];
    },
    (p: Packet) => {
      p.java!.classes = [];
    },
    (p: Packet) => {
      p.java!.classes[0]!.sourceFile = "Foreign.java";
    },
    (p: Packet) => {
      p.java!.sources[0]!.annotations = ["java.lang.SuppressWarnings"];
    },
    (p: Packet) => {
      p.stages[1]!.evidence.native!.sources[0]!.annotations = [
        "scala.annotation.nowarn",
      ];
    },
  ])
    assert.equal(changed(c, f.root, mutate).status, "inconclusive");
  for (const change of [{ stdout: "{}" }, { truncated: true }])
    assert.equal(
      evaluate(nativeCheck(c), [{ ...c.processes[0]!, ...change }], f.root)
        .status,
      "inconclusive",
    );
  const root = await scala2Fixture(t, "// empty source\n");
  assert.equal(
    (await validate(root, { trusted: true })).checks[0]!.status,
    "inconclusive",
  );
  await writeFile(
    path.join(root, "Original.scala"),
    "import scala.annotation.{nowarn=>Quiet}\nobject Original { @Quiet val answer:Int=4 }\n",
  );
  assert.equal(
    (await validate(root, { trusted: true })).checks[0]!.status,
    "inconclusive",
  );
});
test(
  "scala-extensions privacy acceptance",
  { ...options, timeout: 300000 },
  async (t) => {
    const f = await mixedScalaFixture(t, {
      "producer/Producer.java": javaProducer.replace(
        "return 4;",
        'return "wrong";',
      ),
    });
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const run = (trust: boolean, detailed: boolean) =>
      spawnSync(
        process.execPath,
        [
          cli,
          "run",
          "--root",
          f.root,
          ...(trust ? ["--trust-project"] : []),
          ...(detailed ? ["--detailed"] : []),
        ],
        { encoding: "utf8", timeout: 120000, maxBuffer: 2 * 1048576 },
      );
    const denied = run(false, false);
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /trust/i);
    const detailed = run(true, true);
    assert.equal(detailed.status, 1, detailed.stderr);
    const report = reportSchema.parse(JSON.parse(detailed.stdout));
    assert.equal(report.checks[0]!.status, "failed");
    assert.ok(
      report.checks[0]!.findings!.some(
        (f) => f.file === "producer/Producer.java",
      ),
    );
    const summary = run(true, false);
    assert.equal(summary.status, 1, summary.stderr);
    assert.ok(
      !summary.stdout.includes(f.root) &&
        !summary.stdout.includes("Producer") &&
        !summary.stdout.includes('return "wrong"'),
    );
    for (const allow of [false, true]) {
      const client = new Client(
        { name: "synthetic-mixed-Scala-client", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      try {
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [
              cli,
              "serve",
              "--root",
              f.root,
              ...(allow ? ["--allow-execution"] : []),
            ],
            env: {
              PATH: process.env.PATH ?? "",
              JAVA_HOME: process.env.JAVA_HOME ?? "",
              TMPDIR: tmpdir(),
              TMP: tmpdir(),
              TEMP: tmpdir(),
            },
            stderr: "pipe",
          }),
        );
        assert.equal(
          (
            await client.callTool({
              name: "validation_run",
              arguments: { trusted: true },
            })
          ).isError,
          true,
        );
        const result = await client.callTool({
          name: "validation_run",
          arguments: {},
        });
        if (!allow) assert.equal(result.isError, true);
        else {
          assert.notEqual(result.isError, true);
          assert.equal(
            (result.structuredContent as { outcome: string }).outcome,
            "failed",
          );
          assert.deepEqual(
            (result.structuredContent as { checks: unknown }).checks,
            JSON.parse(summary.stdout).checks,
          );
          assert.ok(
            !JSON.stringify(result).includes(f.root) &&
              !JSON.stringify(result).includes("Producer"),
          );
        }
      } finally {
        await client.close();
      }
    }
    await assert.rejects(access(f.marker));
  },
);
test(
  "scala-extensions lifecycle acceptance",
  { ...options, timeout: 180000 },
  async (t) => {
    for (const mode of ["cancel", "timeout", "output"]) {
      const f = await mixedScalaFixture(t),
        marker = path.join(f.root, ".checktrail/waiting");
      await writeFile(
        path.join(f.root, "generators/BuildScalaGenerator.java"),
        waitingScalaGenerator(mode),
      );
      await writeFile(
        path.join(f.root, "checktrail.json"),
        JSON.stringify({
          schemaVersion: 1,
          projects: [
            {
              path: ".",
              checks: ["jvm.scala"],
              environment: ["CHECKTRAIL_SCALA_WAITING"],
            },
          ],
        }),
      );
      const before = (await readdir(tmpdir()))
          .filter((n) => n.startsWith("checktrail-command-"))
          .sort(),
        abort = new AbortController();
      const pending = validate(f.root, {
        trusted: true,
        timeoutMs: mode === "timeout" ? 45000 : 90000,
        signal: abort.signal,
        environment: { CHECKTRAIL_SCALA_WAITING: marker },
      });
      void pending.catch(() => {});
      let ids:
        | { parent: number; child: number; temporary: string; token: string }
        | undefined;
      try {
        const deadline = performance.now() + 35000;
        while (performance.now() < deadline) {
          try {
            ids = JSON.parse(await readFile(marker + ".ready", "utf8"));
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await delay(10);
        }
        assert.ok(
          ids,
          "The generator and detached child must be reached before the lifecycle trigger",
        );
        assert.equal(ids.token, mode);
        assert.ok(ids.parent > 1 && ids.child > 1 && ids.parent !== ids.child);
        for (const pid of [ids.parent, ids.child]) process.kill(pid, 0);
        await access(ids.temporary);
        if (mode === "cancel") abort.abort();
        if (mode === "output") await writeFile(marker + ".release", "release");
        const report = await pending,
          result = report.checks[0]!.processes[0]!;
        assert.equal(report.outcome, "incomplete");
        assert.equal(result.cancelled, mode === "cancel");
        assert.equal(result.timedOut, mode === "timeout");
        assert.equal(result.truncated, mode === "output");
        for (const pid of [ids.parent, ids.child]) {
          let alive = true;
          for (let i = 0; i < 300; i++) {
            try {
              process.kill(pid, 0);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH")
                throw error;
              alive = false;
              break;
            }
            await delay(10);
          }
          assert.equal(
            alive,
            false,
            "Every reached native descendant must be reaped",
          );
        }
        await assert.rejects(access(ids.temporary));
        assert.deepEqual(
          (await readdir(tmpdir()))
            .filter((n) => n.startsWith("checktrail-command-"))
            .sort(),
          before,
        );
        assert.equal(
          await readFile(path.join(f.root, "build/classes/preserve"), "utf8"),
          "keep",
        );
        await assert.rejects(access(f.marker));
      } finally {
        abort.abort();
        await pending;
      }
    }
  },
);
test(
  "scala-extensions installed acceptance",
  { ...options, timeout: 600000 },
  async () => {
    if (process.env.CHECKTRAIL_SCALA_EXTENSIONS_INSTALLED === "1") {
      assert.match(
        await realpath(
          fileURLToPath(new URL("../src/engine.js", import.meta.url)),
        ),
        /node_modules\/@stsepelin\/checktrail\/dist\/src\/engine\.js$/,
      );
      return;
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "scala-extensions",
    };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            "../../scripts/verify-import-context-package.mjs",
            import.meta.url,
          ),
        ),
      ],
      { env, encoding: "utf8", timeout: 570000, maxBuffer: 4 * 1048576 },
    );
    assert.equal(child.status, 0, child.stderr);
    const receipt = JSON.parse(child.stdout);
    assert.equal(receipt.profile.required, 9);
    assert.equal(receipt.profile.passed, 9);
    assert.equal(receipt.profile.complete, true);
    assert.equal(receipt.offlineProductionInstall, true);
    assert.equal(receipt.harnessOutsideInstalledPackage, true);
    if (process.env.CHECKTRAIL_SCALA_INSTALL_RECEIPT)
      await writeFile(
        process.env.CHECKTRAIL_SCALA_INSTALL_RECEIPT,
        JSON.stringify(receipt),
        { flag: "wx" },
      );
  },
);
