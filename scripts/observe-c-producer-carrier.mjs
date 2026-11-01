// Explicit operator-only hosted observation; original producer limits stay intact.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { link, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import {
  cleanupContainer,
  identifyFile,
  observeForeground,
  physicalPath,
} from "./qualify-binutils-producer.mjs";
import {
  boundedCProducerBytes,
  captureCProducerCallerIdentity,
  prepareCProducer,
} from "./qualify-c-producer.mjs";
import { verifyCObservationStartup } from "./verify-c-producer-observation.mjs";
import {
  gccCarrierLimits,
  requireCObservationProfile,
} from "./producer-qualification/c-carrier-observation.mjs";
import { sha256 } from "./producer-qualification/c-producer-profile.mjs";
import {
  afterGccJobAdmission,
  remainingGccObservationMs,
} from "./producer-qualification/gcc-job-envelope.mjs";
import {
  captureAndRetainGithubGccJobClock,
  githubGccContextFromEnvironment,
} from "./producer-qualification/gcc-github-job-clock.mjs";

const { AbortController } = globalThis;
const self = fileURLToPath(import.meta.url);
const ownedFamilies = new WeakMap();

export function carrierChildEnvironment(environment) {
  const copied = { ...environment };
  delete copied.CHECKTRAIL_GITHUB_JOB_TOKEN;
  return copied;
}

export function spawnCarrierNode(args) {
  assert.notEqual(
    process.platform,
    "win32",
    "Carrier process-group observation requires POSIX",
  );
  const child = spawn(process.execPath, args, {
    detached: true,
    env: carrierChildEnvironment(process.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(
    Number.isSafeInteger(child.pid) && child.pid > 0,
    "Carrier child PID was not observed",
  );
  const family = Object.freeze({ pid: child.pid });
  ownedFamilies.set(family, { absent: false });
  return { child, family };
}

export function carrierFamilyAbsent(family) {
  const state = ownedFamilies.get(family);
  assert.ok(state, "Unowned carrier process group");
  if (state.absent) return true;
  try {
    process.kill(-family.pid, 0);
    return false;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    state.absent = true;
    return true;
  }
}

function signalFamily(family, signal) {
  const state = ownedFamilies.get(family);
  assert.ok(state, "Unowned carrier process group");
  if (state.pendingProbeError) {
    // An unknown signal-zero result never becomes authority for another group signal.
    try {
      if (carrierFamilyAbsent(family)) return;
    } catch (error) {
      if (error.code !== "EPERM") throw error;
    }
    throw state.pendingProbeError;
  }
  if (carrierFamilyAbsent(family)) return;
  try {
    process.kill(-family.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function waitFamily(family, deadline) {
  const state = ownedFamilies.get(family);
  assert.ok(state, "Unowned carrier process group");
  for (;;) {
    try {
      if (carrierFamilyAbsent(family)) return true;
    } catch (error) {
      if (error.code !== "EPERM") throw error;
      // Darwin may retain a zombie-only group briefly. This is pending/unknown,
      // never absence: keep the original deadline and require a later ESRCH.
      state.pendingProbeError ??= error;
      state.pendingProbeCount = (state.pendingProbeCount ?? 0) + 1;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(25, remaining)),
    );
  }
}

export function onceCarrierStop(operation) {
  let attempt;
  return () => (attempt ??= Promise.resolve().then(operation));
}

export async function waitCarrierChild(terminal, milliseconds) {
  assert.ok(
    Number.isSafeInteger(milliseconds) &&
      milliseconds > 0 &&
      milliseconds <= gccCarrierLimits.softStopSeconds * 1000,
  );
  let timer;
  try {
    return await Promise.race([
      terminal.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function stopCarrierChild(
  child,
  terminal,
  admitOwner,
  cleanup,
  { softStopMs, deadline, family },
) {
  assert.ok(
    Number.isSafeInteger(softStopMs) &&
      softStopMs > 0 &&
      softStopMs <= gccCarrierLimits.softStopSeconds * 1000,
  );
  assert.ok(
    ownedFamilies.has(family) && family.pid === child.pid,
    "Carrier process-group owner differs",
  );
  assert.ok(
    Number.isFinite(deadline) &&
      deadline <= performance.now() + gccCarrierLimits.cleanupSeconds * 1000,
    "Carrier cleanup deadline is not bounded",
  );
  if (deadline <= performance.now()) {
    // The original reserve cannot be restarted. Stop only our known group,
    // retain unknown cleanup observations, and refuse any completion claim.
    signalFamily(family, "SIGKILL");
    const error = new Error(
      "Carrier cleanup deadline exhausted before observation",
    );
    error.stopObservation = {
      ownerAdmissionError: "deadline-exhausted-before-admission",
      childTerminalObserved: null,
      childReaped: null,
      softFamilyAbsent: null,
      familyAbsent: null,
      processGroupId: family.pid,
    };
    throw error;
  }
  let ownerAdmissionError = null;
  let childTerminalObserved = false;
  void terminal.then(() => {
    childTerminalObserved = true;
  });
  try {
    await admitOwner();
  } catch (error) {
    ownerAdmissionError = String(error);
  }
  signalFamily(family, "SIGTERM");
  const softDeadline = Math.min(deadline, performance.now() + softStopMs);
  const softFamilyAbsent = await waitFamily(family, softDeadline);
  // A controller can terminate while a Docker CLI grandchild remains alive.
  // Never remove its containers until the entire owned group is quiescent.
  if (!softFamilyAbsent) signalFamily(family, "SIGKILL");
  const hardDeadline = Math.min(deadline, performance.now() + 10000);
  const familyAbsent = await waitFamily(family, hardDeadline);
  const remaining = Math.floor(hardDeadline - performance.now());
  const childReaped =
    remaining > 0 && (await waitCarrierChild(terminal, remaining));
  const observation = {
    ownerAdmissionError,
    childTerminalObserved,
    childReaped,
    softFamilyAbsent,
    familyAbsent,
    processGroupId: family.pid,
  };
  const pending = ownedFamilies.get(family).pendingProbeCount ?? 0;
  if (pending)
    observation.pendingGroupProbes = {
      operation: "signal-zero",
      code: "EPERM",
      count: pending,
      absenceInferred: false,
      signallingAuthorized: false,
    };
  if (!familyAbsent || !childReaped) {
    const error = new Error(
      "Carrier process-family terminal remained unobserved after forced stop",
    );
    error.stopObservation = observation;
    throw error;
  }
  try {
    assert.ok(
      performance.now() < deadline,
      "Carrier cleanup reserve exhausted",
    );
    await cleanup(deadline);
    assert.ok(
      performance.now() <= deadline,
      "Carrier cleanup deadline exceeded",
    );
  } catch (error) {
    const failure = new Error("Carrier cleanup failed", { cause: error });
    failure.stopObservation = observation;
    throw failure;
  }
  return observation;
}

export function validateCarrierOwner(owner, plan, caller) {
  assert.equal(owner.profile, plan.profile.profile);
  assert.equal(owner.sourceVersion, plan.profile.sourceVersion);
  assert.equal(owner.catalogSha256, plan.catalogSha256);
  assert.deepEqual(owner.limits, plan.profile.limits);
  assert.deepEqual(owner.sourcePins, plan.sources);
  assert.deepEqual(owner.harnessPins, plan.harness);
  assert.deepEqual(owner.host.capturedCaller, caller);
  assert.match(
    owner.attempt,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
  );
  return owner.attempt;
}

function appendCarrierPublicationFailure(primary, secondary) {
  if (primary === undefined) return secondary;
  const failures = [
    ...(primary?.carrierPublicationSecondaryFailures ?? []),
    secondary,
    ...(secondary?.carrierPublicationSecondaryFailures ?? []),
  ];
  try {
    Object.defineProperty(primary, "carrierPublicationSecondaryFailures", {
      value: failures,
      configurable: true,
    });
    return primary;
  } catch {
    // A frozen primary still remains the cause/first member; cleanup must continue.
    const failure = new AggregateError(
      [primary, ...failures],
      String(primary),
      { cause: primary },
    );
    failure.carrierPublicationSecondaryFailures = failures;
    failure.carrierPublicationPrimary =
      primary?.carrierPublicationPrimary ?? primary;
    return failure;
  }
}

export function finishCarrierPublication(primary, publicationFailure) {
  if (publicationFailure !== undefined)
    throw appendCarrierPublicationFailure(primary, publicationFailure);
}

export async function closeCarrierPublicationHandles(
  handles,
  primary,
  attempted = new Set(),
) {
  let failure = primary;
  for (const handle of handles) {
    if (!handle || attempted.has(handle)) continue;
    attempted.add(handle);
    try {
      await handle.close();
    } catch (error) {
      failure = appendCarrierPublicationFailure(failure, error);
    }
  }
  return failure;
}

export function carrierPublicationFailureDetails(error) {
  return {
    primary: String(error?.carrierPublicationPrimary ?? error),
    secondary: (error?.carrierPublicationSecondaryFailures ?? []).map(String),
  };
}

export async function publishReserved(
  handle,
  part,
  target,
  raw,
  io = { link, unlink, open },
  attempted = new Set(),
) {
  let directory, failure;
  try {
    await handle.writeFile(raw);
    await handle.sync();
    failure = await closeCarrierPublicationHandles(
      [handle],
      undefined,
      attempted,
    );
    if (failure !== undefined) throw failure;
    await io.link(part, target);
    await io.unlink(part);
    directory = await io.open(path.dirname(target), "r");
    await directory.sync();
  } catch (error) {
    failure = error;
  } finally {
    failure = await closeCarrierPublicationHandles(
      [handle, directory],
      failure,
      attempted,
    );
  }
  if (failure !== undefined) throw failure;
}

export async function retainCarrierJobClock(
  carrier,
  observed,
  io = { link, unlink, open },
) {
  // Reserve both files before publishing either; never serialize authentication headers.
  const { responseBytes, ...metadata } = observed;
  const rawPart = path.join(carrier, ".github-job-response.part");
  const metadataPart = path.join(carrier, ".github-job-capture.part");
  const rawHandle = await io.open(rawPart, "wx", 0o600);
  const attempted = new Set();
  let metadataHandle, failure;
  try {
    metadataHandle = await io.open(metadataPart, "wx", 0o600);
    await publishReserved(
      rawHandle,
      rawPart,
      path.join(carrier, "github-job-response.json"),
      responseBytes,
      io,
      attempted,
    );
    await publishReserved(
      metadataHandle,
      metadataPart,
      path.join(carrier, "github-job-capture.json"),
      JSON.stringify(
        {
          ...metadata,
          response: {
            bytes: responseBytes.length,
            sha256: sha256(responseBytes),
          },
        },
        null,
        2,
      ) + "\n",
      io,
      attempted,
    );
  } catch (error) {
    failure = error;
  } finally {
    failure = await closeCarrierPublicationHandles(
      [rawHandle, metadataHandle],
      failure,
      attempted,
    );
  }
  if (failure !== undefined) throw failure;
}

export async function mainCProducerCarrier(args) {
  assert.ok(
    (args.length === 10 ||
      (args.length === 11 && args[10] === "--github-job-envelope")) &&
      args[0] === "--profile" &&
      args[2] === "--inputs" &&
      args[4] === "--output" &&
      args[6] === "--startup" &&
      args[8] === "--operator-trust-execution" &&
      args[9] === "--coordinated-heavy-slot",
    "Usage: --profile gcc-12 --inputs BUNDLE --output NEW_RESULT --startup FILE --operator-trust-execution --coordinated-heavy-slot [--github-job-envelope]",
  );
  const name = requireCObservationProfile(args[1]);
  assert.equal(
    name,
    "gcc-12",
    "This shorter external carrier selects only GCC",
  );
  const inputs = path.resolve(args[3]),
    output = path.resolve(args[5]),
    startupFile = path.resolve(args[7]);
  const caller = captureCProducerCallerIdentity();
  const { startupRaw } = await verifyCObservationStartup(name, startupFile);
  const plan = await prepareCProducer(name, inputs, output);
  const carrier = output + "-carrier";
  await physicalPath(path.dirname(carrier), true);
  await mkdir(carrier, { mode: 0o700 });
  const receiptPart = path.join(carrier, ".receipt.part"),
    ownerPart = path.join(carrier, ".owner-frame.part");
  const receiptHandle = await open(receiptPart, "wx", 0o600);
  let ownerHandle, child, terminal, family, ownerRaw, ownerAttempt;
  const controller = new AbortController();
  const abort = () => controller.abort("operator-carrier-signal");
  const started = performance.now(),
    startedAt = new Date().toISOString();
  const value = {
    schemaVersion: 1,
    selectedProfile: {
      name,
      profile: plan.profile.profile,
      sourceVersion: plan.profile.sourceVersion,
      catalogSha256: plan.catalogSha256,
    },
    originalCommandDeadlineSeconds: plan.profile.limits.deadlineSeconds,
    carrierLimits: gccCarrierLimits,
    startedAt,
    cutoffAt: new Date(
      Date.parse(startedAt) + gccCarrierLimits.observationSeconds * 1000,
    ).toISOString(),
    startupInput: { bytes: startupRaw.length, sha256: sha256(startupRaw) },
    state: "carrier-preparing",
    controllerObserver: null,
    stopCause: null,
    cleanup: {
      producer: { state: "not-observed" },
      retention: { state: "not-observed" },
    },
    originalProducerDefaultsOrBudgetChanged: false,
    fullEightHourHostedCapacityVerified: false,
    originalCommandCompletionClaimed: false,
    fullCompilerSdkBootstrapClosureVerified: false,
    completeOriginalNoticeClosureVerified: false,
    historicalPublisherConsumptionVerified: false,
    gateAComplete: false,
  };
  let limits = gccCarrierLimits;
  const useGithubEnvelope = args.length === 11;
  let failure, finalPublicationFailure;
  const owner = async () => {
    if (ownerAttempt) return;
    ownerRaw = await boundedCProducerBytes(
      path.join(output, "receipt.json"),
      16 * 1024 ** 2,
    );
    ownerAttempt = validateCarrierOwner(JSON.parse(ownerRaw), plan, caller);
    await publishReserved(
      ownerHandle,
      ownerPart,
      path.join(carrier, "owner-frame.json"),
      ownerRaw,
    );
    ownerHandle = undefined;
    value.ownerAttempt = ownerAttempt;
    value.ownerFrame = { bytes: ownerRaw.length, sha256: sha256(ownerRaw) };
  };
  let cleanupPromise;
  const cleanup = (deadline) =>
    (cleanupPromise ??= (async () => {
      await owner();
      const errors = [];
      for (const [role, file] of [
        ["producer", "container.id"],
        ["retention", "retention-observer.id"],
      ]) {
        try {
          assert.ok(
            performance.now() + 45000 <= deadline,
            "Carrier cleanup RPC reserve exhausted",
          );
          value.cleanup[role] = await cleanupContainer(
            path.join(output, file),
            ownerAttempt,
            role,
          );
        } catch (error) {
          value.cleanup[role] = { state: "unavailable", error: String(error) };
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(errors, "Owned carrier cleanup incomplete");
    })());
  const stopAndCleanup = onceCarrierStop(async () => {
    if (!child || !terminal || !family)
      throw new Error(
        "Carrier child/family was not observed; no cleanup authority inferred",
      );
    const cleanupStarted = performance.now();
    const deadline = Math.min(
      started +
        (limits.observationSeconds + gccCarrierLimits.cleanupSeconds) * 1000,
      cleanupStarted + gccCarrierLimits.cleanupSeconds * 1000 - 1,
    );
    value.cleanupStartedSeconds = (cleanupStarted - started) / 1000;
    value.cleanupDeadlineSeconds = (deadline - started) / 1000;
    try {
      value.stopObservation = await stopCarrierChild(
        child,
        terminal,
        owner,
        cleanup,
        {
          softStopMs: gccCarrierLimits.softStopSeconds * 1000,
          deadline,
          family,
        },
      );
    } catch (error) {
      value.stopObservation = error.stopObservation ?? null;
      throw error;
    }
  });
  try {
    ownerHandle = await open(ownerPart, "wx", 0o600);
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    const observeOriginal = async (admitted) => {
      if (admitted) {
        limits = {
          ...gccCarrierLimits,
          observationSeconds: admitted.observationSeconds,
        };
        value.githubJobEnvelope = admitted;
        value.carrierLimits = limits;
        value.cutoffAt = admitted.cutoffAt;
      }
      const remaining = admitted
        ? remainingGccObservationMs(admitted, started, performance.now())
        : Math.floor(
            started + limits.observationSeconds * 1000 - performance.now(),
          );
      assert.ok(
        remaining > 0,
        "Admitted GCC observation envelope expired before original execution",
      );
      return observeForeground(
        () => {
          ({ child, family } = spawnCarrierNode([
            path.join(path.dirname(self), "qualify-c-producer.mjs"),
            "--profile",
            name,
            "--inputs",
            inputs,
            "--output",
            output,
            "--operator-trust-execution",
            "--coordinated-heavy-slot",
          ]));
          terminal = new Promise((resolve) => {
            const observed = () => {
              value.controllerTerminalSeconds ??=
                (performance.now() - started) / 1000;
              resolve();
            };
            child.once("close", observed);
            child.once("error", observed);
          });
          return child;
        },
        path.join(carrier, "controller.log"),
        {
          timeoutMs: remaining,
          maxBytes: gccCarrierLimits.logBytes,
          signal: controller.signal,
          stop: async () => {
            // The initial atomic controller receipt predates every owned container.
            // Read it before SIGTERM can replace the final snapshot.
            await stopAndCleanup();
          },
        },
      );
    };
    if (useGithubEnvelope) {
      const context = githubGccContextFromEnvironment(process.env);
      const capture = () =>
        captureAndRetainGithubGccJobClock(
          context,
          {
            carrierStartedAt: startedAt,
            carrierMonotonicStarted: started,
            token: process.env.CHECKTRAIL_GITHUB_JOB_TOKEN,
          },
          (observed) => retainCarrierJobClock(carrier, observed),
        );
      value.controllerObserver = await afterGccJobAdmission(
        capture,
        observeOriginal,
      );
    } else value.controllerObserver = await observeOriginal(null);
    value.stopCause =
      value.controllerObserver.reason === "deadline"
        ? "external-carrier-cutoff"
        : value.controllerObserver.reason;
    value.state =
      value.stopCause === "external-carrier-cutoff"
        ? "external-carrier-cutoff-incomplete"
        : value.stopCause === null
          ? "original-controller-terminal-observed"
          : "carrier-observation-incomplete";
  } catch (error) {
    failure = error;
    value.error = String(error);
    if (error?.carrierPublicationSecondaryFailures)
      value.publicationFailure = carrierPublicationFailureDetails(error);
    value.state = "carrier-observation-incomplete";
    value.observedFailedTerminal = error.observedTerminal ?? null;
  } finally {
    try {
      await stopAndCleanup();
    } catch (error) {
      failure ??= error;
      value.cleanupError = String(error);
      value.state = "carrier-cleanup-or-observation-incomplete";
    }
    try {
      const current = await verifyCObservationStartup(name, startupFile);
      assert.deepEqual(current.startupRaw, startupRaw);
      value.log = await identifyFile(
        path.join(carrier, "controller.log"),
        gccCarrierLimits.logBytes,
      );
    } catch (error) {
      failure ??= error;
      value.aftercheckError = String(error);
      value.state = "carrier-source-or-log-aftercheck-incomplete";
    }
    value.elapsedSeconds = (performance.now() - started) / 1000;
    value.finishedAt = new Date().toISOString();
    const finalCloseAttempts = new Set();
    try {
      finalPublicationFailure = await closeCarrierPublicationHandles(
        [ownerHandle],
        undefined,
        finalCloseAttempts,
      );
      if (finalPublicationFailure === undefined)
        await publishReserved(
          receiptHandle,
          receiptPart,
          path.join(carrier, "receipt.json"),
          JSON.stringify(value, null, 2) + "\n",
          { link, unlink, open },
          finalCloseAttempts,
        );
    } catch (error) {
      finalPublicationFailure = error;
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
      finalPublicationFailure = await closeCarrierPublicationHandles(
        [ownerHandle, receiptHandle],
        finalPublicationFailure,
        finalCloseAttempts,
      );
    }
  }
  finishCarrierPublication(failure, finalPublicationFailure);
  return {
    state: value.state,
    carrierReceipt: path.join(carrier, "receipt.json"),
    originalControllerExit: value.controllerObserver?.exitCode ?? null,
    failureObserved: Boolean(failure),
    gateAComplete: false,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  try {
    process.stdout.write(
      JSON.stringify(await mainCProducerCarrier(process.argv.slice(2))) + "\n",
    );
  } catch (error) {
    process.stderr.write(String(error) + "\n");
    if (error?.carrierPublicationSecondaryFailures)
      process.stderr.write(
        JSON.stringify({
          publicationFailure: carrierPublicationFailureDetails(error),
        }) + "\n",
      );
  }
  process.exitCode = 2; // A carrier terminal alone never closes original producer ancestry.
}
