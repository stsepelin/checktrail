import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import {
  parseCheckstyleConfiguration,
  renderCheckstyleConfiguration,
} from "../src/checkstyle.js";
import { checkstyleEvidence } from "../src/checkstyle-evidence.js";
import {
  checkstyleFixture,
  nativeOptions,
  goodJava,
  brokenJava,
  checkstyleXml,
  checkstyleConfig,
  checkstylePolicy,
} from "./checkstyle-fixture.js";
import { fixture } from "./helpers.js";

test("Checkstyle planning never executes project code requires explicit activation and protects JVM environment", async (t) => {
  const root = await fixture(t, {
    "pom.xml": "<project/>",
    "build.gradle.kts": 'throw Exception("never execute")',
    "First.java": goodJava,
    "checktrail.json": checkstylePolicy,
    "checktrail.checkstyle.json": JSON.stringify(checkstyleConfig),
    "checkstyle.xml": checkstyleXml,
  });
  const unavailable = (await createPlan(root)).plan.checks[0]!;
  assert.equal(unavailable.id, "jvm.checkstyle");
  assert.ok(unavailable.unavailableReason);
  assert.ok(!unavailable.unavailableReason.includes(root));
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
  await assert.rejects(access(path.join(root, "executed")), { code: "ENOENT" });
  await rm(path.join(root, "checktrail.json"));
  assert.deepEqual(
    (await createPlan(root)).plan.checks.map((c) => c.id),
    ["jvm.javac"],
  );
  for (const name of [
    "JAVA_TOOL_OPTIONS",
    "JDK_JAVA_OPTIONS",
    "_JAVA_OPTIONS",
    "CLASSPATH",
  ]) {
    await writeFile(
      path.join(root, "checktrail.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          { path: ".", checks: ["jvm.checkstyle"], environment: [name] },
        ],
      }),
    );
    const inert = (
      await createPlan(root, { environment: { [name]: "unsafe" } })
    ).plan.checks[0]!;
    assert.ok(inert.unavailableReason, name);
    assert.equal(inert.commands.length, 0, name);
  }
});

test("Checkstyle XML accepts escaped properties formatting comments and exact built-in names while rejecting inactive or external assembly", () => {
  const control = parseCheckstyleConfiguration(checkstyleXml);
  assert.deepEqual(
    parseCheckstyleConfiguration(
      "<!-- ${quoted} <!ENTITY quoted> -->\n" +
        checkstyleXml.replaceAll("><", ">\n  <"),
    ),
    control,
  );
  const escaped =
    '<module name="Checker"><module name="RegexpSingleline"><property name="format" value="&lt;tag&gt; &amp; &quot;x&quot;"/></module></module>';
  const parsed = parseCheckstyleConfiguration(escaped);
  assert.equal(
    parsed.children[0]!.properties.find((p) => p.name === "format")!.value,
    '<tag> & "x"',
  );
  assert.deepEqual(
    parseCheckstyleConfiguration(renderCheckstyleConfiguration(parsed)),
    parsed,
  );
  const exact = checkstyleXml.replace(
    'name="NeedBraces"',
    'name="com.puppycrawl.tools.checkstyle.checks.blocks.NeedBracesCheck"',
  );
  assert.equal(
    parseCheckstyleConfiguration(exact).children[1]!.children[0]!.name,
    "com.puppycrawl.tools.checkstyle.checks.blocks.NeedBracesCheck",
  );
  const numeric = parseCheckstyleConfiguration(
    '<module name="Checker"><module name="FileTabCharacter"><property name="id" value="&#x62;races"/></module></module>',
  );
  assert.equal(
    numeric.children[0]!.properties.find((p) => p.name === "id")!.value,
    "braces",
  );
  const literal = parseCheckstyleConfiguration(
    '<module name="Checker"><module name="RegexpSingleline"><property name="format" value="&amp;#10;"/></module></module>',
  );
  assert.equal(
    literal.children[0]!.properties.find((p) => p.name === "format")!.value,
    "&#10;",
  );
  assert.throws(
    () =>
      parseCheckstyleConfiguration(
        '<module name="Checker"><module name="FileTabCharacter"><property name="id" value="&copy;"/></module></module>',
      ),
    /XML character/,
  );
  const root = (body: string) => `<module name="Checker">${body}</module>`;
  const check = (property: string) =>
    root(
      `<module name="TreeWalker"><module name="NeedBraces">${property}</module></module>`,
    );
  for (const xml of [
    root(""),
    root('<module name="TreeWalker"/>'),
    root('<module name="SuppressionFilter"/>'),
    root(
      '<module name="TreeWalker"><module name="SuppressWarningsHolder"/></module>',
    ),
    check('<property name="severity" value="ignore"/>'),
    check('<property name="tokens" value=""/>'),
    root(
      '<module name="FileTabCharacter"><property name="fileExtensions" value="kt"/></module>',
    ),
    root(
      '<module name="FileTabCharacter"><property name="fileExtensions" value=""/></module>',
    ),
    root(
      '<property name="cacheFile" value=".checktrail/cache"/><module name="FileTabCharacter"/>',
    ),
    check('<property name="file" value="rules.xml"/>'),
    check('<property name="url" value="https://example.invalid"/>'),
    check('<property name="severity" value="${severity}"/>'),
    check('<property name="id" value="&#36;{rule}"/>'),
    root(
      '<module name="TreeWalker"><property name="skipFileOnJavaParseException" value="true"/><module name="NeedBraces"/></module>',
    ),
    root(
      '<property name="charset" value="UTF-16"/><module name="FileTabCharacter"/>',
    ),
    check('<property name="id" value="one"/><property name="id" value="two"/>'),
    root(
      '<module name="TreeWalker"><module name="org.example.NeedBraces"/></module>',
    ),
    root(
      '<module name="TreeWalker"><module name="com.puppycrawl.tools.checkstyle.checksEvil.NeedBraces"/></module>',
    ),
    root(
      '<module name="FileTabCharacter"><module name="NeedBraces"/></module>',
    ),
    '<module name="Checker"/><module name="Checker"/>',
    checkstyleXml.replace(
      'name="NeedBraces"',
      'name="NeedBraces" unexpected="yes"',
    ),
    checkstyleXml.replace(
      'name="NeedBraces"',
      'name="NeedBraces" name="Other"',
    ),
    '<!DOCTYPE module SYSTEM "https://example.invalid"><module name="Checker"/>',
    '<!DOCTYPE module [<!ENTITY private SYSTEM "file:///private">]>' +
      checkstyleXml,
    "<!-- malformed -- comment -->" + checkstyleXml,
    root(
      '<module name="FileTabCharacter"><property name="format" value="&#10;"/></module>',
    ),
  ])
    assert.throws(() => parseCheckstyleConfiguration(xml), Error, xml);
  assert.throws(
    () => parseCheckstyleConfiguration(" ".repeat(256 * 1024) + checkstyleXml),
    /byte bound/,
  );
  assert.throws(() =>
    parseCheckstyleConfiguration(
      root(
        '<module name="TreeWalker">' +
          '<module name="NeedBraces"/>'.repeat(129) +
          "</module>",
      ),
    ),
  );
  assert.throws(
    () =>
      parseCheckstyleConfiguration(
        root(
          (
            '<module name="TreeWalker">' +
            '<module name="NeedBraces"/>'.repeat(128) +
            "</module>"
          ).repeat(4),
        ),
      ),
    /module bound/,
  );
  assert.throws(() =>
    parseCheckstyleConfiguration(
      root(
        '<module name="FileTabCharacter">' +
          Array.from(
            { length: 65 },
            (_, index) => `<property name="field${index}" value="x"/>`,
          ).join("") +
          "</module>",
      ),
    ),
  );
});

test(
  "native Checkstyle catches exact style defects retains thresholds IDs and near misses without writing source or cache",
  nativeOptions,
  async (t) => {
    const root = await checkstyleFixture(t, {
      "First.java": brokenJava,
      ".checktrail/preserved-cache": "preserve",
      "Empty.java": "",
      "EscapedTab.java": 'class EscapedTab { String value = "\\t"; }\n',
      "NeverRun.java":
        'class NeverRun { static { throw new RuntimeException("never run"); } }\n',
    });
    let report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.equal(report.sourceChanged, false);
    assert.equal(report.checks[0]!.findingsComplete, true);
    assert.deepEqual(
      report.checks[0]!.findings!.map((f) => [
        f.ruleId,
        f.file,
        f.line,
        f.level,
      ]),
      [
        [
          "checkstyle/com.puppycrawl.tools.checkstyle.checks.whitespace.FileTabCharacterCheck",
          "First.java",
          2,
          "error",
        ],
        [
          "checkstyle/com.puppycrawl.tools.checkstyle.checks.blocks.NeedBracesCheck",
          "First.java",
          2,
          "error",
        ],
      ],
    );
    assert.equal(
      report.checks[0]!.tools!.find((tool) => tool.name === "checkstyle")!
        .version,
      "14.3.0",
    );
    assert.equal(
      await readFile(path.join(root, "First.java"), "utf8"),
      brokenJava,
    );
    assert.equal(
      await readFile(path.join(root, ".checktrail/preserved-cache"), "utf8"),
      "preserve",
    );
    await writeFile(
      path.join(root, "First.java"),
      goodJava.replaceAll("\n", "\r\n"),
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.findingsComplete, true);
    await writeFile(path.join(root, "First.java"), brokenJava);
    await writeFile(
      path.join(root, "checkstyle.xml"),
      checkstyleXml
        .replace(
          '<module name="Checker">',
          '<module name="Checker"><property name="severity" value="warning"/>',
        )
        .replace(
          '<module name="NeedBraces"/>',
          '<module name="NeedBraces"><property name="id" value="brace-rule"/></module>',
        ),
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.findings!.length, 2);
    assert.ok(report.checks[0]!.findings!.every((f) => f.level === "warning"));
    assert.ok(
      report.checks[0]!.findings!.some((f) => f.ruleId.endsWith("/brace-rule")),
    );
    await writeFile(
      path.join(root, "checktrail.checkstyle.json"),
      JSON.stringify({ ...checkstyleConfig, failOn: "warning" }),
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "failed");
    await writeFile(
      path.join(root, "checkstyle.xml"),
      checkstyleXml.replace(
        '<module name="Checker">',
        '<module name="Checker"><property name="severity" value="info"/>',
      ),
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    assert.ok(report.checks[0]!.findings!.every((f) => f.level === "note"));
  },
);

test(
  "native Checkstyle completion rejects missing duplicate foreign stale forged and interrupted audit evidence",
  nativeOptions,
  async (t) => {
    const root = await checkstyleFixture(t);
    const report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    const check = (await createPlan(root)).plan.checks[0]!,
      process = report.checks[0]!.processes[0]!;
    const good = JSON.parse(process.stdout);
    const changes: [string, (value: typeof good) => void][] = [
      ["missing file", (d) => d.events.splice(1, 2)],
      ["duplicate file", (d) => d.events.splice(1, 0, ...d.events.slice(1, 3))],
      [
        "foreign file",
        (d) => {
          d.events[1].file = "/foreign.java";
        },
      ],
      ["missing completion", (d) => d.events.pop()],
      ["late event", (d) => d.events.push(d.events[1])],
      [
        "interleaved sources",
        (d) => {
          [d.events[2], d.events[3]] = [d.events[3], d.events[2]];
        },
      ],
      ["missing start", (d) => d.events.shift()],
      ["second audit", (d) => d.events.push(...d.events)],
      [
        "wrong configuration",
        (d) => {
          d.configuration.children[0].name = "LineLength";
        },
      ],
      ["missing rule", (d) => d.rules.pop()],
      [
        "foreign rule",
        (d) => {
          d.rules[0].type =
            "com.puppycrawl.tools.checkstyle.checksEvil.FileTabCharacterCheck";
        },
      ],
      [
        "wrong rule class",
        (d) => {
          d.rules[0].type =
            "com.puppycrawl.tools.checkstyle.checks.whitespace.LineLengthCheck";
        },
      ],
      [
        "wrong rule id",
        (d) => {
          d.rules[0].moduleId = "another";
        },
      ],
      [
        "wrong rule name",
        (d) => {
          d.rules[0].name = "Another";
        },
      ],
      [
        "native counter mismatch",
        (d) => {
          d.nativeErrors = 1;
        },
      ],
      [
        "wrong version",
        (d) => {
          d.checkstyle = "14.2.0";
        },
      ],
      [
        "wrong runtime",
        (d) => {
          d.runtime = "25.0.3";
        },
      ],
      [
        "wrong vendor",
        (d) => {
          d.vendor = "another";
        },
      ],
      [
        "foreign diagnostic",
        (d) =>
          d.diagnostics.push({
            file: "/foreign.java",
            line: 1,
            column: 1,
            severity: "warning",
            source: d.rules[0].type,
            moduleId: null,
            message: "private",
          }),
      ],
      [
        "unconfigured diagnostic",
        (d) =>
          d.diagnostics.push({
            file: d.events[1].file,
            line: 1,
            column: 1,
            severity: "warning",
            source: "unknown",
            moduleId: null,
            message: "private",
          }),
      ],
      [
        "ignored diagnostic",
        (d) =>
          d.diagnostics.push({
            file: d.events[1].file,
            line: 1,
            column: 1,
            severity: "ignore",
            source: d.rules[0].type,
            moduleId: null,
            message: "ignored",
          }),
      ],
      [
        "unknown field",
        (d) => {
          d.extra = true;
        },
      ],
    ];
    for (const [name, change] of changes) {
      const value = structuredClone(good);
      change(value);
      const result = checkstyleEvidence(
        check,
        [{ ...process, stdout: JSON.stringify(value) }],
        root,
      );
      assert.equal(result.status, "inconclusive", name);
      assert.equal(result.findingsComplete, false, name);
    }
    for (const flag of ["cancelled", "timedOut", "truncated"] as const)
      assert.equal(
        checkstyleEvidence(check, [{ ...process, [flag]: true }], root).status,
        "inconclusive",
        flag,
      );
    for (const value of [
      { ...process, signal: "SIGKILL" as const },
      { ...process, errorCode: "EIO" },
      { ...process, stdout: "{}" },
      { ...process, stderr: "unparsed" },
      { ...process, exitCode: 2 },
    ])
      assert.notEqual(
        checkstyleEvidence(check, [value], root).status,
        "passed",
      );
    for (const change of [
      (d: typeof good) =>
        d.exceptions.push({ file: d.events[1].file, type: "IOException" }),
      (d: typeof good) =>
        d.diagnostics.push({
          file: d.events[1].file,
          line: 0,
          column: 0,
          severity: "warning",
          source: d.rules[0].type,
          moduleId: null,
          message: "unlocated",
        }),
    ]) {
      const data = structuredClone(good);
      change(data);
      const result = checkstyleEvidence(
        check,
        [{ ...process, stdout: JSON.stringify(data) }],
        root,
      );
      assert.equal(result.status, "error");
      assert.equal(result.findingsComplete, false);
    }
    assert.equal(
      checkstyleEvidence({ ...check, scope: [] }, [process], root).status,
      "inconclusive",
    );
    assert.equal(
      checkstyleEvidence(
        { ...check, scope: [...check.scope, check.scope[0]!] },
        [process],
        root,
      ).status,
      "inconclusive",
    );
    assert.equal(
      checkstyleEvidence(check, [process, process], root).status,
      "inconclusive",
    );
    const unavailable = {
      ...process,
      exitCode: 3,
      stdout: JSON.stringify({ unavailable: "checkstyle-toolchain" }),
    };
    assert.equal(
      checkstyleEvidence(check, [unavailable], root).status,
      "unavailable",
    );
    assert.equal(
      checkstyleEvidence(
        check,
        [{ ...unavailable, stdout: '{"unavailable":"another"}' }],
        root,
      ).status,
      "inconclusive",
    );
    assert.equal(
      checkstyleEvidence(check, [{ ...unavailable, cancelled: true }], root)
        .status,
      "inconclusive",
    );
  },
);

test(
  "native Checkstyle rejects malformed Java inactive tokens unknown modules and changed pinned inputs",
  nativeOptions,
  async (t) => {
    const root = await checkstyleFixture(t, {
      "First.java": "class First { int value( { }\n",
    });
    let report = await validate(root, { trusted: true });
    // Native TreeWalker throws on malformed Java before it emits a complete
    // audit. Preserve the collection failure; it establishes no clean analysis.
    assert.equal(report.outcome, "incomplete", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.status, "error");
    assert.equal(report.checks[0]!.findingsComplete, false);
    assert.equal(report.checks[0]!.processes[0]!.exitCode, 2);
    await writeFile(path.join(root, "First.java"), goodJava);
    const planningBin = path.join(root, ".checktrail/planning-bin");
    await mkdir(planningBin);
    const planningMarker = path.join(root, ".checktrail/planning-executed");
    await writeFile(
      path.join(planningBin, "java"),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(planningMarker)}, 'unexpected');\n`,
      { mode: 0o700 },
    );
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = planningBin;
      const prepared = (await createPlan(root)).plan.checks[0]!;
      await assert.rejects(access(planningMarker), { code: "ENOENT" });
      assert.equal(prepared.unavailableReason, undefined);
      assert.equal(prepared.commands.length, 1);
      await assert.rejects(
        validate(root, { trusted: false }),
        /operator trust/,
      );
      await assert.rejects(access(planningMarker), { code: "ENOENT" });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    for (const name of [
      "NeedBracesUnknown",
      "SuppressWarningsFilter",
      "TreeWalker",
      "SuppressWarningsHolder",
    ]) {
      await writeFile(
        path.join(root, "checkstyle.xml"),
        checkstyleXml.replace('name="NeedBraces"', `name="${name}"`),
      );
      assert.equal(
        (await validate(root, { trusted: true })).outcome,
        "incomplete",
        name,
      );
    }
    await writeFile(path.join(root, "checkstyle.xml"), checkstyleXml);
    for (const name of [
      "JAVA_TOOL_OPTIONS",
      "JDK_JAVA_OPTIONS",
      "_JAVA_OPTIONS",
      "CLASSPATH",
    ]) {
      await writeFile(
        path.join(root, "checktrail.json"),
        JSON.stringify({
          schemaVersion: 1,
          projects: [
            { path: ".", checks: ["jvm.checkstyle"], environment: [name] },
          ],
        }),
      );
      await assert.rejects(
        createPlan(root, { environment: { [name]: "unsafe" } }),
        /protected/,
        name,
      );
    }
    await writeFile(path.join(root, "checktrail.json"), checkstylePolicy);
    const { plan } = await createPlan(root),
      command = plan.checks[0]!.commands[0]!;
    const invoke = () =>
      spawnSync(command.executable, command.args, {
        cwd: root,
        env: { ...process.env, ...command.env },
        encoding: "utf8",
        timeout: 30000,
      });
    await writeFile(
      path.join(root, "checkstyle.xml"),
      checkstyleXml + "<!-- changed -->",
    );
    const changed = invoke();
    assert.equal(changed.status, 2);
    assert.equal(changed.stdout, "");
    assert.equal(
      changed.stderr,
      "Checkstyle evidence collection could not complete\n",
    );
    await writeFile(path.join(root, "checkstyle.xml"), checkstyleXml);
    const jar = path.join(root, checkstyleConfig.jar),
      saved = await readFile(jar);
    await writeFile(
      jar,
      Buffer.concat([
        saved.subarray(0, saved.length - 1),
        Buffer.from([saved.at(-1)! ^ 1]),
      ]),
    );
    assert.ok((await createPlan(root)).plan.checks[0]!.unavailableReason);
    assert.equal(invoke().status, 2);
    await writeFile(jar, saved);
    await symlink(jar, path.join(root, ".checktrail/alias.jar"));
    await writeFile(
      path.join(root, "checktrail.checkstyle.json"),
      JSON.stringify({ ...checkstyleConfig, jar: ".checktrail/alias.jar" }),
    );
    assert.match(
      (await createPlan(root)).plan.checks[0]!.unavailableReason!,
      /symbolic links/,
    );
    await writeFile(
      path.join(root, "checktrail.checkstyle.json"),
      JSON.stringify(checkstyleConfig),
    );
    await writeFile(
      path.join(root, "checkstyle.xml"),
      Buffer.concat([Buffer.from(checkstyleXml), Buffer.from([255])]),
    );
    assert.ok((await createPlan(root)).plan.checks[0]!.unavailableReason);
    await writeFile(path.join(root, "checkstyle.xml"), checkstyleXml);
    await writeFile(
      path.join(root, "First.java"),
      Buffer.concat([
        Buffer.from("// "),
        Buffer.from([255]),
        Buffer.from("\nclass First {}\n"),
      ]),
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "incomplete");
    assert.equal(report.checks[0]!.findingsComplete, false);
    await writeFile(path.join(root, "First.java"), goodJava);
    const emptyPath = path.join(root, ".checktrail/empty-bin");
    await mkdir(emptyPath);
    const missing = spawnSync(command.executable, command.args, {
      cwd: root,
      env: { ...command.env, PATH: emptyPath },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(missing.status, 3);
    assert.deepEqual(JSON.parse(missing.stdout), {
      unavailable: "checkstyle-toolchain",
    });
    const original = process.env.JAVA_TOOL_OPTIONS;
    try {
      process.env.JAVA_TOOL_OPTIONS = "-javaagent:missing.jar";
      report = await validate(root, { trusted: true });
      assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    } finally {
      if (original === undefined) delete process.env.JAVA_TOOL_OPTIONS;
      else process.env.JAVA_TOOL_OPTIONS = original;
    }
  },
);

test(
  "native Checkstyle cancellation kills its active JVM and removes the engine-owned temporary artifacts",
  nativeOptions,
  async (t) => {
    const root = await checkstyleFixture(t, {
      "checkstyle.xml":
        '<module name="Checker"><module name="RegexpSingleline"><property name="format" value="(a+)+$"/></module></module>',
      "First.java": "// " + "a".repeat(2_000_000) + "!\n",
    });
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
              if (!child.startsWith("checktrail-checkstyle-")) continue;
              const text = await readFile(
                path.join(candidate, child, "inputs.txt"),
                "utf8",
              );
              if (
                text
                  .split("\n")
                  .slice(1)
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
              cmd.includes("VerifierCheckstyle.java")
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
