import type {
  ArchitecturePolicy,
  DependencyGraph,
} from "../src/architecture.js";
export function architectureFixture(): {
  graph: DependencyGraph;
  policy: ArchitecturePolicy;
} {
  return {
    graph: {
      schemaVersion: 1,
      format: "dependency-graph",
      capturedAt: "2026-09-18T00:00:00Z",
      collector: { name: "synthetic-graph", version: "1.0.0" },
      complete: true,
      projects: ["domain", "service", "service-extra"].map((id) => ({
        id,
        language: id === "domain" ? "typescript" : "python",
        sourceFingerprint: "a".repeat(64),
        complete: true,
      })),
      dependencies: [{ consumer: "service", producer: "domain" }],
    },
    policy: {
      schemaVersion: 1,
      format: "architecture-policy",
      layers: ["domain", "service", "service-extra"],
      projects: ["domain", "service", "service-extra"].map((id) => ({
        id,
        layer: id,
      })),
      allowedDependencies: [{ consumer: "service", producer: "domain" }],
      requireAcyclic: true,
    },
  };
}
