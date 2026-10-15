import { randomUUID } from "node:crypto";
import nodeProcess from "node:process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createPlan } from "./engine.js";
import { inventory } from "./inventory.js";
import { runProcess } from "./runner.js";
import {
  mutationDependencies,
  mutationBoundedBytes,
  mutationHash,
  writeMutationCopy,
  type MutationDependencies,
} from "./mutation-native-copy.js";
import { mutationNativeEvidence } from "./mutation-native-evidence.js";
import {
  nativeMutationReportSchema,
  type NativeMutationRecipe,
  type NativeMutationReport,
  type NativeMutationObservation,
} from "./mutation-native-schema.js";
import { mutationPytestRunner } from "./mutation-pytest-runner.js";
import { mutationPhpunitRunner } from "./mutation-phpunit-runner.js";
import { VERSION, type Command } from "./types.js";
import {
  captureProcessOutput,
  parseCapturedProcessOutput,
} from "./process-output.js";
const settings = {
  "vitest-flat-tests": {
    check: "javascript.vitest",
    directory: "node_modules",
    tool: "vitest/dist/node.js",
    name: "vitest",
    version: "5.0.1",
    extension: /\.[cm]?[jt]sx?$/,
  },
  "jest-flat-tests": {
    check: "javascript.jest",
    directory: "node_modules",
    tool: "jest/build/index.js",
    name: "jest",
    version: "30.5.2",
    extension: /\.[cm]?[jt]sx?$/,
  },
  "pytest-flat-tests": {
    check: "python.pytest",
    directory: ".checktrail/mutation-python-tools",
    tool: "",
    name: "pytest",
    version: "9.1.1",
    extension: /\.py$/,
  },
  "phpunit-flat-tests": {
    check: "php.phpunit",
    directory: "vendor",
    tool: "phpunit/phpunit/phpunit",
    name: "phpunit",
    version: "13.3.4",
    extension: /\.php$/,
  },
} as const;
export async function runNativeMutations(
  root: string,
  recipe: NativeMutationRecipe,
  options: { trusted: boolean; timeoutMs?: number; signal?: AbortSignal },
): Promise<NativeMutationReport> {
  if (!options.trusted)
    throw Error("Mutation experiments require operator execution trust");
  if (
    new Set(recipe.mutations.map((m) => m.id)).size !== recipe.mutations.length
  )
    throw Error("Mutation IDs must be unique");
  const timeout = options.timeoutMs ?? 30000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000)
    throw Error("Timeout must be between 1 and 120000 milliseconds");
  const started = performance.now(),
    remaining = () => Math.floor(timeout - (performance.now() - started)),
    active = () => remaining() > 0 && !options.signal?.aborted;
  const { source, plan } = await createPlan(root),
    spec = settings[recipe.profile],
    check = plan.checks[0];
  if (
    plan.projects.length !== 1 ||
    plan.projects[0]?.path !== "." ||
    plan.checks.length !== 1 ||
    check?.id !== spec.check ||
    check.environment?.length ||
    check.scope.length > 16
  )
    throw Error(
      "Native mutation profile requires one root project and only its selected flat test check without environment grants",
    );
  const selected = check!.scope;
  const trials: NativeMutationReport["trials"] = recipe.mutations.map((m) => ({
    id: m.id,
    file: m.file,
    status: "not-run",
    reason: "Experiment has not run",
  }));
  const sources = new Map<string, Buffer>(),
    edits = new Map<string, string>();
  let dependencies: MutationDependencies | undefined,
    prerequisite = "";
  try {
    if (
      process.platform !== "linux" ||
      process.arch !== "arm64" ||
      process.versions.node !== "22.23.2"
    )
      throw Error(
        "Selected native mutation runtime requires Linux ARM64 Node 22.23.2",
      );
    if (check.unavailableReason || !check.scope.length)
      throw Error("Selected native mutation check or test files unavailable");
    let sourceBytes = 0;
    for (const file of source.files) {
      if (!active()) throw Error("Mutation snapshot interrupted");
      const bytes = await mutationBoundedBytes(
        source.root,
        file,
        Math.min(8 * 1048576, 64 * 1048576 - sourceBytes),
      );
      sourceBytes += bytes.length;
      sources.set(file, bytes);
    }
    dependencies = await mutationDependencies(
      source.root,
      spec.directory,
      active,
    );
    if (
      recipe.profile === "vitest-flat-tests" ||
      recipe.profile === "jest-flat-tests"
    ) {
      const metadata = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await mutationBoundedBytes(
            source.root,
            path.posix.join(spec.directory, spec.name, "package.json"),
            65536,
          ),
        ),
      ) as { name?: unknown; version?: unknown };
      if (metadata.name !== spec.name || metadata.version !== spec.version)
        throw Error("Selected native mutation tool pin differs");
    }
    if (
      (await inventory(source.root)).fingerprint !== source.fingerprint ||
      (await mutationDependencies(source.root, spec.directory, active))
        .fingerprint !== dependencies.fingerprint
    )
      throw Error("Mutation original inputs changed during preparation");
  } catch {
    prerequisite =
      "Selected runtime, complete physical dependencies, source, tests or preparation budget unavailable";
  }
  if (!prerequisite)
    for (const [i, m] of recipe.mutations.entries()) {
      let reason = "";
      const bytes = sources.get(m.file);
      if (
        !bytes ||
        !spec.extension.test(m.file) ||
        check.scope.includes(m.file)
      )
        reason =
          "Target must be inventoried source outside selected test files";
      else
        try {
          const text = new TextDecoder("utf-8", {
              fatal: true,
              ignoreBOM: true,
            }).decode(bytes),
            at = text.indexOf(m.expected);
          if (
            at < 0 ||
            text.indexOf(m.expected, at + 1) !== -1 ||
            m.expected === m.replacement
          )
            reason =
              "Mutation must replace one unique occurrence with different text";
          else
            edits.set(
              m.id,
              text.slice(0, at) +
                m.replacement +
                text.slice(at + m.expected.length),
            );
        } catch {
          reason = "Mutation target must contain valid UTF-8";
        }
      if (reason) {
        trials[i]!.status = "invalid";
        trials[i]!.reason = reason;
      }
    }
  let baseline: NativeMutationObservation | undefined,
    reason = prerequisite || "Requested experiments finished";
  let temporary: string | undefined;
  try {
    if (!prerequisite && edits.size) {
      temporary = await realpath(
        await mkdtemp(path.join(tmpdir(), "checktrail-native-mutations-")),
      );
      async function attempt(
        name: string,
        edit?: { file: string; text: string },
      ): Promise<NativeMutationObservation | undefined> {
        if (!active() || !dependencies) return undefined;
        if (
          (await inventory(source.root)).fingerprint !== source.fingerprint ||
          (await mutationDependencies(source.root, spec.directory, active))
            .fingerprint !== dependencies.fingerprint
        )
          throw Error("Original mutation inputs changed before attempt");
        const copy = path.join(temporary!, name);
        await mkdir(copy, { mode: 0o700 });
        try {
          await writeMutationCopy(copy, sources, dependencies, active, edit);
          const home = path.join(copy, ".checktrail/mutation-home"),
            temp = path.join(copy, ".checktrail/mutation-tmp");
          await mkdir(home, { recursive: true });
          await mkdir(temp, { recursive: true });
          const before = await inventory(copy),
            beforeDependencies = await mutationDependencies(
              copy,
              spec.directory,
              active,
            );
          if (beforeDependencies.fingerprint !== dependencies.fingerprint)
            throw Error("Copied mutation dependency bytes differ");
          const time = remaining();
          if (!active()) return undefined;
          let command: Command;
          if (
            recipe.profile === "vitest-flat-tests" ||
            recipe.profile === "jest-flat-tests"
          )
            command = {
              executable: nodeProcess.execPath,
              args: [
                fileURLToPath(
                  new URL(
                    recipe.profile === "vitest-flat-tests"
                      ? "./mutation-vitest-runner.js"
                      : "./mutation-jest-runner.js",
                    import.meta.url,
                  ),
                ),
                path.join(copy, spec.directory, spec.tool),
                copy,
                ...selected,
              ],
              cwd: ".",
              env: { CI: "1", HOME: home, TMPDIR: temp, TMP: temp, TEMP: temp },
            };
          else if (recipe.profile === "pytest-flat-tests")
            command = {
              executable: "python3",
              args: [
                "-I",
                "-S",
                "-B",
                "-c",
                mutationPytestRunner,
                copy,
                ...selected,
              ],
              cwd: ".",
              env: {
                PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1",
                PYTHONDONTWRITEBYTECODE: "1",
                HOME: home,
                TMPDIR: temp,
                TMP: temp,
                TEMP: temp,
              },
            };
          else
            command = {
              executable: "php",
              args: [
                "-d",
                "opcache.enable_cli=0",
                "-r",
                mutationPhpunitRunner,
                copy,
                ...selected,
              ],
              cwd: ".",
              env: { HOME: home, TMPDIR: temp, TMP: temp, TEMP: temp },
            };
          const process = await runProcess(copy, command, {
            timeoutMs: time,
            maxOutputBytes: 1048576,
            captureRawOutput: true,
            ...(options.signal ? { signal: options.signal } : {}),
          });
          let final: string | null = null,
            finalDependencies: string | null = null;
          try {
            final = (await inventory(copy)).fingerprint;
            finalDependencies = (
              await mutationDependencies(copy, spec.directory, () => true)
            ).fingerprint;
          } catch {
            /* Missing or unreadable copy evidence remains incomplete. */
          }
          let evidence = mutationNativeEvidence(
            recipe.profile,
            process,
            copy,
            selected,
          );
          const sourceChanged = final !== before.fingerprint,
            dependenciesChanged =
              finalDependencies !== dependencies.fingerprint;
          const capturedOutput = parseCapturedProcessOutput(
            process.capturedOutput ??
              captureProcessOutput(Buffer.alloc(0), Buffer.alloc(0), 0, true),
          );
          try {
            for (const stream of [capturedOutput.stdout, capturedOutput.stderr])
              new TextDecoder("utf-8", { fatal: true }).decode(
                Buffer.from(stream.base64, "base64"),
              );
            for (const item of evidence.cases) {
              const text = new TextDecoder("utf-8", { fatal: true }).decode(
                sources.get(item.file)!,
              );
              const lines = text.split("\n"),
                column = JSON.parse(item.id)[3] as number;
              if (
                item.line > lines.length ||
                column > Buffer.byteLength(lines[item.line - 1]!) + 1
              )
                throw Error("Native case address is outside its frozen source");
            }
          } catch {
            evidence = { outcome: "inconclusive", cases: [] };
          }
          const counts = {
            total: evidence.cases.length,
            passed: evidence.cases.filter((c) => c.status === "passed").length,
            failed: evidence.cases.filter((c) =>
              ["assertion-failure", "setup-error", "execution-error"].includes(
                c.status,
              ),
            ).length,
            skipped: evidence.cases.filter((c) => c.status === "skipped")
              .length,
          };
          return {
            runId: randomUUID(),
            durationMs: Math.round(process.durationMs),
            outcome:
              sourceChanged || dependenciesChanged
                ? "inconclusive"
                : evidence.outcome,
            sourceFingerprint: before.fingerprint,
            sourceChanged,
            sourceError: final === null,
            dependencyFingerprint: beforeDependencies.fingerprint,
            dependenciesChanged,
            exitCode: process.exitCode,
            timedOut: process.timedOut,
            cancelled: process.cancelled,
            truncated: process.truncated,
            cleanupError:
              process.errorCode === "PROCESS_TREE_CLEANUP_UNAVAILABLE",
            processError: !!process.errorCode,
            capturedOutput,
            outputBytes: process.outputBytes,
            stdoutSha256: capturedOutput.stdout.sha256,
            stderrSha256: capturedOutput.stderr.sha256,
            ...(counts.total ? { tests: counts } : {}),
            cases: evidence.cases,
          };
        } finally {
          await rm(copy, { recursive: true, force: true });
        }
      }
      baseline = await attempt("baseline");
      if (baseline?.outcome !== "passed" || !baseline.cases.length)
        reason =
          "A passing baseline with complete native flat-test evidence is required";
      else
        for (const [i, m] of recipe.mutations.entries()) {
          const text = edits.get(m.id);
          if (text === undefined) continue;
          const observation = await attempt("trial-" + i, {
            file: m.file,
            text,
          });
          if (!observation) {
            reason = "Experiment interrupted or total time budget exhausted";
            break;
          }
          const trial = trials[i]!;
          trial.observation = observation;
          const same =
            JSON.stringify(observation.cases.map((c) => c.id).sort()) ===
            JSON.stringify(baseline.cases.map((c) => c.id).sort());
          if (
            observation.outcome === "setup-error" ||
            observation.outcome === "execution-error"
          ) {
            trial.status = observation.outcome;
            trial.reason =
              "Native collection or lifecycle evidence reported this failure category; it is not an assertion kill";
          } else if (
            !same ||
            observation.outcome === "inconclusive" ||
            observation.outcome === "unavailable"
          ) {
            trial.status = "inconclusive";
            trial.reason =
              "Missing or changed test cohort, runtime, copy or complete native evidence";
          } else if (observation.outcome === "passed") {
            trial.status = "survived";
            trial.reason =
              "The same native test cohort passed this fresh mutation copy";
          } else if (observation.outcome === "skipped") {
            trial.status = "skipped";
            trial.reason =
              "The native cohort skipped tests; skipped tests do not kill mutations";
          } else {
            trial.status = "killed";
            trial.reason =
              "The same native test cohort completed with typed assertion failures and no skipped or execution-error cases";
          }
        }
    } else if (!prerequisite) reason = "No valid mutation target was supplied";
  } catch {
    reason =
      "Original inputs, fresh copy, budget or native attempt preparation changed or became unavailable";
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
  let finalSourceFingerprint: string | null = null,
    finalDependencyFingerprint: string | null = null;
  try {
    finalSourceFingerprint = (await inventory(source.root)).fingerprint;
    finalDependencyFingerprint = (
      await mutationDependencies(source.root, spec.directory, () => true)
    ).fingerprint;
  } catch {
    /* Preserve reached attempts without claiming current original inputs. */
  }
  const counts = {
    total: trials.length,
    killed: 0,
    survived: 0,
    skipped: 0,
    setupError: 0,
    executionError: 0,
    invalid: 0,
    inconclusive: 0,
    notRun: 0,
  };
  for (const trial of trials) {
    const key =
      trial.status === "not-run"
        ? "notRun"
        : trial.status === "setup-error"
          ? "setupError"
          : trial.status === "execution-error"
            ? "executionError"
            : trial.status;
    counts[key]++;
  }
  const complete =
    baseline?.outcome === "passed" &&
    finalSourceFingerprint === source.fingerprint &&
    !!dependencies &&
    finalDependencyFingerprint === dependencies.fingerprint &&
    counts.killed + counts.survived === counts.total;
  if (
    finalSourceFingerprint !== source.fingerprint ||
    (dependencies && finalDependencyFingerprint !== dependencies.fingerprint)
  )
    reason =
      "Original source or dependency inputs changed or could not be re-inspected";
  else if (!complete && reason === "Requested experiments finished")
    reason = "Some requested experiments lack conclusive mutation evidence";
  return nativeMutationReportSchema.parse({
    schemaVersion: 1,
    engineVersion: VERSION,
    profile: recipe.profile,
    channel: "advisory",
    provenance: "temporary-copy-mutation-experiment",
    recipeDigest: mutationHash(JSON.stringify(recipe)),
    sourceFingerprint: source.fingerprint,
    finalSourceFingerprint,
    dependencyFingerprint: dependencies?.fingerprint ?? null,
    finalDependencyFingerprint,
    complete,
    reason,
    durationMs: Math.round(performance.now() - started),
    runtime: {
      name: "node",
      version: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      selectedRunner: { name: spec.name, version: spec.version },
    },
    counts,
    excluded: source.excluded,
    ...(baseline ? { baseline } : {}),
    trials,
  });
}
