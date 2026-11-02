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
  physicalPath,
  validateDestination,
  validateInputs,
} from "./qualify-binutils-producer.mjs";
import {
  loadCProducerProfile,
  cProducerProfileKey,
} from "./producer-qualification/c-producer-profile.mjs";
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

export async function validateRetainedU13SourceInputs(
  profile,
  sourceRoot,
  output,
) {
  assert.equal(
    cProducerProfileKey(profile),
    "glibc-u13",
    "Retained-source input is only for the exact u13 tuple",
  );
  const sourceRows = profile.files.filter((row) =>
    ["signed-source-descriptor", "original-source-archive"].includes(row.kind),
  );
  assert.deepEqual(
    sourceRows.map((row) => row.file).sort(),
    [
      "source/glibc/glibc_2.36-9+deb12u13.debian.tar.xz",
      "source/glibc/glibc_2.36-9+deb12u13.dsc",
      "source/glibc/glibc_2.36.orig.tar.xz",
    ],
    "Exactly three closed u13 source input names",
  );
  const retainedSource = await physicalPath(path.resolve(sourceRoot), true);
  const retainedRows = sourceRows.map((row) => ({
    ...row,
    file: path.basename(row.file),
  }));
  await validateInputs(retainedSource, retainedRows);
  await validateDestination(retainedSource, output);
  return { retainedSource, sourceRows, retainedRows };
}

export async function copyRetainedU13SourceInput(retained, row, target) {
  assert.ok(retained.retainedSource && retained.sourceRows.length === 3);
  assert.deepEqual(
    row,
    retained.sourceRows.find((source) => source.file === row.file),
    "Only a preflight-admitted u13 source row can be copied",
  );
  await copyPinnedInput(
    path.join(retained.retainedSource, path.basename(row.file)),
    target,
    row,
  );
  return { kind: "exact-retained-u13-source-copy" };
}

export async function acquireCProducerInputs(
  name,
  commonRoot,
  output,
  sourceRoot,
) {
  const { catalog, profile, catalogSha256 } = await loadCProducerProfile(name);
  assert.ok(
    sourceRoot === undefined ||
      (name === "glibc-u13" && typeof sourceRoot === "string"),
    "Only glibc-u13 accepts the optional fixed retained-source input directory",
  );
  const retained =
    name === "glibc-u13" && sourceRoot !== undefined
      ? await validateRetainedU13SourceInputs(profile, sourceRoot, output)
      : { retainedSource: null, sourceRows: [], retainedRows: [] };
  const { retainedSource, sourceRows, retainedRows } = retained;
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
      } else if (
        retainedSource &&
        sourceRows.some((source) => source.file === row.file)
      ) {
        origin = await copyRetainedU13SourceInput(retained, row, target);
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
    if (retainedSource) await validateInputs(retainedSource, retainedRows);
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
      (args.length === 6 ||
        (args[1] === "glibc-u13" &&
          args.length === 8 &&
          args[6] === "--source-inputs")) &&
        args[0] === "--profile" &&
        args[2] === "--common-inputs" &&
        args[4] === "--output",
      "Usage: --profile gcc-12|glibc|glibc-u13 --common-inputs BUNDLE --output NEW_DIRECTORY [--source-inputs RETAINED_THREE_SOURCE_FILES (glibc-u13 only)]",
    );
    process.stdout.write(
      JSON.stringify(
        await acquireCProducerInputs(
          args[1],
          path.resolve(args[3]),
          path.resolve(args[5]),
          args[1] === "glibc-u13" && args.length === 8
            ? path.resolve(args[7])
            : undefined,
        ),
      ) + "\n",
    );
  } catch (error) {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 2;
  }
}
