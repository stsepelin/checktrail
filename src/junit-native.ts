import path from "node:path";
import { z } from "zod";
import { importJUnit } from "./junit.js";
import type { TestEvidence } from "./types.js";
const string = z.string().min(1).max(8192);
const nodeSchema = z.strictObject({
  type: z.enum(["discovered", "dynamic", "started", "skipped", "finished"]),
  module: string,
  id: string,
  displayName: string,
  parent: string.nullable(),
  test: z.boolean(),
  className: string.nullable(),
  output: string.nullable(),
  sourceFile: string.nullable(),
  reason: z.string().max(65536).optional(),
  status: z.enum(["SUCCESSFUL", "FAILED", "ABORTED"]).optional(),
  failure: string.nullable().optional(),
});
export const nativeJUnitEventSchema = z.union([
  nodeSchema,
  z.strictObject({
    type: z.literal("planStarted"),
    module: string,
    launcher: string,
    engine: string,
  }),
  z.strictObject({ type: z.literal("planFinished"), module: string }),
]);
export const nativeDeclarationSchema = z.strictObject({
  file: string,
  className: string,
});
export const nativeReportSchema = z.strictObject({
  file: string,
  xml: z.string().max(2 * 1024 * 1024),
});
export function requireNative(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw Error(message);
}
export const nativeTotals = (): TestEvidence => ({
  total: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
});
export function reconcileNativeJUnit(input: {
  events: z.infer<typeof nativeJUnitEventSchema>[];
  declarations: z.infer<typeof nativeDeclarationSchema>[];
  classes: { file: string; className: string }[];
  base: string;
  output: string;
  repository: string;
  reports: z.infer<typeof nativeReportSchema>[];
}): TestEvidence {
  const { events, declarations, classes, base, output, repository, reports } =
    input;
  requireNative(
    events.length >= 2 &&
      events[0]!.type === "planStarted" &&
      events.at(-1)!.type === "planFinished" &&
      events.filter((e) => e.type === "planStarted").length === 1 &&
      events.filter((e) => e.type === "planFinished").length === 1,
    "Complete JUnit plan",
  );
  const plan = events[0]!;
  requireNative(
    plan.type === "planStarted" &&
      plan.launcher ===
        path.join(
          repository,
          "org/junit/platform/junit-platform-launcher/6.1.3/junit-platform-launcher-6.1.3.jar",
        ) &&
      plan.engine ===
        path.join(
          repository,
          "org/junit/jupiter/junit-jupiter-engine/6.1.3/junit-jupiter-engine-6.1.3.jar",
        ),
    "Pinned JUnit origins",
  );
  requireNative(
    new Set(declarations.map((d) => d.className)).size === declarations.length,
    "Unique source declarations",
  );
  for (const item of classes)
    requireNative(
      declarations.some(
        (d) =>
          d.className === item.className &&
          d.file === path.resolve(base, item.file),
      ),
      "Actual declared test source binding",
    );
  const nodes = events.filter(
      (event): event is z.infer<typeof nodeSchema> => "id" in event,
    ),
    discovered = nodes.filter(
      (e) => e.type === "discovered" || e.type === "dynamic",
    );
  requireNative(
    new Set(discovered.map((d) => d.id)).size === discovered.length,
    "Distinct native discoveries",
  );
  const byId = new Map(discovered.map((d) => [d.id, d]));
  for (const node of nodes) {
    const original = byId.get(node.id);
    requireNative(
      original &&
        node.id.startsWith("[engine:junit-jupiter]") &&
        JSON.stringify([
          node.parent,
          node.test,
          node.className,
          node.output,
          node.sourceFile,
          node.displayName,
        ]) ===
          JSON.stringify([
            original.parent,
            original.test,
            original.className,
            original.output,
            original.sourceFile,
            original.displayName,
          ]),
      "Native node identity",
    );
    requireNative(
      node.parent === null
        ? node.id === "[engine:junit-jupiter]"
        : byId.has(node.parent),
      "Native parent identity",
    );
    if (node.className !== null) {
      const declared = classes.find((c) => c.className === node.className);
      requireNative(
        declared &&
          node.output === output &&
          node.sourceFile === path.posix.basename(declared.file),
        "Native class-file origin",
      );
    } else
      requireNative(
        node.output === null && node.sourceFile === null,
        "Empty class origin",
      );
    if (
      node.type === "started" ||
      node.type === "finished" ||
      node.type === "skipped"
    )
      requireNative(
        nodes.indexOf(original) < nodes.indexOf(node),
        "Discovery precedes use",
      );
  }
  for (const item of classes)
    requireNative(
      discovered.some((n) => n.className === item.className),
      "Every test class discovered",
    );
  const counts = nativeTotals();
  for (const node of discovered) {
    const terminals = nodes.filter(
        (e) =>
          e.id === node.id && (e.type === "finished" || e.type === "skipped"),
      ),
      starts = nodes.filter((e) => e.id === node.id && e.type === "started");
    let ancestor = node.parent,
      ancestorSkipped = false;
    const seen = new Set<string>();
    while (ancestor !== null) {
      requireNative(!seen.has(ancestor), "Acyclic native hierarchy");
      seen.add(ancestor);
      if (nodes.some((e) => e.id === ancestor && e.type === "skipped"))
        ancestorSkipped = true;
      ancestor = byId.get(ancestor)?.parent ?? null;
    }
    requireNative(
      terminals.length === 1 || (!terminals.length && ancestorSkipped),
      "Exactly one native terminal",
    );
    const terminal = terminals[0];
    if (terminal?.type === "finished") {
      requireNative(
        starts.length === 1 &&
          terminal.status !== undefined &&
          nodes.indexOf(starts[0]!) < nodes.indexOf(terminal),
        "Started native terminal",
      );
      requireNative(
        terminal.status !== "SUCCESSFUL" || terminal.failure === null,
        "Successful terminal has no failure",
      );
    } else
      requireNative(starts.length === 0, "Skipped native node is not started");
    if (!node.test) {
      requireNative(
        terminal?.status !== "FAILED" && terminal?.status !== "ABORTED",
        "Container failure is infrastructure",
      );
      continue;
    }
    counts.total++;
    if (
      ancestorSkipped ||
      terminal?.type === "skipped" ||
      terminal?.status === "ABORTED"
    )
      counts.skipped++;
    else if (terminal?.status === "FAILED") counts.failed++;
    else {
      requireNative(
        terminal?.status === "SUCCESSFUL",
        "Successful native test",
      );
      counts.passed++;
    }
  }
  requireNative(
    reports.length > 0 &&
      new Set(reports.map((r) => r.file)).size === reports.length,
    "Fresh unique reports",
  );
  const xml = nativeTotals();
  for (const report of reports) {
    requireNative(
      path.dirname(report.file) ===
        path.join(base, "build/test-results/test") &&
        /^TEST-[A-Za-z0-9_.$-]+\.xml$/.test(path.basename(report.file)),
      "Fresh native report address",
    );
    const imported = importJUnit(report.xml);
    requireNative(
      imported.tests && imported.cases,
      "Valid reconciled XML cases",
    );
    for (const key of ["total", "passed", "failed", "skipped"] as const)
      xml[key] += imported.tests[key];
  }
  requireNative(
    JSON.stringify(xml) === JSON.stringify(counts),
    "Native XML terminal agreement",
  );
  requireNative(counts.total > 0, "Nonempty native discovery");
  return counts;
}

export function nativeJUnitCases(
  events: z.infer<typeof nativeJUnitEventSchema>[],
) {
  const nodes = events.filter(
      (event): event is z.infer<typeof nodeSchema> => "id" in event,
    ),
    discovered = nodes.filter(
      (event) => event.type === "discovered" || event.type === "dynamic",
    ),
    byId = new Map(discovered.map((node) => [node.id, node]));
  return discovered
    .filter((node) => node.test)
    .map((node) => {
      let className = node.className,
        parent = node.parent,
        skipped = false;
      const ancestors = new Set<string>();
      while (parent !== null) {
        requireNative(!ancestors.has(parent), "Acyclic case ancestry");
        ancestors.add(parent);
        const ancestor = byId.get(parent);
        requireNative(ancestor, "Case ancestor present");
        className ??= ancestor.className;
        if (
          nodes.some((event) => event.id === parent && event.type === "skipped")
        )
          skipped = true;
        parent = ancestor.parent;
      }
      requireNative(className !== null, "Class-based native test case");
      const terminal = nodes.find(
        (event) =>
          event.id === node.id &&
          (event.type === "finished" || event.type === "skipped"),
      );
      const status =
        skipped ||
        terminal?.type === "skipped" ||
        terminal?.status === "ABORTED"
          ? "skipped"
          : terminal?.status === "FAILED"
            ? "failed"
            : "passed";
      return { className, displayName: node.displayName, status };
    });
}
