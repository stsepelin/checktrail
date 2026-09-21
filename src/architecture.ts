import { createHash } from "node:crypto";
import { z } from "zod";
import { VERSION } from "./types.js";

const name = z.string().min(1).max(1024);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();
const edge = z.strictObject({ consumer: name, producer: name });
export const dependencyGraphSchema = z.strictObject({
  schemaVersion: z.literal(1),
  format: z.literal("dependency-graph"),
  capturedAt: z.iso.datetime(),
  collector: z.strictObject({ name, version: name }),
  complete: z.boolean(),
  projects: z
    .array(
      z.strictObject({
        id: name,
        language: name,
        sourceFingerprint: hash,
        complete: z.boolean(),
      }),
    )
    .min(1)
    .max(1000),
  dependencies: z.array(edge).max(20_000),
});
export const architecturePolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  format: z.literal("architecture-policy"),
  projects: z
    .array(z.strictObject({ id: name, layer: name }))
    .min(1)
    .max(1000),
  layers: z.array(name).min(1).max(128),
  allowedDependencies: z.array(edge).max(16_384),
  requireAcyclic: z.boolean(),
});
export const architectureReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  engineVersion: z.string(),
  provenance: z.literal("imported-dependency-graph"),
  outcome: z.enum(["passed", "failed", "incomplete"]),
  reason: z.string(),
  artifactFingerprint: hash,
  policyFingerprint: hash,
  captureComplete: z.boolean(),
  counts: z.strictObject({
    projects: count,
    verifiedProjects: count,
    unverifiedProjects: count,
    dependencies: count,
    allowed: count,
    forbidden: count,
    unverified: count,
    cycles: count,
  }),
  projects: z.array(
    z.strictObject({
      id: name,
      status: z.enum(["verified", "missing", "unconfigured", "incomplete"]),
    }),
  ),
  dependencies: z.array(
    edge.extend({ status: z.enum(["allowed", "forbidden", "unverified"]) }),
  ),
  cycles: z.array(z.array(name)),
});
export const architectureSummarySchema = architectureReportSchema.omit({
  projects: true,
  dependencies: true,
  cycles: true,
});
export type DependencyGraph = z.infer<typeof dependencyGraphSchema>;
export type ArchitecturePolicy = z.infer<typeof architecturePolicySchema>;
export type ArchitectureReport = z.infer<typeof architectureReportSchema>;

function bounded(input: unknown): string {
  const serialized = JSON.stringify(input);
  if (
    typeof serialized !== "string" ||
    Buffer.byteLength(serialized) > 8 * 1024 * 1024
  )
    throw new Error("Architecture artifact exceeds input limit");
  return serialized;
}
function unique(values: string[], description: string): Set<string> {
  const result = new Set(values);
  if (result.size !== values.length)
    throw new Error(`Duplicate ${description}`);
  return result;
}
const pair = (consumer: string, producer: string) =>
  JSON.stringify([consumer, producer]);

function cycleComponents(graph: DependencyGraph): string[][] {
  const forward = new Map(
    graph.projects.map((project) => [project.id, [] as string[]]),
  );
  const reverse = new Map(
    graph.projects.map((project) => [project.id, [] as string[]]),
  );
  for (const { consumer, producer } of graph.dependencies) {
    forward.get(consumer)!.push(producer);
    reverse.get(producer)!.push(consumer);
  }
  const visited = new Set<string>();
  const finish: string[] = [];
  for (const start of forward.keys()) {
    if (visited.has(start)) continue;
    const stack: { id: string; offset: number }[] = [{ id: start, offset: 0 }];
    visited.add(start);
    while (stack.length) {
      const item = stack[stack.length - 1]!;
      const next = forward.get(item.id)![item.offset++];
      if (next === undefined) {
        finish.push(item.id);
        stack.pop();
      } else if (!visited.has(next)) {
        visited.add(next);
        stack.push({ id: next, offset: 0 });
      }
    }
  }
  visited.clear();
  const cycles: string[][] = [];
  for (const start of finish.reverse()) {
    if (visited.has(start)) continue;
    const members: string[] = [];
    const pending = [start];
    visited.add(start);
    while (pending.length) {
      const id = pending.pop()!;
      members.push(id);
      for (const dependency of reverse.get(id)!)
        if (!visited.has(dependency)) {
          visited.add(dependency);
          pending.push(dependency);
        }
    }
    if (members.length > 1 || forward.get(start)!.includes(start))
      cycles.push(members.sort());
  }
  return cycles.sort((a, b) => a[0]!.localeCompare(b[0]!, "en"));
}

export function checkArchitecture(
  graphInput: unknown,
  policyInput: unknown,
): ArchitectureReport {
  const graphBytes = bounded(graphInput);
  const policyBytes = bounded(policyInput);
  const graph = dependencyGraphSchema.parse(graphInput);
  const policy = architecturePolicySchema.parse(policyInput);
  const observed = unique(
    graph.projects.map((project) => project.id),
    "observed project ID",
  );
  unique(
    policy.projects.map((project) => project.id),
    "policy project ID",
  );
  const layers = unique(policy.layers, "architecture layer");
  for (const project of policy.projects)
    if (!layers.has(project.layer))
      throw new Error("Project uses an undeclared architecture layer");
  const allowed = unique(
    policy.allowedDependencies.map((item) =>
      pair(item.consumer, item.producer),
    ),
    "allowed layer dependency",
  );
  for (const item of policy.allowedDependencies)
    if (!layers.has(item.consumer) || !layers.has(item.producer))
      throw new Error("Allowed dependency uses an undeclared layer");
  unique(
    graph.dependencies.map((item) => pair(item.consumer, item.producer)),
    "observed project dependency",
  );
  for (const item of graph.dependencies)
    if (!observed.has(item.consumer) || !observed.has(item.producer))
      throw new Error("Observed dependency references a missing graph project");
  const observedProjects = new Map(
    graph.projects.map((project) => [project.id, project]),
  );
  const configured = new Map(
    policy.projects.map((project) => [project.id, project.layer]),
  );
  const projects: ArchitectureReport["projects"] = [
    ...new Set([...observed, ...configured.keys()]),
  ]
    .sort()
    .map((id) => ({
      id,
      status: !observed.has(id)
        ? "missing"
        : !configured.has(id)
          ? "unconfigured"
          : !observedProjects.get(id)!.complete
            ? "incomplete"
            : "verified",
    }));
  const dependencies: ArchitectureReport["dependencies"] =
    graph.dependencies.map((item) => {
      const consumer = configured.get(item.consumer);
      const producer = configured.get(item.producer);
      return {
        ...item,
        status:
          consumer === undefined || producer === undefined
            ? "unverified"
            : allowed.has(pair(consumer, producer))
              ? "allowed"
              : "forbidden",
      };
    });
  const cycles = policy.requireAcyclic ? cycleComponents(graph) : [];
  const counts = {
    projects: projects.length,
    verifiedProjects: projects.filter((item) => item.status === "verified")
      .length,
    unverifiedProjects: projects.filter((item) => item.status !== "verified")
      .length,
    dependencies: dependencies.length,
    allowed: dependencies.filter((item) => item.status === "allowed").length,
    forbidden: dependencies.filter((item) => item.status === "forbidden")
      .length,
    unverified: dependencies.filter((item) => item.status === "unverified")
      .length,
    cycles: cycles.length,
  };
  const outcome =
    counts.forbidden || counts.cycles
      ? "failed"
      : !graph.complete || counts.unverifiedProjects || counts.unverified
        ? "incomplete"
        : "passed";
  return {
    schemaVersion: 1,
    engineVersion: VERSION,
    provenance: "imported-dependency-graph",
    outcome,
    captureComplete: graph.complete,
    reason:
      outcome === "failed"
        ? "Observed dependencies cross forbidden layer boundaries or contain prohibited cycles."
        : outcome === "incomplete"
          ? "Dependency capture or project-to-layer coverage is incomplete."
          : "The supplied complete graph satisfies the explicit layer boundaries and cycle policy.",
    artifactFingerprint: createHash("sha256").update(graphBytes).digest("hex"),
    policyFingerprint: createHash("sha256").update(policyBytes).digest("hex"),
    counts,
    projects,
    dependencies,
    cycles,
  };
}

export function projectArchitectureReport(
  report: ArchitectureReport,
  detailed: boolean,
): Record<string, unknown> {
  if (detailed) return report;
  return architectureSummarySchema.parse({
    schemaVersion: report.schemaVersion,
    engineVersion: report.engineVersion,
    provenance: report.provenance,
    outcome: report.outcome,
    reason: report.reason,
    artifactFingerprint: report.artifactFingerprint,
    policyFingerprint: report.policyFingerprint,
    captureComplete: report.captureComplete,
    counts: report.counts,
  });
}
