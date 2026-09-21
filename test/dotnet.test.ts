import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPlan, validate } from "../src/engine.js";
import { dotnetEvidence } from "../src/dotnet-evidence.js";
import { fixture } from "./helpers.js";

const version = spawnSync("dotnet", ["--list-sdks"], {
  encoding: "utf8",
  timeout: 10000,
});
const sdkBase = /^10\.0\.401 \[([^\r\n]+)\]$/m.exec(version.stdout ?? "")?.[1];
const native = version.status === 0 && !!sdkBase;
const options = {
  skip: native ? false : "Verified .NET SDK unavailable",
  timeout: 120000,
};
const config = {
  schemaVersion: 1,
  targetFramework: "net10.0",
  assemblyName: "Example.Catalog",
  languageVersion: "14",
  outputKind: "library",
  nullable: "enable",
  warningsAsErrors: true,
  allowUnsafe: false,
  checkedArithmetic: true,
  implicitUsings: false,
  defines: ["NET", "NET10_0", "NETCOREAPP"],
  references: [] as { path: string; sha256: string }[],
};
const simple = {
  "Catalog.csproj": "<Project/>",
  "checktrail.dotnet.json": JSON.stringify(config),
  "Value.cs": "public class Value { public int Amount => 1; }",
};

test("C# planning reads explicit settings without running build targets, and rejects unsupported compilation shapes", async (t) => {
  const root = await fixture(t, {
    "Catalog.csproj":
      '<Project><Target Name="Trap"><Exec Command="touch executed"/></Target></Project>',
    "Value.cs": simple["Value.cs"],
  });
  assert.match(
    (await createPlan(root)).plan.checks[0]!.unavailableReason!,
    /Prepare/,
  );
  await writeFile(
    path.join(root, "checktrail.dotnet.json"),
    JSON.stringify(config),
  );
  assert.equal(
    (await createPlan(root)).plan.checks[0]!.unavailableReason,
    undefined,
  );
  await assert.rejects(validate(root, { trusted: false }), /trust/);
  for (const invalid of [
    { ...config, targetFramework: "net9.0" },
    { ...config, languageVersion: "preview" },
    { ...config, defines: ["ONE", "ONE"] },
    { ...config, defines: ["true"] },
    { ...config, analyzer: "custom.dll" },
    {
      ...config,
      references: [{ path: "../hidden.dll", sha256: "0".repeat(64) }],
    },
  ]) {
    await writeFile(
      path.join(root, "checktrail.dotnet.json"),
      JSON.stringify(invalid),
    );
    assert.ok((await createPlan(root)).plan.checks[0]!.unavailableReason);
  }
  await writeFile(
    path.join(root, "checktrail.dotnet.json"),
    JSON.stringify(config),
  );
  for (const file of [
    "Other.csproj",
    "Other.fsproj",
    "Other.vbproj",
    "Other.fs",
    "Other.vb",
    "Other.csx",
    "Other.fsx",
    "Other.razor",
    "Other.xaml",
  ]) {
    await writeFile(path.join(root, file), "");
    assert.ok((await createPlan(root)).plan.checks[0]!.unavailableReason, file);
    await rm(path.join(root, file));
  }
  await writeFile(
    path.join(root, "checktrail.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: ".",
          checks: ["dotnet.csharp"],
          environment: ["DOTNET_STARTUP_HOOKS"],
        },
      ],
    }),
  );
  await assert.rejects(
    createPlan(root, { environment: { DOTNET_STARTUP_HOOKS: "hook.dll" } }),
    /protected/,
  );
  await assert.rejects(access(path.join(root, "executed")));
});

test("C# missing tooling and malformed unavailable evidence cannot produce a pass", async (t) => {
  const root = await fixture(t, simple);
  const directory = path.join(root, "empty-path");
  await mkdir(directory);
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [cli, "run", "--root", root, "--trust-project", "--detailed"],
    {
      env: { ...process.env, PATH: directory },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout) as Awaited<
    ReturnType<typeof validate>
  >;
  assert.equal(report.outcome, "incomplete");
  assert.equal(report.checks[0]!.status, "unavailable");
  const { plan } = await createPlan(root);
  const evidence = {
    command: plan.checks[0]!.commands[0]!,
    exitCode: 3,
    signal: null,
    stdout: "{}",
    stderr: "",
    durationMs: 0,
    timedOut: false,
    cancelled: false,
    truncated: false,
  };
  assert.equal(
    dotnetEvidence(plan.checks[0]!, [evidence], root).status,
    "inconclusive",
  );
});

test(
  "native C# validates the public record, catches a type-error/fix pair and never executes application initialization or build targets",
  options,
  async (t) => {
    const root = await fixture(t, {});
    await cp(
      fileURLToPath(new URL("../../examples/dotnet/", import.meta.url)),
      root,
      { recursive: true },
    );
    await writeFile(
      path.join(root, "NeverRun.cs"),
      `class NeverRun { static NeverRun() { System.IO.File.WriteAllText(${JSON.stringify(path.join(root, "executed"))}, "bad"); } }`,
    );
    await writeFile(
      path.join(root, "Directory.Build.targets"),
      '<Project><Target Name="Trap" BeforeTargets="Build"><Error Text="Build targets must not run"/></Target></Project>',
    );
    await writeFile(
      path.join(root, "global.json"),
      JSON.stringify({ sdk: { version: "0.0.0", rollForward: "disable" } }),
    );
    const good = await validate(root, { trusted: true });
    assert.equal(good.outcome, "passed", JSON.stringify(good.checks));
    assert.equal(good.checks[0]!.findingsComplete, true);
    assert.equal(good.checks[0]!.tests, undefined);
    assert.ok(
      good.checks[0]!.tools!.every((tool) => tool.status === "identified"),
    );
    for (const file of ["executed", "Example.Catalog.dll", "obj"])
      await assert.rejects(access(path.join(root, file)));
    const source = path.join(root, "Quantity.cs");
    const text = await readFile(source, "utf8");
    await writeFile(source, text.replace("Value + other.Value", "false"));
    const broken = await validate(root, { trusted: true });
    assert.equal(broken.outcome, "failed", JSON.stringify(broken.checks));
    assert.equal(broken.checks[0]!.findingsComplete, false);
    assert.ok(
      broken.checks[0]!.findings!.some(
        (item) =>
          item.ruleId === "csharp/CS1503" &&
          item.file === "Quantity.cs" &&
          item.line === 5,
      ),
    );
    await writeFile(source, text);
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
  },
);

test(
  "native C# accounts for empty files, partial types and semantic analysis; incomplete or inconsistent native evidence is rejected",
  options,
  async (t) => {
    const root = await fixture(t, {
      ...simple,
      "Empty.cs": "",
      "space directory/First.cs":
        "public partial class Pair { public int First => 1; }",
      "Second.cs": "public partial class Pair { public int Sum => First + 1; }",
    });
    const report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    const { plan } = await createPlan(root);
    const process = report.checks[0]!.processes[0]!;
    type Native = {
      referenceFiles: number;
      compilation: {
        compiler: string;
        success: boolean;
        settings: typeof config;
        ownedTreeCount: number;
        sources: {
          file: string;
          semantic: boolean;
          syntaxLength: number;
          textLength: number;
        }[];
        outputBytes: number;
      };
    };
    for (const mutate of [
      (data: Native) => data.compilation.sources.pop(),
      (data: Native) => {
        data.compilation.sources[0]!.semantic = false;
      },
      (data: Native) => {
        data.compilation.sources[0]!.syntaxLength++;
      },
      (data: Native) => {
        data.compilation.sources[0]!.file = "/unknown.cs";
      },
      (data: Native) => {
        data.compilation.sources[0] = data.compilation.sources[1]!;
      },
      (data: Native) => {
        data.compilation.outputBytes = 0;
      },
      (data: Native) => {
        data.compilation.ownedTreeCount = 1;
      },
      (data: Native) => {
        data.compilation.settings.nullable = "disable";
      },
      (data: Native) => {
        data.compilation.success = false;
      },
      (data: Native) => {
        data.compilation.compiler = "0.0.0.0";
      },
      (data: Native) => {
        data.referenceFiles++;
      },
    ]) {
      const data = JSON.parse(process.stdout) as Native;
      mutate(data);
      assert.equal(
        dotnetEvidence(
          plan.checks[0]!,
          [{ ...process, stdout: JSON.stringify(data) }],
          root,
        ).status,
        "inconclusive",
      );
    }
  },
);

test(
  "native C# honors explicit nullability, warnings, defines, output kind and unsafe settings without implicit source inclusion",
  options,
  async (t) => {
    const root = await fixture(t, {
      ...simple,
      "Value.cs": "public class Value { public string Text => null; }",
    });
    const settings = async (values: Partial<typeof config>) =>
      writeFile(
        path.join(root, "checktrail.dotnet.json"),
        JSON.stringify({ ...config, ...values }),
      );
    const source = async (text: string) =>
      writeFile(path.join(root, "Value.cs"), text);
    const broken = await validate(root, { trusted: true });
    assert.equal(broken.outcome, "failed", JSON.stringify(broken.checks));
    assert.ok(
      broken.checks[0]!.findings!.some(
        (item) => item.ruleId === "csharp/CS8603",
      ),
    );
    await settings({ warningsAsErrors: false });
    const warnings = await validate(root, { trusted: true });
    assert.equal(
      warnings.checks[0]!.status,
      "passed",
      JSON.stringify(warnings.checks),
    );
    assert.ok(
      warnings.checks[0]!.findings!.some(
        (item) => item.level === "warning" && item.ruleId === "csharp/CS8603",
      ),
    );
    await settings({ nullable: "disable" });
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await source('Console.WriteLine("application must not execute");');
    await settings({ implicitUsings: true, outputKind: "console" });
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await settings({ implicitUsings: false, outputKind: "console" });
    assert.equal((await validate(root, { trusted: true })).outcome, "failed");
    await settings({ implicitUsings: true, outputKind: "library" });
    assert.equal((await validate(root, { trusted: true })).outcome, "failed");
    await source(
      "#if FEATURE\n#error Selected conditional branch\n#endif\npublic class Value {}\n",
    );
    await settings({ defines: ["FEATURE"] });
    assert.equal((await validate(root, { trusted: true })).outcome, "failed");
    await settings({ defines: ["FEATURE_EXTRA"] });
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await source(
      "public class Box { public int Amount { get; set { field = value; } } }",
    );
    await settings({ languageVersion: "14" });
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await settings({ languageVersion: "13" });
    assert.equal((await validate(root, { trusted: true })).outcome, "failed");
    await source(
      "public unsafe class Value { public int Get(int* value) => *value; }",
    );
    await settings({ allowUnsafe: false });
    assert.equal((await validate(root, { trusted: true })).outcome, "failed");
    await settings({ allowUnsafe: true });
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await mkdir(path.join(root, "obj"));
    await writeFile(
      path.join(root, "obj/Generated.cs"),
      "public class Generated {}",
    );
    await source("public class Value { public Generated? Missing => null; }");
    await settings({});
    assert.equal((await validate(root, { trusted: true })).outcome, "failed");
  },
);

test(
  "native C# consumes pinned metadata without executing modules or source generators and respects the declared assembly identity",
  options,
  async (t) => {
    const root = await fixture(t, {
      ...simple,
      "Value.cs": "public class Value { public int Amount => Library.Amount; }",
    });
    const prepared = path.join(root, ".checktrail");
    await mkdir(prepared);
    const sdk = path.join(sdkBase!, "10.0.401");
    const refs = path.resolve(
      sdk,
      "../../packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0",
    );
    const compiler = path.join(sdk, "Roslyn/bincore");
    const args = (await readdir(refs))
      .filter((file) => file.endsWith(".dll"))
      .map((file) => `-r:${path.join(refs, file)}`);
    const source = path.join(prepared, "Library.cs");
    const dll = path.join(prepared, "Library.dll");
    await writeFile(
      source,
      `[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("Example.Catalog")] internal static class Library { public static int Amount => 7; [System.Runtime.CompilerServices.ModuleInitializer] public static void Initialize() { System.IO.File.WriteAllText(${JSON.stringify(path.join(root, "executed"))}, "bad"); } } [Microsoft.CodeAnalysis.Generator] public class Trap : Microsoft.CodeAnalysis.IIncrementalGenerator { public void Initialize(Microsoft.CodeAnalysis.IncrementalGeneratorInitializationContext context) { throw new System.InvalidOperationException("generator executed"); } }`,
    );
    const compile = spawnSync(
      "dotnet",
      [
        "exec",
        path.join(compiler, "csc.dll"),
        "-nologo",
        "-noconfig",
        "-nostdlib+",
        "-target:library",
        `-out:${dll}`,
        ...args,
        `-r:${path.join(compiler, "Microsoft.CodeAnalysis.dll")}`,
        `-r:${path.join(compiler, "Microsoft.CodeAnalysis.CSharp.dll")}`,
        source,
      ],
      { cwd: root, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(compile.status, 0, compile.stdout + compile.stderr);
    const pinned = {
      ...config,
      references: [
        {
          path: ".checktrail/Library.dll",
          sha256: createHash("sha256")
            .update(await readFile(dll))
            .digest("hex"),
        },
      ],
    };
    const settings = async (value = pinned) =>
      writeFile(
        path.join(root, "checktrail.dotnet.json"),
        JSON.stringify(value),
      );
    await settings();
    const good = await validate(root, { trusted: true });
    assert.equal(good.outcome, "passed", JSON.stringify(good.checks));
    await assert.rejects(access(path.join(root, "executed")));
    const controlSource = path.join(prepared, "Control.cs");
    const controlOutput = path.join(prepared, "Example.Catalog.dll");
    await writeFile(
      controlSource,
      "class Control { static void Main() { System.Console.WriteLine(Library.Amount); } }",
    );
    const controlCompile = spawnSync(
      "dotnet",
      [
        "exec",
        path.join(compiler, "csc.dll"),
        "-nologo",
        "-noconfig",
        "-nostdlib+",
        "-target:exe",
        `-out:${controlOutput}`,
        ...args,
        `-r:${dll}`,
        controlSource,
      ],
      { cwd: prepared, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(
      controlCompile.status,
      0,
      controlCompile.stdout + controlCompile.stderr,
    );
    await writeFile(
      path.join(prepared, "Example.Catalog.runtimeconfig.json"),
      JSON.stringify({
        runtimeOptions: {
          tfm: "net10.0",
          framework: { name: "Microsoft.NETCore.App", version: "10.0.12" },
          rollForward: "Disable",
        },
      }),
    );
    const controlRun = spawnSync("dotnet", ["exec", controlOutput], {
      cwd: prepared,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(controlRun.status, 0, controlRun.stdout + controlRun.stderr);
    assert.equal(controlRun.stdout.trim(), "7");
    assert.equal(await readFile(path.join(root, "executed"), "utf8"), "bad");
    await rm(path.join(root, "executed"));
    await settings({ ...pinned, assemblyName: "Different.Consumer" });
    const denied = await validate(root, { trusted: true });
    assert.equal(denied.outcome, "failed");
    assert.ok(
      denied.checks[0]!.findings!.some(
        (item) => item.ruleId === "csharp/CS0122",
      ),
    );
    await settings();
    await writeFile(
      path.join(root, "Value.cs"),
      "public class Value { public string Amount => Library.Amount; }",
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "failed");
    await symlink(dll, path.join(prepared, "Alias.dll"));
    await settings({
      ...pinned,
      references: [{ ...pinned.references[0]!, path: ".checktrail/Alias.dll" }],
    });
    assert.match(
      (await createPlan(root)).plan.checks[0]!.unavailableReason!,
      /symbolic links/,
    );
    await settings({
      ...pinned,
      references: [pinned.references[0]!, pinned.references[0]!],
    });
    assert.match(
      (await createPlan(root)).plan.checks[0]!.unavailableReason!,
      /Duplicate/,
    );
    await settings();
    await writeFile(dll, "not a DLL");
    assert.match(
      (await createPlan(root)).plan.checks[0]!.unavailableReason!,
      /checksum/,
    );
    const part = path.join(prepared, "Part.cs");
    const module = path.join(prepared, "Part.netmodule");
    await writeFile(
      part,
      "public class ExternalPart { public int Amount => 2; }",
    );
    await writeFile(source, "public class Facade {}");
    for (const build of [
      ["-target:module", `-out:${module}`, part],
      ["-target:library", `-out:${dll}`, `-addmodule:${module}`, source],
    ]) {
      const result = spawnSync(
        "dotnet",
        [
          "exec",
          path.join(compiler, "csc.dll"),
          "-nologo",
          "-noconfig",
          "-nostdlib+",
          ...args,
          ...build,
        ],
        { cwd: root, encoding: "utf8", timeout: 10000 },
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    await writeFile(
      path.join(root, "Value.cs"),
      "public class Value { public int Amount => new ExternalPart().Amount; }",
    );
    await settings({
      ...pinned,
      references: [
        {
          path: ".checktrail/Library.dll",
          sha256: createHash("sha256")
            .update(await readFile(dll))
            .digest("hex"),
        },
      ],
    });
    const multiFile = await validate(root, { trusted: true });
    assert.equal(
      multiFile.outcome,
      "incomplete",
      JSON.stringify(multiFile.checks),
    );
    assert.equal(multiFile.checks[0]!.status, "error");
  },
);

test(
  "native C# compiler suppressions cannot silently establish complete findings",
  options,
  async (t) => {
    const root = await fixture(t, {
      ...simple,
      "Value.cs":
        "#pragma warning disable CS8603\npublic class Value { public string Text => null; }",
    });
    const suppressed = await validate(root, { trusted: true });
    assert.equal(
      suppressed.outcome,
      "incomplete",
      JSON.stringify(suppressed.checks),
    );
    assert.equal(suppressed.checks[0]!.findingsComplete, false);
    await writeFile(
      path.join(root, "Value.cs"),
      '// #pragma warning disable CS8603\npublic class Value { public string Text => "valid"; }',
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
  },
);
