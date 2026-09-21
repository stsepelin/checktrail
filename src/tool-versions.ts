import { externalInvocationSchema } from "./external-adapter.js";
import { clangVersion } from "./clang-protocol.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readProjectFile } from "./inventory.js";
import { localTool } from "./local-tool.js";
import type {
  Check,
  Command,
  ProcessResult,
  ToolEvidence,
  ToolSpec,
} from "./types.js";

const packages: Record<string, string> = {
  "javascript.typescript": "typescript",
  "javascript.typescript-build": "typescript",
  "javascript.vue-tsc": "vue-tsc",
  "javascript.vue-router": "vue-router",
  "javascript.eslint": "eslint",
  "javascript.vitest": "vitest",
  "javascript.jest": "jest",
  "javascript.playwright": "playwright",
};

export async function toolsFor(
  root: string,
  check: Check,
): Promise<ToolSpec[]> {
  const command = (
    name: string,
    executable: string,
    args: string[],
  ): ToolSpec => ({
    name,
    source: "version-command",
    command: {
      executable,
      args,
      cwd: check.project,
      ...(check.commands[0]?.env ? { env: check.commands[0].env } : {}),
    },
  });
  if (check.external) {
    const result: ToolSpec[] = [{ name: "node", source: "engine-runtime" }];
    if (check.commands[0]) {
      const invocation = externalInvocationSchema.parse(
        JSON.parse(check.commands[0].args[2]!),
      );
      result.push(
        command(invocation.identity.id, process.execPath, [
          fileURLToPath(new URL("./external-runner.js", import.meta.url)),
          "--version",
          JSON.stringify(invocation.reference),
        ]),
      );
      if (invocation.runtime === "python3")
        result.push(command("python", "python3", ["-I", "--version"]));
      if (invocation.runtime === "php")
        result.push(command("php", "php", ["-n", "--version"]));
    }
    return result;
  }
  if (check.adapter === "javascript") {
    const tools: ToolSpec[] = [{ name: "node", source: "engine-runtime" }];
    if (check.id === "javascript.nuxt-runtime" && check.commands[0]) {
      const metadata = JSON.parse(check.commands[0].args[2]!) as Record<
        string,
        string
      >;
      tools.push(
        ...Object.entries(metadata).map(([name, path]) => ({
          name,
          path,
          source: "package-metadata" as const,
        })),
      );
    }
    if (check.id === "javascript.vue-router")
      tools.push({
        name: "vue",
        source: "package-metadata",
        path: check.commands[0]?.args[2] ?? null,
      });
    const name = packages[check.id];
    if (name)
      tools.push({
        name,
        source: "package-metadata",
        path:
          (await localTool(root, check.project, `${name}/package.json`)) ??
          null,
      });
    return tools;
  }
  if (check.adapter === "python") {
    const tools = [command("python", "python3", ["--version"])];
    if (check.id === "python.pytest" || check.id === "python.mypy") {
      const name = check.id.slice("python.".length);
      tools.push(
        command(name, "python3", [
          "-c",
          `from importlib.metadata import version; print(version(${JSON.stringify(name)}))`,
        ]),
      );
    }
    if (check.id === "python.ruff")
      tools.push(command("ruff", "ruff", ["--version"]));
    if (check.id === "python.fastapi-routes")
      for (const name of ["fastapi", "starlette"])
        tools.push(
          command(name, "python3", [
            "-c",
            `from importlib.metadata import version; print(version(${JSON.stringify(name)}))`,
          ]),
        );
    if (check.id === "python.django-routes")
      tools.push(
        command("django", "python3", [
          "-c",
          "from importlib.metadata import version; print(version('Django'))",
        ]),
      );
    return tools;
  }
  if (check.adapter === "go")
    return [
      command("go", "go", ["version"]),
      ...(check.id === "go.golangci-lint"
        ? [
            { name: "node", source: "engine-runtime" } as const,
            command("golangci-lint", "golangci-lint", ["version", "--short"]),
          ]
        : []),
      ...(check.id === "go.staticcheck"
        ? [command("staticcheck", "staticcheck", ["-version"])]
        : []),
    ];
  if (check.adapter === "rust")
    return [
      { name: "node", source: "engine-runtime" },
      command("rustc", "rustc", ["--version"]),
      command("cargo", "cargo", ["--version"]),
    ];
  if (check.adapter === "cpp") {
    const tools: ToolSpec[] = [{ name: "node", source: "engine-runtime" }];
    if (check.commands[0]?.args[2]) {
      const invocation = JSON.parse(check.commands[0].args[2]) as {
        units: { compiler: string }[];
      };
      for (const name of new Set(invocation.units.map((unit) => unit.compiler)))
        tools.push(command(name, name, ["--no-default-config", "--version"]));
    }
    return tools;
  }
  if (check.adapter === "swift")
    return [command("swift", "swiftc", ["--version"])];
  if (check.adapter === "jvm")
    return [
      { name: "node", source: "engine-runtime" },
      command("java", process.execPath, [
        fileURLToPath(new URL("./java-runner.js", import.meta.url)),
        "--version",
      ]),
    ];
  if (check.adapter === "ruby")
    return [command("ruby", "ruby", ["--disable-gems", "--version"])];
  if (check.id === "infrastructure.actionlint")
    return [
      { name: "node", source: "engine-runtime" },
      command("actionlint", process.execPath, [
        fileURLToPath(new URL("./actionlint-runner.js", import.meta.url)),
        "--version",
      ]),
    ];
  if (check.adapter === "dotnet")
    return [
      { name: "node", source: "engine-runtime" },
      command("dotnet", process.execPath, [
        fileURLToPath(new URL("./dotnet-runner.js", import.meta.url)),
        "--version",
      ]),
    ];
  if (check.adapter === "php") {
    const tools = [command("php", "php", ["-n", "--version"])];
    if (check.id === "php.laravel-runtime" && check.commands[0]?.args[2])
      tools.push(
        command("laravel", "php", [
          "-r",
          "require $argv[1]; echo Illuminate\\Foundation\\Application::VERSION;",
          check.commands[0].args[2],
        ]),
      );
    if (check.id === "php.pint" && check.commands[0]?.args[3])
      tools.push(
        command("pint", "php", [
          check.commands[0].args[3],
          "--version",
          "--no-ansi",
        ]),
      );
    if (
      ["php.phpstan", "php.phpunit", "php.pest"].includes(check.id) &&
      check.commands[0]?.args[0]
    )
      tools.push(
        command(check.id.slice("php.".length), "php", [
          check.commands[0].args[0],
          ...(check.id === "php.pest" ? ["--colors=never"] : []),
          "--version",
        ]),
      );
    return tools;
  }
  return [];
}

const versionPattern = /^\d+\.\d+\.\d+(?:[-+a-zA-Z0-9.]+)?$/;

export async function identifyTool(
  root: string,
  tool: ToolSpec,
  execute: (command: Command) => Promise<ProcessResult | undefined>,
): Promise<ToolEvidence> {
  const result: ToolEvidence = {
    name: tool.name,
    source: tool.source,
    version: null,
    status: "inconclusive",
  };
  if (tool.source === "engine-runtime")
    return { ...result, version: process.versions.node, status: "identified" };
  if (tool.source === "package-metadata") {
    if (!tool.path) return { ...result, status: "unavailable" };
    result.path = tool.path;
    try {
      const value: unknown = JSON.parse(
        await readProjectFile(root, path.relative(root, tool.path)),
      );
      if (
        typeof value === "object" &&
        value !== null &&
        "name" in value &&
        value.name === tool.name &&
        "version" in value &&
        typeof value.version === "string" &&
        value.version.length <= 128 &&
        versionPattern.test(value.version)
      )
        return { ...result, version: value.version, status: "identified" };
    } catch {
      return result;
    }
    return result;
  }
  const execution = await execute(tool.command);
  if (!execution) return result;
  result.process = execution;
  if (execution.errorCode === "ENOENT")
    return { ...result, status: "unavailable" };
  if (
    execution.exitCode !== 0 ||
    execution.signal ||
    execution.errorCode ||
    execution.cancelled ||
    execution.timedOut ||
    execution.truncated
  )
    return result;
  const output = execution.stdout.trim();
  const version =
    tool.name === "java"
      ? /^openjdk (\d+\.\d+\.\d+) \d{4}-\d{2}-\d{2} LTS\nOpenJDK Runtime Environment [^\n]+\nOpenJDK 64-Bit Server VM [^\n]+$/.exec(
          output,
        )?.[1]
      : tool.name === "clang" || tool.name === "clang++"
        ? clangVersion(output)
        : tool.name === "swift"
          ? /^(?:Apple )?Swift version (\d+\.\d+(?:\.\d+)?) \([^\r\n]+\)\r?\nTarget: [a-zA-Z0-9_.-]+$/.exec(
              output,
            )?.[1]
          : tool.name === "ruby"
            ? /^ruby (\d+\.\d+\.\d+)(?:p\d+)? /.exec(output)?.[1]
            : tool.name === "cargo" || tool.name === "rustc"
              ? output.startsWith(`${tool.name} `)
                ? /^(?:cargo|rustc) (\S+) \([a-f0-9]+ [0-9-]+\)$/.exec(
                    output,
                  )?.[1]
                : undefined
              : tool.name === "pint"
                ? /^Pint (\S+)$/.exec(output)?.[1]
                : tool.name === "pest"
                  ? /^Pest Testing Framework (\S+)\.$/.exec(output)?.[1]
                  : tool.name === "phpunit"
                    ? /^PHPUnit (\S+) by .+$/.exec(output)?.[1]
                    : tool.name === "phpstan"
                      ? /^PHPStan - PHP Static Analysis Tool (\S+)$/.exec(
                          output,
                        )?.[1]
                      : tool.name === "staticcheck"
                        ? /^staticcheck \S+ \((\d+\.\d+\.\d+)\)$/.exec(
                            output,
                          )?.[1]
                        : tool.name === "go"
                          ? /^go version go(\S+) \S+$/.exec(output)?.[1]
                          : tool.name === "php"
                            ? /^PHP (\S+) /.exec(output)?.[1]
                            : tool.name === "python"
                              ? /^Python (\S+)$/.exec(output)?.[1]
                              : tool.name === "ruff"
                                ? /^ruff (\S+)$/.exec(output)?.[1]
                                : output;
  if (
    version &&
    (tool.name === "swift"
      ? /^\d+\.\d+(?:\.\d+)?$/.test(version)
      : versionPattern.test(version)) &&
    (!execution.stderr.trim() ||
      (tool.name === "swift" &&
        /^swift-driver version: \d+\.\d+\.\d+$/.test(execution.stderr.trim())))
  )
    return { ...result, version, status: "identified" };
  return result;
}
