import { laravelAssemblyVersionRunner } from "./laravel-assembly-runner.js";
import { laravelAssemblyPhpFlags } from "./laravel.js";
import { cppToolNames, cppSupportedVersion } from "./cpp-native.js";
import {
  cppExtensionsToolNames,
  cppExtensionsSupportedVersion,
} from "./cpp-extensions-native.js";
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
  "javascript.vite-library": "vite",
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
      ...([
        "jvm.spotbugs",
        "jvm.detekt",
        "jvm.kotlin",
        "jvm.scala",
        "jvm.maven-test",
        "jvm.gradle-test",
        "dotnet.build",
        "dotnet.test",
        "dotnet.format-whitespace",
        "dotnet.format-fsharp",
        "dotnet.format-extensions",
        "dotnet.generator-extensions",
        "infrastructure.terraform-validate",
        "infrastructure.terraform-extensions",
        "infrastructure.kustomize",
        "infrastructure.helm",
        "infrastructure.helm-extensions",
      ].includes(check.id) && check.commands[0]?.temporaryDirectory
        ? { temporaryDirectory: true }
        : {}),
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
    if (check.parser === "python-extension-json" && check.commands[0]) {
      const executable = check.commands[0].executable;
      const name = check.id.slice("python.".length);
      return [
        command("python", executable, ["-I", "--version"]),
        command(name, executable, [
          "-I",
          "-B",
          "-c",
          `from importlib.metadata import version; print(version('${name}'))`,
        ]),
      ];
    }

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
    if (check.id === "python.pyright")
      tools.push(
        { name: "node", source: "engine-runtime" },
        {
          name: "pyright",
          source: "package-metadata",
          path:
            (await localTool(root, check.project, "pyright/package.json")) ??
            null,
        },
      );
    if (check.id === "python.ruff")
      tools.push(command("ruff", "ruff", ["--version"]));
    if (check.id === "python.fastapi-routes")
      for (const name of check.commands[0]?.args[0] === "-I"
        ? ["fastapi", "starlette", "pydantic"]
        : ["fastapi", "starlette"])
        tools.push(
          command(name, "python3", [
            ...(check.commands[0]?.args[0] === "-I" ? ["-I"] : []),
            "-c",
            `from importlib.metadata import version; print(version(${JSON.stringify(name)}))`,
          ]),
        );
    if (
      check.id === "python.django-routes" &&
      check.commands[0]?.args[0] === "-I"
    )
      tools.push(
        command("asgiref", "python3", [
          "-I",
          "-c",
          "from importlib.metadata import version; print(version('asgiref'))",
        ]),
      );
    if (check.id === "python.django-routes")
      tools.push(
        command("django", "python3", [
          ...(check.commands[0]?.args[0] === "-I" ? ["-I"] : []),
          "-c",
          "from importlib.metadata import version; print(version('Django'))",
        ]),
      );
    return tools;
  }
  if (check.adapter === "go")
    return [
      command("go", "go", ["version"]),
      ...(["go.build", "go.golangci-lint"].includes(check.id)
        ? [{ name: "node", source: "engine-runtime" } as const]
        : []),
      ...(check.id === "go.golangci-lint"
        ? [command("golangci-lint", "golangci-lint", ["version", "--short"])]
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
      ...(check.id === "rust.cargo-test"
        ? [command("rustdoc", "rustdoc", ["--version"])]
        : []),
      ...(check.id === "rust.cargo-clippy"
        ? [command("clippy", "cargo-clippy", ["--version"])]
        : []),
      ...(check.id === "rust.cargo-fmt"
        ? [command("rustfmt", "rustfmt", ["--version"])]
        : []),
    ];
  if (check.adapter === "cpp") {
    if (
      check.parser === "cpp-tools-json" ||
      check.parser === "cpp-extensions-json"
    )
      return [
        { name: "node", source: "engine-runtime" },
        ...(check.parser === "cpp-extensions-json"
          ? cppExtensionsToolNames
          : cppToolNames
        ).map((name) =>
          command(
            name,
            name === "as" || name === "ld" ? "/usr/bin/" + name : name,
            name === "clang" || name === "clang++"
              ? ["--no-default-config", "--version"]
              : ["--version"],
          ),
        ),
      ];
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
  if (check.adapter === "swift" && check.id !== "swift.syntax")
    return [
      { name: "node", source: "engine-runtime" },
      ...["swift", "swiftpm", "swiftlint"].map((name) =>
        command(name, process.execPath, [
          fileURLToPath(new URL("./swift-version-runner.js", import.meta.url)),
          name,
        ]),
      ),
    ];
  if (check.adapter === "swift")
    return [command("swift", "swiftc", ["--version"])];
  if (check.id === "jvm.gradle-test" && check.commands[0])
    return [
      { name: "node", source: "engine-runtime" },
      command("java", process.execPath, [
        fileURLToPath(new URL("./java-runner.js", import.meta.url)),
        "--version",
      ]),
      command("gradle", process.execPath, [
        ...check.commands[0].args,
        "--version",
      ]),
    ];
  if (check.id === "jvm.maven-test" && check.commands[0])
    return [
      { name: "node", source: "engine-runtime" },
      command("java", process.execPath, [
        fileURLToPath(new URL("./java-runner.js", import.meta.url)),
        "--version",
      ]),
      command("maven", process.execPath, [
        ...check.commands[0].args,
        "--version",
      ]),
    ];
  if (check.id === "jvm.scala" && check.commands[0])
    return [
      { name: "node", source: "engine-runtime" },
      command("java", process.execPath, [
        fileURLToPath(new URL("./java-runner.js", import.meta.url)),
        "--version",
      ]),
      command(
        JSON.parse(check.commands[0].args[2]!).config.profile ===
          "linux-arm64-scala2-typed-class-v1"
          ? "scala2"
          : "scala",
        process.execPath,
        [...check.commands[0].args, "--version"],
      ),
    ];
  if (check.id === "jvm.kotlin" && check.commands[0])
    return [
      { name: "node", source: "engine-runtime" },
      command("java", process.execPath, [
        fileURLToPath(new URL("./java-runner.js", import.meta.url)),
        "--version",
      ]),
      command("kotlin", process.execPath, [
        ...check.commands[0].args,
        "--version",
      ]),
    ];
  if (check.id === "jvm.detekt" && check.commands[0])
    return [
      { name: "node", source: "engine-runtime" },
      command("java", process.execPath, [
        fileURLToPath(new URL("./java-runner.js", import.meta.url)),
        "--version",
      ]),
      command("detekt", process.execPath, [
        ...check.commands[0].args,
        "--version",
      ]),
    ];
  if (check.id === "jvm.spotbugs" && check.commands[0])
    return [
      { name: "node", source: "engine-runtime" },
      command("java", process.execPath, [
        fileURLToPath(new URL("./java-runner.js", import.meta.url)),
        "--version",
      ]),
      command("spotbugs", process.execPath, [
        ...check.commands[0].args,
        "--version",
      ]),
    ];
  if (check.id === "jvm.checkstyle" && check.commands[0])
    return [
      { name: "node", source: "engine-runtime" },
      command("java", process.execPath, [
        fileURLToPath(new URL("./java-runner.js", import.meta.url)),
        "--version",
      ]),
      command("checkstyle", process.execPath, [
        ...check.commands[0].args,
        "--version",
      ]),
    ];
  if (check.adapter === "jvm")
    return [
      { name: "node", source: "engine-runtime" },
      command("java", process.execPath, [
        fileURLToPath(new URL("./java-runner.js", import.meta.url)),
        "--version",
      ]),
    ];
  if (check.adapter === "ruby")
    return [
      ...(check.id === "ruby.syntax"
        ? []
        : [{ name: "node", source: "engine-runtime" } as const]),
      command("ruby", "ruby", ["--disable-gems", "--version"]),
    ];
  if (
    [
      "infrastructure.terraform-validate",
      "infrastructure.terraform-extensions",
    ].includes(check.id) &&
    check.commands[0]
  )
    return [
      { name: "node", source: "engine-runtime" },
      command("terraform", process.execPath, [
        ...check.commands[0].args,
        "--version",
      ]),
    ];
  if (
    ["infrastructure.helm", "infrastructure.helm-extensions"].includes(
      check.id,
    ) &&
    check.commands[0]
  )
    return [
      { name: "node", source: "engine-runtime" },
      command("helm", process.execPath, [
        ...check.commands[0].args,
        "--version",
      ]),
    ];
  if (check.id === "infrastructure.kustomize" && check.commands[0])
    return [
      { name: "node", source: "engine-runtime" },
      ...(["kustomize", "kubeconform"] as const).map((name) =>
        command(name, process.execPath, [
          ...check.commands[0]!.args,
          `--version=${name}`,
        ]),
      ),
    ];
  if (check.id === "infrastructure.kubeconform")
    return [
      { name: "node", source: "engine-runtime" },
      command("kubeconform", "kubeconform", ["-v"]),
    ];
  if (check.id === "infrastructure.actionlint")
    return [
      { name: "node", source: "engine-runtime" },
      command("actionlint", process.execPath, [
        fileURLToPath(new URL("./actionlint-runner.js", import.meta.url)),
        "--version",
      ]),
    ];
  if (
    [
      "dotnet.build",
      "dotnet.test",
      "dotnet.format-whitespace",
      "dotnet.format-extensions",
      "dotnet.generator-extensions",
    ].includes(check.id) &&
    check.commands[0]
  )
    return [
      { name: "node", source: "engine-runtime" },
      command("dotnet", process.execPath, [
        ...check.commands[0].args,
        "--version",
      ]),
    ];
  if (check.id === "dotnet.format-fsharp")
    return [
      { name: "node", source: "engine-runtime" },
      ...(check.commands[0]
        ? [
            command("fantomas", process.execPath, [
              ...check.commands[0].args,
              "--version",
            ]),
          ]
        : []),
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
    if (check.id === "php.extensions") {
      for (const [name, selected] of [
        ["phpstan", "phpstan/phpstan"],
        ["larastan", "larastan/larastan"],
        ["php-cs-fixer", "friendsofphp/php-cs-fixer"],
        ["laravel", "laravel/framework"],
      ]) {
        tools.push({
          name: name!,
          source: "package-metadata",
          path: path.resolve(
            root,
            check.project,
            "vendor/composer/installed.json",
          ),
          package: selected!,
        });
      }
    }
    if (check.id === "php.laravel-runtime" && check.commands[0]?.args[2]) {
      const assembly = check.commands[0].args[0] === "-d";
      tools.push(
        command(
          "laravel",
          "php",
          assembly
            ? [
                ...laravelAssemblyPhpFlags,
                laravelAssemblyVersionRunner,
                check.commands[0].args[laravelAssemblyPhpFlags.length + 1]!,
              ]
            : [
                "-r",
                "require $argv[1]; echo Illuminate\\Foundation\\Application::VERSION;",
                check.commands[0].args[2],
              ],
        ),
      );
    }
    if (check.id === "php.php-cs-fixer" && check.commands[0]?.args[3])
      tools.push(
        command("php-cs-fixer", "php", [
          "-r",
          "require $argv[1]; echo PhpCsFixer\\Console\\Application::VERSION;",
          "--",
          check.commands[0].args[3],
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
      if (tool.package !== undefined) {
        if (
          typeof value !== "object" ||
          value === null ||
          !("packages" in value) ||
          !Array.isArray(value.packages)
        )
          return result;
        const matches = value.packages.filter(
          (entry: unknown) =>
            typeof entry === "object" &&
            entry !== null &&
            "name" in entry &&
            entry.name === tool.package,
        );
        if (matches.length !== 1 || typeof matches[0].version !== "string")
          return result;
        const version = matches[0].version.replace(/^v/, "");
        if (version.length <= 128 && versionPattern.test(version))
          return { ...result, version, status: "identified" };
        return result;
      }
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
    tool.name === "helm" &&
    path.basename(tool.command?.args[0] ?? "") ===
      "helm-extensions-runner.js" &&
    execution.exitCode === 3 &&
    !execution.signal &&
    !execution.errorCode &&
    !execution.cancelled &&
    !execution.timedOut &&
    !execution.truncated &&
    !execution.stderr &&
    execution.stdout ===
      JSON.stringify({
        unavailable: "helm-extensions",
        reason: "pinned-prerequisite",
      }) +
        "\n"
  )
    return { ...result, status: "unavailable" };

  if (
    tool.name === "terraform" &&
    path.basename(tool.command?.args[0] ?? "") ===
      "terraform-extensions-runner.js" &&
    execution.exitCode === 3 &&
    !execution.signal &&
    !execution.errorCode &&
    !execution.cancelled &&
    !execution.timedOut &&
    !execution.truncated &&
    !execution.stderr &&
    execution.stdout ===
      JSON.stringify({
        unavailable: "terraform-extensions",
        reason: "pinned-prerequisite",
      }) +
        "\n"
  )
    return { ...result, status: "unavailable" };
  if (
    (tool.name === "terraform" ||
      tool.name === "helm" ||
      (["kustomize", "kubeconform"].includes(tool.name) &&
        path.basename(tool.command?.args[0] ?? "") ===
          "kustomize-runner.js")) &&
    execution.exitCode === 3 &&
    !execution.signal &&
    !execution.errorCode &&
    !execution.cancelled &&
    !execution.timedOut &&
    !execution.truncated &&
    !execution.stderr &&
    execution.stdout ===
      JSON.stringify({
        unavailable:
          tool.name === "helm"
            ? "helm-toolchain"
            : tool.name === "terraform"
              ? "terraform-toolchain"
              : "kustomize-toolchain",
      })
  )
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
  if (tool.name === "fantomas") {
    const verified =
      !execution.stderr &&
      output === "Fantomas 8.0.7 (SDK 10.0.401; runtime 10.0.12)";
    return {
      ...result,
      status: verified ? "identified" : "inconclusive",
      version: verified ? "8.0.7" : null,
    };
  }
  if (tool.name === "helm") {
    const verified = !execution.stderr && output === "v4.3.0";
    return {
      ...result,
      status: verified ? "identified" : "inconclusive",
      version: verified ? "4.3.0" : null,
    };
  }
  if (
    [
      "clang-format",
      "clang-tidy",
      "llvm-dwarfdump",
      "llvm-ar",
      "llvm-ranlib",
      "llvm-readelf",
      "as",
      "ld",
      "cmake",
      "ctest",
      "make",
    ].includes(tool.name)
  ) {
    const verified =
      !execution.stderr.trim() &&
      (tool.name === "as" || tool.name === "ld"
        ? cppExtensionsSupportedVersion(tool.name, output)
        : cppSupportedVersion(tool.name, output));
    return {
      ...result,
      status: verified ? "identified" : "inconclusive",
      version: verified
        ? ["cmake", "ctest"].includes(tool.name)
          ? "4.2.3"
          : tool.name === "make"
            ? "4.4.1"
            : tool.name === "as" || tool.name === "ld"
              ? "2.45.1"
              : "22.1.3"
        : null,
    };
  }
  const version =
    tool.name === "kustomize"
      ? /^v(5\.8\.2)$/.exec(output)?.[1]
      : tool.name === "terraform"
        ? /^Terraform v(1\.16\.5)$/.exec(output)?.[1]
        : tool.name === "kubeconform"
          ? /^v(0\.8\.0)$/.exec(output)?.[1]
          : tool.name === "java"
            ? /^openjdk (\d+\.\d+\.\d+) \d{4}-\d{2}-\d{2} LTS\nOpenJDK Runtime Environment [^\n]+\nOpenJDK 64-Bit Server VM [^\n]+$/.exec(
                output,
              )?.[1]
            : tool.name === "gradle"
              ? /^(?:Welcome to Gradle 9\.8\.0!\n\nHere are the highlights of this release:\n - Java 27 support\n - Maven mirror settings reuse\n - Linked problem locations in build output\n\nFor more details see https:\/\/docs\.gradle\.org\/9\.8\.0\/release-notes\.html\n\n\n)?-+\nGradle (9\.8\.0)\n-+\n\nBuild time: +2026-09-24 13:40:00 UTC\nRevision: +a927be5e08efe79e0b87ada06c762dde6bb9f8b8\n\nKotlin: +2\.4\.10\nGroovy: +4\.0\.33\nAnt: +Apache Ant\(TM\) version 1\.10\.17 compiled on April 6 2026\nLauncher JVM: +25\.0\.4 \(Eclipse Adoptium 25\.0\.4\+7-LTS\)\nDaemon JVM: +[^\n]+\nOS: +[^\n]+$/.exec(
                  output,
                )?.[1]
              : tool.name === "maven"
                ? /^Apache Maven (3\.10\.0) \([a-f0-9]{40}\)\nMaven home: [^\n]+\nJava version: 25\.0\.4, vendor: Eclipse Adoptium, runtime: [^\n]+\nDefault locale: [^\n]+\nOS name: [^\n]+$/.exec(
                    output,
                  )?.[1]
                : tool.name === "spotbugs"
                  ? /^SpotBugs (4\.10\.4)$/.exec(output)?.[1]
                  : tool.name === "scala2"
                    ? /^Scala compiler (2\.13\.18)$/.exec(output)?.[1]
                    : tool.name === "scala"
                      ? /^Scala compiler (3\.9\.0)$/.exec(output)?.[1]
                      : tool.name === "kotlin"
                        ? /^Kotlin compiler (2\.4\.10)$/.exec(output)?.[1]
                        : tool.name === "detekt"
                          ? /^(2\.0\.0-alpha\.6)$/.exec(output)?.[1]
                          : tool.name === "checkstyle"
                            ? /^Checkstyle version: (\d+\.\d+\.\d+)$/.exec(
                                output,
                              )?.[1]
                            : tool.name === "clang" || tool.name === "clang++"
                              ? clangVersion(output)
                              : tool.name === "swift"
                                ? /^(?:Apple )?Swift version (\d+\.\d+(?:\.\d+)?) \([^\r\n]+\)\r?\nTarget: [a-zA-Z0-9_.-]+$/.exec(
                                    output,
                                  )?.[1]
                                : tool.name === "ruby"
                                  ? /^ruby (\d+\.\d+\.\d+)(?:p\d+)? /.exec(
                                      output,
                                    )?.[1]
                                  : tool.name === "clippy"
                                    ? /^clippy (\S+) \([a-f0-9]+ [0-9-]+\)$/.exec(
                                        output,
                                      )?.[1]
                                    : tool.name === "rustfmt"
                                      ? /^rustfmt (\S+) \([a-f0-9]+ [0-9-]+\)$/.exec(
                                          output,
                                        )?.[1]
                                      : tool.name === "cargo" ||
                                          tool.name === "rustc" ||
                                          tool.name === "rustdoc"
                                        ? output.startsWith(`${tool.name} `)
                                          ? /^(?:cargo|rustc|rustdoc) (\S+) \([a-f0-9]+ [0-9-]+\)$/.exec(
                                              output,
                                            )?.[1]
                                          : undefined
                                        : tool.name === "php-cs-fixer"
                                          ? /^(3\.[0-9]+\.[0-9]+)$/.exec(
                                              output,
                                            )?.[1]
                                          : tool.name === "pint"
                                            ? /^Pint (\S+)$/.exec(output)?.[1]
                                            : tool.name === "pest"
                                              ? /^Pest Testing Framework (\S+)\.$/.exec(
                                                  output,
                                                )?.[1]
                                              : tool.name === "phpunit"
                                                ? /^PHPUnit (\S+) by .+$/.exec(
                                                    output,
                                                  )?.[1]
                                                : tool.name === "phpstan"
                                                  ? /^PHPStan - PHP Static Analysis Tool (\S+)$/.exec(
                                                      output,
                                                    )?.[1]
                                                  : tool.name === "staticcheck"
                                                    ? /^staticcheck \S+ \((\d+\.\d+\.\d+)\)$/.exec(
                                                        output,
                                                      )?.[1]
                                                    : tool.name === "go"
                                                      ? /^go version go(\S+) \S+$/.exec(
                                                          output,
                                                        )?.[1]
                                                      : tool.name === "php"
                                                        ? /^PHP (\S+) /.exec(
                                                            output,
                                                          )?.[1]
                                                        : tool.name === "python"
                                                          ? /^Python (\S+)$/.exec(
                                                              output,
                                                            )?.[1]
                                                          : tool.name === "ruff"
                                                            ? /^ruff (\S+)$/.exec(
                                                                output,
                                                              )?.[1]
                                                            : tool.name ===
                                                                "swiftpm"
                                                              ? /^Swift Package Manager - Swift (\d+\.\d+\.\d+)$/.exec(
                                                                  output,
                                                                )?.[1]
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
