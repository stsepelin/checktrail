import { constants } from "node:fs";
import {
  access,
  link,
  lstat,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { adapters, checksFor } from "./adapters.js";
import { configSchema, type Config } from "./config.js";
import { createPlan, type PlanOptions } from "./engine.js";
import { inventory, readProjectFile } from "./inventory.js";
import { identifyTool } from "./tool-versions.js";
import { VERSION } from "./types.js";

async function configurationExists(root: string): Promise<boolean> {
  try {
    const entry = await lstat(path.join(root, "checktrail.json"));
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new Error(
        "checktrail.json must be a regular file, not a symlink or directory",
      );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export interface InitOptions {
  write?: boolean;
  selections?: { path: string; checks: string[] }[];
}

export interface InitResult {
  schemaVersion: 1;
  engineVersion: string;
  status: "preview" | "created" | "preserved" | "needs-selection";
  configuration: Config | null;
  unresolved: { path: string; adapter: string; choices: string[] }[];
  executionEnabled: false;
}

export async function initialize(
  root: string,
  options: InitOptions = {},
): Promise<InitResult> {
  root = await realpath(root);
  const exists = await configurationExists(root);
  const { source, plan } = await createPlan(root);
  const result: InitResult = {
    schemaVersion: 1,
    engineVersion: VERSION,
    status: "preview",
    configuration: null,
    unresolved: [],
    executionEnabled: false,
  };
  if (exists) {
    if (options.selections?.length)
      throw new Error(
        "Existing configuration is preserved; edit its policy explicitly to change checks",
      );
    return { ...result, status: "preserved" };
  }
  const selected = new Map<string, string[]>();
  for (const selection of options.selections ?? []) {
    if (selected.has(selection.path))
      throw new Error("Duplicate selection path");
    if (
      !selection.checks.length ||
      new Set(selection.checks).size !== selection.checks.length
    )
      throw new Error("Selections require nonempty, unique check IDs");
    selected.set(selection.path, selection.checks);
  }
  for (const selectedPath of selected.keys())
    if (!plan.projects.some((project) => project.path === selectedPath))
      throw new Error("Selection does not match a discovered project path");
  const grouped = new Map<string, Set<string>>();
  for (const project of plan.projects) {
    const registered = adapters.find(
      (adapter) => adapter.id === project.adapter,
    )!.checks as readonly string[];
    const requested = selected.get(project.path);
    let ids = requested?.filter((id) => registered.includes(id));
    if (!requested) {
      ids = plan.checks
        .filter(
          (check) =>
            check.project === project.path &&
            check.adapter === project.adapter &&
            registered.includes(check.id),
        )
        .map((check) => check.id);
      if (project.adapter === "python") ids = [];
      if (project.adapter === "javascript") {
        const manifest = JSON.parse(
          await readProjectFile(
            root,
            path.posix.join(project.path, "package.json"),
          ),
        ) as { scripts?: { test?: unknown } };
        const runners: Record<string, string> = {
          "node --test": "javascript.node-test",
          "vitest run": "javascript.vitest",
          jest: "javascript.jest",
          "playwright test": "javascript.playwright",
        };
        const script = manifest?.scripts?.test;
        ids =
          typeof script === "string" && Object.hasOwn(runners, script)
            ? [runners[script]!]
            : [];
      }
    }
    if (
      !ids?.length ||
      plan.checks.some(
        (check) =>
          check.project === project.path &&
          check.adapter === project.adapter &&
          check.kind === "unsupported",
      )
    ) {
      result.unresolved.push({
        path: project.path,
        adapter: project.adapter,
        choices: [...registered],
      });
      continue;
    }
    const candidates = await checksFor(source, project, ids);
    if (ids.some((id) => !candidates.some((check) => check.id === id)))
      throw new Error(
        "Selected check is inapplicable to the discovered project",
      );
    const checks = grouped.get(project.path) ?? new Set<string>();
    for (const id of ids) checks.add(id);
    grouped.set(project.path, checks);
  }
  for (const [selectedPath, ids] of selected)
    if (ids.some((id) => !grouped.get(selectedPath)?.has(id)))
      throw new Error("Selected check is unknown or inapplicable");
  if (!plan.projects.length || result.unresolved.length)
    return { ...result, status: "needs-selection" };
  result.configuration = configSchema.parse({
    schemaVersion: 1,
    projects: [...grouped].map(([projectPath, checks]) => ({
      path: projectPath,
      checks: [...checks].sort(),
    })),
  });
  if (!options.write) return result;
  if ((await inventory(root)).fingerprint !== source.fingerprint)
    throw new Error("Project changed during setup; review a fresh preview");
  const temporary = await mkdtemp(path.join(root, ".checktrail-init-"));
  try {
    const staged = path.join(temporary, "checktrail.json");
    await writeFile(
      staged,
      `${JSON.stringify(result.configuration, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    // An exclusive link publishes complete bytes without replacing a concurrent writer.
    await link(staged, path.join(root, "checktrail.json"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return { ...result, status: "created" };
}

export interface DoctorIssue {
  code:
    | "configuration-error"
    | "empty-plan"
    | "unselected-project"
    | "unavailable-check"
    | "missing-executable"
    | "package-metadata"
    | "unsupported-platform";
  check?: string;
  adapter?: string;
  project?: string;
  detail?: string;
}

export interface DoctorResult {
  schemaVersion: 1;
  engineVersion: string;
  status: "no-static-blockers" | "attention-required";
  validationPerformed: false;
  projects: number;
  checks: number;
  issues: DoctorIssue[];
  unverified: string[];
}

async function executableAvailable(
  executable: string,
  cwd: string,
  searchPath: string,
): Promise<boolean> {
  const candidates =
    executable.includes("/") || path.isAbsolute(executable)
      ? [path.resolve(cwd, executable)]
      : searchPath
          .split(path.delimiter)
          .map((directory) => path.resolve(cwd, directory, executable));
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      /* Other PATH entries may provide the executable. */
    }
  }
  return false;
}

export async function diagnose(
  root: string,
  options: Omit<PlanOptions, "base"> & { detailed?: boolean } = {},
): Promise<DoctorResult> {
  const issues: DoctorIssue[] = [];
  const result: DoctorResult = {
    schemaVersion: 1,
    engineVersion: VERSION,
    status: "attention-required",
    validationPerformed: false,
    projects: 0,
    checks: 0,
    issues,
    unverified: [
      "Tool versions and runtime compatibility",
      "Importable modules and runtime services",
      "Validation results; run with explicit project trust",
    ],
  };
  const add = (issue: DoctorIssue): void => {
    const summary = { ...issue };
    delete summary.project;
    delete summary.detail;
    issues.push(options.detailed ? issue : summary);
  };
  if (process.platform === "win32") add({ code: "unsupported-platform" });
  try {
    root = await realpath(root);
    await configurationExists(root);
    const { plan } = await createPlan(root, {
      ...(options.externalAdapters
        ? { externalAdapters: options.externalAdapters }
        : {}),
      ...(options.policyOverlay
        ? { policyOverlay: options.policyOverlay }
        : {}),
      ...(options.environment ? { environment: options.environment } : {}),
    });
    result.projects = plan.projects.length;
    result.checks = plan.checks.length;
    if (!plan.checks.length) add({ code: "empty-plan" });
    for (const project of plan.projects)
      if (
        !plan.checks.some(
          (check) =>
            check.project === project.path && check.adapter === project.adapter,
        )
      )
        add({
          code: "unselected-project",
          project: project.path,
          adapter: project.adapter,
        });
    for (const check of plan.checks) {
      const context = {
        check: check.id,
        adapter: check.adapter,
        project: check.project,
      };
      if (check.unavailableReason)
        add({
          ...context,
          code: "unavailable-check",
          detail: check.unavailableReason,
        });
      const commands = [...check.commands];
      for (const tool of check.tools ?? []) {
        if (tool.source === "version-command") commands.push(tool.command);
        else if (tool.source === "package-metadata") {
          const identity = await identifyTool(root, tool, async () => {
            throw new Error("Doctor must not execute version probes");
          });
          if (identity.status !== "identified")
            add({
              ...context,
              code: "package-metadata",
              detail: `Missing or invalid package metadata: ${tool.name}`,
            });
        }
      }
      const wrapped =
        check.adapter === "jvm"
          ? ["java"]
          : check.adapter === "dotnet"
            ? ["dotnet"]
            : check.id === "infrastructure.actionlint"
              ? ["actionlint"]
              : [];
      for (const executable of wrapped)
        commands.push({ executable, args: [], cwd: check.project });
      const checked = new Set<string>();
      for (const command of commands) {
        const searchPath =
          command.env?.PATH ??
          (check.environment?.includes("PATH")
            ? options.environment?.PATH
            : undefined) ??
          process.env.PATH ??
          "/usr/bin:/bin";
        const cwd = path.resolve(root, command.cwd);
        const key = JSON.stringify([command.executable, cwd, searchPath]);
        if (checked.has(key)) continue;
        checked.add(key);
        if (!(await executableAvailable(command.executable, cwd, searchPath)))
          add({
            ...context,
            code: "missing-executable",
            detail: `Executable unavailable or not executable: ${command.executable}`,
          });
      }
    }
  } catch (error) {
    add({
      code: "configuration-error",
      detail: error instanceof Error ? error.message : "Cannot inspect project",
    });
  }
  result.status = issues.length ? "attention-required" : "no-static-blockers";
  return result;
}

export const mcpClients = [
  "codex",
  "claude-code",
  "claude-desktop",
  "cursor",
  "vscode",
] as const;
export type McpClient = (typeof mcpClients)[number];

export async function mcpConfiguration(
  root: string,
  client: McpClient,
): Promise<{
  client: McpClient;
  format: "json" | "toml";
  configuration: string;
  executionEnabled: false;
}> {
  if (!mcpClients.includes(client)) throw new Error("Unknown MCP client");
  root = await realpath(root);
  if (!(await stat(root)).isDirectory())
    throw new Error("MCP root must be a directory");
  if (root.includes("${"))
    throw new Error(
      "MCP root contains client variable syntax; choose a path without ${",
    );
  const server = {
    command: "npx",
    args: [
      "--yes",
      "--ignore-scripts",
      `@stsepelin/checktrail@${VERSION}`,
      "serve",
      "--root",
      root,
    ],
  };
  return {
    client,
    executionEnabled: false,
    format: client === "codex" ? "toml" : "json",
    configuration:
      client === "codex"
        ? `[mcp_servers.checktrail]\ncommand = "npx"\nargs = ${JSON.stringify(server.args)}\n`
        : `${JSON.stringify(client === "vscode" ? { servers: { checktrail: { type: "stdio", ...server } } } : { mcpServers: { checktrail: server } }, null, 2)}\n`,
  };
}
