import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  readFile,
  mkdir,
  mkdtemp,
  cp,
  rm,
  writeFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  swiftToolsInvocationSchema,
  swiftToolsProtectedEnvironment,
  swiftToolsScope,
} from "./swift-tools.js";
import { mavenHash, mavenLocal } from "./maven.js";
import {
  swiftCommon,
  swiftAstArgs,
  swiftLintOptions,
  swiftNativeScope,
  swiftRequire,
} from "./swift-native.js";
async function regular(file: string, bound = 4 * 1024 * 1024) {
  const stat = await lstat(file);
  swiftRequire(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size <= bound &&
      (await realpath(file)) === file,
    "Swift artifact is not a bounded regular file",
  );
  const data = await readFile(file);
  swiftRequire(data.length <= bound, "Swift artifact grew");
  return data;
}
async function tool(name: string) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const entry = path.resolve(directory, name);
    try {
      await access(entry, constants.X_OK);
    } catch {
      continue;
    }
    const resolved = await realpath(entry),
      bytes = await regular(resolved, 512 * 1024 * 1024);
    return { name, entry, resolved, sha256: mavenHash(bytes), afterSha256: "" };
  }
  throw Error("Pinned Swift native executable unavailable");
}
async function main() {
  const root = await realpath(process.argv[2]!),
    project = path.relative(root, process.cwd()),
    invocation = swiftToolsInvocationSchema.parse(JSON.parse(process.argv[3]!)),
    config = invocation.config,
    mode = process.argv[4];
  swiftRequire(
    ["build", "test", "swiftlint"].includes(mode!),
    "Swift native mode",
  );
  swiftRequire(
    new Set(invocation.inputs.map((p) => p.path)).size ===
      invocation.inputs.length,
    "Duplicate Swift inputs",
  );
  swiftToolsScope(
    config,
    invocation.inputs.map((p) => p.path),
  );
  const verify = async (base: string, relative: string) => {
    for (const pin of invocation.inputs)
      swiftRequire(
        mavenHash(await regular(await mavenLocal(base, relative, pin.path))) ===
          pin.sha256,
        "Swift source changed during native execution",
      );
  };
  await verify(root, project);
  const temporary = await mkdtemp(
      path.join(process.env.CHECKTRAIL_TEMP || tmpdir(), "swift-tools-"),
    ),
    workspace = path.join(temporary, "project");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env))
    if (
      swiftToolsProtectedEnvironment.includes(key) ||
      /^(?:SWIFT_|SWIFTPM_|SWIFTLINT_|SCRIPT_INPUT_|DYLD_)/.test(key)
    )
      delete env[key];
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
  }[] = [];
  const artifacts: { path: string; text: string; sha256: string }[] = [];
  let total = 0;
  try {
    for (const directory of [
      workspace,
      env.HOME!,
      env.TMPDIR!,
      ...["cache", "config", "security", "scratch"].map((d) =>
        path.join(temporary, d),
      ),
    ])
      await mkdir(directory, { recursive: true });
    for (const pin of invocation.inputs) {
      const target = path.join(workspace, pin.path);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(await mavenLocal(root, project, pin.path), target, {
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
        result = spawnSync(executable, args, {
          cwd: workspace,
          env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 4 * 1024 * 1024,
        });
      swiftRequire(
        !result.error && !result.signal && result.status !== null,
        "Swift native process incomplete",
      );
      total +=
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
      swiftRequire(
        total <= 12 * 1024 * 1024 && receipts.length < 260,
        "Swift native output bound",
      );
      const row = {
        phase,
        executable,
        args,
        exitCode: result.status!,
        stdout: result.stdout,
        stderr: result.stderr,
        stdoutSha256: mavenHash(result.stdout),
        stderrSha256: mavenHash(result.stderr),
        durationMs: Math.round(performance.now() - start),
      };
      receipts.push(row);
      return row;
    };
    for (const [phase, name, args, expected] of [
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
    ] as const) {
      const result = invoke(phase, name, [...args]);
      swiftRequire(
        result.exitCode === 0 &&
          result.stdout === expected &&
          !result.stderr.trim(),
        "Swift native version differs",
      );
    }
    const common = swiftCommon(workspace, temporary),
      manifest = invoke("manifest", "swift", [
        "package",
        ...common,
        "dump-package",
      ]),
      describe = invoke("describe", "swift", [
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
      "Swift native manifest collection incomplete",
    );
    swiftNativeScope(config, workspace, manifest.stdout, describe.stdout);
    const options = swiftLintOptions(config),
      optionsFile = path.join(temporary, "swiftlint.yml");
    await writeFile(optionsFile, options, { flag: "wx" });
    const collect = async (relative: string) => {
      const file = path.join(temporary, relative),
        text = (await regular(file)).toString("utf8");
      total += Buffer.byteLength(text);
      swiftRequire(total <= 12 * 1024 * 1024, "Swift artifact output bound");
      artifacts.push({ path: relative, text, sha256: mavenHash(text) });
    };
    if (mode === "swiftlint") {
      for (const source of config.targets.flatMap((t) => t.sources))
        swiftRequire(
          !(await regular(path.join(workspace, source))).includes(
            Buffer.from("swiftlint:"),
          ),
          "Swift inline lint directives need an audited suppression profile",
        );
      invoke("swiftlint", "swiftlint", [
        "lint",
        "--config",
        optionsFile,
        "--no-cache",
        "--strict",
        "--reporter",
        "json",
        ...config.targets
          .flatMap((t) => t.sources)
          .map((f) => path.join(workspace, f)),
      ]);
    } else {
      const frameworkFlag =
          config.tests.framework === "xctest"
            ? "--disable-swift-testing"
            : "--disable-xctest",
        build = invoke("build", "swift", [
          "build",
          ...common,
          "--build-tests",
          frameworkFlag,
          "-j",
          "2",
          "--verbose",
        ]);
      if (build.exitCode === 0 && mode === "test") {
        invoke("list", "swift", [
          "test",
          ...common,
          "--skip-build",
          frameworkFlag,
          "list",
        ]);
        for (const target of config.targets.filter((t) => t.type === "test"))
          for (const file of target.sources)
            invoke(
              "ast:" + file,
              "swiftc",
              swiftAstArgs(
                config,
                workspace,
                temporary,
                target,
                file,
                tools.find((t) => t.name === "swift-frontend")!.entry,
              ),
            );
        if (config.tests.framework === "xctest") {
          invoke("test", "swift", [
            "test",
            ...common,
            "--skip-build",
            frameworkFlag,
            "--no-parallel",
          ]);
        } else {
          invoke("test", "swift", [
            "test",
            ...common,
            "--skip-build",
            frameworkFlag,
            "--xunit-output",
            path.join(temporary, "results.xml"),
            "--event-stream-version",
            "0",
            "--event-stream-output-path",
            path.join(temporary, "events.jsonl"),
          ]);
          await collect("results.xml");
          await collect("events.jsonl");
        }
      }
    }
    await verify(temporary, "project");
    await verify(root, project);
    swiftRequire(
      (await regular(optionsFile)).toString("utf8") === options,
      "Swift lint options changed",
    );
    for (const tool of tools) {
      swiftRequire(
        (await realpath(tool.entry)) === tool.resolved,
        "Swift executable changed target",
      );
      tool.afterSha256 = mavenHash(
        await regular(tool.resolved, 512 * 1024 * 1024),
      );
      swiftRequire(
        tool.sha256 === tool.afterSha256,
        "Swift executable bytes changed",
      );
    }
    process.stdout.write(
      JSON.stringify({
        version: 1,
        mode,
        temporary,
        workspace,
        inputSha256: mavenHash(JSON.stringify(invocation.inputs)),
        optionsSha256: mavenHash(options),
        tools,
        receipts,
        artifacts,
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch((error: unknown) => {
  const message =
    error instanceof Error && error.message.startsWith("Swift ")
      ? error.message
      : "Swift native collection unavailable or incomplete";
  process.stderr.write(message + "\n");
  process.exitCode = 2;
});
