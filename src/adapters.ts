import { applyRustBuildPolicy } from "./rust-build.js";
import { applyGoBuildPolicy } from "./go-build.js";
import { applyGoScopePolicy } from "./go-scope-policy.js";
import type { ExternalAdapter } from "./external-adapter.js";
import { actionlintCheck, workflowRoot } from "./actionlint.js";
import { cppToolsCheck } from "./cpp-tools.js";
import { terraformCheck } from "./terraform.js";
import { kubeconformCheck } from "./kubeconform.js";
import { clangCheck } from "./clang.js";
import { javaCheck } from "./java.js";
import { checkstyleCheck } from "./checkstyle.js";
import { mavenCheck } from "./maven.js";
import { gradleCheck } from "./gradle.js";
import { dotnetCheck } from "./dotnet.js";
import {
  dotnetBuildCheck,
  dotnetTestCheck,
  dotnetFormatCheck,
} from "./dotnet-build.js";
import { swiftCheck } from "./swift.js";
import { swiftToolsCheck } from "./swift-tools.js";
import { rubyCheck } from "./ruby.js";
import { rubyToolsCheck } from "./ruby-tools.js";
import { rustCheck, rustTestCheck } from "./rust.js";
import { rustfmtCheck } from "./rustfmt.js";
import { golangciCheck } from "./golangci.js";
import { fastapiCheck } from "./fastapi.js";
import { laravelCheck } from "./laravel.js";
import { djangoCheck } from "./django.js";
import { nuxtCheck } from "./nuxt.js";
import { vueRouterCheck } from "./vue-router.js";
import { goEnvironment, goScopeCommand } from "./go-scope.js";
import { pintCheck } from "./pint.js";
import { phpCsFixerCheck } from "./php-cs-fixer.js";
import path from "node:path";
import { phpunitCheck } from "./phpunit.js";
import { phpstanCheck } from "./phpstan.js";
import { pyrightCheck } from "./pyright.js";
import { mypyCheck } from "./mypy.js";
import { ruffCheck } from "./ruff.js";
import { pytestCheck } from "./pytest.js";
import { fileURLToPath } from "node:url";
import { readProjectFile } from "./inventory.js";
import { typescriptBuildCheck } from "./typescript-build.js";
import { typescriptCheck } from "./typescript.js";
import { eslintCheck } from "./eslint.js";
import { playwrightCheck } from "./playwright.js";
import { jestCheck } from "./jest.js";
import { vitestCheck } from "./vitest.js";
import type { Check, Inventory, Project } from "./types.js";

export const adapters = [
  {
    id: "javascript",
    markers: ["package.json"],
    checks: [
      "javascript.node-test",
      "javascript.typescript",
      "javascript.typescript-build",
      "javascript.vue-tsc",
      "javascript.vue-router",
      "javascript.nuxt-runtime",
      "javascript.eslint",
      "javascript.vitest",
      "javascript.jest",
      "javascript.playwright",
    ],
  },
  {
    id: "python",
    markers: [
      "pyproject.toml",
      "pyrightconfig.json",
      "setup.py",
      "requirements.txt",
    ],
    checks: [
      "python.unittest",
      "python.pytest",
      "python.ruff",
      "python.mypy",
      "python.pyright",
      "python.fastapi-routes",
      "python.django-routes",
    ],
  },
  {
    id: "go",
    markers: ["go.mod"],
    checks: [
      "go.format",
      "go.build",
      "go.vet",
      "go.test",
      "go.test-race",
      "go.staticcheck",
      "go.golangci-lint",
    ],
  },
  {
    id: "php",
    markers: ["composer.json"],
    checks: [
      "php.syntax",
      "php.phpstan",
      "php.phpunit",
      "php.pest",
      "php.pint",
      "php.php-cs-fixer",
      "php.laravel-runtime",
    ],
  },
  {
    id: "rust",
    markers: ["Cargo.toml"],
    checks: [
      "rust.cargo-check",
      "rust.cargo-fmt",
      "rust.cargo-clippy",
      "rust.cargo-test",
    ],
  },
  {
    id: "jvm",
    markers: ["pom.xml", "build.gradle", "build.gradle.kts"],
    checks: [
      "jvm.javac",
      "jvm.checkstyle",
      "jvm.maven-test",
      "jvm.gradle-test",
    ],
  },
  {
    id: "dotnet",
    markers: [],
    checks: [
      "dotnet.csharp",
      "dotnet.build",
      "dotnet.test",
      "dotnet.format-whitespace",
    ],
  },
  {
    id: "ruby",
    markers: ["Gemfile"],
    checks: ["ruby.syntax", "ruby.rubocop", "ruby.rspec", "ruby.minitest"],
  },
  {
    id: "swift",
    markers: ["Package.swift"],
    checks: ["swift.syntax", "swift.build", "swift.test", "swift.swiftlint"],
  },
  {
    id: "cpp",
    markers: ["CMakeLists.txt", "meson.build", "compile_commands.json"],
    checks: [
      "cpp.clang-check",
      "cpp.build",
      "cpp.ctest",
      "cpp.clang-format",
      "cpp.clang-tidy",
    ],
  },
  {
    id: "infrastructure",
    markers: [
      "Chart.yaml",
      "kustomization.yaml",
      "checktrail.kubeconform.json",
      "checktrail.terraform.json",
    ],
    checks: [
      "infrastructure.actionlint",
      "infrastructure.kubeconform",
      "infrastructure.terraform-validate",
    ],
  },
] as const;

function matches(
  adapter: { id: string; markers: readonly string[] },
  name: string,
): boolean {
  return (
    (adapter.markers as readonly string[]).includes(name) ||
    (adapter.id === "dotnet" &&
      /\.(csproj|fsproj|vbproj|sln|slnx)$/.test(name)) ||
    (adapter.id === "ruby" && name.endsWith(".gemspec")) ||
    (adapter.id === "infrastructure" &&
      (name.endsWith(".tf") || name.endsWith(".tf.json")))
  );
}

export function discover(
  source: Inventory,
  external: ExternalAdapter[] = [],
): Project[] {
  const found = new Map<string, Project>();
  for (const file of source.files) {
    const name = path.posix.basename(file);
    for (const adapter of [
      ...adapters,
      ...external.map((item) => ({
        id: item.identity.id,
        markers: item.manifest.markers,
      })),
    ]) {
      const workflow =
        adapter.id === "infrastructure" ? workflowRoot(file) : undefined;
      if (!matches(adapter, name) && workflow === undefined) continue;
      const directory = workflow ?? path.posix.dirname(file);
      const key = `${directory}:${adapter.id}`;
      const project = found.get(key) ?? {
        path: directory,
        adapter: adapter.id,
        markers: [],
        files: [],
      };
      project.markers.push(file);
      found.set(key, project);
    }
  }
  const projects = [...found.values()].sort((a, b) =>
    `${a.path}:${a.adapter}`.localeCompare(`${b.path}:${b.adapter}`, "en"),
  );
  for (const project of projects) {
    const prefix = project.path === "." ? "" : `${project.path}/`;
    const children = projects.filter(
      (child) => child.path !== project.path && child.path.startsWith(prefix),
    );
    project.files = source.files
      .filter(
        (file) =>
          file.startsWith(prefix) &&
          !children.some((child) => file.startsWith(`${child.path}/`)),
      )
      .map((file) => file.slice(prefix.length));
  }
  return projects;
}

export async function checksFor(
  source: Inventory,
  project: Project,
  requested?: readonly string[],
): Promise<Check[]> {
  const explicit = requested !== undefined;
  const base = {
    adapter: project.adapter,
    project: project.path,
    scope: project.files,
    commands: [],
    parser: "exit" as const,
  };
  if (project.adapter === "javascript") {
    const manifest: unknown = JSON.parse(
      await readProjectFile(
        source.root,
        path.posix.join(project.path, "package.json"),
      ),
    );
    const scripts =
      typeof manifest === "object" && manifest !== null && "scripts" in manifest
        ? manifest.scripts
        : undefined;
    const script =
      typeof scripts === "object" && scripts !== null && "test" in scripts
        ? scripts.test
        : undefined;
    const files = project.files.filter((file) =>
      /\.(test|spec)\.[cm]?js$/.test(file),
    );
    const reason =
      "Run JavaScript tests with the native Node runner; TypeScript and framework runners need separate adapters.";
    const check: Check = {
      ...base,
      id: "javascript.node-test",
      kind: "test",
      parser: "node-events",
      scope: files,
      reason,
      commands: [
        {
          executable: process.execPath,
          args: [
            "--test",
            `--test-reporter=${fileURLToPath(new URL("./node-reporter.js", import.meta.url))}`,
            ...files.map((file) => `./${file}`),
          ],
          cwd: project.path,
        },
      ],
    };
    if (!explicit && script !== "node --test") {
      check.unavailableReason =
        "Node runner is not explicitly selected. Set scripts.test to node --test or select javascript.node-test in policy after verifying the runner.";
    } else if (files.length === 0) {
      check.unavailableReason =
        "No .test.js/.spec.js (or .mjs/.cjs) files were discovered.";
    }
    return explicit
      ? [
          check,
          await typescriptCheck(source, project),
          await typescriptBuildCheck(source, project),
          await typescriptCheck(source, project, true),
          ...(requested?.includes("javascript.nuxt-runtime")
            ? [await nuxtCheck(source, project)]
            : []),
          ...(requested?.includes("javascript.vue-router")
            ? [await vueRouterCheck(source, project)]
            : []),
          await eslintCheck(source, project),
          await vitestCheck(source, project),
          await jestCheck(source, project),
          await playwrightCheck(source, project),
        ]
      : [check];
  }
  if (project.adapter === "python") {
    const files = project.files.filter((file) =>
      /(^|\/)test[^/]*\.py$/.test(file),
    );
    const start = files.some((file) => file.startsWith("tests/"))
      ? "tests"
      : ".";
    const check: Check = {
      ...base,
      id: "python.unittest",
      kind: "test",
      parser: "unittest",
      scope: files,
      commands: [
        {
          executable: "python3",
          args: ["-m", "unittest", "discover", "-s", start, "-p", "test*.py"],
          cwd: project.path,
          env: { PYTHONDONTWRITEBYTECODE: "1" },
        },
      ],
      reason:
        "Use the standard-library unittest runner only when explicitly selected.",
    };
    if (!explicit)
      check.unavailableReason =
        "Select python.unittest explicitly; a Python manifest does not identify its test framework.";
    else if (files.length === 0)
      check.unavailableReason = "No unittest candidate files were discovered.";
    return explicit
      ? [
          check,
          pytestCheck(project),
          ruffCheck(project),
          mypyCheck(project),
          await pyrightCheck(source, project),
          ...(requested?.includes("python.fastapi-routes")
            ? [await fastapiCheck(source, project)]
            : []),
          ...(requested?.includes("python.django-routes")
            ? [await djangoCheck(source, project)]
            : []),
        ]
      : [check];
  }
  if (project.adapter === "go") {
    const goFiles = project.files.filter((file) => file.endsWith(".go"));
    const env = goEnvironment;
    const format: Check = {
      ...base,
      id: "go.format",
      kind: "format",
      parser: "empty",
      scope: goFiles,
      commands: goFiles.map((file) => ({
        executable: "gofmt",
        args: ["-l", `./${file}`],
        cwd: project.path,
      })),
      reason:
        "Check formatting of inventoried Go files without rewriting them.",
    };
    if (!goFiles.length)
      format.unavailableReason = "No Go files were discovered.";
    const checks: Check[] = [
      format,
      {
        ...base,
        id: "go.vet",
        kind: "analysis",
        parser: "go-scope-analysis",
        scope: goFiles,
        commands: [
          goScopeCommand(project.path),
          { executable: "go", args: ["vet", "./..."], cwd: project.path, env },
        ],
        reason:
          "Vet the whole Go module; dependency downloads and module edits are disabled.",
      },
      {
        ...base,
        id: "go.test",
        kind: "test",
        parser: "go-scope-test",
        scope: goFiles,
        commands: [
          goScopeCommand(project.path),
          {
            executable: "go",
            args: ["test", "-json", "-count=1", "./..."],
            cwd: project.path,
            env,
          },
        ],
        reason:
          "Run module tests without cached results and parse test events.",
      },
    ];
    if (explicit && requested?.includes("go.build"))
      checks.push({
        ...base,
        id: "go.build",
        kind: "analysis",
        parser: "go-build",
        scope: goFiles.filter((file) => !file.endsWith("_test.go")),
        commands: [
          goScopeCommand(project.path),
          {
            executable: process.execPath,
            args: [
              fileURLToPath(new URL("./go-build-runner.js", import.meta.url)),
              "[]",
            ],
            cwd: project.path,
            env,
            temporaryDirectory: true,
          },
        ],
        reason:
          "Compile production Go packages and link mains into owned temporary outputs; test files are outside this build check.",
      });
    if (explicit)
      checks.push({
        ...base,
        id: "go.test-race",
        kind: "test",
        parser: "go-scope-test",
        scope: goFiles,
        commands: [
          goScopeCommand(
            project.path,
            {
              ...env,
              CGO_ENABLED: "1",
              GORACE: "exitcode=66 log_path=stderr",
            },
            true,
          ),
          {
            executable: "go",
            args: ["test", "-race", "-json", "-count=1", "./..."],
            cwd: project.path,
            env: {
              ...env,
              CGO_ENABLED: "1",
              GORACE: "exitcode=66 log_path=stderr",
            },
          },
        ],
        reason:
          "Run uncached module tests with the native race detector; requires a supported platform and C compiler.",
      });
    if (explicit)
      checks.push({
        ...base,
        id: "go.staticcheck",
        kind: "analysis",
        parser: "staticcheck-json",
        scope: goFiles,
        commands: [
          goScopeCommand(project.path),
          {
            executable: "staticcheck",
            args: [
              "-f",
              "json",
              "-checks=all",
              "-fail=all",
              "-show-ignored",
              "-tests=true",
              "./...",
            ],
            cwd: project.path,
            env,
          },
        ],
        reason:
          "Run installed Staticcheck with all checks, surfaced suppressions and native Go file accounting.",
      });
    if (explicit) checks.push(await golangciCheck(source, project));
    await applyGoScopePolicy(source, project, checks);
    await applyGoBuildPolicy(source, project, checks);
    return checks;
  }
  if (project.adapter === "infrastructure") {
    const workflow = project.markers.some(
      (file) => workflowRoot(file) === project.path,
    );
    const other = project.markers.filter(
      (file) =>
        workflowRoot(file) !== project.path &&
        path.posix.basename(file) !== "checktrail.kubeconform.json" &&
        path.posix.basename(file) !== "checktrail.terraform.json" &&
        !(
          project.files.includes("checktrail.terraform.json") &&
          file.endsWith(".tf.json")
        ),
    );
    return [
      ...(project.files.includes("checktrail.terraform.json") ||
      requested?.includes("infrastructure.terraform-validate")
        ? [await terraformCheck(source, project)]
        : []),
      ...(project.files.includes("checktrail.kubeconform.json") ||
      requested?.includes("infrastructure.kubeconform")
        ? [await kubeconformCheck(source, project)]
        : []),
      ...(workflow || requested?.includes("infrastructure.actionlint")
        ? [await actionlintCheck(source, project)]
        : []),
      ...(!explicit && other.length
        ? [
            {
              ...base,
              id: "infrastructure.unsupported",
              kind: "unsupported" as const,
              scope: other.map((file) =>
                path.posix.relative(project.path, file),
              ),
              reason:
                "Terraform, Helm and Kustomize execution require separate verified profiles.",
              unavailableReason:
                "No registered execution profile for these infrastructure inputs.",
            },
          ]
        : []),
    ];
  }
  if (project.adapter === "cpp")
    return [
      await clangCheck(source, project),
      ...(project.files.includes("checktrail.cpp-tools.json") ||
      requested?.some((id) =>
        /^cpp\.(?:build|ctest|clang-format|clang-tidy)$/.test(id),
      )
        ? await Promise.all(
            (["build", "ctest", "clang-format", "clang-tidy"] as const)
              .filter((mode) => !requested || requested.includes(`cpp.${mode}`))
              .map((mode) => cppToolsCheck(source, project, mode)),
          )
        : []),
    ];
  if (project.adapter === "jvm")
    return [
      await javaCheck(source, project),
      ...(requested?.includes("jvm.gradle-test")
        ? [await gradleCheck(source, project)]
        : []),
      ...(requested?.includes("jvm.maven-test")
        ? [await mavenCheck(source, project)]
        : []),
      ...(requested?.includes("jvm.checkstyle")
        ? [await checkstyleCheck(source, project)]
        : []),
    ];
  if (project.adapter === "dotnet")
    return [
      await dotnetCheck(source, project),
      ...(requested?.includes("dotnet.build")
        ? [await dotnetBuildCheck(source, project)]
        : []),
      ...(requested?.includes("dotnet.format-whitespace")
        ? [await dotnetFormatCheck(source, project)]
        : []),
      ...(requested?.includes("dotnet.test")
        ? [await dotnetTestCheck(source, project)]
        : []),
    ];
  if (project.adapter === "swift")
    return [
      swiftCheck(project),
      ...(project.files.includes("checktrail.swift-tools.json") ||
      requested?.some((id) => /^swift\.(?:build|test|swiftlint)$/.test(id))
        ? await Promise.all(
            (["build", "test", "swiftlint"] as const)
              .filter(
                (mode) => !requested || requested.includes(`swift.${mode}`),
              )
              .map((mode) => swiftToolsCheck(source, project, mode)),
          )
        : []),
    ];
  if (project.adapter === "ruby")
    return [
      rubyCheck(project),
      ...(project.files.includes("checktrail.ruby-tools.json") ||
      requested?.some((id) => /^ruby\.(?:rubocop|rspec|minitest)$/.test(id))
        ? await Promise.all(
            (["rubocop", "rspec", "minitest"] as const)
              .filter(
                (mode) => !requested || requested.includes(`ruby.${mode}`),
              )
              .map((mode) => rubyToolsCheck(source, project, mode)),
          )
        : []),
    ];
  if (project.adapter === "rust") {
    const checks = [
      rustCheck(source, project),
      ...(requested?.includes("rust.cargo-test")
        ? [rustTestCheck(source, project)]
        : []),
      ...(requested?.includes("rust.cargo-clippy")
        ? [rustCheck(source, project, true)]
        : []),
      ...(requested?.includes("rust.cargo-fmt")
        ? [rustfmtCheck(source, project)]
        : []),
    ];
    await applyRustBuildPolicy(source, project, checks);
    return checks;
  }
  if (project.adapter === "php") {
    const files = project.files.filter((file) => file.endsWith(".php"));
    const check: Check = {
      ...base,
      id: "php.syntax",
      kind: "syntax",
      scope: files,
      commands: files.map((file) => ({
        executable: "php",
        args: ["-n", "-l", `./${file}`],
        cwd: project.path,
      })),
      reason:
        "Lint PHP syntax without loading php.ini; this provides no test or type evidence.",
    };
    if (!files.length)
      check.unavailableReason = "No PHP files were discovered.";
    return explicit
      ? [
          check,
          await phpstanCheck(source, project),
          await phpunitCheck(source, project),
          await phpunitCheck(source, project, true),
          await pintCheck(source, project),
          await phpCsFixerCheck(source, project),
          ...(requested?.includes("php.laravel-runtime")
            ? [await laravelCheck(source, project)]
            : []),
        ]
      : [check];
  }
  return [
    {
      ...base,
      id: `${project.adapter}.unsupported`,
      kind: "unsupported",
      reason:
        "This ecosystem is detected but execution support is not implemented.",
      unavailableReason: "No registered execution adapter for this ecosystem.",
    },
  ];
}
