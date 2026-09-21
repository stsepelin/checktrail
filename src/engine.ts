import {
  externalChecks,
  externalPolicyFingerprint,
  externalReferencesSchema,
  loadExternalAdapters,
  type ExternalReference,
} from "./external-adapter.js";
import { selectGitChanges, verifyGitIdentity } from "./git-selection.js";
import {
  operatorEnvironment,
  selectEnvironment,
  environmentFingerprint,
} from "./environment.js";
import { randomUUID } from "node:crypto";
import { discover, checksFor } from "./adapters.js";
import { loadConfig } from "./config.js";
import { evaluate } from "./evidence.js";
import { inventory } from "./inventory.js";
import { runProcess } from "./runner.js";
import { identifyTool, toolsFor } from "./tool-versions.js";
import { VERSION } from "./types.js";
import type {
  CheckResult,
  Command,
  Inventory,
  Plan,
  ProcessResult,
  Report,
  ToolEvidence,
} from "./types.js";

export interface PlanOptions {
  externalAdapters?: ExternalReference[];
  base?: string;
  policyOverlay?: string;
  environment?: Record<string, string>;
}

export async function createPlan(
  root: string,
  options: PlanOptions = {},
): Promise<{ source: Inventory; plan: Plan }> {
  const suppliedEnvironment = operatorEnvironment(options.environment);
  const source = await inventory(root);
  const external = await loadExternalAdapters(options.externalAdapters);
  const projects = discover(source, external);
  const { config, fingerprint: baseFingerprint } = await loadConfig(
    source,
    options.policyOverlay,
  );
  const fingerprint = externalPolicyFingerprint(baseFingerprint, external);
  const selected = new Map(config?.projects.map((p) => [p.path, p.checks]));
  for (const key of selected.keys()) {
    if (!projects.some((p) => p.path === key))
      throw new Error(`No detected project at configured path: ${key}`);
  }
  const checks = [];
  const accepted = new Map<string, Set<string>>();
  for (const project of projects) {
    if (config && !selected.has(project.path)) continue;
    const requested = selected.get(project.path);
    const extension = external.find(
      (item) => item.identity.id === project.adapter,
    );
    const candidates = extension
      ? externalChecks(source, project, extension)
      : await checksFor(source, project, requested);
    for (const check of candidates) {
      if (requested && !requested.includes(check.id)) continue;
      const names =
        config?.projects.find((item) => item.path === project.path)
          ?.environment ?? [];
      if (names.length) {
        check.environment = [...names].sort();
        if (names.some((name) => !Object.hasOwn(suppliedEnvironment, name)))
          check.unavailableReason ??=
            "Required project environment was not supplied by the operator.";
        if (
          check.commands.some((command) =>
            names.some((name) => Object.hasOwn(command.env ?? {}, name)),
          )
        )
          throw new Error(
            "Project environment conflicts with protected adapter settings",
          );
      }
      check.tools = await toolsFor(source.root, check);
      checks.push(check);
      const ids = accepted.get(project.path) ?? new Set<string>();
      ids.add(check.id);
      accepted.set(project.path, ids);
    }
  }
  for (const [project, ids] of selected) {
    for (const id of ids) {
      if (!accepted.get(project)?.has(id))
        throw new Error(`Check is unknown or inapplicable: ${id}`);
    }
  }
  const selection =
    options.base === undefined
      ? undefined
      : await selectGitChanges(
          source,
          [...new Set(checks.map((check) => check.project))],
          options.base,
          config?.workspace,
        );
  if (
    selection &&
    (external.length > 0 ||
      options.policyOverlay !== undefined ||
      config?.projects.some((project) => project.packs?.length))
  ) {
    selection.mode = "full";
    selection.reason = external.length
      ? "External adapter impact requires complete project validation."
      : "Pack and operator-overlay impact requires complete project validation.";
    selection.selectedProjects = [
      ...new Set(checks.map((check) => check.project)),
    ];
  }
  const selectedChecks = selection
    ? checks.filter((check) =>
        selection.selectedProjects.includes(check.project),
      )
    : checks;
  return {
    source,
    plan: {
      schemaVersion: 1,
      engineVersion: VERSION,
      sourceFingerprint: source.fingerprint,
      policyFingerprint: fingerprint,
      excluded: source.excluded,
      projects,
      checks: selectedChecks,
      ...(config?.workspace ? { workspace: config.workspace } : {}),
      ...(selection ? { selection } : {}),
    },
  };
}

export function aggregate(
  checks: CheckResult[],
  stale = false,
): Report["outcome"] {
  if (checks.some((check) => check.status === "failed")) return "failed";
  if (
    stale ||
    checks.length === 0 ||
    checks.some((check) => check.status !== "passed")
  )
    return "incomplete";
  return "passed";
}

export interface ValidationOptions extends PlanOptions {
  trusted: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function validate(
  root: string,
  options: ValidationOptions,
): Promise<Report> {
  if (!options.trusted)
    throw new Error(
      "Execution requires operator trust. Use --trust-project or start MCP with --allow-execution.",
    );
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new Error("Timeout must be between 1 and 120000 milliseconds");
  const externalAdapters = externalReferencesSchema.parse(
    options.externalAdapters ?? [],
  );
  const started = Date.now();
  const suppliedEnvironment = operatorEnvironment(options.environment);
  const { source, plan } = await createPlan(root, {
    environment: suppliedEnvironment,
    externalAdapters,
    ...(options.base !== undefined ? { base: options.base } : {}),
    ...(options.policyOverlay !== undefined
      ? { policyOverlay: options.policyOverlay }
      : {}),
  });
  let activeEnvironment: Record<string, string> = {};
  const checks: CheckResult[] = [];
  let outputBudget = 4 * 1024 * 1024;
  const identified = new Map<string, ToolEvidence>();
  const execute = async (
    command: Command,
    maximum = 1024 * 1024,
  ): Promise<ProcessResult | undefined> => {
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0 || outputBudget <= 0 || options.signal?.aborted)
      return undefined;
    const result = await runProcess(source.root, command, {
      timeoutMs: remaining,
      environment: activeEnvironment,
      maxOutputBytes: Math.min(outputBudget, maximum),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    outputBudget -=
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
    return result;
  };
  for (const check of plan.checks) {
    activeEnvironment = selectEnvironment(
      check.environment ?? [],
      suppliedEnvironment,
    );
    const environmentIdentity = environmentFingerprint(activeEnvironment);
    const tools: ToolEvidence[] = [];
    if (!check.unavailableReason)
      for (const tool of check.tools ?? []) {
        const key = JSON.stringify([tool, environmentIdentity]);
        let identity = identified.get(key);
        if (!identity) {
          try {
            identity = await identifyTool(source.root, tool, (command) =>
              execute(command, 8192),
            );
          } catch {
            identity = {
              name: tool.name,
              source: tool.source,
              version: null,
              status: "inconclusive",
            };
          }
          identified.set(key, identity);
        }
        tools.push(identity);
      }
    const processes = [];
    let executionError = false;
    if (!check.unavailableReason) {
      for (const command of check.commands) {
        const remaining = timeoutMs - (Date.now() - started);
        if (remaining <= 0 || outputBudget <= 0 || options.signal?.aborted)
          break;
        try {
          const processResult = await execute(command);
          if (!processResult) break;
          processes.push(processResult);
        } catch {
          executionError = true;
          break;
        }
      }
    }
    const result = evaluate(check, processes, source.root);
    result.tools = tools;
    if (check.environment?.length)
      result.environment = {
        names: Object.keys(activeEnvironment),
        fingerprint: environmentIdentity,
      };
    if (
      result.status === "passed" &&
      tools.some((tool) => tool.status !== "identified")
    ) {
      result.status = "inconclusive";
      result.reason =
        "The check completed but required tool identity could not be established.";
    }
    if (executionError) {
      result.status = "error";
      result.reason = "The command could not be prepared or started safely.";
    }
    checks.push(result);
  }
  let finalSourceFingerprint: string | null = null;
  try {
    finalSourceFingerprint = (await inventory(source.root)).fingerprint;
  } catch {
    /* The report must retain results when source inspection fails. */
  }
  let sourceError = finalSourceFingerprint === null;
  let sourceChanged =
    !sourceError && finalSourceFingerprint !== source.fingerprint;
  if (plan.selection?.git) {
    const state = await verifyGitIdentity(source.root, plan.selection.git);
    sourceError ||= state === "error";
    sourceChanged ||= state === "changed";
  }
  try {
    const currentPolicy = await loadConfig(source, options.policyOverlay);
    const currentExternal = await loadExternalAdapters(externalAdapters);
    sourceChanged ||=
      externalPolicyFingerprint(currentPolicy.fingerprint, currentExternal) !==
      plan.policyFingerprint;
  } catch {
    sourceError = true;
  }
  return {
    ...(plan.selection ? { selection: plan.selection } : {}),
    schemaVersion: 1,
    engineVersion: VERSION,
    runId: randomUUID(),
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    sourceFingerprint: source.fingerprint,
    finalSourceFingerprint,
    policyFingerprint: plan.policyFingerprint,
    excluded: source.excluded,
    sourceChanged,
    sourceError,
    outcome: aggregate(checks, sourceChanged || sourceError),
    checks,
  };
}
