import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  checkArchitecture,
  projectArchitectureReport,
  architectureReportSchema,
  architectureSummarySchema,
} from "../src/architecture.js";
import { architectureFixture } from "./architecture-helpers.js";
import { fixture } from "./helpers.js";

test("architecture policies use exact closed layer boundaries and account for every project and edge", () => {
  const { graph, policy } = architectureFixture();
  assert.equal(checkArchitecture(graph, policy).outcome, "passed");
  graph.dependencies.push({ consumer: "service-extra", producer: "domain" });
  graph.dependencies.push({ consumer: "domain", producer: "service" });
  const report = checkArchitecture(graph, policy);
  assert.equal(report.outcome, "failed");
  assert.equal(report.counts.forbidden, 2);
  assert.deepEqual(report.cycles, [["domain", "service"]]);
  assert.equal(
    report.counts.allowed + report.counts.forbidden + report.counts.unverified,
    report.counts.dependencies,
  );
  assert.equal(
    report.counts.verifiedProjects + report.counts.unverifiedProjects,
    report.counts.projects,
  );
  architectureReportSchema.parse(report);
  const summary = projectArchitectureReport(report, false);
  architectureSummarySchema.parse(summary);
  assert.ok(!JSON.stringify(summary).includes("service-extra"));
  graph.complete = false;
  graph.projects[0]!.complete = false;
  assert.equal(checkArchitecture(graph, policy).outcome, "failed");
  graph.dependencies.splice(1);
  const incomplete = checkArchitecture(graph, policy);
  assert.equal(incomplete.outcome, "incomplete");
  assert.equal(incomplete.captureComplete, false);
  assert.equal(incomplete.counts.unverifiedProjects, 1);
});

test("missing and unconfigured projects cannot pass, but do not erase a known forbidden edge", () => {
  const { graph, policy } = architectureFixture();
  graph.projects.pop();
  assert.deepEqual(
    checkArchitecture(graph, policy).projects.find(
      (item) => item.id === "service-extra",
    ),
    { id: "service-extra", status: "missing" },
  );
  assert.equal(checkArchitecture(graph, policy).outcome, "incomplete");
  policy.projects.pop();
  policy.projects.pop();
  const unknown = checkArchitecture(graph, policy);
  assert.equal(unknown.counts.unverified, 1);
  assert.equal(unknown.counts.unverifiedProjects, 1);
  policy.projects.push({ id: "service", layer: "service-extra" });
  assert.equal(checkArchitecture(graph, policy).outcome, "failed");
});

test("architecture validation rejects ambiguous graph/policy declarations and bounded-input violations", () => {
  for (const alter of [
    ({ graph }: ReturnType<typeof architectureFixture>) =>
      graph.projects.push(graph.projects[0]!),
    ({ policy }: ReturnType<typeof architectureFixture>) =>
      policy.projects.push(policy.projects[0]!),
    ({ policy }: ReturnType<typeof architectureFixture>) =>
      policy.layers.push("domain"),
    ({ policy }: ReturnType<typeof architectureFixture>) =>
      (policy.projects[0]!.layer = "unknown"),
    ({ policy }: ReturnType<typeof architectureFixture>) =>
      policy.allowedDependencies.push({
        consumer: "unknown",
        producer: "domain",
      }),
    ({ policy }: ReturnType<typeof architectureFixture>) =>
      policy.allowedDependencies.push(policy.allowedDependencies[0]!),
    ({ graph }: ReturnType<typeof architectureFixture>) =>
      graph.dependencies.push(graph.dependencies[0]!),
    ({ graph }: ReturnType<typeof architectureFixture>) =>
      (graph.dependencies[0]!.producer = "unobserved"),
    ({ graph }: ReturnType<typeof architectureFixture>) =>
      (graph.projects[0]!.sourceFingerprint = "unknown"),
    ({ graph }: ReturnType<typeof architectureFixture>) =>
      (graph.projects[0]!.id = "a".repeat(8 * 1024 * 1024)),
  ]) {
    const input = architectureFixture();
    alter(input);
    assert.throws(() => checkArchitecture(input.graph, input.policy));
  }
});

test("iterative cycle analysis finds strongly connected components without treating diamonds or converging paths as cycles", () => {
  const { graph, policy } = architectureFixture();
  graph.projects = Array.from({ length: 1000 }, (_, index) => ({
    id: String(index),
    language: "synthetic",
    sourceFingerprint: "b".repeat(64),
    complete: true,
  }));
  policy.projects = graph.projects.map((project) => ({
    id: project.id,
    layer: "domain",
  }));
  policy.allowedDependencies = [{ consumer: "domain", producer: "domain" }];
  graph.dependencies = graph.projects.slice(1).map((project, index) => ({
    consumer: String(index),
    producer: project.id,
  }));
  graph.dependencies.push({ consumer: "0", producer: "2" });
  assert.equal(checkArchitecture(graph, policy).outcome, "passed");
  graph.dependencies.push(
    { consumer: "999", producer: "998" },
    { consumer: "10", producer: "8" },
    { consumer: "4", producer: "4" },
  );
  assert.deepEqual(checkArchitecture(graph, policy).cycles, [
    ["10", "8", "9"],
    ["4"],
    ["998", "999"],
  ]);
  policy.requireAcyclic = false;
  assert.equal(checkArchitecture(graph, policy).outcome, "passed");
});

test("architecture CLI checks local artifacts without execution permission and preserves summary privacy", async (t) => {
  const { graph, policy } = architectureFixture();
  const root = await fixture(t, {
    "graph.json": JSON.stringify(graph),
    "boundaries.json": JSON.stringify(policy),
  });
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const invoke = (extra: string[] = []) =>
    spawnSync(
      process.execPath,
      [
        cli,
        "check-architecture",
        "--root",
        root,
        "--input",
        "graph.json",
        "--policy",
        "boundaries.json",
        ...extra,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
  assert.equal(invoke().status, 0);
  assert.equal(
    JSON.parse(invoke().stdout).provenance,
    "imported-dependency-graph",
  );
  assert.ok(!invoke().stdout.includes("service-extra"));
  graph.dependencies.push({ consumer: "service-extra", producer: "domain" });
  await writeFile(path.join(root, "graph.json"), JSON.stringify(graph));
  assert.equal(invoke().status, 1);
  assert.equal(JSON.parse(invoke(["--detailed"]).stdout).counts.forbidden, 1);
  graph.dependencies.pop();
  graph.complete = false;
  await writeFile(path.join(root, "graph.json"), JSON.stringify(graph));
  assert.equal(invoke().status, 2);
});
