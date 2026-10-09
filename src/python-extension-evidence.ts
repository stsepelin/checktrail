import path from "node:path";
import { z } from "zod";
import { pythonManifestSchema } from "./python-extensions.js";
import { pythonExtensionPins } from "./python-extension-pins.js";
import { mypyEvidence } from "./mypy-evidence.js";
import { pytestEvidence } from "./pytest-evidence.js";
import type { Check, CheckResult, ProcessResult } from "./types.js";
const schema = z.strictObject({
  format: z.literal("checktrail-python-extensions-1"),
  manifest: pythonManifestSchema,
  python: z.literal("3.12.13"),
  environmentPackages: z
    .array(
      z.strictObject({
        name: z.string(),
        version: z.string(),
        metadata: z.string(),
        imports: z.array(z.string()),
      }),
    )
    .max(64),
  plugins: z
    .array(
      z.strictObject({
        path: z.string(),
        sha256: z.string(),
        loaded: z.boolean(),
      }),
    )
    .max(16),
  modules: z
    .array(
      z.strictObject({
        file: z.string(),
        module: z.string().min(1),
        parsed: z.boolean(),
        typeChecked: z.boolean(),
        finished: z.boolean(),
        suppressed: z.boolean(),
      }),
    )
    .max(256),
  dependencyParticipation: z
    .array(
      z.strictObject({
        metadata: z.string(),
        files: z.array(z.string()).max(4096),
        complete: z.boolean(),
      }),
    )
    .max(64),
  complete: z.boolean(),
  inputsStable: z.boolean(),
  native: z.unknown(),
  exitCode: z.number().int().min(0).max(5),
});
export function pythonExtensionEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "tests"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Declared Python sources, virtualenv inputs, native module/plugin participation or receipt bindings are incomplete.",
  };
  if (
    !root ||
    processes.length !== 1 ||
    !check.scope.length ||
    check.commands.length !== 1
  )
    return incomplete;
  const process = processes[0]!;
  let value: unknown;
  let expected: unknown;
  try {
    value = JSON.parse(process.stdout);
    expected = JSON.parse(check.commands[0]!.args.at(-1)!);
  } catch {
    return incomplete;
  }
  const unavailable = z
    .strictObject({
      format: z.literal("checktrail-python-extensions-1"),
      unavailable: z.string().min(1),
    })
    .safeParse(value);
  if (process.exitCode === 3 && unavailable.success)
    return { status: "unavailable", reason: unavailable.data.unavailable };
  const parsed = schema.safeParse(value);
  const planned = pythonManifestSchema.safeParse(expected);
  if (!parsed.success || !planned.success) return incomplete;
  const report = parsed.data;
  const manifest = planned.data;
  if (
    JSON.stringify(report.manifest) !== JSON.stringify(manifest) ||
    JSON.stringify(manifest.toolPins) !== JSON.stringify(pythonExtensionPins) ||
    process.exitCode !== report.exitCode
  )
    return incomplete;
  if (!report.inputsStable) return incomplete;
  if (
    check.id !== "python." + manifest.kind ||
    check.kind !== (manifest.kind === "pytest" ? "test" : "analysis")
  )
    return incomplete;
  const sources = manifest.sources.map((s) => s.path);
  if (
    JSON.stringify(sources) !== JSON.stringify(check.scope) ||
    new Set(sources).size !== sources.length
  )
    return incomplete;
  const declared =
    manifest.kind === "pytest"
      ? manifest.config.pytestPlugins
      : manifest.config.mypyPlugins;
  if (
    JSON.stringify(report.environmentPackages) !==
      JSON.stringify(manifest.environmentPackages) ||
    report.plugins.length !== declared.length ||
    report.plugins.some(
      (p, i) =>
        p.path !== declared[i]!.path ||
        p.sha256 !== declared[i]!.sha256 ||
        !p.loaded,
    )
  )
    return incomplete;
  const nativeProcess = { ...process, stdout: JSON.stringify(report.native) };
  const originalCheck = {
    ...check,
    parser:
      manifest.kind === "pytest"
        ? ("pytest-json" as const)
        : ("mypy-json" as const),
  };
  const native =
    manifest.kind === "pytest"
      ? pytestEvidence(originalCheck, [nativeProcess], root)
      : mypyEvidence(originalCheck, [nativeProcess], root);
  if (native.status !== "passed") return native;
  if (!report.complete) return incomplete;
  if (
    report.dependencyParticipation.length !==
    manifest.environmentPackages.length
  )
    return incomplete;
  const boundFiles = new Set(
    manifest.bindings.map((f) => path.resolve(root, check.project, f.path)),
  );
  for (const [i, participation] of report.dependencyParticipation.entries()) {
    const expected = manifest.environmentPackages[i]!;
    const site = path.resolve(
      root,
      check.project,
      manifest.config.environment!.directory,
      "lib/python3.12/site-packages",
    );
    if (
      participation.metadata !== expected.metadata ||
      !participation.complete ||
      !participation.files.length ||
      new Set(participation.files).size !== participation.files.length ||
      participation.files.some(
        (file) =>
          !boundFiles.has(file) ||
          !expected.imports.includes(
            path.relative(site, file).split(path.sep)[0]!.split(".")[0]!,
          ),
      )
    )
      return incomplete;
  }

  if (manifest.kind === "mypy") {
    const files = new Set(
      check.scope.map((file) => path.resolve(root, check.project, file)),
    );
    if (
      report.modules.length !== files.size ||
      new Set(report.modules.map((m) => m.file)).size !== files.size ||
      new Set(report.modules.map((m) => m.module)).size !== files.size ||
      report.modules.some(
        (m) =>
          !files.has(m.file) ||
          !m.parsed ||
          !m.typeChecked ||
          !m.finished ||
          m.suppressed,
      )
    )
      return incomplete;
  } else if (report.modules.length) return incomplete;
  return {
    ...native,
    reason:
      "Native Python accounted for every selected source/test, declared plugin and frozen virtualenv input.",
  };
}
