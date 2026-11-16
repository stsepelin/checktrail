// Only an operator-pinned ExternalAdapter bundle can select this coordinator.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
async function main() {
  const request = JSON.parse(await readFile(process.argv[2], "utf8"));
  const bundleRoot = fileURLToPath(new URL("./", import.meta.url));
  const policy = JSON.parse(
    await readFile(path.join(bundleRoot, "policy.json"), "utf8"),
  );
  assert.ok(path.isAbsolute(policy.coordinator.file));
  assert.equal(
    await realpath(policy.coordinator.file),
    policy.coordinator.file,
  );
  const descriptor = await open(
    policy.coordinator.file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await descriptor.stat();
    assert.ok(
      before.isFile() && before.size > 0 && before.size <= 2 * 1024 * 1024,
    );
    const bytes = await descriptor.readFile();
    const after = await descriptor.stat();
    assert.ok(
      before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === bytes.length &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs,
    );
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      policy.coordinator.sha256,
      "Startup coordinator source pin differs",
    );
  } finally {
    await descriptor.close();
  }
  const { composeNativeProvenance, provenanceHash } = await import(
    pathToFileURL(policy.coordinator.file).href
  );
  const controller = new globalThis.AbortController();
  const abort = () => controller.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  try {
    const receipt = await composeNativeProvenance(
      request,
      process.env.CHECKTRAIL_TEMP,
      controller.signal,
      policy,
      bundleRoot,
    );
    const raw = JSON.stringify(receipt);
    process.stderr.write("CHECKTRAIL_PROVENANCE_RECEIPT " + raw + "\n");
    process.stdout.write(
      JSON.stringify({
        protocolVersion: 1,
        identity: request.identity,
        checkId: request.checkId,
        sourceFingerprint: request.sourceFingerprint,
        files: request.scope.map((file) => ({
          path: file,
          status: "unavailable",
        })),
        findingsComplete: false,
        findings: [],
        tools: [
          {
            name: "selected-provenance-observation",
            version: "v1-" + provenanceHash(raw),
          },
        ],
      }),
    );
    process.exitCode = receipt.state === "error" ? 2 : 0;
  } finally {
    process.off("SIGTERM", abort);
    process.off("SIGINT", abort);
  }
}
main().catch(() => {
  process.stderr.write("Operator provenance startup could not be admitted\n");
  process.exitCode = 2;
});
