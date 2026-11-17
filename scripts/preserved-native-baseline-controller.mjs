import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  completeFreshBaseline,
  runFreshBaselineAtInstallation,
} from "./preserved-baseline-fresh-coordinator.mjs";
import { captureControllerSourceScope } from "./preserved-baseline-source-worker.mjs";

const docker = (args, options = {}) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 660000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
export function inspectBaselineImage(reference) {
  const rows = JSON.parse(
    docker(["image", "inspect", reference], { timeout: 30000 }),
  );
  assert.equal(rows.length, 1);
  assert.match(rows[0].Id, /^sha256:[a-f0-9]{64}$/);
  return { id: rows[0].Id, os: rows[0].Os, architecture: rows[0].Architecture };
}
export function ownedDockerRun(args, invoke = docker) {
  assert.equal(args[0], "run");
  assert.ok(
    !args.includes("--name"),
    "Source arguments already own a container name",
  );
  const name = "checktrail-native-baseline-" + randomUUID();
  const cleanup = () => {
    try {
      invoke(["rm", "--force", name], { timeout: 30000 });
    } catch (error) {
      assert.ok(
        String(error.stderr ?? "").includes("No such container"),
        "Owned native baseline container cleanup failed",
      );
    }
  };
  try {
    return invoke(["run", "--name", name, ...args.slice(1)]);
  } finally {
    cleanup();
  }
}
export function freshNativeDockerArgs({
  containerArgs,
  repository,
  temporary,
  harness,
  worker,
  inputFile,
  extraMounts = [],
}) {
  assert.equal(containerArgs[0], "run");
  const args = [];
  for (let index = 0; index < containerArgs.length - 1; index++) {
    if (containerArgs[index] === "--workdir") {
      index++;
      continue;
    }
    args.push(containerArgs[index]);
  }
  return [
    ...args,
    "--mount",
    "type=bind,src=" + repository + ",target=" + repository + ",readonly",
    "--mount",
    "type=bind,src=" + temporary + ",target=" + temporary + ",readonly",
    ...extraMounts,
    "--workdir",
    harness,
    containerArgs.at(-1),
    "node",
    worker,
    inputFile,
  ];
}
export async function captureNativeContainerSource({
  repository,
  cohortName,
  selection,
  containerArgs,
}) {
  const image = inspectBaselineImage(containerArgs.at(-1));
  assert.equal(image.os, "linux");
  const fixedArgs = [...containerArgs.slice(0, -1), image.id];
  const { sourceScope } = await captureControllerSourceScope(
    repository,
    cohortName,
    selection,
  );
  const sourceCapture = JSON.parse(
    ownedDockerRun([
      ...fixedArgs,
      "node",
      "scripts/preserved-baseline-source-worker.mjs",
      cohortName,
      ...selection,
    ]),
  );
  assert.deepEqual(
    sourceCapture.sourceScope,
    sourceScope,
    "Native source capture differs from the original controller scope",
  );
  process.stdout.write(JSON.stringify(sourceCapture.originalReport) + "\n");
  return {
    sourceCapture,
    expectedSourceScope: sourceScope,
    containerArgs: fixedArgs,
    image,
  };
}
export async function completeNativeContainerFresh({
  repository,
  baseline,
  installedPackage,
  harness,
  preparedDirectories = [],
  preparedMounts = [],
}) {
  repository = await realpath(repository);
  const launchWorker = async (context) => {
    const extraMounts = [];
    for (const prepared of preparedMounts) {
      assert.match(prepared.name, /^[a-z0-9-]+$/);
      const target = path.join(context.harness, ".checktrail", prepared.name);
      await mkdir(target, { recursive: true });
      extraMounts.push(
        "--mount",
        "type=bind,src=" + prepared.source + ",target=" + target + ",readonly",
      );
    }
    return ownedDockerRun(
      freshNativeDockerArgs({
        ...context,
        containerArgs: baseline.containerArgs,
        extraMounts,
      }),
    );
  };
  const options = {
    repository,
    sourceRoot: "/workspace",
    sourceCapture: baseline.sourceCapture,
    expectedSourceScope: baseline.expectedSourceScope,
    preparedDirectories,
    launchWorker,
  };
  const report = installedPackage
    ? await runFreshBaselineAtInstallation({
        ...options,
        installedPackage: await realpath(installedPackage),
        harness: path.join(
          await realpath(path.dirname(harness)),
          path.basename(harness),
        ),
      })
    : await completeFreshBaseline(options);
  assert.deepEqual(inspectBaselineImage(baseline.image.id), baseline.image);
  process.stdout.write(
    JSON.stringify({
      ...report,
      nativeImage: baseline.image,
      originalSourceCommandsRetained: true,
    }) + "\n",
  );
  return report;
}
