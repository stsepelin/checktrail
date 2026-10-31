// Data acquisition only. No package manager, installer, source hook or compiler runs.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";
import { createHash } from "node:crypto";
import {
  atomicReceipt,
  copyPinnedInput,
  validateDestination,
  validateInputs,
} from "./qualify-binutils-producer.mjs";
import { loadCProducerProfile } from "./producer-qualification/c-producer-profile.mjs";
const { AbortController, fetch } = globalThis;

export function validateCProducerDownloadUrl(address) {
  const url = new URL(address);
  assert.equal(url.protocol, "https:");
  assert.ok(
    ["deb.debian.org", "snapshot.debian.org"].includes(url.hostname),
    "Unregistered archive origin",
  );
  assert.equal(
    url.username + url.password + url.port + url.search + url.hash,
    "",
  );
  assert.ok(
    /^\/(debian(?:-security)?\/pool\/|file\/)/u.test(url.pathname),
    "Unregistered archive path",
  );
  return url.href;
}

// Separate finite capability for the exact87MB GCC source; shared64MiB stays unchanged.
export async function retainCProducerDownload(response, target, pin, signal) {
  assert.ok(
    Number.isSafeInteger(pin.bytes) &&
      pin.bytes > 0 &&
      pin.bytes <= 128 * 1024 ** 2,
    "Finite C producer input bound exceeded",
  );
  assert.match(pin.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(response.status, 200, "Original archive request failed");
  assert.equal(
    response.headers.get("content-encoding") ?? "identity",
    "identity",
    "Encoded archive transport refused",
  );
  const length = response.headers.get("content-length");
  if (length !== null)
    assert.equal(length, String(pin.bytes), "Declared archive length differs");
  assert.ok(response.body, "Missing original archive body");
  assert.ok(
    !signal.aborted,
    "Archive acquisition interrupted before publication",
  );
  const output = await open(
    target,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      assert.ok(!signal.aborted, "Archive acquisition interrupted");
      bytes += chunk.length;
      assert.ok(
        bytes <= pin.bytes,
        "Archive body exceeds exact declared length",
      );
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const result = await output.write(
          Buffer.from(chunk),
          offset,
          chunk.length - offset,
        );
        assert.ok(result.bytesWritten > 0, "Archive writer made no progress");
        offset += result.bytesWritten;
      }
    }
    assert.equal(bytes, pin.bytes, "Original archive body is incomplete");
    assert.equal(
      hash.digest("hex"),
      pin.sha256,
      "Original archive SHA256 differs",
    );
    await output.sync();
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  } finally {
    await output.close();
  }
}

async function download(row, target, signal) {
  const failures = [];
  for (const candidate of row.sourceUrls ?? []) {
    try {
      let address = validateCProducerDownloadUrl(candidate);
      for (let redirects = 0; ; redirects++) {
        const response = await fetch(address, {
          redirect: "manual",
          signal,
          headers: { "accept-encoding": "identity" },
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          assert.ok(redirects < 4, "Archive redirect bound exceeded");
          const location = response.headers.get("location");
          assert.ok(location, "Missing archive redirect location");
          address = validateCProducerDownloadUrl(
            new URL(location, address).href,
          );
          continue;
        }
        await retainCProducerDownload(response, target, row, signal);
        return { candidate, finalUrl: address };
      }
    } catch (error) {
      failures.push(String(error).slice(0, 1000));
      if (signal.aborted) throw error;
    }
  }
  throw new Error("No exact original archive was acquired: " + row.file, {
    cause: failures,
  });
}

export async function acquireCProducerInputs(name, commonRoot, output) {
  const { catalog, profile, catalogSha256 } = await loadCProducerProfile(name);
  await validateInputs(commonRoot, catalog.commonInputs);
  const { destination } = await validateDestination(commonRoot, output);
  await mkdir(destination, { mode: 0o700 });
  const bundle = path.join(destination, "bundle");
  await mkdir(bundle, { mode: 0o700 });
  const state = {
    state: "acquiring-pinned-data",
    profile: profile.profile,
    catalogSha256,
    acquired: [],
    buildExecuted: false,
    freshSourceSignatureExecutionPerformed: false,
    inputAuthenticationAndFreshnessDisabled: false,
    fullCompilerSdkBootstrapClosureVerified: false,
    completeOriginalNoticeClosureVerified: false,
    gateAComplete: false,
  };
  const controller = new AbortController();
  const abort = () => controller.abort("caller-signal");
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  const timer = setTimeout(
    () => controller.abort("data-acquisition-deadline"),
    15 * 60 * 1000,
  );
  try {
    await atomicReceipt(destination, state);
    for (const row of profile.files) {
      assert.ok(!controller.signal.aborted, "Data acquisition stopped");
      const target = path.join(bundle, row.file);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const common = catalog.commonInputs.find(
        (entry) => entry.file === row.file,
      );
      let origin;
      if (common) {
        await copyPinnedInput(path.join(commonRoot, row.file), target, row);
        origin = { kind: "exact-shared-authenticated-metadata-copy" };
      } else if (row.bytes === 0) {
        await writeFile(target, "", { mode: 0o600, flag: "wx" });
        origin = { kind: "exact-empty-cache-lock" };
      } else origin = await download(row, target, controller.signal);
      state.acquired.push({
        file: row.file,
        bytes: row.bytes,
        sha256: row.sha256,
        origin,
      });
      await atomicReceipt(destination, state);
    }
    await validateInputs(bundle, profile.files);
    await validateInputs(commonRoot, catalog.commonInputs);
    assert.ok(
      !controller.signal.aborted,
      "Data acquisition stopped before final qualification",
    );
    state.state = "complete-pinned-input-bundle";
  } catch (error) {
    state.state = "incomplete-input-acquisition";
    state.error = String(error).slice(0, 2000);
    throw error;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    await atomicReceipt(destination, state);
  }
  return {
    state: state.state,
    bundle,
    files: state.acquired.length,
    gateAComplete: false,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    assert.ok(
      args.length === 6 &&
        args[0] === "--profile" &&
        args[2] === "--common-inputs" &&
        args[4] === "--output",
      "Usage: node scripts/acquire-c-producer-inputs.mjs --profile gcc-12|glibc --common-inputs AUTHENTICATED_BINUTILS_BUNDLE --output NEW_DIRECTORY",
    );
    process.stdout.write(
      JSON.stringify(
        await acquireCProducerInputs(
          args[1],
          path.resolve(args[3]),
          path.resolve(args[5]),
        ),
      ) + "\n",
    );
  } catch (error) {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 2;
  }
}
