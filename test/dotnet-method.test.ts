import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createPlan, validate } from "../src/engine.js";
import {
  dotnetTestEvidence,
  dotnetTestPacketSchema,
} from "../src/dotnet-test-evidence.js";
import { dotnetNunitSettings } from "../src/dotnet-nunit.js";
import { mavenHash } from "../src/maven.js";
import { dotnetMethodFixture } from "./dotnet-method-fixture.js";
import type { CheckResult } from "../src/types.js";
const available =
    !!process.env.CHECKTRAIL_DOTNET_BUILD_CACHE &&
    spawnSync("dotnet", ["--list-sdks"], { encoding: "utf8" }).stdout?.includes(
      "10.0.401 [",
    ),
  native = {
    skip: available
      ? false
      : "Pinned native .NET SDK/dependency cache not selected",
    timeout: 240000,
  };
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
const expect = (r: CheckResult, status: string) =>
  assert.equal(
    r.status,
    status,
    JSON.stringify({
      status: r.status,
      reason: r.reason,
      stderr: r.processes.map((p) => p.stderr.slice(0, 512)),
    }),
  );
test("NUnit owned settings escape data and select complete native discovery without a result dump", () => {
  const s = dotnetNunitSettings("/owned/path with spaces & <boundary>");
  assert.ok(
    s.includes(
      "<TestOutputXml>/owned/path with spaces &amp; &lt;boundary&gt;</TestOutputXml>",
    ),
  );
  assert.ok(s.includes("<DumpXmlTestDiscovery>true</DumpXmlTestDiscovery>"));
  assert.ok(s.includes("<DumpXmlTestResults>false</DumpXmlTestResults>"));
  assert.ok(s.includes("<SkipNonTestAssemblies>false</SkipNonTestAssemblies>"));
});
test(
  "native NUnit method provenance reconciles C#/F#/VB custom names escaped literals broken boundaries and repair",
  native,
  async (t) => {
    const { root } = await dotnetMethodFixture(t),
      initial = (await run(root)).checks[0]!;
    expect(initial, "passed");
    assert.deepEqual(initial.tests, {
      total: 6,
      passed: 6,
      failed: 0,
      skipped: 0,
    });
    assert.equal(initial.findingsComplete, true);
    const baseline = dotnetTestPacketSchema.parse(
      JSON.parse(initial.processes[0]!.stdout),
    );
    assert.equal(baseline.runs.length, 3);
    assert.ok(
      baseline.runs.every(
        (r) =>
          r.nunit?.discovery?.text.includes("methodname=") &&
          r.nunit?.execution?.text.includes("methodname="),
      ),
    );
    const file = path.join(root, "CSharp/Counter.cs"),
      original = await readFile(file, "utf8");
    assert.equal(original.split("value + 1").length, 2);
    try {
      await writeFile(
        file,
        original.replace("value + 1", "value < 0 ? value : value + 1"),
      );
      const broken = (await run(root)).checks[0]!;
      expect(broken, "failed");
      assert.deepEqual(broken.tests, {
        total: 6,
        passed: 5,
        failed: 1,
        skipped: 0,
      });
      assert.deepEqual(
        broken.findings
          ?.filter((f) => f.ruleId === "dotnet-test/case-failure")
          .map((f) => f.file),
        ["CSharpTests/CounterTests.cs"],
      );
      const check = (await createPlan(root)).plan.checks[0]!,
        process = broken.processes[0]!,
        partial = dotnetTestPacketSchema.parse(JSON.parse(process.stdout));
      partial.runs[0]!.nunit!.execution = null;
      const retained = dotnetTestEvidence(check, [
        { ...process, stdout: JSON.stringify(partial) },
      ]);
      assert.equal(
        retained.status,
        "failed",
        "A later missing native NUnit result cannot erase a validated source-bound failure",
      );
      assert.equal(retained.findingsComplete, false);
      assert.ok(
        retained.findings?.some(
          (f) =>
            f.ruleId === "dotnet-test/case-failure" &&
            f.file === "CSharpTests/CounterTests.cs",
        ),
      );
    } finally {
      await writeFile(file, original);
    }
    expect((await run(root)).checks[0]!, "passed");
  },
);
test(
  "native NUnit method evidence rejects missing forged stale duplicate hidden and mismatched XML and settings",
  native,
  async (t) => {
    const { root } = await dotnetMethodFixture(t),
      check = (await createPlan(root)).plan.checks[0]!,
      result = (await run(root)).checks[0]!;
    expect(result, "passed");
    const process = result.processes[0]!,
      baseline = dotnetTestPacketSchema.parse(JSON.parse(process.stdout));
    type Packet = typeof baseline;
    const controls: Array<[string, (d: Packet) => void]> = [];
    const add = (name: string, change: (d: Packet) => void) =>
        controls.push([name, change]),
      xml = (
        d: Packet,
        phase: "discovery" | "execution",
        change: (s: string) => string,
      ) => {
        const p = d.runs[0]!.nunit![phase]!;
        p.text = change(p.text);
        p.sha256 = mavenHash(p.text);
      };
    add("missing method provenance", (d) => {
      d.runs[0]!.nunit = null;
    });
    add("missing native discovery", (d) => {
      d.runs[0]!.nunit!.discovery = null;
    });
    add("missing native result", (d) => {
      d.runs[0]!.nunit!.execution = null;
    });
    add("foreign settings", (d) => {
      d.runs[0]!.nunit!.settingsSha256 = "0".repeat(64);
    });
    add("foreign owned settings path", (d) => {
      d.runs[0]!.nunit!.settingsFile = "/foreign/settings";
    });
    add("foreign discovery path", (d) => {
      d.runs[0]!.nunit!.discovery!.file = "/foreign/discovery";
    });
    add("foreign result path", (d) => {
      d.runs[0]!.nunit!.execution!.file = "/foreign/result";
    });
    add("foreign XML bytes", (d) => {
      d.runs[0]!.nunit!.discovery!.sha256 = "0".repeat(64);
    });
    add("missing native method", (d) =>
      xml(d, "discovery", (s) =>
        s.replace("methodname='Scale'", "methodname='OriginalMissing'"),
      ),
    );
    add("unbound method in both native phases", (d) => {
      for (const phase of ["discovery", "execution"] as const)
        xml(d, phase, (s) =>
          s.replace(
            /methodname=(['"])Scale\1/g,
            'methodname="OriginalMissing"',
          ),
        );
    });
    add("foreign class in both native phases", (d) => {
      for (const phase of ["discovery", "execution"] as const)
        xml(d, phase, (s) =>
          s.replace(
            /classname=(['"])Example\.CounterTests\1/g,
            'classname="Example.OtherTests"',
          ),
        );
    });
    add("foreign native class", (d) =>
      xml(d, "discovery", (s) =>
        s.replace(
          "methodname='Scale' classname='Example.CounterTests'",
          "methodname='Scale' classname='Example.OtherTests'",
        ),
      ),
    );
    add("wrong native working directory", (d) =>
      xml(d, "discovery", (s) => s.replace(/cwd='[^']*'/, "cwd='/foreign'")),
    );
    add("wrong native worker policy", (d) =>
      xml(d, "discovery", (s) =>
        s.replace(
          "name='NumberOfTestWorkers' value='0'",
          "name='NumberOfTestWorkers' value='2'",
        ),
      ),
    );
    add("wrong native runtime", (d) =>
      xml(d, "discovery", (s) =>
        s.replace("clr-version='10.0.12'", "clr-version='9.0.0'"),
      ),
    );
    add("zero native host PID", (d) =>
      xml(d, "discovery", (s) =>
        s.replace(/name='_PID' value='\d+'/, "name='_PID' value='0'"),
      ),
    );
    add("missing native leaf", (d) =>
      xml(d, "discovery", (s) => s.replace(/<test-case\s[^>]*\/>(\s*)/, "$1")),
    );
    add("duplicate native leaf", (d) =>
      xml(d, "discovery", (s) => s.replace(/(<test-case\s[^>]*\/>)/, "$1$1")),
    );
    add("wrong native suite count", (d) =>
      xml(d, "discovery", (s) =>
        s.replace("testcasecount='2'", "testcasecount='1'"),
      ),
    );
    add("hidden native case", (d) =>
      xml(d, "discovery", (s) =>
        s.replace(
          "</test-run>",
          "<OriginalHidden><test-case id='hidden' name='Hidden' fullname='Example.CounterTests.Hidden' methodname='Scale' classname='Example.CounterTests' runstate='Runnable'/></OriginalHidden></test-run>",
        ),
      ),
    );
    add("hidden native leaf", (d) =>
      xml(d, "discovery", (s) =>
        s.replace(
          /(<test-case\s[^>]*)(\/>)/,
          "$1><OriginalHidden><test-case id='hidden' name='Hidden' fullname='Example.CounterTests.Hidden' methodname='Scale' classname='Example.CounterTests' runstate='Runnable'/></OriginalHidden></test-case>",
        ),
      ),
    );
    add("foreign native launcher", (d) =>
      xml(d, "execution", (s) =>
        s.replace(/ --parentprocessid \d+ /, " --parentprocessid 1 "),
      ),
    );
    add("malformed discovery", (d) =>
      xml(d, "discovery", (s) => s.slice(0, -12)),
    );
    add("foreign result suite identity", (d) =>
      xml(d, "execution", (s) =>
        s.replace(
          'fullname="Example.CounterTests.Scale"',
          'fullname="Example.CounterTests.OriginalMissing"',
        ),
      ),
    );
    add("foreign result method", (d) =>
      xml(d, "execution", (s) =>
        s.replace('methodname="Scale"', 'methodname="OriginalMissing"'),
      ),
    );
    add("wrong native result count", (d) =>
      xml(d, "execution", (s) => s.replace('passed="2"', 'passed="1"')),
    );
    add("malformed result", (d) => xml(d, "execution", (s) => s.slice(0, -12)));
    for (const [name, change] of controls) {
      const d = structuredClone(baseline);
      change(d);
      assert.notDeepEqual(
        d,
        baseline,
        "Control must change native evidence: " + name,
      );
      const parsed = dotnetTestEvidence(check, [
        { ...process, stdout: JSON.stringify(d) },
      ]);
      assert.equal(parsed.status, "inconclusive", name);
      assert.equal(parsed.findingsComplete, false, name);
    }
    assert.equal(dotnetTestEvidence(check, [process]).status, "passed");
  },
);
test(
  "native NUnit duplicate custom full names remain ambiguous without assigning a guessed method",
  native,
  async (t) => {
    const { root } = await dotnetMethodFixture(t),
      file = path.join(root, "CSharpTests/CounterTests.cs"),
      source = await readFile(file, "utf8");
    assert.equal(source.split("[TestCase(2)]").length, 2);
    await writeFile(
      file,
      source.replace(
        "[TestCase(2)]",
        '[TestCase(2, TestName="Original C# minus one <boundary>")]',
      ),
    );
    const duplicate = (await run(root)).checks[0]!;
    assert.notEqual(duplicate.status, "passed");
    assert.equal(duplicate.findingsComplete, false);
    await writeFile(file, source);
    expect((await run(root)).checks[0]!, "passed");
    const anchor =
      "public void Scale(int value) => Assert.That(Counter.Next(value), Is.EqualTo(value + 1));";
    assert.equal(source.split(anchor).length, 2);
    try {
      await writeFile(
        file,
        source.replace(
          anchor,
          anchor +
            '\n[TestCase(3.5, TestName="Original fraction")] public void Scale(double value) => Assert.That(value, Is.GreaterThan(0));',
        ),
      );
      const overloaded = (await run(root)).checks[0]!;
      assert.equal(
        overloaded.status,
        "inconclusive",
        "Overloaded native method names cannot select a source signature by guessing",
      );
      assert.equal(overloaded.findingsComplete, false);
    } finally {
      await writeFile(file, source);
    }
    expect((await run(root)).checks[0]!, "passed");
  },
);

test(
  "native NUnit custom-name parent fixture skips and setup failures retain promoted case counts source addresses and repair",
  native,
  async (t) => {
    const { root } = await dotnetMethodFixture(t),
      file = path.join(root, "CSharpTests/CounterTests.cs"),
      original = await readFile(file, "utf8");
    const anchor = "public class CounterTests\n{";
    assert.equal(original.split(anchor).length, 2);
    try {
      for (const mode of ["ignored", "setup"] as const) {
        await writeFile(
          file,
          original.replace(
            anchor,
            mode === "ignored"
              ? '[Ignore("Original skipped fixture")] public class CounterTests\n{'
              : anchor +
                  '\n[OneTimeSetUp] public void Prepare() => throw new System.InvalidOperationException("Original fixture setup failure");',
          ),
        );
        const check = (await createPlan(root)).plan.checks[0]!,
          result = (await run(root)).checks[0]!;
        expect(result, mode === "ignored" ? "inconclusive" : "failed");
        assert.deepEqual(result.tests, {
          total: 6,
          passed: 4,
          failed: mode === "setup" ? 2 : 0,
          skipped: mode === "ignored" ? 2 : 0,
        });
        if (mode === "setup")
          assert.deepEqual(
            result.findings
              ?.filter((f) => f.ruleId === "dotnet-test/case-failure")
              .map((f) => f.file),
            ["CSharpTests/CounterTests.cs", "CSharpTests/CounterTests.cs"],
          );
        const process = result.processes[0]!,
          baseline = dotnetTestPacketSchema.parse(JSON.parse(process.stdout));
        for (const [name, change] of [
          [
            "nonzero native placeholder execution count",
            (s: string) =>
              s.replace(
                /(<test-suite type="ParameterizedMethod"[^>]*total=")0"/,
                '$11"',
              ),
          ],
          [
            "foreign native promoted case site",
            (s: string) =>
              s.replace(/(<test-case[^>]*site=")Parent"/, '$1Child"'),
          ],
          [
            "foreign native placeholder case count",
            (s: string) =>
              s.replace(
                /(<test-suite type="ParameterizedMethod"[^>]*testcasecount=")2"/,
                '$11"',
              ),
          ],
        ] as const) {
          const data = structuredClone(baseline),
            artifact = data.runs[0]!.nunit!.execution!;
          artifact.text = change(artifact.text);
          artifact.sha256 = mavenHash(artifact.text);
          assert.notDeepEqual(data, baseline, name);
          const changed = dotnetTestEvidence(check, [
            { ...process, stdout: JSON.stringify(data) },
          ]);
          assert.equal(changed.findingsComplete, false, name);
          assert.equal(changed.tests, undefined, name);
          assert.equal(
            changed.status,
            mode === "setup" ? "failed" : "inconclusive",
            name,
          );
        }
      }
    } finally {
      await writeFile(file, original);
    }
    expect((await run(root)).checks[0]!, "passed");
  },
);
