// Explicit native-Linux synthetic permission proof; compiles no source.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath, URL } from "node:url";
import {
  cleanupContainer,
  copyPinnedInput,
  identifyFile,
  validateDestination,
  validateInputs,
} from "./qualify-binutils-producer.mjs";
import {
  startRetentionObserver,
  reconcileRetentionLog,
} from "./producer-qualification/binutils-retention-observer.mjs";
const directory = fileURLToPath(
  new URL("producer-qualification/", import.meta.url),
);
const environment = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  DOCKER_HOST: "unix:///var/run/docker.sock",
};
const exec = promisify(execFile);
const docker = (args) =>
  exec("docker", args, { env: environment, timeout: 20000, maxBuffer: 65536 });
async function main(args) {
  assert.deepEqual(args.slice(0, 1), ["--output"]);
  assert.equal(args.length, 2);
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  assert.equal(os.machine(), "x86_64");
  assert.ok(
    process.getuid() !== 0,
    "Permission-negative proof requires an unprivileged host user",
  );
  const recipe = JSON.parse(
    await readFile(path.join(directory, "binutils.v1.json"), "utf8"),
  );
  await validateInputs(directory, recipe.controllerFiles);
  const { destination } = await validateDestination(
    path.resolve(directory, "../.."),
    args[1],
  );
  assert.ok(!/[\r\n,]/u.test(destination));
  await mkdir(destination, { mode: 0o700 });
  for (const name of ["bundle", "controls", "work"])
    await mkdir(path.join(destination, name), { mode: 0o755 });
  const attempt = randomUUID(),
    sentinel = "protected original sentinel";
  let expectedBytes = Buffer.byteLength(sentinel),
    observer;
  const state = {
    schemaVersion: 1,
    state: "preparing",
    attempt,
    image: recipe.image,
    nativeLinuxPermissionProof: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
    gateAComplete: false,
  };
  for (const row of recipe.controllerFiles.filter((row) =>
    row.file.startsWith("binutils-retention-observer."),
  )) {
    await copyPinnedInput(
      path.join(directory, row.file),
      path.join(destination, "controls", row.file),
      row,
    );
    expectedBytes += row.bytes;
  }
  const worker = async (program) => {
    try {
      return await docker([
        "run",
        "--rm",
        "--name",
        "checktrail-producer-" + attempt,
        "--label",
        "io.checktrail.producer-attempt=" + attempt,
        "--network",
        "none",
        "--read-only",
        "--user",
        "0:0",
        "--pull=never",
        "--platform",
        recipe.platform,
        "--cap-drop=ALL",
        "--cap-add=CHOWN",
        "--cap-add=FOWNER",
        "--cap-add=DAC_OVERRIDE",
        "--cpus",
        "0.25",
        "--memory",
        "128m",
        "--pids-limit",
        "16",
        "--mount",
        "type=bind,src=" + destination + ",target=/fixture",
        "--entrypoint",
        "/usr/bin/python3",
        recipe.image,
        "-I",
        "-S",
        "-B",
        "-c",
        program,
      ]);
    } finally {
      await cleanupContainer(
        path.join(destination, "worker-cid-absent"),
        attempt,
      );
    }
  };
  try {
    await worker(
      "import os,pathlib; p=pathlib.Path('/fixture/bundle/partial');p.mkdir(mode=0o700);(p/'retained').write_bytes(" +
        JSON.stringify(sentinel) +
        ".encode());os.chown(p,42,42);os.chown(p/'retained',42,42);os.chmod(p/'retained',0o600)",
    );
    const metadata = await lstat(path.join(destination, "bundle/partial"));
    assert.equal(metadata.uid, 42);
    assert.equal(metadata.mode & 0o777, 0o700);
    await assert.rejects(
      readFile(path.join(destination, "bundle/partial/retained")),
      (error) => ["EACCES", "EPERM"].includes(error.code),
    );
    state.hostPermissionDenialObserved = true;
    observer = await startRetentionObserver({
      destination,
      image: recipe.image,
      platform: recipe.platform,
      attempt,
      environment,
      onFailure: (error) => {
        state.observerError = String(error);
      },
    });
    const inspected = JSON.parse(
      (await docker(["inspect", "checktrail-retention-" + attempt])).stdout,
    )[0];
    state.boundary = {
      readOnlyRootfs: inspected.HostConfig.ReadonlyRootfs,
      network: inspected.HostConfig.NetworkMode,
      capDrop: inspected.HostConfig.CapDrop,
      capAdd: inspected.HostConfig.CapAdd,
      mounts: inspected.Mounts.map((row) => ({
        destination: row.Destination,
        rw: row.RW,
      })),
      nanoCpus: inspected.HostConfig.NanoCpus,
      memory: inspected.HostConfig.Memory,
      pids: inspected.HostConfig.PidsLimit,
    };
    assert.equal(state.boundary.readOnlyRootfs, true);
    assert.equal(state.boundary.network, "none");
    assert.deepEqual(state.boundary.capDrop, ["ALL"]);
    assert.deepEqual(
      state.boundary.capAdd.map((value) => value.replace(/^CAP_/u, "")),
      ["DAC_READ_SEARCH"],
    );
    assert.deepEqual(
      state.boundary.mounts.map((row) => row.destination).sort(),
      ["/observed/bundle", "/observed/controls", "/observed/work"],
    );
    assert.ok(state.boundary.mounts.every((row) => row.rw === false));
    assert.equal(state.boundary.nanoCpus, 250000000);
    assert.equal(state.boundary.memory, 128 * 1024 ** 2);
    assert.equal(state.boundary.pids, 16);
    const first = await observer.sample();
    assert.equal(first.bytes, expectedBytes);
    assert.equal(first.files, 3);
    assert.equal(first.directories, 4);
    const second = await observer.sample();
    assert.deepEqual({ ...second, sequence: 1 }, first);
    state.observer = await observer.close();
    observer = undefined;
    const log = path.join(destination, "retention-observer.jsonl");
    state.observer.log = await identifyFile(log, 16 * 1024 ** 2);
    state.reconciled = reconcileRetentionLog(
      await readFile(log),
      state.observer,
    );
    await assert.rejects(
      readFile(path.join(destination, "bundle/partial/retained")),
      (error) => ["EACCES", "EPERM"].includes(error.code),
    );
    state.nativeLinuxPermissionProof = true;
    state.state = "observed";
  } catch (error) {
    state.error = String(error);
    state.state = "failed";
    process.exitCode = 1;
  } finally {
    if (observer)
      try {
        await observer.close();
      } catch (error) {
        state.closeError = String(error);
        state.state = "failed";
        process.exitCode = 1;
      }
    try {
      state.observerCleanup = await cleanupContainer(
        path.join(destination, "observer-cid-absent"),
        attempt,
        "retention",
      );
      await worker(
        "import pathlib,shutil; p=pathlib.Path('/fixture/bundle/partial');shutil.rmtree(p) if p.exists() else None",
      );
      state.fixtureRemoved = true;
    } catch (error) {
      state.cleanupError = String(error);
      state.state = "failed";
      process.exitCode = 1;
    }
    await writeFile(
      path.join(destination, "observations.json"),
      JSON.stringify(state, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  }
  process.stdout.write(
    JSON.stringify({
      state: state.state,
      nativeLinuxPermissionProof: state.nativeLinuxPermissionProof,
      gateAComplete: false,
    }) + "\n",
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
  }
}
