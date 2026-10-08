import { createHash } from "node:crypto";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import { inventory, inventorySourcePath } from "./inventory.js";
import { gitReader } from "./git-selection.js";
import { commitId } from "./review-diff.js";
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
      !Array.from(value).some((c) => c.charCodeAt(0) < 32) &&
      !path.posix.isAbsolute(value) &&
      path.posix.normalize(value) === value &&
      value !== "." &&
      !value.startsWith("../"),
  );
const count = z.number().int().nonnegative().max(20000);
const reasons = z.enum([
  "file-budget",
  "source-capture-unavailable",
  "syntax-incomplete",
  "unresolved-import",
  "excluded-source",
  "empty-project",
  "git-scope-unavailable",
]);
const dependencies = dependencyGraphSchema.shape.dependencies;
export const historicalImportInputSchema = z.strictObject({
  schemaVersion: z.literal(2),
  profile: z.literal("js-ts-historical-imports-v1"),
  projects: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(128),
        root: z.union([z.literal("."), relative]),
      }),
    )
    .min(1)
    .max(16),
  baseCommit: commitId,
  currentSource: z.enum(["working-tree", "index"]),
});
export const historicalImportReportSchema = z.strictObject({
  schemaVersion: z.literal(2),
  format: z.literal("import-context"),
  profile: z.literal("js-ts-historical-imports-v1"),
  engineVersion: z.string(),
  parser: z.literal("typescript"),
  parserVersion: z.literal("6.0.3"),
  sourceFingerprint: digest,
  input: historicalImportInputSchema,
  reportDigest: digest,
  state: z.enum(["collected", "partial"]),
  executionInvoked: z.literal(false),
  runtimeReachabilityVerified: z.literal(false),
  runtimeGraphComplete: z.literal(false),
  validationPlanUnchanged: z.literal(true),
  renamesInferred: z.literal(false),
  scope: z.literal(
    "inventoried-base-and-current-js-ts-files-under-declared-project-roots",
  ),
  git: z
    .strictObject({
      baseCommit: commitId,
      headCommit: commitId,
      indexFingerprint: digest,
      currentSource: z.enum(["working-tree", "index"]),
    })
    .nullable(),
  counts: z.strictObject({
    projects: count,
    observedFiles: count,
    capturedFiles: count,
    omittedFiles: count,
    baseFiles: count,
    currentFiles: count,
    importOccurrences: count,
    resolvedOccurrences: count,
    unresolvedOccurrences: count,
    projectEdges: count,
    affectedProjects: count,
    capturedChanges: count,
  }),
  files: z.array(relative).max(20000),
  context: reviewContextSchema.nullable(),
  dependencies,
  revisionDependencies: z.strictObject({
    base: dependencies,
    current: dependencies,
  }),
  changes: z
    .array(
      z.strictObject({
        path: relative,
        kind: z.enum(["added", "deleted", "modified", "mode-only"]),
      }),
    )
    .max(16),
  impact: z.strictObject({
    mode: z.enum(["affected", "full-fallback"]),
    projects: z.array(z.string().min(1).max(128)).max(16),
    reasons: z.array(reasons).max(16),
  }),
  omissions: z
    .array(
      z.enum([
        "runtime-dispatch",
        "project-module-resolution",
        "unselected-projects",
        "excluded-build-vendor-source",
        "non-js-ts-source",
        "rename-identity",
      ]),
    )
    .length(6),
});
export const historicalImportSummarySchema = historicalImportReportSchema
  .omit({
    input: true,
    git: true,
    files: true,
    context: true,
    dependencies: true,
    revisionDependencies: true,
    changes: true,
    impact: true,
  })
  .extend({ impactMode: z.enum(["affected", "full-fallback"]) });
export type HistoricalImportReport = z.infer<
  typeof historicalImportReportSchema
>;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const supported = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i;
const within = (root: string, file: string) =>
  root === "." || file.startsWith(root + "/");
const bounded = (value: unknown) => {
  const body = JSON.stringify(value);
  if (typeof body !== "string" || Buffer.byteLength(body) > 2 * 1024 * 1024)
    throw new Error("Historical import context exceeds limits");
};
const unique = (values: string[]) => {
  if (new Set(values).size !== values.length)
    throw new Error("Duplicate historical import root or identifier");
};

/** Read native Git objects and engine-parse captured strings, without loading project configuration. */
export async function collectHistoricalImports(
  root: string,
  value: unknown,
): Promise<HistoricalImportReport> {
  bounded(value);
  const input = historicalImportInputSchema.parse(value);
  unique(input.projects.map((p) => p.id));
  unique(input.projects.map((p) => p.root));
  for (const a of input.projects)
    for (const b of input.projects)
      if (a !== b && (a.root === "." || within(a.root, b.root)))
        throw new Error("Historical import project roots must not overlap");
  input.projects.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const before = await inventory(root);
  const owner = (file: string) =>
    input.projects.find((p) => within(p.root, file))?.id;
  const why = new Set<z.infer<typeof reasons>>();
  const base = new Set<string>(),
    current = new Set<string>();
  let git: HistoricalImportReport["git"] = null;
  let context: HistoricalImportReport["context"] = null;
  let assertGitCurrent: (() => Promise<void>) | null = null;
  for (const file of before.files)
    if (
      input.currentSource === "working-tree" &&
      supported.test(file) &&
      owner(file) !== undefined
    )
      current.add(file);
  const knownExcluded = new Set([
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
  for (const excluded of before.excluded) {
    if (owner(excluded) === undefined) continue;
    const name = path.posix.basename(excluded);
    if (
      !knownExcluded.has(name) &&
      name !== ".env" &&
      !name.startsWith(".env.") &&
      name !== ".checktrail.local.json" &&
      name !== ".repo-verifier.local.json" &&
      !/\.(pem|key|p12|pfx)$/i.test(name)
    )
      why.add("excluded-source");
  }
  try {
    const read = gitReader(before.root);
    const gitRoot = await realpath(
      (await read(["rev-parse", "--show-toplevel"])).trimEnd(),
    );
    if (gitRoot !== before.root)
      throw new Error(
        "Historical imports require the configured Git worktree root",
      );
    const exact = (
      await read([
        "rev-parse",
        "--verify",
        "--end-of-options",
        input.baseCommit + "^{commit}",
      ])
    ).trim();
    if (exact !== input.baseCommit)
      throw new Error("Historical imports require immutable base");
    const head = commitId.parse(
      (await read(["rev-parse", "--verify", "HEAD^{commit}"])).trim(),
    );
    const index = await read(["ls-files", "--stage", "-z"]);
    const tree = await read([
      "ls-tree",
      "-rz",
      "--full-tree",
      input.baseCommit,
    ]);
    const parseEntries = (
      text: string,
      isIndex: boolean,
      target: Set<string>,
    ) => {
      if (text && !text.endsWith("\0"))
        throw new Error("Incomplete historical import file inventory");
      const entries = text.split("\0").filter(Boolean);
      if (entries.length > 20000)
        throw new Error("Historical import file inventory exceeds limits");
      const seen = new Set<string>();
      for (const entry of entries) {
        const tab = entry.indexOf("\t");
        if (tab < 0) throw new Error("Malformed historical import entry");
        const file = entry.slice(tab + 1);
        if (owner(file) === undefined || !inventorySourcePath(file)) continue;
        if (!supported.test(file)) {
          if (entry.startsWith("120000 ")) why.add("excluded-source");
          continue;
        }
        const valid = isIndex
          ? /^(100644|100755) ([a-f0-9]{40}|[a-f0-9]{64}) 0$/.test(
              entry.slice(0, tab),
            )
          : /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})$/.test(
              entry.slice(0, tab),
            );
        if (!valid || seen.has(file)) {
          why.add("excluded-source");
          continue;
        }
        relative.parse(file);
        seen.add(file);
        target.add(file);
      }
    };
    parseEntries(tree, false, base);
    if (input.currentSource === "index") parseEntries(index, true, current);
    git = {
      baseCommit: input.baseCommit,
      headCommit: head,
      indexFingerprint: createHash("sha256").update(index).digest("hex"),
      currentSource: input.currentSource,
    };
    assertGitCurrent = async () => {
      if (
        (await read(["rev-parse", "--verify", "HEAD^{commit}"])).trim() !==
          head ||
        (await read(["ls-files", "--stage", "-z"])) !== index
      )
        throw new Error("Historical import Git inventory changed");
    };
  } catch {
    why.add("git-scope-unavailable");
  }
  const files = [...new Set([...base, ...current])].sort();
  if (files.length > 16) why.add("file-budget");
  if (input.projects.some((p) => !files.some((f) => owner(f) === p.id)))
    why.add("empty-project");
  if (files.length && git && !why.has("git-scope-unavailable")) {
    try {
      context = await createReviewContext(before.root, {
        schemaVersion: 5,
        track: "diff",
        currentSource: input.currentSource,
        baseCommit: input.baseCommit,
        files: files.slice(0, 16),
        supportFiles: [],
        topics: [],
      });
      if (
        context.schemaVersion !== 5 ||
        context.evidence.track !== "diff" ||
        context.evidence.headCommit !== git.headCommit ||
        context.evidence.indexFingerprint !== git.indexFingerprint
      )
        throw new Error("Historical import context identity disagrees");
    } catch {
      context = null;
      why.add("source-capture-unavailable");
    }
  }
  if ((await inventory(before.root)).fingerprint !== before.fingerprint)
    throw new Error("Source changed while collecting historical imports");
  await assertGitCurrent?.();
  const analysis = context?.schemaVersion === 5 ? context.analysis : null;
  if (analysis && analysis.state !== "collected") why.add("syntax-incomplete");
  const modules = analysis?.modules ?? [];
  if (modules.some((m) => m.resolution !== "selected"))
    why.add("unresolved-import");
  const edgeMap = (revision?: "base" | "current") => {
    const edges = new Map<string, { consumer: string; producer: string }>();
    for (const module of modules) {
      if (
        (revision && module.revision !== revision) ||
        module.resolution !== "selected" ||
        module.targetFile === null
      )
        continue;
      const consumer = owner(module.file),
        producer = owner(module.targetFile);
      if (consumer === undefined || producer === undefined)
        throw new Error("Historical import edge escapes scope");
      if (consumer !== producer)
        edges.set(JSON.stringify([consumer, producer]), { consumer, producer });
    }
    return [...edges.values()].sort((a, b) => {
      const x = JSON.stringify([a.consumer, a.producer]),
        y = JSON.stringify([b.consumer, b.producer]);
      return x < y ? -1 : x > y ? 1 : 0;
    });
  };
  const edges = edgeMap();
  const changes: HistoricalImportReport["changes"] = [];
  if (context?.schemaVersion === 5 && context.evidence.track === "diff") {
    for (const change of context.evidence.changes) {
      if (change.kind !== "unchanged")
        changes.push({ path: change.path, kind: change.kind });
      else {
        const mode = context.evidence.fileModes.find(
          (m) => m.path === change.path,
        )!;
        if (mode.before !== mode.after)
          changes.push({ path: change.path, kind: "mode-only" });
      }
    }
  }
  const affected = new Set(
    changes
      .map((c) => owner(c.path))
      .filter((p): p is string => p !== undefined),
  );
  const pending = [...affected];
  while (pending.length) {
    const producer = pending.pop()!;
    for (const edge of edges)
      if (edge.producer === producer && !affected.has(edge.consumer)) {
        affected.add(edge.consumer);
        pending.push(edge.consumer);
      }
  }
  const mode = why.size ? "full-fallback" : "affected";
  const projects =
    mode === "full-fallback"
      ? input.projects.map((p) => p.id)
      : [...affected].sort();
  const captured = new Set([
    ...(context?.files ?? []).map((f) => f.path),
    ...(context?.schemaVersion === 5 && context.evidence.track === "diff"
      ? context.evidence.baseFiles.map((f) => f.path)
      : []),
  ]);
  const body = {
    schemaVersion: 2,
    format: "import-context",
    profile: input.profile,
    engineVersion: VERSION,
    parser: "typescript",
    parserVersion: "6.0.3",
    sourceFingerprint: before.fingerprint,
    input,
    state: why.size ? "partial" : "collected",
    executionInvoked: false,
    runtimeReachabilityVerified: false,
    runtimeGraphComplete: false,
    validationPlanUnchanged: true,
    renamesInferred: false,
    scope:
      "inventoried-base-and-current-js-ts-files-under-declared-project-roots",
    git,
    counts: {
      projects: input.projects.length,
      observedFiles: files.length,
      capturedFiles: captured.size,
      omittedFiles: files.length - captured.size,
      baseFiles: base.size,
      currentFiles: current.size,
      importOccurrences: modules.length,
      resolvedOccurrences: modules.filter((m) => m.resolution === "selected")
        .length,
      unresolvedOccurrences: modules.filter((m) => m.resolution !== "selected")
        .length,
      projectEdges: edges.length,
      affectedProjects: projects.length,
      capturedChanges: changes.length,
    },
    files,
    context,
    dependencies: edges,
    revisionDependencies: {
      base: edgeMap("base"),
      current: edgeMap("current"),
    },
    changes,
    impact: { mode, projects, reasons: [...why].sort() },
    omissions: [
      "runtime-dispatch",
      "project-module-resolution",
      "unselected-projects",
      "excluded-build-vendor-source",
      "non-js-ts-source",
      "rename-identity",
    ],
  };
  const report = historicalImportReportSchema.parse({
    ...body,
    reportDigest: hash(body),
  });
  bounded(report);
  return report;
}
export async function assertHistoricalImportsCurrent(
  root: string,
  value: unknown,
) {
  bounded(value);
  const report = historicalImportReportSchema.parse(value);
  const rebuilt = await collectHistoricalImports(root, report.input);
  if (JSON.stringify(report) !== JSON.stringify(rebuilt))
    throw new Error("Stale or forged historical imports");
  return rebuilt;
}
export function projectHistoricalImports(
  value: unknown,
  detailed: boolean,
  sourceEnabled: boolean,
): Record<string, unknown> {
  bounded(value);
  const parsed = historicalImportReportSchema.parse(value);
  const { reportDigest, ...body } = parsed;
  if (reportDigest !== hash(body))
    throw new Error("Historical import report digest mismatch");
  if (detailed && sourceEnabled) return parsed;
  const summary: Record<string, unknown> = {
    ...parsed,
    impactMode: parsed.impact.mode,
  };
  for (const key of [
    "input",
    "git",
    "files",
    "context",
    "dependencies",
    "revisionDependencies",
    "changes",
    "impact",
  ])
    delete summary[key];
  return historicalImportSummarySchema.parse(summary);
}
