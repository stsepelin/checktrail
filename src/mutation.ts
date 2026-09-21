import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { createPlan, validate } from "./engine.js";
import { inventory, withinRoot } from "./inventory.js";
import { VERSION } from "./types.js";
import type { Report } from "./types.js";

const count = z.number().int().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const relative = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.includes("\0") &&
      !path.posix.isAbsolute(value) &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
  );
export const mutationRecipeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("node-flat-tests"),
  mutations: z
    .array(
      z.strictObject({
        id: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[a-z0-9][a-z0-9.-]*$/),
        file: relative,
        expected: z.string().min(1).max(4096),
        replacement: z.string().max(4096),
      }),
    )
    .min(1)
    .max(8),
});
const testsSchema = z.strictObject({
  total: count,
  passed: count,
  failed: count,
  skipped: count,
});
const observationSchema = z.strictObject({
  runId: z.string().uuid(),
  outcome: z.enum(["passed", "failed", "incomplete"]),
  durationMs: count,
  sourceFingerprint: digest,
  sourceChanged: z.boolean(),
  sourceError: z.boolean(),
  tests: testsSchema.optional(),
});
const trialSchema = z.strictObject({
  id: z.string(),
  file: relative,
  status: z.enum(["killed", "survived", "invalid", "inconclusive", "not-run"]),
  reason: z.string(),
  observation: observationSchema.optional(),
});
const metadata = {
  schemaVersion: z.literal(1),
  engineVersion: z.string(),
  profile: z.literal("node-flat-tests"),
  channel: z.literal("advisory"),
  provenance: z.literal("temporary-copy-mutation-experiment"),
  recipeDigest: digest,
  sourceFingerprint: digest,
  finalSourceFingerprint: digest.nullable(),
  complete: z.boolean(),
  reason: z.string(),
  durationMs: count,
  runtime: z.strictObject({ name: z.literal("node"), version: z.string() }),
  counts: z.strictObject({
    total: count,
    killed: count,
    survived: count,
    invalid: count,
    inconclusive: count,
    notRun: count,
  }),
};
export const mutationReportSchema = z.strictObject({
  ...metadata,
  excluded: z.array(z.string()),
  baseline: observationSchema.optional(),
  trials: z.array(trialSchema).max(8),
});
export const mutationSummarySchema = z.strictObject(metadata);
export type MutationRecipe = z.infer<typeof mutationRecipeSchema>;
export type MutationReport = z.infer<typeof mutationReportSchema>;
type Trial = z.infer<typeof trialSchema>;

function observation(report: Report): z.infer<typeof observationSchema> {
  return {
    runId: report.runId,
    outcome: report.outcome,
    durationMs: Math.round(report.durationMs),
    sourceFingerprint: report.sourceFingerprint,
    sourceChanged: report.sourceChanged,
    sourceError: report.sourceError,
    ...(report.checks[0]?.tests ? { tests: report.checks[0].tests } : {}),
  };
}

function testIdentities(
  report: Report,
  root: string,
): { identities: string[]; assertionFailures: number } | undefined {
  const check = report.checks[0];
  if (
    report.sourceChanged ||
    report.sourceError ||
    report.checks.length !== 1 ||
    check?.id !== "javascript.node-test" ||
    !check.tests ||
    check.tests.skipped ||
    check.processes.length !== 1 ||
    check.tools?.some((tool) => tool.status !== "identified")
  )
    return undefined;
  const identities: string[] = [];
  let assertionFailures = 0;
  try {
    for (const line of check.processes[0]!.stdout.split("\n").filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.type !== "test:pass" && event.type !== "test:fail") continue;
      const data = event.data;
      if (
        !data ||
        data.nesting !== 0 ||
        data.details?.type !== "test" ||
        typeof data.file !== "string" ||
        typeof data.name !== "string" ||
        !Number.isSafeInteger(data.line) ||
        !Number.isSafeInteger(data.column)
      )
        return undefined;
      const file = path.relative(root, data.file).split(path.sep).join("/");
      if (!check.scope.includes(file)) return undefined;
      identities.push(
        JSON.stringify([file, data.name, data.line, data.column]),
      );
      if (event.type === "test:fail") {
        const error = data.details.error;
        if (
          error?.failureType !== "testCodeFailure" ||
          error?.cause?.name !== "AssertionError" ||
          error?.cause?.code !== "ERR_ASSERTION"
        )
          return undefined;
        assertionFailures++;
      }
    }
  } catch {
    return undefined;
  }
  if (
    !identities.length ||
    new Set(identities).size !== identities.length ||
    identities.length !== check.tests.total ||
    assertionFailures !== check.tests.failed
  )
    return undefined;
  return { identities: identities.sort(), assertionFailures };
}

export async function runMutations(
  root: string,
  input: unknown,
  options: {
    trusted: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<MutationReport> {
  if (!options.trusted)
    throw new Error("Mutation experiments require operator execution trust");
  const serialized = JSON.stringify(input);
  if (serialized === undefined || Buffer.byteLength(serialized) > 128 * 1024)
    throw new Error("Mutation recipe exceeds input limits");
  const recipe = mutationRecipeSchema.parse(input);
  if (
    new Set(recipe.mutations.map((mutation) => mutation.id)).size !==
    recipe.mutations.length
  )
    throw new Error("Mutation IDs must be unique");
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new Error("Timeout must be between 1 and 120000 milliseconds");
  const started = performance.now();
  const remaining = () => Math.floor(timeoutMs - (performance.now() - started));
  const { source, plan } = await createPlan(root);
  if (
    plan.projects.length !== 1 ||
    plan.projects[0]?.path !== "." ||
    plan.checks.length !== 1 ||
    plan.checks[0]?.id !== "javascript.node-test" ||
    plan.checks[0]?.unavailableReason ||
    plan.checks[0]?.environment?.length
  )
    throw new Error(
      "Mutation profile requires one root Node test project without additional checks or environment requirements",
    );
  const manifest = JSON.parse(
    await readFile(await withinRoot(source.root, "package.json"), "utf8"),
  );
  for (const key of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ])
    if (manifest[key] && Object.keys(manifest[key]).length)
      throw new Error(
        "Mutation profile requires a dependency-free Node project",
      );
  const snapshot = new Map<string, Buffer>();
  let snapshotBytes = 0;
  for (const file of source.files) {
    const bytes = await readFile(await withinRoot(source.root, file));
    snapshotBytes += bytes.length;
    if (bytes.length > 8 * 1024 * 1024 || snapshotBytes > 64 * 1024 * 1024)
      throw new Error("Mutation snapshot exceeds inventory limits");
    snapshot.set(file, bytes);
  }
  if ((await inventory(source.root)).fingerprint !== source.fingerprint)
    throw new Error("Source changed while preparing mutation copies");
  const trials: Trial[] = [];
  const edits = new Map<string, string>();
  for (const mutation of recipe.mutations) {
    const bytes = snapshot.get(mutation.file);
    let reason = "";
    if (
      !bytes ||
      !/\.[cm]?js$/.test(mutation.file) ||
      plan.checks[0].scope.includes(mutation.file)
    ) {
      reason =
        "Target must be inventoried JavaScript source outside the selected test files";
    } else {
      try {
        const original = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
        const first = original.indexOf(mutation.expected);
        if (
          first < 0 ||
          original.indexOf(mutation.expected, first + 1) !== -1 ||
          mutation.expected === mutation.replacement
        )
          reason =
            "Mutation must replace one unique occurrence with different text";
        else
          edits.set(
            mutation.id,
            original.slice(0, first) +
              mutation.replacement +
              original.slice(first + mutation.expected.length),
          );
      } catch {
        reason = "Mutation target must contain valid UTF-8";
      }
    }
    trials.push({
      id: mutation.id,
      file: mutation.file,
      status: reason ? "invalid" : "not-run",
      reason: reason || "Experiment has not run",
    });
  }
  let baseline: Report | undefined;
  let reason = "Requested experiments finished";
  const temporary = await mkdtemp(path.join(tmpdir(), "checktrail-mutations-"));
  try {
    async function trialCopy(
      name: string,
      edit?: { file: string; contents: string },
    ): Promise<{ report: Report; root: string } | undefined> {
      if (remaining() <= 0 || options.signal?.aborted) return undefined;
      const copy = path.join(temporary, name);
      await mkdir(copy, { mode: 0o700 });
      try {
        for (const [file, bytes] of snapshot) {
          if (remaining() <= 0 || options.signal?.aborted) return undefined;
          const destination = path.join(copy, file);
          await mkdir(path.dirname(destination), { recursive: true });
          await writeFile(
            destination,
            edit?.file === file ? edit.contents : bytes,
          );
        }
        const time = remaining();
        if (time <= 0 || options.signal?.aborted) return undefined;
        return {
          report: await validate(copy, {
            trusted: true,
            timeoutMs: Math.min(time, 120_000),
            ...(options.signal ? { signal: options.signal } : {}),
          }),
          root: await realpath(copy),
        };
      } finally {
        await rm(copy, { recursive: true, force: true });
      }
    }
    if (!edits.size) reason = "No valid mutation target was supplied";
    else {
      const initial = await trialCopy("baseline");
      baseline = initial?.report;
      const baselineTests =
        initial && testIdentities(initial.report, initial.root);
      if (baseline?.outcome !== "passed" || !baselineTests)
        reason =
          "A passing baseline with complete flat-test evidence is required";
      else {
        for (const [index, mutation] of recipe.mutations.entries()) {
          const contents = edits.get(mutation.id);
          if (contents === undefined) continue;
          const trial = trials[index]!;
          const run = await trialCopy(`trial-${index}`, {
            file: mutation.file,
            contents,
          });
          if (!run) {
            reason = "Experiment interrupted or total time budget exhausted";
            break;
          }
          trial.observation = observation(run.report);
          const evidence = testIdentities(run.report, run.root);
          if (
            !evidence ||
            JSON.stringify(evidence.identities) !==
              JSON.stringify(baselineTests.identities)
          ) {
            trial.status = "inconclusive";
            trial.reason =
              "Missing or changed test evidence, non-assertion failure, or source mutation during execution";
          } else if (run.report.outcome === "passed") {
            trial.status = "survived";
            trial.reason = "The same observed tests passed with this mutation";
          } else if (
            run.report.outcome === "failed" &&
            evidence.assertionFailures > 0
          ) {
            trial.status = "killed";
            trial.reason =
              "The same observed tests completed with native assertion failures";
          } else {
            trial.status = "inconclusive";
            trial.reason =
              "Native validation did not provide conclusive mutation evidence";
          }
        }
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  let finalSourceFingerprint: string | null = null;
  try {
    finalSourceFingerprint = (await inventory(source.root)).fingerprint;
  } catch {
    /* Retain experiment observations when final source inspection fails. */
  }
  const counts = {
    total: trials.length,
    killed: 0,
    survived: 0,
    invalid: 0,
    inconclusive: 0,
    notRun: 0,
  };
  for (const trial of trials)
    counts[trial.status === "not-run" ? "notRun" : trial.status]++;
  const complete =
    finalSourceFingerprint === source.fingerprint &&
    counts.invalid + counts.inconclusive + counts.notRun === 0;
  if (finalSourceFingerprint !== source.fingerprint)
    reason =
      "Original source changed or could not be inspected after the experiment";
  else if (!complete && reason === "Requested experiments finished")
    reason = "Some requested experiments lack conclusive evidence";
  return mutationReportSchema.parse({
    schemaVersion: 1,
    engineVersion: VERSION,
    profile: recipe.profile,
    channel: "advisory",
    provenance: "temporary-copy-mutation-experiment",
    recipeDigest: createHash("sha256")
      .update(JSON.stringify(recipe))
      .digest("hex"),
    sourceFingerprint: source.fingerprint,
    finalSourceFingerprint,
    excluded: source.excluded,
    complete,
    reason,
    durationMs: Math.round(performance.now() - started),
    runtime: { name: "node", version: process.versions.node },
    counts,
    ...(baseline ? { baseline: observation(baseline) } : {}),
    trials,
  });
}

export function projectMutations(
  report: MutationReport,
  detailed: boolean,
): Record<string, unknown> {
  const parsed = mutationReportSchema.parse(report);
  if (detailed) return parsed;
  return mutationSummarySchema.parse(
    Object.fromEntries(
      Object.entries(parsed).filter(
        ([key]) => key !== "excluded" && key !== "baseline" && key !== "trials",
      ),
    ),
  );
}
