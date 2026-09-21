import type { ExternalAdapter } from "./external-adapter.js";
import { actionlintCheck, workflowRoot } from "./actionlint.js";
import { clangCheck } from "./clang.js";
import { javaCheck } from "./java.js";
import { dotnetCheck } from "./dotnet.js";
import { swiftCheck } from "./swift.js";
import { rubyCheck } from "./ruby.js";
import { rustCheck } from "./rust.js";
import { golangciCheck } from "./golangci.js";
import { fastapiCheck } from "./fastapi.js";
import { laravelCheck } from "./laravel.js";
import { djangoCheck } from "./django.js";
import { nuxtCheck } from "./nuxt.js";
import { vueRouterCheck } from "./vue-router.js";
import { goEnvironment, goScopeCommand } from "./go-scope.js";
import { pintCheck } from "./pint.js";
import path from "node:path";
import { phpunitCheck } from "./phpunit.js";
import { phpstanCheck } from "./phpstan.js";
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
    markers: ["pyproject.toml", "setup.py", "requirements.txt"],
    checks: [
      "python.unittest",
      "python.pytest",
      "python.ruff",
      "python.mypy",
      "python.fastapi-routes",
      "python.django-routes",
    ],
  },
  {
    id: "go",
    markers: ["go.mod"],
    checks: [
      "go.format",
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
      "php.laravel-runtime",
    ],
  },
  { id: "rust", markers: ["Cargo.toml"], checks: ["rust.cargo-check"] },
  {
    id: "jvm",
    markers: ["pom.xml", "build.gradle", "build.gradle.kts"],
    checks: ["jvm.javac"],
  },
  { id: "dotnet", markers: [], checks: ["dotnet.csharp"] },
  { id: "ruby", markers: ["Gemfile"], checks: ["ruby.syntax"] },
  { id: "swift", markers: ["Package.swift"], checks: ["swift.syntax"] },
  {
    id: "cpp",
    markers: ["CMakeLists.txt", "meson.build", "compile_commands.json"],
    checks: ["cpp.clang-check"],
  },
  {
    id: "infrastructure",
    markers: ["Chart.yaml", "kustomization.yaml"],
    checks: ["infrastructure.actionlint"],
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
    (adapter.id === "infrastructure" && name.endsWith(".tf"))
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
    if (explicit)
      checks.push({
        ...base,
        id: "go.test-race",
        kind: "test",
        parser: "go-scope-test",
        scope: goFiles,
        commands: [
          goScopeCommand(project.path, {
            ...env,
            CGO_ENABLED: "1",
            GORACE: "exitcode=66 log_path=stderr",
          }),
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
    return checks;
  }
  if (project.adapter === "infrastructure") {
    const workflow = project.markers.some(
      (file) => workflowRoot(file) === project.path,
    );
    const other = project.markers.filter(
      (file) => workflowRoot(file) !== project.path,
    );
    return [
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
  if (project.adapter === "cpp") return [await clangCheck(source, project)];
  if (project.adapter === "jvm") return [await javaCheck(source, project)];
  if (project.adapter === "dotnet") return [await dotnetCheck(source, project)];
  if (project.adapter === "swift") return [swiftCheck(project)];
  if (project.adapter === "ruby") return [rubyCheck(project)];
  if (project.adapter === "rust") return [rustCheck(source, project)];
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
