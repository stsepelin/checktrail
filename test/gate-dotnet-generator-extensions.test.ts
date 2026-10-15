import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { projectReport } from "../src/output.js";
import { runProcess } from "../src/runner.js";
import { dotnetGeneratorExtensionsEvidence } from "../src/dotnet-generator-extensions-evidence.js";
import { createPlan, validate } from "../src/engine.js";
import { dotnetGeneratorExtensionsPacketSchema } from "../src/dotnet-generator-extensions-evidence.js";
import { native } from "./dotnet-test-controls.js";
import {
  dotnetGeneratorMethodFixture,
  dotnetGeneratorCrossAssemblyFixture,
  rewriteDotnetGeneratorNative,
  rewriteDotnetGeneratorPacket,
} from "./dotnet-generator-extensions-fixture.js";
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
function expect(report: Awaited<ReturnType<typeof run>>, status: string) {
  const c = report.checks[0]!;
  assert.equal(
    c.status,
    status,
    JSON.stringify({
      reason: c.reason,
      findings: c.findings?.map((f) => ({
        rule: f.ruleId,
        file: f.file,
        message: f.message.slice(0, 1000),
      })),
      processes: c.processes.map((p) => ({
        exit: p.exitCode,
        stderr: p.stderr.slice(-800),
        truncated: p.truncated,
        timedOut: p.timedOut,
      })),
    }),
  );
  assert.equal(c.findingsComplete, true);
  assert.equal(report.sourceChanged, false);
  assert.equal(report.sourceFingerprint, report.finalSourceFingerprint);
  return c;
}
const broken = (text: string) => {
  assert.equal(text.split("GeneratedCounter.Advance(value)").length, 2);
  return text.replace(
    "GeneratedCounter.Advance(value)",
    "GeneratedCounter.Advance(value) + 1",
  );
};
test("dotnet-generator-extensions broken acceptance", native, async (t) => {
  const { root } = await dotnetGeneratorMethodFixture(t),
    file = path.join(root, "CSharp/Counter.cs"),
    source = await readFile(file, "utf8");
  await writeFile(file, broken(source));
  const report = await run(root),
    check = expect(report, "failed");
  assert.equal(report.outcome, "failed");
  assert.deepEqual(check.tests, {
    total: 15,
    passed: 11,
    failed: 4,
    skipped: 0,
  });
  const failures = check.findings!.filter(
    (f) => f.ruleId === "dotnet-test/case-failure",
  );
  assert.equal(failures.length, 4);
  assert.equal(
    failures.filter((f) => f.file === "CSharpTests/BaseCases.cs").length,
    1,
  );
  assert.equal(
    failures.filter((f) => f.file === "CSharpTests/CounterTests.cs").length,
    3,
  );
});
test("dotnet-generator-extensions fixed acceptance", native, async (t) => {
  const { root } = await dotnetGeneratorMethodFixture(t),
    file = path.join(root, "CSharp/Counter.cs"),
    source = await readFile(file, "utf8");
  await writeFile(file, broken(source));
  try {
    assert.equal(expect(await run(root), "failed").tests!.failed, 4);
  } finally {
    await writeFile(file, source);
  }
  const repaired = expect(await run(root), "passed");
  assert.deepEqual(repaired.tests, {
    total: 15,
    passed: 15,
    failed: 0,
    skipped: 0,
  });
  assert.equal(
    repaired.findings!.filter((f) => f.ruleId === "dotnet-test/case-failure")
      .length,
    0,
  );
});
test("dotnet-generator-extensions near-miss acceptance", native, async (t) => {
  const { root } = await dotnetGeneratorMethodFixture(t),
    check = expect(await run(root), "passed");
  assert.deepEqual(check.tests, {
    total: 15,
    passed: 15,
    failed: 0,
    skipped: 0,
  });
  const packet = dotnetGeneratorExtensionsPacketSchema.parse(
    JSON.parse(check.processes[0]!.stdout),
  );
  assert.equal(packet.generatorIdentity!.discovery.length, 3);
  for (const capture of packet.generatorIdentity!.discovery) {
    const n = capture.native;
    assert.equal(n.mode, "discovery");
    if (n.mode !== "discovery") throw Error("Native discovery required");
    assert.equal(n.observation.count, 5);
    const overloads = n.observation.cases.filter(
      (c) => c.methodName === "Boundary",
    );
    assert.equal(overloads.length, 2);
    assert.notEqual(overloads[0]!.methodToken, overloads[1]!.methodToken);
    assert.deepEqual(
      new Set(overloads.flatMap((c) => c.parameterTypes)),
      new Set(["System.Int32", "System.String"]),
    );
    const parameters = n.observation.cases.filter(
      (c) => c.methodName === "Scale",
    );
    assert.equal(parameters.length, 2);
    assert.equal(parameters[0]!.methodToken, parameters[1]!.methodToken);
    assert.notDeepEqual(parameters[0]!.arguments, parameters[1]!.arguments);
    const inherited = n.observation.cases.filter(
      (c) => c.methodName === "Inherited",
    );
    assert.equal(inherited.length, 1);
    assert.equal(inherited[0]!.declaringType, "Example.BaseCases");
    assert.equal(inherited[0]!.fixtureType, "Example.CounterTests");
    assert.deepEqual(
      inherited[0]!.baseChain.map((b) => b.className),
      ["Example.CounterTests", "Example.BaseCases"],
    );
  }

  const cross = (await dotnetGeneratorCrossAssemblyFixture(t)).root,
    crossReport = await run(cross),
    crossCheck = expect(crossReport, "passed");
  assert.deepEqual(crossCheck.tests, {
    total: 15,
    passed: 15,
    failed: 0,
    skipped: 0,
  });
  const crossPacket = dotnetGeneratorExtensionsPacketSchema.parse(
    JSON.parse(crossCheck.processes[0]!.stdout),
  );
  for (const capture of crossPacket.generatorIdentity!.discovery) {
    const n = capture.native;
    if (n.mode !== "discovery") throw Error("Discovery required");
    const inherited = n.observation.cases.find(
      (c) => c.methodName === "Inherited",
    )!;
    assert.notEqual(inherited.methodMvid, inherited.fixtureMvid);
    assert.notEqual(inherited.methodAssembly, inherited.fixtureAssembly);
    assert.equal(inherited.baseChain.length, 2);
  }
  const file = path.join(cross, "CSharp/Counter.cs");
  await writeFile(file, broken(await readFile(file, "utf8")));
  const crossFailed = expect(await run(cross), "failed");
  assert.equal(crossFailed.tests!.failed, 4);
  assert.equal(
    crossFailed.findings!.filter(
      (f) =>
        f.ruleId === "dotnet-test/case-failure" &&
        f.file === "CSharp/BaseCases.cs",
    ).length,
    1,
  );
});

test(
  "dotnet-generator-extensions prerequisite acceptance",
  native,
  async (t) => {
    const { root, policy } = await dotnetGeneratorMethodFixture(t),
      file = path.join(root, "checktrail.dotnet-generator.json"),
      original = await readFile(file);
    try {
      for (const config of [
        { ...policy, trusted: true },
        { ...policy, profile: policy.profile + "-adjacent" },
        {
          ...policy,
          projectReferences: policy.projectReferences.filter(
            (r) => r.kind !== "analyzer",
          ),
        },
        {
          ...policy,
          incrementalGenerators: [
            {
              ...policy.incrementalGenerators[0]!,
              className: "Example.OriginalGeneratorAdjacent",
            },
          ],
        },
        {
          ...policy,
          projectReferences: [
            ...policy.projectReferences,
            {
              consumer: "CSharp/CSharp.csproj",
              producer: "CSharpTests/CSharpTests.csproj",
              kind: "assembly",
            },
          ],
        },
      ]) {
        await writeFile(file, JSON.stringify(config));
        const check = (await createPlan(root)).plan.checks[0]!;
        assert.equal(check.commands.length, 0);
        assert.match(
          check.unavailableReason!,
          /Prepare the bounded native generator\/method policy/,
        );
      }
    } finally {
      await writeFile(file, original);
    }
    const fake = await mkdtemp(path.join(tmpdir(), "original-generator-sdk-")),
      marker = path.join(fake, "executed"),
      previous = process.env.PATH;
    try {
      await writeFile(
        path.join(fake, "dotnet"),
        `#!/bin/sh\n: > '${marker}'\nprintf '10.0.401\\n'\n`,
        { mode: 0o755 },
      );
      process.env.PATH = fake;
      assert.equal((await createPlan(root)).plan.checks[0]!.commands.length, 0);
      await assert.rejects(access(marker), { code: "ENOENT" });
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
      await rm(fake, { recursive: true, force: true });
    }
    assert.equal((await createPlan(root)).plan.checks[0]!.commands.length, 1);
  },
);
test("dotnet-generator-extensions stale acceptance", native, async (t) => {
  const { root } = await dotnetGeneratorMethodFixture(t),
    report = await run(root);
  expect(report, "passed");
  const check = (await createPlan(root)).plan.checks[0]!,
    process = report.checks[0]!.processes[0]!;
  for (const file of [
    "CSharp/Counter.cs",
    "CSharpTests/BaseCases.cs",
    "Generator/OriginalGenerator.cs",
    "CSharpTests/CSharpTests.csproj",
    "CSharpTests/packages.lock.json",
    "checktrail.dotnet-generator.json",
    ".checktrail/dependencies/repository.json",
  ]) {
    const target = path.join(root, file),
      original = await readFile(target);
    try {
      await writeFile(target, Buffer.concat([original, Buffer.from("\n")]));
      assert.equal(
        dotnetGeneratorExtensionsEvidence(check, [process], root)
          .findingsComplete,
        false,
        file,
      );
    } finally {
      await writeFile(target, original);
    }
    assert.equal(
      dotnetGeneratorExtensionsEvidence(check, [process], root).status,
      "passed",
      file,
    );
  }
  const extra = path.join(
    root,
    ".checktrail/dependencies/artifacts/original-unlisted.txt",
  );
  try {
    await writeFile(extra, "Original unlisted dependency");
    assert.equal(
      dotnetGeneratorExtensionsEvidence(check, [process], root)
        .findingsComplete,
      false,
    );
  } finally {
    await rm(extra, { force: true });
  }
  const failedRoot = (await dotnetGeneratorMethodFixture(t)).root,
    producer = path.join(failedRoot, "CSharp/Counter.cs"),
    source = await readFile(producer, "utf8");
  await writeFile(
    producer,
    source.replace(
      "GeneratedCounter.Advance(value)",
      '"original wrong native return type"',
    ),
  );
  const failedCheck = (await createPlan(failedRoot)).plan.checks[0]!,
    failedReport = await run(failedRoot);
  assert.equal(failedReport.checks[0]!.status, "failed");
  assert.ok(
    failedReport.checks[0]!.findings!.some(
      (f) =>
        f.ruleId === "dotnet-build/CS0029" && f.file === "CSharp/Counter.cs",
    ),
  );
  await writeFile(producer, source);
  assert.equal(
    dotnetGeneratorExtensionsEvidence(
      failedCheck,
      failedReport.checks[0]!.processes,
      failedRoot,
    ).findingsComplete,
    false,
  );
  for (const field of [
    "observerSourceSha256",
    "observerSha256",
    "runtimeconfigSha256",
  ] as const) {
    assert.equal(
      dotnetGeneratorExtensionsEvidence(
        check,
        [
          rewriteDotnetGeneratorPacket(process, (p) => {
            p.generatorIdentity![field] = "0".repeat(64);
          }),
        ],
        root,
      ).findingsComplete,
      false,
      field,
    );
  }
  for (const mutate of [
    (p: ReturnType<typeof dotnetGeneratorExtensionsPacketSchema.parse>) => {
      p.generatorIdentity!.discovery[0]!.stdout += " ";
    },
    (p: ReturnType<typeof dotnetGeneratorExtensionsPacketSchema.parse>) => {
      p.generatorIdentity!.discovery[0]!.launcherPid++;
    },
    (p: ReturnType<typeof dotnetGeneratorExtensionsPacketSchema.parse>) => {
      p.nativeReceipts.at(-1)!.phase += "-adjacent";
    },
  ])
    assert.equal(
      dotnetGeneratorExtensionsEvidence(
        check,
        [rewriteDotnetGeneratorPacket(process, mutate)],
        root,
      ).findingsComplete,
      false,
    );
});
test("dotnet-generator-extensions empty acceptance", native, async (t) => {
  const { root } = await dotnetGeneratorMethodFixture(t),
    report = await run(root);
  expect(report, "passed");
  const check = (await createPlan(root)).plan.checks[0]!,
    process = report.checks[0]!.processes[0]!;
  for (const text of ["", "{}", "[]", process.stdout.slice(0, -1)])
    assert.equal(
      dotnetGeneratorExtensionsEvidence(
        check,
        [{ ...process, stdout: text }],
        root,
      ).findingsComplete,
      false,
    );
  assert.equal(
    dotnetGeneratorExtensionsEvidence(check, [], root).findingsComplete,
    false,
  );
  for (const flag of ["cancelled", "timedOut", "truncated"] as const)
    assert.equal(
      dotnetGeneratorExtensionsEvidence(
        check,
        [{ ...process, [flag]: true }],
        root,
      ).findingsComplete,
      false,
      flag,
    );
  type Identity = NonNullable<
    ReturnType<
      typeof dotnetGeneratorExtensionsPacketSchema.parse
    >["generatorIdentity"]
  >;
  const first = (i: Identity) => {
    const n = i.discovery[0]!.native;
    assert.equal(n.mode, "discovery");
    if (n.mode !== "discovery") throw Error("Discovery required");
    return n;
  };
  const metadata = (i: Identity) => {
    const n = i.metadata[0]!.native;
    assert.equal(n.mode, "metadata");
    if (n.mode !== "metadata") throw Error("Metadata required");
    return n;
  };
  const corrupt: Array<(i: Identity) => void> = [
    (i) => {
      i.metadata.pop();
    },
    (i) => {
      i.discovery.pop();
    },
    (i) => {
      first(i).observation.count++;
    },
    (i) => {
      first(i).observation.cases.pop();
    },
    (i) => {
      first(i).observation.cases.push(
        structuredClone(first(i).observation.cases[0]!),
      );
      first(i).observation.count++;
    },
    (i) => {
      first(i).processId++;
    },
    (i) => {
      first(i).arguments[1] += ".adjacent";
    },
    (i) => {
      first(i).assembly.sha256 = "0".repeat(64);
    },
    (i) => {
      first(i).pdb.sha256 = "0".repeat(64);
    },
    (i) => {
      first(i).helper.sha256 = "0".repeat(64);
    },
    (i) => {
      first(i).framework.sha256 = "0".repeat(64);
    },
    (i) => {
      first(i).modules[0]!.artifact.sha256 = "0".repeat(64);
    },
    (i) => {
      first(i).observation.cases[0]!.methodMvid =
        "00000000-0000-0000-0000-000000000000";
    },
    (i) => {
      first(i).observation.cases[0]!.fixtureMvid =
        "00000000-0000-0000-0000-000000000000";
    },
    (i) => {
      first(i).observation.cases[0]!.baseChain.pop();
    },
    (i) => {
      first(i).observation.cases[0]!.methodAssembly += ".adjacent";
    },
    (i) => {
      first(i).observation.cases[0]!.methodName += "Adjacent";
    },
    (i) => {
      first(i).observation.cases[0]!.methodSignature = "01";
    },
    (i) => {
      first(i).observation.cases[0]!.returnSignature = "System.String";
    },
    (i) => {
      first(i).observation.cases[0]!.parameterSignatures[0] = "System.String";
    },
    (i) => {
      first(i).observation.cases[0]!.arguments = [];
    },
    (i) => {
      const cases = first(i).observation.cases.filter(
        (c) => c.methodName === "Boundary",
      );
      assert.equal(cases.length, 2);
      cases[0]!.methodToken = cases[1]!.methodToken;
    },
    (i) => {
      const cases = first(i).observation.cases.filter(
        (c) => c.methodName === "Boundary",
      );
      assert.equal(cases.length, 2);
      cases[0]!.methodToken = cases[1]!.methodToken;
      cases[0]!.methodSignature = cases[1]!.methodSignature;
    },
    (i) => {
      metadata(i).observation.documents.pop();
    },
    (i) => {
      const n = i.metadata.find((c) =>
        c.native.assembly.file.includes("/CSharpTests/"),
      )!.native;
      if (n.mode !== "metadata") throw Error("Metadata required");
      const type = n.observation.types.find(
          (t) => t.className === "Example.BaseCases",
        )!,
        method = type.methods.find((m) => m.name === "Inherited")!,
        file = n.observation.documents.find((d) =>
          d.file.endsWith("/CounterTests.cs"),
        )!.file;
      method.files = [file];
      for (const point of method.points)
        if (point.file !== null) point.file = file;
    },
    (i) => {
      const n = i.metadata.find((c) =>
        c.native.assembly.file.includes("/CSharpTests/"),
      )!.native;
      if (n.mode !== "metadata") throw Error("Metadata required");
      const method = n.observation.types
          .find((t) => t.className === "Example.BaseCases")!
          .methods.find((m) => m.name === "Inherited")!,
        file = n.observation.documents.find((d) =>
          d.file.endsWith("/CounterTests.cs"),
        )!.file;
      const point = method.points.find((p) => p.file !== null)!;
      assert.ok(point);
      point.file = file;
    },

    (i) => {
      const n = i.metadata.find((c) =>
        c.native.assembly.file.includes("/CSharpTests/"),
      )!.native;
      if (n.mode !== "metadata") throw Error("Metadata required");
      n.observation.mvid = "00000000-0000-0000-0000-000000000000";
    },
  ];
  for (const [index, mutate] of corrupt.entries())
    assert.equal(
      dotnetGeneratorExtensionsEvidence(
        check,
        [rewriteDotnetGeneratorNative(process, mutate)],
        root,
      ).findingsComplete,
      false,
      "coherently rehashed identity corruption " + index,
    );
  const missingEdge = rewriteDotnetGeneratorPacket(process, (p) => {
    const compiler = p.build.events.find(
        (e) =>
          e.type === "compilerStarted" &&
          String(e.file).endsWith("/CSharpTests/CSharpTests.csproj"),
      )!,
      row = p.build.events.find(
        (e) =>
          e.type === "parameter" &&
          e.name === "References" &&
          JSON.stringify(e.context) === JSON.stringify(compiler.context),
      )!;
    const values = row.values as string[],
      removed = values.filter((v) => v.endsWith("/Original.CSharp.dll"));
    assert.equal(removed.length, 1);
    row.values = values.filter((v) => !removed.includes(v));
  });
  assert.equal(
    dotnetGeneratorExtensionsEvidence(check, [missingEdge], root)
      .findingsComplete,
    false,
    "coherently omitted native project reference",
  );
  const skippedRoot = (await dotnetGeneratorMethodFixture(t)).root,
    source = path.join(skippedRoot, "CSharpTests/CounterTests.cs"),
    text = await readFile(source, "utf8");
  await writeFile(
    source,
    text.replace(
      "[TestCase(-1)]",
      '[TestCase(-1, Ignore="Original skipped method")]',
    ),
  );
  const skipped = (await run(skippedRoot)).checks[0]!;
  assert.equal(skipped.status, "inconclusive");
  assert.equal(skipped.findingsComplete, false);
  assert.deepEqual(skipped.tests, {
    total: 15,
    passed: 14,
    failed: 0,
    skipped: 1,
  });
  await writeFile(source, text);
  for (const [file, anchor, ignored] of [
    [
      "CSharpTests/CounterTests.cs",
      "[TestFixture]",
      '[TestFixture, Ignore("Original all-skipped fixture")]',
    ],
    [
      "FSharpTests/CounterTests.fs",
      "[<TestFixture>]",
      '[<TestFixture; Ignore("Original all-skipped fixture")>]',
    ],
    [
      "VisualBasicTests/CounterTests.vb",
      "<TestFixture>",
      '<TestFixture, Ignore("Original all-skipped fixture")>',
    ],
  ]) {
    const target = path.join(skippedRoot, file!),
      content = await readFile(target, "utf8");
    assert.equal(content.split(anchor!).length, 2);
    await writeFile(target, content.replace(anchor!, ignored!));
  }
  const allSkipped = (await run(skippedRoot)).checks[0]!;
  assert.equal(allSkipped.status, "inconclusive");
  assert.equal(allSkipped.findingsComplete, false);
  assert.deepEqual(allSkipped.tests, {
    total: 15,
    passed: 0,
    failed: 0,
    skipped: 15,
  });
});
test(
  "dotnet-generator-extensions lifecycle acceptance",
  { ...native, timeout: 300000 },
  async (t) => {
    for (const mode of ["cancel", "timeout", "output"] as const) {
      const { root } = await dotnetGeneratorMethodFixture(t),
        marker = path.join(root, ".checktrail/started"),
        control = path.join(root, "original-wait.cjs");
      await writeFile(
        control,
        `const fs=require('node:fs');let pid=process.pid,client=0,host=0;for(let count=0;count<32&&pid>1;count++){const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0');if(args.some(a=>a.endsWith('/testhost.dll')))host=pid;if(args.includes('/usr/share/dotnet/sdk/10.0.401/vstest.console.dll')){client=pid;break}const parent=/^PPid:\\s+(\\d+)$/m.exec(fs.readFileSync('/proc/'+pid+'/status','utf8'));if(!parent)break;pid=Number(parent[1])}const marker=process.env.CHECKTRAIL_DOTNET_STARTED;fs.writeFileSync(marker+'.prepared',JSON.stringify({pid:process.pid,client,host,owned:client>1&&host>1,scratch:process.env.TMPDIR,owner:process.env.CHECKTRAIL_TEMP}));fs.renameSync(marker+'.prepared',marker);setTimeout(()=>{},${mode === "output" ? 100 : 60000});`,
      );
      const source = path.join(root, "CSharpTests/CounterTests.cs"),
        text = await readFile(source, "utf8"),
        anchor =
          "public void Scale(int value) => Assert.That(Counter.Next(value), Is.EqualTo(value + 1));";
      assert.equal(text.split(anchor).length, 2);
      await writeFile(
        source,
        text.replace(
          anchor,
          `public void Scale(int value) { if(value==2)return; var script=System.IO.Path.GetFullPath(System.IO.Path.Combine(System.IO.Path.GetDirectoryName(typeof(CounterTests).Assembly.Location)!,"../../../..","original-wait.cjs")); using var child=System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("node") {UseShellExecute=false,ArgumentList={script}})!; child.WaitForExit(); }`,
        ),
      );
      await writeFile(
        path.join(root, "checktrail.json"),
        JSON.stringify({
          schemaVersion: 1,
          projects: [
            {
              path: ".",
              checks: ["dotnet.generator-extensions"],
              environment: ["CHECKTRAIL_DOTNET_STARTED"],
            },
          ],
        }),
      );
      const check = (await createPlan(root)).plan.checks[0]!,
        owner = await mkdtemp(path.join(tmpdir(), "original-generator-owned-")),
        previous = process.env.TMPDIR,
        abort = new AbortController();
      process.env.TMPDIR = owner;
      const pending = runProcess(root, check.commands[0]!, {
        timeoutMs: mode === "timeout" ? 45000 : 120000,
        maxOutputBytes: mode === "output" ? 1024 : 4 * 1048576,
        signal: abort.signal,
        environment: { CHECKTRAIL_DOTNET_STARTED: marker },
      });
      void pending.catch(() => {});
      let record:
        | {
            pid: number;
            client: number;
            host: number;
            owned: boolean;
            scratch: string;
            owner: string;
          }
        | undefined;
      try {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          try {
            record = JSON.parse(await readFile(marker, "utf8"));
            break;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(
          record,
          "Actual native NUnit method body reached before control",
        );
        assert.equal(record.owned, true);
        assert.ok(record.scratch.startsWith(record.owner + path.sep));
        assert.ok(record.owner.startsWith(owner + path.sep));
        for (const pid of [record.pid, record.host, record.client])
          process.kill(pid, 0);
        if (mode === "cancel") abort.abort();
        const result = await pending;
        assert.equal(result.cancelled, mode === "cancel");
        assert.equal(result.timedOut, mode === "timeout");
        assert.equal(result.truncated, mode === "output");
        assert.equal(
          dotnetGeneratorExtensionsEvidence(check, [result], root)
            .findingsComplete,
          false,
        );
        await assert.rejects(access(record.scratch), { code: "ENOENT" });
        assert.deepEqual(await readdir(owner), []);
        for (const pid of [record.pid, record.host, record.client])
          await assert.rejects(readFile(`/proc/${pid}/cmdline`), {
            code: "ENOENT",
          });
      } finally {
        abort.abort();
        await pending;
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
        await rm(owner, { recursive: true, force: true });
      }
    }
  },
);
test(
  "dotnet-generator-extensions privacy acceptance",
  { ...native, timeout: 900000 },
  async (t) => {
    const root = await dotnetGeneratorMethodFixture(t).then((d) => d.root),
      file = path.join(root, "CSharpTests/CounterTests.cs"),
      text = await readFile(file, "utf8");
    await writeFile(
      file,
      text.replace(
        'TestName="integer & literal"',
        'TestName="original_generator_private_case_canary"',
      ),
    );
    const producer = path.join(root, "CSharp/Counter.cs");
    await writeFile(producer, broken(await readFile(producer, "utf8")));
    const report = await run(root);
    expect(report, "failed");
    assert.equal(
      JSON.stringify(projectReport(report, false)).includes(
        "original_generator_private_case_canary",
      ),
      false,
    );
    assert.equal(
      JSON.stringify(projectReport(report, false)).includes(root),
      false,
    );
    assert.ok(
      JSON.stringify(projectReport(report, true)).includes(
        "original_generator_private_case_canary",
      ),
    );
    const denied = spawnSync(process.execPath, [cli, "run", "--root", root], {
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /trust/i);
    for (const detailed of [false, true]) {
      const response = spawnSync(
        process.execPath,
        [
          cli,
          "run",
          "--root",
          root,
          "--trust-project",
          "--timeout-ms",
          "120000",
          ...(detailed ? ["--detailed"] : []),
        ],
        { encoding: "utf8", timeout: 150000, maxBuffer: 8 * 1048576 },
      );
      assert.equal(response.status, 1, response.stderr.slice(-1500));
      assert.equal(JSON.parse(response.stdout).outcome, "failed");
      assert.equal(
        response.stdout.includes("original_generator_private_case_canary"),
        detailed,
      );
      assert.equal(response.stdout.includes(root), detailed);
    }
    for (const { allow, detailed } of [
      { allow: false, detailed: false },
      { allow: true, detailed: false },
      { allow: true, detailed: true },
    ]) {
      const client = new Client(
        { name: "original-dotnet-generator-client", version: "1.0.0" },
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
              root,
              "--timeout-ms",
              "120000",
              ...(allow ? ["--allow-execution"] : []),
              ...(detailed ? ["--detailed"] : []),
            ],
            env: {
              PATH: process.env.PATH ?? "",
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
        const response = await client.callTool(
          {
            name: "validation_run",
            arguments: { timeoutMs: 120000 },
          },
          { timeout: 150000 },
        );
        if (allow) {
          assert.notEqual(response.isError, true);
          const encoded = JSON.stringify(response);
          assert.equal(
            (response.structuredContent as { outcome?: unknown }).outcome,
            "failed",
          );
          assert.equal(
            encoded.includes("original_generator_private_case_canary"),
            detailed,
          );
          assert.equal(encoded.includes(root), detailed);
        } else assert.equal(response.isError, true);
        assert.equal(
          (
            await client.callTool({
              name: "validation_run",
              arguments: { detailed: true },
            })
          ).isError,
          true,
        );
      } finally {
        await client.close();
      }
    }
  },
);
test(
  "dotnet-generator-extensions installed acceptance",
  { ...native, timeout: 1200000 },
  async () => {
    if (process.env.CHECKTRAIL_DOTNET_GENERATOR_EXTENSIONS_INSTALLED === "1") {
      assert.match(
        await import("node:fs/promises").then((fs) =>
          fs.realpath(
            fileURLToPath(new URL("../src/engine.js", import.meta.url)),
          ),
        ),
        /node_modules\/@stsepelin\/checktrail\/dist\/src\/engine\.js$/,
      );
      return;
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "dotnet-generator-extensions",
    };
    delete env.NODE_TEST_CONTEXT;
    const installed = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            "../../scripts/verify-import-context-package.mjs",
            import.meta.url,
          ),
        ),
      ],
      { env, encoding: "utf8", timeout: 1170000, maxBuffer: 4 * 1048576 },
    );
    assert.equal(installed.error, undefined, installed.error?.message ?? "");
    assert.equal(installed.signal, null);
    assert.equal(installed.status, 0, installed.stderr.slice(-2000));
    const receipt = JSON.parse(installed.stdout);
    assert.equal(receipt.profile.complete, true);
    assert.equal(receipt.profile.required, 9);
    assert.equal(receipt.profile.passed, 9);
    assert.equal(receipt.offlineProductionInstall, true);
    assert.equal(receipt.harnessOutsideInstalledPackage, true);
    if (process.env.CHECKTRAIL_DOTNET_GENERATOR_EXTENSIONS_INSTALL_RECEIPT)
      await writeFile(
        process.env.CHECKTRAIL_DOTNET_GENERATOR_EXTENSIONS_INSTALL_RECEIPT,
        JSON.stringify(receipt),
      );
  },
);
