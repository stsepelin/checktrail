import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { inventory } from "./inventory.js";
import { createReviewContext, reviewContextSchema } from "./review.js";
import { dependencyGraphSchema } from "./architecture.js";
import { VERSION } from "./types.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const relative = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !Array.from(value).some((character) => character.charCodeAt(0) < 32) &&
      !path.posix.isAbsolute(value) &&
      path.posix.normalize(value) === value &&
      value !== "." &&
      !value.startsWith("../"),
  );
const project = z.strictObject({
  id: z.string().min(1).max(128),
  root: z.union([z.literal("."), relative]),
});
const count = z.number().int().nonnegative().max(20000);
export const importContextInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("js-ts-selected-imports-v1"),
  projects: z.array(project).min(1).max(16),
  changedFiles: z.array(relative).max(1024),
});
export const importContextReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  format: z.literal("import-context"),
  profile: z.literal("js-ts-selected-imports-v1"),
  engineVersion: z.string(),
  parser: z.literal("typescript"),
  parserVersion: z.literal("6.0.3"),
  sourceFingerprint: digest,
  input: importContextInputSchema,
  reportDigest: digest,
  state: z.enum(["collected", "partial"]),
  executionInvoked: z.literal(false),
  runtimeReachabilityVerified: z.literal(false),
  runtimeGraphComplete: z.literal(false),
  validationPlanUnchanged: z.literal(true),
  scope: z.literal("inventoried-js-ts-files-under-declared-project-roots"),
  counts: z.strictObject({
    projects: count,
    observedFiles: count,
    capturedFiles: count,
    omittedFiles: count,
    importOccurrences: count,
    resolvedOccurrences: count,
    unresolvedOccurrences: count,
    projectEdges: count,
    affectedProjects: count,
  }),
  files: z.array(relative).max(20000),
  context: reviewContextSchema.nullable(),
  dependencies: dependencyGraphSchema.shape.dependencies,
  impact: z.strictObject({
    mode: z.enum(["affected", "full-fallback"]),
    projects: z.array(z.string().min(1).max(128)).max(16),
    reasons: z
      .array(
        z.enum([
          "file-budget",
          "source-capture-unavailable",
          "syntax-incomplete",
          "unresolved-import",
          "unknown-changed-file",
          "excluded-source",
          "empty-project",
        ]),
      )
      .max(16),
  }),
  omissions: z
    .array(
      z.enum([
        "runtime-dispatch",
        "project-module-resolution",
        "unselected-projects",
        "excluded-build-vendor-source",
        "non-js-ts-source",
        "historical-consumers",
      ]),
    )
    .length(6),
});
export const importContextSummarySchema = importContextReportSchema
  .omit({
    input: true,
    files: true,
    context: true,
    dependencies: true,
    impact: true,
  })
  .extend({ impactMode: z.enum(["affected", "full-fallback"]) });
export type ImportContextReport = z.infer<typeof importContextReportSchema>;
export type ImportContextInput = z.infer<typeof importContextInputSchema>;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const supported = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i;
const within = (root: string, file: string) =>
  root === "." || file.startsWith(root + "/");
function unique(values: string[]) {
  if (new Set(values).size !== values.length)
    throw new Error("Duplicate import context identifier");
}
function bounded(value: unknown, maximum: number) {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string" || Buffer.byteLength(serialized) > maximum)
    throw new Error("Import context exceeds input limit");
}
function parseInput(value: unknown): ImportContextInput {
  bounded(value, 2 * 1024 * 1024);
  const input = importContextInputSchema.parse(value);
  unique(input.projects.map((item) => item.id));
  unique(input.projects.map((item) => item.root));
  unique(input.changedFiles);
  for (const a of input.projects)
    for (const b of input.projects)
      if (a !== b && (a.root === "." || within(a.root, b.root)))
        throw new Error("Import project roots must not overlap");
  input.projects.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  input.changedFiles.sort();
  return input;
}

/** Parse inventoried strings with the engine parser; never load project configuration or code. */
export async function collectImportContext(
  root: string,
  value: unknown,
): Promise<ImportContextReport> {
  const input = parseInput(value);
  const before = await inventory(root);
  const owner = (file: string) =>
    input.projects.find((item) => within(item.root, file))?.id;
  const files = before.files
    .filter((file) => supported.test(file) && owner(file) !== undefined)
    .sort();
  const reasons = new Set<ImportContextReport["impact"]["reasons"][number]>();
  if (files.length > 16) reasons.add("file-budget");
  if (
    input.projects.some(
      (item) => !files.some((file) => owner(file) === item.id),
    )
  )
    reasons.add("empty-project");
  // Known build/vendor/sensitive exclusions are part of the declared profile. Other
  // excluded entries, including symlinks, cannot be certified by their spelling.
  const ignored = new Set([
    ".git",
    "node_modules",
    "vendor",
    ".venv",
    "venv",
    "__pycache__",
    "dist",
    "build",
    ".build",
    "target",
    "coverage",
    ".next",
    ".nuxt",
    ".output",
    ".checktrail",
    ".repo-verifier",
    ".terraform",
    "obj",
  ]);
  for (const file of before.excluded) {
    if (owner(file) === undefined) continue;
    const name = path.posix.basename(file);
    if (
      !ignored.has(name) &&
      name !== ".env" &&
      !name.startsWith(".env.") &&
      name !== ".checktrail.local.json" &&
      name !== ".repo-verifier.local.json" &&
      !/\.(pem|key|p12|pfx)$/i.test(name)
    )
      reasons.add("excluded-source");
  }
  let context: ImportContextReport["context"] = null;
  if (files.length) {
    try {
      context = await createReviewContext(before.root, {
        schemaVersion: 5,
        track: "snapshot",
        currentSource: "working-tree",
        files: files.slice(0, 16),
        supportFiles: [],
        topics: [],
      });
    } catch {
      reasons.add("source-capture-unavailable");
    }
  }
  const after = await inventory(before.root);
  if (
    before.fingerprint !== after.fingerprint ||
    (context && context.sourceFingerprint !== before.fingerprint)
  )
    throw new Error("Source changed while collecting import context");
  const analysis = context?.schemaVersion === 5 ? context.analysis : null;
  if (analysis && analysis.state !== "collected")
    reasons.add("syntax-incomplete");
  const modules =
    analysis?.modules.filter((item) => item.revision === "current") ?? [];
  if (modules.some((item) => item.resolution !== "selected"))
    reasons.add("unresolved-import");
  const selected = new Set(context?.files.map((file) => file.path) ?? []);
  if (input.changedFiles.some((file) => !selected.has(file)))
    reasons.add("unknown-changed-file");
  const edges = new Map<string, { consumer: string; producer: string }>();
  for (const item of modules) {
    if (item.resolution !== "selected" || item.targetFile === null) continue;
    const consumer = owner(item.file),
      producer = owner(item.targetFile);
    if (consumer === undefined || producer === undefined)
      throw new Error("Import address outside selected roots");
    if (consumer !== producer)
      edges.set(JSON.stringify([consumer, producer]), { consumer, producer });
  }
  const dependencies = [...edges.values()].sort((a, b) => {
    const x = JSON.stringify([a.consumer, a.producer]),
      y = JSON.stringify([b.consumer, b.producer]);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const affected = new Set(
    input.changedFiles
      .map(owner)
      .filter((item): item is string => item !== undefined),
  );
  // Reverse dependency direction: a changed producer affects its consumers.
  const pending = [...affected];
  while (pending.length) {
    const producer = pending.pop()!;
    for (const edge of dependencies)
      if (edge.producer === producer && !affected.has(edge.consumer)) {
        affected.add(edge.consumer);
        pending.push(edge.consumer);
      }
  }
  const mode = reasons.size ? "full-fallback" : "affected";
  const projects =
    mode === "full-fallback"
      ? input.projects.map((item) => item.id)
      : [...affected].sort();
  const counts = {
    projects: input.projects.length,
    observedFiles: files.length,
    capturedFiles: context?.files.length ?? 0,
    omittedFiles: files.length - (context?.files.length ?? 0),
    importOccurrences: modules.length,
    resolvedOccurrences: modules.filter(
      (item) => item.resolution === "selected",
    ).length,
    unresolvedOccurrences: modules.filter(
      (item) => item.resolution !== "selected",
    ).length,
    projectEdges: dependencies.length,
    affectedProjects: projects.length,
  };
  const body = {
    schemaVersion: 1,
    format: "import-context",
    profile: input.profile,
    engineVersion: VERSION,
    parser: "typescript",
    parserVersion: "6.0.3",
    sourceFingerprint: before.fingerprint,
    input,
    state: reasons.size ? "partial" : "collected",
    executionInvoked: false,
    runtimeReachabilityVerified: false,
    runtimeGraphComplete: false,
    validationPlanUnchanged: true,
    scope: "inventoried-js-ts-files-under-declared-project-roots",
    counts,
    files,
    context,
    dependencies,
    impact: { mode, projects, reasons: [...reasons].sort() },
    omissions: [
      "runtime-dispatch",
      "project-module-resolution",
      "unselected-projects",
      "excluded-build-vendor-source",
      "non-js-ts-source",
      "historical-consumers",
    ],
  };
  const report = importContextReportSchema.parse({
    ...body,
    reportDigest: hash(body),
  });
  bounded(report, 2 * 1024 * 1024);
  return report;
}

/** Reconstruct source and parser output; a rehashed imported graph is not fresh evidence. */
export async function assertImportContextCurrent(
  root: string,
  value: unknown,
): Promise<ImportContextReport> {
  bounded(value, 2 * 1024 * 1024);
  const report = importContextReportSchema.parse(value);
  const rebuilt = await collectImportContext(root, report.input);
  if (JSON.stringify(report) !== JSON.stringify(rebuilt))
    throw new Error("Stale or forged import context");
  return rebuilt;
}
export function projectImportContext(
  report: ImportContextReport,
  detailed: boolean,
  sourceEnabled: boolean,
): Record<string, unknown> {
  const parsed = importContextReportSchema.parse(report);
  const { reportDigest, ...body } = parsed;
  if (reportDigest !== hash(body))
    throw new Error("Import report digest mismatch");
  if (detailed && sourceEnabled) return parsed;
  const summary: Record<string, unknown> = {
    ...parsed,
    impactMode: parsed.impact.mode,
  };
  for (const key of ["input", "files", "context", "dependencies", "impact"])
    delete summary[key];
  return importContextSummarySchema.parse(summary);
}
