import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mavenHash, mavenLocal } from "./maven.js";
import { swiftToolsProtectedEnvironment } from "./swift-tools.js";
import {
  swiftExtensionsConfigSchema,
  swiftExtensionsInvocationSchema,
  swiftExtensionsScope,
} from "./swift-extensions-contract.js";
import { swiftExtensionsPolicyFile } from "./swift-extensions.js";
import {
  swiftCommon,
  swiftAstArgs,
  swiftLintOptions,
  swiftRequire,
  swiftSame,
} from "./swift-native.js";
import {
  swiftExtensionsRegular as regular,
  swiftExtensionsTool as tool,
  swiftExtensionsSdkBytes,
  swiftExtensionsTree,
} from "./swift-extensions-physical.js";
import {
  swiftExtensionsTargets,
  swiftExtensionsGenerated,
  swiftExtensionsCompiled,
  swiftExtensionsScanArgs,
} from "./swift-extensions-native.js";
import { swiftExtensionsNativeGraph } from "./swift-extensions-graph.js";
import { swiftExtensionsSdkReferences } from "./swift-extensions-sdk.js";
const versions = [
  [
    "swift-version",
    "swiftc",
    ["--version"],
    "Swift version 6.2.3 (swift-6.2.3-RELEASE)\nTarget: aarch64-unknown-linux-gnu\n",
  ],
  [
    "swiftpm-version",
    "swift",
    ["package", "--version"],
    "Swift Package Manager - Swift 6.2.3\n",
  ],
  ["swiftlint-version", "swiftlint", ["version"], "0.65.1\n"],
] as const;
async function main() {
  const root = await realpath(process.argv[2]!),
    project = path.relative(root, process.cwd()),
    invocation = swiftExtensionsInvocationSchema.parse(
      JSON.parse(process.argv[3]!),
    ),
    mode = process.argv[4]!;
  swiftRequire(
    ["build", "xctest", "testing", "swiftlint"].includes(mode),
    "Swift extension mode differs",
  );
  swiftRequire(
    new Set(invocation.inputs.map((p) => p.path)).size ===
      invocation.inputs.length,
    "Swift extension inputs repeated",
  );
  const configFile = await mavenLocal(root, project, swiftExtensionsPolicyFile),
    configBytes = await regular(configFile);
  swiftRequire(
    mavenHash(configBytes) === invocation.configSha256,
    "Swift extension policy changed",
  );
  const config = swiftExtensionsConfigSchema.parse(
    JSON.parse(configBytes.toString("utf8")),
  );
  swiftExtensionsScope(
    config,
    invocation.inputs.map((p) => p.path),
  );
  const verify = async (base: string, relative: string) => {
    for (const pin of invocation.inputs)
      swiftRequire(
        mavenHash(await regular(await mavenLocal(base, relative, pin.path))) ===
          pin.sha256,
        "Swift extension source changed",
      );
  };
  await verify(root, project);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env))
    if (
      swiftToolsProtectedEnvironment.includes(key) ||
      /^(?:SWIFT_|SWIFTPM_|SWIFTLINT_|SCRIPT_INPUT_|DYLD_)/.test(key)
    )
      delete env[key];
  // No project manifest or plugin is touched before all native versions agree.
  const ready = versions.every(([, name, args, expected]) => {
    const r = spawnSync(name, [...args], {
      env,
      encoding: "utf8",
      maxBuffer: 8192,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
    });
    return (
      !r.error &&
      !r.signal &&
      r.status === 0 &&
      r.stdout === expected &&
      r.stderr === ""
    );
  });
  if (!ready) {
    process.stdout.write(
      JSON.stringify({
        version: 1,
        mode,
        inputSha256: mavenHash(JSON.stringify(invocation.inputs)),
        prerequisite: "unavailable",
      }),
    );
    return;
  }
  let sdkBefore;
  try {
    sdkBefore = await swiftExtensionsSdkBytes(config);
  } catch {
    process.stdout.write(
      JSON.stringify({
        version: 1,
        mode,
        inputSha256: mavenHash(JSON.stringify(invocation.inputs)),
        prerequisite: "unavailable",
      }),
    );
    return;
  }
  const sdkBeforeSha256 = mavenHash(JSON.stringify(sdkBefore));
  const temporary = await mkdtemp(
      path.join(process.env.CHECKTRAIL_TEMP || tmpdir(), "swift-extensions-"),
    ),
    workspace = path.join(temporary, "project");
  Object.assign(env, {
    HOME: path.join(temporary, "home"),
    TMPDIR: path.join(temporary, "tmp"),
    LC_ALL: "C",
    LANG: "C",
    NO_COLOR: "1",
  });
  const receipts: {
      phase: string;
      executable: string;
      args: string[];
      exitCode: number;
      stdout: string;
      stderr: string;
      stdoutSha256: string;
      stderrSha256: string;
      durationMs: number;
    }[] = [],
    artifacts: { path: string; text: string; sha256: string }[] = [];
  let total = 0;
  const generatedBefore: string[] = [],
    generatedAfter: string[] = [];
  try {
    for (const d of [
      workspace,
      env.HOME!,
      env.TMPDIR!,
      ...["cache", "config", "security", "scratch"].map((d) =>
        path.join(temporary, d),
      ),
    ])
      await mkdir(d, { recursive: true });
    for (const pin of invocation.inputs) {
      const dest = path.join(workspace, pin.path);
      await mkdir(path.dirname(dest), { recursive: true });
      await cp(await mavenLocal(root, project, pin.path), dest, {
        force: false,
        errorOnExist: true,
      });
    }
    await verify(temporary, "project");
    const tools = await Promise.all(
      ["swift", "swiftc", "swift-frontend", "swiftlint"].map(tool),
    );
    const invoke = (phase: string, name: string, args: string[]) => {
      const executable = tools.find((t) => t.name === name)!.entry,
        start = performance.now(),
        r = spawnSync(executable, args, {
          cwd: workspace,
          env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 4 * 1024 * 1024,
          timeout: 110000,
        });
      swiftRequire(
        !r.error && !r.signal && r.status !== null,
        "Swift extension native process incomplete",
      );
      total += Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr);
      swiftRequire(
        total <= 12 * 1024 * 1024 && receipts.length < 600,
        "Swift extension native output bound",
      );
      const row = {
        phase,
        executable,
        args,
        exitCode: r.status!,
        stdout: r.stdout,
        stderr: r.stderr,
        stdoutSha256: mavenHash(r.stdout),
        stderrSha256: mavenHash(r.stderr),
        durationMs: Math.round(performance.now() - start),
      };
      receipts.push(row);
      return row;
    };
    for (const [phase, name, args, expected] of versions) {
      const r = invoke(phase, name, [...args]);
      swiftRequire(
        r.exitCode === 0 && r.stdout === expected && !r.stderr,
        "Swift extension native version changed",
      );
    }
    const graph = [];
    for (const p of config.packages) {
      const common = swiftCommon(path.join(workspace, p.path), temporary),
        manifest = invoke("manifest:" + p.identity, "swift", [
          "package",
          ...common,
          "dump-package",
        ]),
        describe = invoke("describe:" + p.identity, "swift", [
          "package",
          ...common,
          "describe",
          "--type",
          "json",
        ]);
      swiftRequire(
        manifest.exitCode === 0 &&
          describe.exitCode === 0 &&
          !manifest.stderr.trim() &&
          !describe.stderr.trim(),
        "Swift extension manifest collection incomplete",
      );
      graph.push({
        identity: p.identity,
        manifest: manifest.stdout,
        describe: describe.stdout,
      });
    }
    swiftExtensionsNativeGraph(config, workspace, graph);
    const options = swiftLintOptions(config),
      optionsFile = path.join(temporary, "swiftlint.yml"),
      targets = swiftExtensionsTargets(config),
      generated = swiftExtensionsGenerated(config, temporary),
      common = swiftCommon(workspace, temporary);
    await writeFile(optionsFile, options, { flag: "wx" });
    const collect = async (file: string) => {
      const text = (await regular(file)).toString("utf8");
      total += Buffer.byteLength(text);
      swiftRequire(
        total <= 12 * 1024 * 1024 && artifacts.length < 512,
        "Swift extension artifact output bound",
      );
      artifacts.push({
        path: path.relative(temporary, file).split(path.sep).join("/"),
        text,
        sha256: mavenHash(text),
      });
    };
    const build = invoke("build", "swift", [
      "build",
      ...common,
      "--build-tests",
      "-j",
      "2",
      "--verbose",
    ]);
    if (build.exitCode === 0) {
      const frontend = tools.find((t) => t.name === "swift-frontend")!.entry;
      swiftExtensionsCompiled(
        config,
        workspace,
        temporary,
        frontend,
        build.stdout + "\n" + build.stderr,
      );
      // Generated files are captured from the actual plugin output, including the complete tree.
      for (const directory of new Set(
        generated.map((g) => path.dirname(g.path)),
      )) {
        const files = await swiftExtensionsTree(directory);
        swiftRequire(
          swiftSame(
            files,
            generated
              .filter((g) => path.dirname(g.path) === directory)
              .map((g) => g.path),
          ),
          "Swift generated output tree differs",
        );
        generatedBefore.push(...files);
      }
      for (const g of generated) await collect(g.path);
      // Scan every physical module, including the plugin and both test frameworks.
      await mkdir(path.join(temporary, "sdk"));
      for (const target of targets) {
        const row = invoke(
          "sdk:" + target.name,
          "swift-frontend",
          swiftExtensionsScanArgs(config, workspace, temporary, target),
        );
        swiftRequire(row.exitCode === 0, "Swift extension SDK scan incomplete");
        const sources = [
          ...target.sources,
          ...generated
            .filter(
              (g) => g.package === target.package && g.target === target.name,
            )
            .map((g) => path.relative(workspace, g.path)),
        ];
        const scanFile = path.join(temporary, "sdk", target.name + ".json");
        await collect(scanFile);
        swiftExtensionsSdkReferences(
          config,
          target.name,
          workspace,
          temporary,
          sources,
          artifacts.at(-1)!.text,
          row.stderr,
        );
      }
      if (mode === "swiftlint") {
        const sources = targets.flatMap((t) => t.sources);
        for (const f of sources)
          swiftRequire(
            !(await regular(path.join(workspace, f))).includes(
              Buffer.from("swiftlint:"),
            ),
            "Swift extension inline lint directives unsupported",
          );
        invoke("swiftlint", "swiftlint", [
          "lint",
          "--config",
          optionsFile,
          "--no-cache",
          "--strict",
          "--reporter",
          "json",
          ...sources.map((f) => path.join(workspace, f)),
        ]);
      } else if (mode === "xctest" || mode === "testing") {
        const framework =
          mode === "xctest" ? "--disable-swift-testing" : "--disable-xctest";
        invoke("list", "swift", [
          "test",
          ...common,
          "--skip-build",
          framework,
          "list",
        ]);
        for (const target of targets.filter((t) => t.type === "test"))
          for (const f of target.sources)
            invoke(
              "ast:" + f,
              "swiftc",
              swiftAstArgs(
                {
                  platform: config.platform,
                  tests: { framework: "swift-testing" },
                },
                workspace,
                temporary,
                target,
                f,
                frontend,
              ),
            );
        invoke("test", "swift", [
          "test",
          ...common,
          "--skip-build",
          framework,
          ...(mode === "xctest"
            ? ["--no-parallel"]
            : [
                "--xunit-output",
                path.join(temporary, "results.xml"),
                "--event-stream-version",
                "0",
                "--event-stream-output-path",
                path.join(temporary, "events.jsonl"),
              ]),
        ]);
        if (mode === "testing") {
          await collect(path.join(temporary, "results.xml"));
          await collect(path.join(temporary, "events.jsonl"));
        }
      }
    }
    if (build.exitCode === 0)
      for (const directory of new Set(
        generated.map((g) => path.dirname(g.path)),
      ))
        generatedAfter.push(...(await swiftExtensionsTree(directory)));
    swiftRequire(
      swiftSame(generatedBefore, generatedAfter),
      "Swift generated output tree changed during execution",
    );
    await verify(temporary, "project");
    await verify(root, project);
    swiftRequire(
      (await regular(optionsFile)).toString("utf8") === options,
      "Swift extension lint options changed",
    );
    for (const g of artifacts)
      swiftRequire(
        mavenHash(await regular(path.join(temporary, g.path))) === g.sha256,
        "Swift extension generated or test output changed",
      );
    for (const t of tools) {
      swiftRequire(
        (await realpath(t.entry)) === t.resolved,
        "Swift extension executable target changed",
      );
      t.afterSha256 = mavenHash(await regular(t.resolved, 512 * 1024 * 1024));
      swiftRequire(
        t.sha256 === t.afterSha256,
        "Swift extension executable bytes changed",
      );
    }
    const sdkAfterSha256 = mavenHash(
      JSON.stringify(await swiftExtensionsSdkBytes(config)),
    );
    swiftRequire(
      sdkBeforeSha256 === sdkAfterSha256,
      "Swift extension SDK changed during execution",
    );
    process.stdout.write(
      JSON.stringify({
        version: 1,
        mode,
        temporary,
        workspace,
        inputSha256: mavenHash(JSON.stringify(invocation.inputs)),
        config,
        optionsSha256: mavenHash(options),
        tools,
        sdkBeforeSha256,
        sdkAfterSha256,
        generatedBefore,
        generatedAfter,
        receipts,
        artifacts,
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch((error: unknown) => {
  process.stderr.write(
    (error instanceof Error && error.message.startsWith("Swift ")
      ? error.message
      : "Swift extension collection unavailable or incomplete") + "\n",
  );
  process.exitCode = 2;
});
