import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  readFile,
  writeFile,
  access,
  realpath,
  mkdir,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { cppExtensionsEvidence } from "../src/cpp-extensions-evidence.js";
import { cppExtensionsPacketSchema } from "../src/cpp-extensions-packet.js";
import { cppExtensionsPolicyFile } from "../src/cpp-extensions.js";
import { mavenHash } from "../src/maven.js";
import {
  cppExtensionsFixture,
  cppExtensionsNative as native,
  cppExtensionsWriteConfig,
} from "./cpp-extensions-fixture.js";
import type { ProcessResult } from "../src/types.js";
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
const brief = (r: Awaited<ReturnType<typeof run>>) =>
  JSON.stringify(
    r.checks.map((c) => ({
      id: c.id,
      status: c.status,
      reason: c.reason,
      processes: c.processes.map((p) => ({
        exit: p.exitCode,
        stderr: p.stderr.slice(-500),
        truncated: p.truncated,
        timedOut: p.timedOut,
      })),
    })),
  );
const packet = (p: ProcessResult) =>
  cppExtensionsPacketSchema.parse(JSON.parse(p.stdout));
const changed = (
  p: ProcessResult,
  edit: (p: ReturnType<typeof packet>) => void,
) => {
  const value = packet(p);
  edit(value);
  return { ...p, stdout: JSON.stringify(value) };
};
const bytes = async (root: string) =>
  await readFile(path.join(root, "lib/core/core.c"), "utf8");
const breakCore = async (root: string) => {
  const before = await bytes(root);
  assert.equal(before.split("value + ORIGINAL_STEP").length, 2);
  await writeFile(
    path.join(root, "lib/core/core.c"),
    before.replace("value + ORIGINAL_STEP", "value"),
  );
  return before;
};
test("cpp-extensions broken acceptance", native, async (t) => {
  const { root } = await cppExtensionsFixture(t, ["build", "ctest"]);
  await breakCore(root);
  const r = await run(root);
  assert.equal(r.outcome, "failed", brief(r));
  assert.equal(r.checks[0]!.status, "passed", brief(r));
  assert.deepEqual(r.checks[1]!.tests, {
    total: 2,
    passed: 0,
    failed: 2,
    skipped: 0,
  });
  assert.equal(r.checks[1]!.findings?.length, 2);
  assert.ok(
    r.checks[1]!.findings!.every(
      (f) =>
        f.file === "CMakeLists.txt" &&
        f.line! > 0 &&
        f.message.includes("does not identify its failing assertion"),
    ),
  );
});
test("cpp-extensions fixed acceptance", native, async (t) => {
  const { root } = await cppExtensionsFixture(t);
  const before = await breakCore(root);
  assert.equal((await run(root)).outcome, "failed");
  await writeFile(path.join(root, "lib/core/core.c"), before);
  const r = await run(root);
  assert.equal(r.outcome, "passed", brief(r));
  assert.deepEqual(r.checks[1]!.tests, {
    total: 2,
    passed: 2,
    failed: 0,
    skipped: 0,
  });
  assert.equal(r.sourceChanged, false);
  for (const check of r.checks) {
    const p = packet(check.processes[0]!);
    assert.equal(p.sdkBeforeSha256, p.sdkAfterSha256);
    assert.deepEqual(p.generatedBefore, p.generatedAfter);
    assert.ok(
      p.sdkObserved.length > 0 && p.sdkObserved.length < p.config.sdk.length,
    );
    await assert.rejects(access(p.temporary));
  }
});
test("cpp-extensions near-miss acceptance", native, async (t) => {
  const { root, config } = await cppExtensionsFixture(t, ["build", "ctest"]);
  config.targets.find((t) => t.name === "original_bridge")!.publicLinks = [];
  config.targets.find((t) => t.name === "original_bridge")!.privateLinks = [
    "original_core",
  ];
  await cppExtensionsWriteConfig(root, config);
  const r = await run(root);
  assert.equal(r.outcome, "passed", brief(r));
  assert.deepEqual(r.checks[1]!.tests, {
    total: 2,
    passed: 2,
    failed: 0,
    skipped: 0,
  });
  const file = path.join(root, "lib/core/include/original_step.h.in"),
    before = await readFile(file, "utf8");
  await writeFile(file, "// original adjacent template\n" + before);
  const near = await run(root);
  assert.equal(near.outcome, "passed", brief(near));
  assert.equal(
    packet(near.checks[0]!.processes[0]!).generated[0]!.text,
    "// original adjacent template\n#define ORIGINAL_STEP 1\n",
  );
  const privateGraph = await cppExtensionsFixture(t, ["build", "ctest"]),
    c = privateGraph.config,
    core = c.targets.find((t) => t.name === "original_core")!;
  core.privateLinks = ["original_leaf"];
  core.privateIncludes = ["lib/core/private"];
  c.headers.push("lib/core/private/original_leaf.h");
  c.targets.push({
    name: "original_leaf",
    directory: "lib/core",
    type: "static",
    sources: ["lib/core/leaf.c"],
    publicIncludes: ["lib/core/private"],
    privateIncludes: [],
    publicLinks: [],
    privateLinks: [],
  });
  await mkdir(path.join(privateGraph.root, "lib/core/private"));
  await writeFile(
    path.join(privateGraph.root, "lib/core/private/original_leaf.h"),
    "int original_leaf(int value);\n",
  );
  await writeFile(
    path.join(privateGraph.root, "lib/core/leaf.c"),
    '#include "original_leaf.h"\nint original_leaf(int value){return value;}\n',
  );
  const coreBefore = await bytes(privateGraph.root);
  await writeFile(
    path.join(privateGraph.root, "lib/core/core.c"),
    '#include "original_leaf.h"\n' +
      coreBefore.replace(
        "value + ORIGINAL_STEP",
        "original_leaf(value) + ORIGINAL_STEP",
      ),
  );
  await cppExtensionsWriteConfig(privateGraph.root, c);
  const linked = await run(privateGraph.root);
  assert.equal(linked.outcome, "passed", brief(linked));
  assert.deepEqual(linked.checks[1]!.tests, {
    total: 2,
    passed: 2,
    failed: 0,
    skipped: 0,
  });
  const pureC = await cppExtensionsFixture(t, ["build", "ctest"]);
  pureC.config.targets.find((t) => t.name === "original_consumer")!.sources = [
    "main.c",
  ];
  pureC.config.targets.find((t) => t.name === "original_bridge")!.sources = [
    "lib/bridge.c",
  ];
  await rm(path.join(pureC.root, "main.cpp"));
  await rm(path.join(pureC.root, "lib/bridge.cpp"));
  await writeFile(
    path.join(pureC.root, "main.c"),
    '#include "original_bridge.hpp"\nint main(void){int values[2]={2,4};for(int i=0;i<2;i++){if(original_bridge(values[i])!=values[i]+1)return 1;}return 0;}\n',
  );
  await writeFile(
    path.join(pureC.root, "lib/bridge.c"),
    '#include "original_bridge.hpp"\n#include "original_core.h"\nint original_bridge(int value){return original_core(value);}\n',
  );
  await cppExtensionsWriteConfig(pureC.root, pureC.config);
  const nativeC = await run(pureC.root);
  assert.equal(nativeC.outcome, "passed", brief(nativeC));
  assert.deepEqual(nativeC.checks[1]!.tests, {
    total: 2,
    passed: 2,
    failed: 0,
    skipped: 0,
  });
});

test("cpp-extensions prerequisite acceptance", native, async (t) => {
  const { root, config } = await cppExtensionsFixture(t, ["build"]),
    manifest = path.join(root, "lib/CMakeLists.txt"),
    before = await readFile(manifest, "utf8"),
    marker = path.join(root, "original-must-not-execute");
  try {
    await writeFile(
      manifest,
      before + `file(WRITE "${marker}" "original synthetic canary")\n`,
    );
    const p = await createPlan(root);
    assert.ok(p.plan.checks[0]!.unavailableReason);
    assert.deepEqual(p.plan.checks[0]!.commands, []);
    assert.equal((await run(root)).checks[0]!.status, "unavailable");
    await assert.rejects(access(marker));
  } finally {
    await writeFile(manifest, before);
  }
  const original = structuredClone(config),
    canonical = config.sdk.find(
      (p) => p.path === p.resolved && p.path.startsWith("usr/include/"),
    )!;
  for (const kind of ["hash", "size", "missing"] as const) {
    const bad = structuredClone(original);
    for (const pin of bad.sdk.filter((p) => p.resolved === canonical.path)) {
      if (kind === "hash") pin.sha256 = "0".repeat(64);
      else if (kind === "size") pin.bytes++;
      else {
        if (pin.path === canonical.path)
          pin.path = "usr/include/original_missing_sdk_zz.h";
        pin.resolved = "usr/include/original_missing_sdk_zz.h";
      }
    }
    await cppExtensionsWriteConfig(root, bad);
    const plan = await createPlan(root);
    assert.equal(plan.plan.checks[0]!.unavailableReason, undefined);
    assert.equal(plan.plan.checks[0]!.commands.length, 1);
    const result = await run(root);
    assert.equal(result.checks[0]!.status, "unavailable", kind + brief(result));
    assert.equal(result.checks[0]!.processes[0]!.exitCode, 3);
    assert.deepEqual(JSON.parse(result.checks[0]!.processes[0]!.stdout), {
      unavailable: "cpp-extensions",
      reason: "unsupported-sdk",
    });
    await assert.rejects(access(marker));
  }
  await cppExtensionsWriteConfig(root, original);
  assert.equal((await run(root)).outcome, "passed");
});
test("cpp-extensions stale acceptance", native, async (t) => {
  const { root } = await cppExtensionsFixture(t, ["build"]),
    r = await run(root);
  assert.equal(r.outcome, "passed", brief(r));
  const { plan, source } = await createPlan(root),
    check = plan.checks[0]!,
    p = r.checks[0]!.processes[0]!;
  assert.equal(cppExtensionsEvidence(check, [p], source.root).status, "passed");
  for (const file of [
    "main.cpp",
    "lib/include/original_bridge.hpp",
    "lib/core/include/original_step.h.in",
    cppExtensionsPolicyFile,
  ]) {
    const absolute = path.join(root, file),
      before = await readFile(absolute);
    try {
      await writeFile(absolute, Buffer.concat([before, Buffer.from("\n")]));
      assert.equal(
        cppExtensionsEvidence(check, [p], source.root).status,
        "inconclusive",
        file,
      );
    } finally {
      await writeFile(absolute, before);
    }
  }
  assert.equal(cppExtensionsEvidence(check, [p], source.root).status, "passed");
  await writeFile(
    path.join(root, "OriginalAdjacent.bin"),
    Buffer.from([0, 255]),
  );
  assert.equal(
    cppExtensionsEvidence(check, [p], source.root).status,
    "inconclusive",
  );
});
test("cpp-extensions empty acceptance", native, async (t) => {
  const { root } = await cppExtensionsFixture(t, ["build"]),
    r = await run(root);
  assert.equal(r.outcome, "passed", brief(r));
  const { plan, source } = await createPlan(root),
    check = plan.checks[0]!,
    p = r.checks[0]!.processes[0]!;
  const edits: ((p: ReturnType<typeof packet>) => void)[] = [
    (p) => {
      p.tools.pop();
    },
    (p) => {
      p.tools[0]!.afterSha256 = "0".repeat(64);
    },
    (p) => {
      p.sdkAfterSha256 = "0".repeat(64);
    },
    (p) => {
      p.binaries[0]!.afterSha256 = "0".repeat(64);
    },
    (p) => {
      const extra = p.config.sdk.find(
        (pin) => !p.sdkObserved.some((v) => v.path === pin.path),
      )!;
      p.sdkObserved.push({ ...extra, md5: "0".repeat(32) });
    },
    (p) => {
      const a = p.artifacts.find((a) => a.path.endsWith("core.c.o"))!,
        data = Buffer.from(a.text, "base64");
      data[data.length - 1] = data[data.length - 1]! ^ 1;
      a.text = data.toString("base64");
      a.sha256 = a.afterSha256 = mavenHash(data);
    },
    (p) => {
      const a = p.artifacts.find((a) => a.path.endsWith("/link.d"))!;
      const sections = a.text.split("\n\n"),
        rule = sections[0]!,
        matches = [...rule.matchAll(/ {2}\/usr\/lib\/libgcc_s\.so \\\n/g)];
      assert.ok(matches.length >= 2);
      sections[0] =
        rule.slice(0, matches[0]!.index) +
        rule.slice(matches[0]!.index! + matches[0]![0].length);
      const phony = sections.findIndex(
        (v, i) => i > 0 && v === "/usr/lib/libgcc_s.so:",
      );
      assert.ok(phony > 0);
      sections.splice(phony, 1);
      a.text = sections.join("\n\n");
      a.sha256 = a.afterSha256 = mavenHash(a.text);
    },

    (p) => {
      p.receipts.pop();
    },
    (p) => {
      p.artifacts.pop();
    },
    (p) => {
      p.binaries.pop();
    },
    (p) => {
      p.generatedAfter = [];
    },
    (p) => {
      p.sdkObserved.pop();
    },
    (p) => {
      const a = p.artifacts.find((a) => a.path.endsWith("/link.d"))!;
      a.text = a.text.split("\n\n")[0] + "\n";
      a.sha256 = a.afterSha256 = mavenHash(a.text);
    },
    (p) => {
      p.sdkObserved[0]!.resolved = "usr/include/original_adjacent.h";
    },
    (p) => {
      const r = p.receipts.find((r) =>
        r.phase.startsWith("dwarf:CMakeFiles/"),
      )!;
      r.stdout = r.stdout.replace(
        /md5_checksum: [a-f0-9]{32}/,
        "md5_checksum: " + "0".repeat(32),
      );
      r.stdoutSha256 = mavenHash(r.stdout);
    },
    (p) => {
      const r = p.receipts.find(
        (r) => r.phase === "sdk-dwarf:usr/lib/Scrt1.o",
      )!;
      r.args = ["--debug-line", "/usr/lib/crti.o"];
    },
    (p) => {
      const r = p.receipts.find((r) => r.phase === "elf:original_consumer")!;
      r.stdout = r.stdout.replace(
        "liboriginal_bridge.so",
        "liboriginal_adjacent.so",
      );
      r.stdoutSha256 = mavenHash(r.stdout);
    },
    (p) => {
      const a = p.artifacts.find((a) => a.path.endsWith("main.cpp.o.d"))!;
      a.text = a.text.replace(
        /\/usr\/[^\s]+\/vector/,
        "/usr/include/original_adjacent.h",
      );
      a.sha256 = a.afterSha256 = mavenHash(a.text);
    },
  ];
  for (const [i, edit] of edits.entries())
    assert.equal(
      cppExtensionsEvidence(check, [changed(p, edit)], source.root).status,
      "inconclusive",
      String(i),
    );
  for (const edit of [
    { truncated: true },
    { cancelled: true },
    { timedOut: true },
    { exitCode: null },
    { stdout: "{}" },
    { stderr: "original unexpected error" },
  ])
    assert.equal(
      cppExtensionsEvidence(check, [{ ...p, ...edit }], source.root).status,
      "inconclusive",
    );
  assert.equal(cppExtensionsEvidence(check, [p], source.root).status, "passed");
});
test(
  "cpp-extensions compiler formatter analyzer acceptance",
  native,
  async (t) => {
    const compiler = await cppExtensionsFixture(t, ["build"]),
      file = path.join(compiler.root, "lib/core/core.c"),
      before = await bytes(compiler.root);
    await writeFile(
      file,
      before.replace("value + ORIGINAL_STEP", '"original invalid type"'),
    );
    const broken = await run(compiler.root);
    assert.equal(broken.outcome, "failed", brief(broken));
    assert.ok(
      broken.checks[0]!.findings?.some(
        (f) => f.file === "lib/core/core.c" && f.level === "error",
      ),
    );
    await writeFile(file, before);
    assert.equal((await run(compiler.root)).outcome, "passed");
    const format = await cppExtensionsFixture(t, ["clang-format"]),
      formatBefore = await bytes(format.root);
    await writeFile(
      path.join(format.root, "lib/core/core.c"),
      formatBefore.replace("value + ORIGINAL_STEP", "value+ORIGINAL_STEP"),
    );
    const formatted = await run(format.root);
    assert.equal(formatted.outcome, "failed", brief(formatted));
    assert.ok(
      formatted.checks[0]!.findings?.some((f) => f.file === "lib/core/core.c"),
    );
    await writeFile(path.join(format.root, "lib/core/core.c"), formatBefore);
    assert.equal((await run(format.root)).outcome, "passed");
    const tidy = await cppExtensionsFixture(t, ["clang-tidy"]),
      tidyBefore = await bytes(tidy.root);
    await writeFile(
      path.join(tidy.root, "lib/core/core.c"),
      tidyBefore.replace(
        "return value + ORIGINAL_STEP;",
        "int original_divisor = 0;\n  return (value + ORIGINAL_STEP) / original_divisor;",
      ),
    );
    const analyzed = await run(tidy.root);
    assert.equal(analyzed.outcome, "failed", brief(analyzed));
    assert.ok(
      analyzed.checks[0]!.findings?.some(
        (f) =>
          f.file === "lib/core/core.c" &&
          f.ruleId === "clang-tidy/clang-analyzer-core.DivideZero",
      ),
    );
    const tidyPlan = await createPlan(tidy.root),
      check = tidyPlan.plan.checks[0]!,
      nativeProcess = analyzed.checks[0]!.processes[0]!;
    for (const edit of [
      (p: ReturnType<typeof packet>) => {
        const row = p.receipts.find((r) => r.phase === "tidy:lib/core/core.c")!;
        row.stderr = "2 warnings generated.\n2 warnings treated as error\n";
        row.stderrSha256 = mavenHash(row.stderr);
      },
      (p: ReturnType<typeof packet>) => {
        const row = p.receipts.find((r) => r.phase === "tidy:lib/core/core.c")!;
        row.stdout = row.stdout.replace(
          "error: Division by zero",
          "error: Original omitted diagnostic",
        );
        row.stdoutSha256 = mavenHash(row.stdout);
      },
      (p: ReturnType<typeof packet>) => {
        const a = p.artifacts.find(
          (a) => a.path === "fixes-original_core-core.c.yaml",
        )!;
        a.text = a.text.replace(
          "Length:          42",
          "Length:          2147483647",
        );
        assert.notEqual(
          a.text,
          packet(nativeProcess).artifacts.find(
            (a) => a.path === "fixes-original_core-core.c.yaml",
          )!.text,
        );
        a.sha256 = a.afterSha256 = mavenHash(a.text);
      },
    ])
      assert.equal(
        cppExtensionsEvidence(check, [changed(nativeProcess, edit)], tidy.root)
          .status,
        "inconclusive",
      );
    await writeFile(path.join(tidy.root, "lib/core/core.c"), tidyBefore);
    assert.equal((await run(tidy.root)).outcome, "passed");
    tidy.config.tidyRules.push("bugprone-use-after-move");
    await cppExtensionsWriteConfig(tidy.root, tidy.config);
    const cxxFile = path.join(tidy.root, "main.cpp"),
      cxxBefore = await readFile(cxxFile, "utf8");
    await writeFile(
      cxxFile,
      cxxBefore.replace(
        "return 0;",
        "std::vector<int> original_other{1,3}; auto original_moved = std::move(values); auto original_other_moved = std::move(original_other); return values[0] + original_other[0] + original_moved[0] + original_other_moved[0];",
      ),
    );
    const moved = await run(tidy.root);
    assert.equal(moved.outcome, "failed", brief(moved));
    assert.ok(
      moved.checks[0]!.findings?.some(
        (f) =>
          f.file === "main.cpp" &&
          f.ruleId === "clang-tidy/bugprone-use-after-move",
      ),
    );
    assert.equal(
      moved.checks[0]!.findings?.filter(
        (f) => f.ruleId === "clang-tidy/bugprone-use-after-move",
      ).length,
      2,
    );
    await writeFile(
      cxxFile,
      cxxBefore.replace(
        "return 0;",
        "auto original_moved = std::move(values); values = {2,4}; return values.size() == original_moved.size();",
      ),
    );
    assert.equal((await run(tidy.root)).outcome, "passed");
    await writeFile(cxxFile, cxxBefore);
    assert.equal((await run(tidy.root)).outcome, "passed");
  },
);

test(
  "cpp-extensions installed acceptance",
  { ...native, timeout: 300000 },
  async () => {
    if (process.env.CHECKTRAIL_CPP_EXTENSIONS_INSTALLED === "1") {
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
      CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "cpp-extensions",
    };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            "../../scripts/verify-import-context-package.mjs",
            import.meta.url,
          ),
        ),
      ],
      { env, encoding: "utf8", timeout: 285000, maxBuffer: 4 * 1048576 },
    );
    assert.equal(result.error, undefined, result.error?.message ?? "");
    assert.equal(result.status, 0, result.stderr.slice(-3000));
    const receipt = JSON.parse(result.stdout),
      requirements = JSON.parse(
        await readFile(
          fileURLToPath(
            new URL(
              "../../scripts/required-native-tests.json",
              import.meta.url,
            ),
          ),
          "utf8",
        ),
      );
    assert.equal(
      receipt.profile.required,
      requirements["cpp-extensions"].length,
    );
    assert.equal(receipt.profile.passed, receipt.profile.required);
    assert.equal(receipt.profile.complete, true);
    assert.equal(receipt.offlineProductionInstall, true);
    assert.equal(receipt.harnessOutsideInstalledPackage, true);
    if (process.env.CHECKTRAIL_CPP_EXTENSIONS_INSTALL_RECEIPT)
      await writeFile(
        process.env.CHECKTRAIL_CPP_EXTENSIONS_INSTALL_RECEIPT,
        JSON.stringify(receipt),
      );
  },
);
