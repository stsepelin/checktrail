import { Buffer } from "node:buffer";
import process from "node:process";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  mkdtemp,
  mkdir,
  open,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  validateReleaseGpgStatus,
  releaseSignatureVerificationSchema,
} from "../dist/src/release-signature-proof.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pin = (name, body) => ({
  path: name,
  bytes: body.length,
  sha256: hash(body),
});
const maximumInput = 32 * 1024 * 1024;
function inputReference(value, bound = maximumInput) {
  if (
    !value ||
    typeof value.path !== "string" ||
    value.path.length > 256 ||
    !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value.path) ||
    value.path.split("/").some((part) => part === "." || part === "..") ||
    !(value.body instanceof Uint8Array) ||
    value.body.byteLength < 1 ||
    value.body.byteLength > bound
  )
    throw new Error("Bounded logical signature input required");
  return value;
}
function snapshot(value) {
  return { path: value.path, body: Buffer.from(value.body) };
}
async function observe(file, role) {
  if (!path.isAbsolute(file) || (await realpath(file)) !== file)
    throw new Error("Canonical verifier executable required");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      !(before.mode & 0o111) ||
      before.size < 1 ||
      before.size > maximumInput
    )
      throw new Error("Bounded verifier executable required");
    const buffer = Buffer.allocUnsafe(before.size + 1);
    let used = 0,
      eof = false;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        used,
        buffer.length - used,
        null,
      );
      if (bytesRead === 0) {
        eof = true;
        break;
      }
      used += bytesRead;
    }
    if (!eof || used !== before.size)
      throw new Error("Verifier grew beyond its read bound");
    const body = buffer.subarray(0, used),
      after = await handle.stat();
    const fields = [
      "dev",
      "ino",
      "mode",
      "uid",
      "gid",
      "nlink",
      "size",
      "mtimeMs",
      "ctimeMs",
    ];
    if (
      fields.some((key) => before[key] !== after[key]) ||
      body.length !== before.size
    )
      throw new Error("Verifier changed while observed");
    return { pin: pin(role, body), physical: fields.map((key) => before[key]) };
  } finally {
    await handle.close();
  }
}
async function executable(role, supplied) {
  const candidates =
    supplied === undefined
      ? (process.env.PATH ?? "")
          .split(path.delimiter)
          .filter(Boolean)
          .map((part) => path.resolve(part, role))
      : [supplied];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate))
      throw new Error("Absolute operator verifier path required");
    try {
      await access(candidate, constants.X_OK);
    } catch (error) {
      if (supplied !== undefined) throw error;
      continue;
    }
    const file = await realpath(candidate);
    return { file, before: await observe(file, role) };
  }
  throw new Error("Required native release signature verifier unavailable");
}
function execute(file, args, env) {
  const result = spawnSync(file, args, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
    maxBuffer: 16 * 1024,
  });
  if (result.error || result.signal || result.status !== 0) {
    const error = new Error(
      "Native detached-signature verification did not complete",
    );
    error.cause = {
      exitCode: result.status,
      signal: result.signal,
      errorCode: result.error?.code,
      stdout: result.stdout?.slice(0, 16384),
      stderr: result.stderr?.slice(0, 16384),
    };
    throw error;
  }
  return { stdout: result.stdout, stderr: result.stderr };
}
/** Explicit operator preparation only. Importing this module starts no process. */
export async function verifyDetachedReleaseSignatures(options) {
  if (
    !/^[A-F0-9]{40}$/.test(options.signerFingerprint) ||
    !/^[A-F0-9]{40}$/.test(options.primaryFingerprint)
  )
    throw new Error("Exact release signer fingerprints required");
  if (
    !Array.isArray(options.signatures) ||
    options.signatures.length < 1 ||
    options.signatures.length > 16
  )
    throw new Error("Release signature input cohort exceeds its bounds");
  const keyReference = inputReference(options.publicKey, 1024 * 1024);
  const references = options.signatures.map((item) => ({
    subject: inputReference(item?.subject),
    signature: inputReference(item?.signature, 1024 * 1024),
  }));
  if (
    new Set(references.map((item) => item.subject.path)).size !==
    references.length
  )
    throw new Error("Duplicate release signed subject");
  let total = keyReference.body.byteLength;
  for (const item of references) {
    total += item.subject.body.byteLength + item.signature.body.byteLength;
    if (total > 64 * 1024 * 1024)
      throw new Error("Release signature input cohort exceeds its bounds");
  }
  // Validate every cardinality and byte bound before making any body snapshot.
  const key = snapshot(keyReference);
  const subjects = references.map((item) => ({
    subject: snapshot(item.subject),
    signature: snapshot(item.signature),
  }));
  const gpg = await executable("gpg", options.tools?.gpg),
    gpgv = await executable("gpgv", options.tools?.gpgv);
  const temporary = await mkdtemp(
    path.join(tmpdir(), "checktrail-release-signature-"),
  );
  async function verify() {
    const home = path.join(temporary, "home");
    await mkdir(home, { mode: 0o700 });
    const env = {
      HOME: home,
      GNUPGHOME: home,
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
    };
    const keyFile = path.join(temporary, "public-key.asc"),
      ring = path.join(temporary, "publickeys.gpg");
    await writeFile(keyFile, key.body, { flag: "wx", mode: 0o600 });
    const versions = [
      execute(
        gpg.file,
        [
          "--no-options",
          "--homedir",
          home,
          "--batch",
          "--no-autostart",
          "--version",
        ],
        env,
      ).stdout.split("\n")[0],
      execute(gpgv.file, ["--homedir", home, "--version"], env).stdout.split(
        "\n",
      )[0],
    ];
    execute(
      gpg.file,
      [
        "--no-options",
        "--homedir",
        home,
        "--batch",
        "--no-autostart",
        "--dearmor",
        "--output",
        ring,
        keyFile,
      ],
      env,
    );
    const signatures = [];
    for (const [index, item] of subjects.entries()) {
      const subjectFile = path.join(temporary, "subject-" + index),
        signatureFile = path.join(temporary, "signature-" + index);
      await writeFile(subjectFile, item.subject.body, {
        flag: "wx",
        mode: 0o600,
      });
      await writeFile(signatureFile, item.signature.body, {
        flag: "wx",
        mode: 0o600,
      });
      const result = execute(
        gpgv.file,
        [
          "--homedir",
          home,
          "--keyring",
          ring,
          "--status-fd",
          "1",
          signatureFile,
          subjectFile,
        ],
        env,
      );
      validateReleaseGpgStatus(
        result.stdout,
        options.signerFingerprint,
        options.primaryFingerprint,
      );
      signatures.push({
        subject: pin(item.subject.path, item.subject.body),
        signature: pin(item.signature.path, item.signature.body),
        exitCode: 0,
        status: result.stdout,
        stderr: result.stderr,
        signerFingerprint: options.signerFingerprint,
        primaryFingerprint: options.primaryFingerprint,
      });
    }
    const after = [
      await observe(gpg.file, "gpg"),
      await observe(gpgv.file, "gpgv"),
    ];
    for (const [index, tool] of [gpg, gpgv].entries())
      if (JSON.stringify(tool.before) !== JSON.stringify(after[index]))
        throw new Error("Native release verifier changed");
    return releaseSignatureVerificationSchema.parse({
      keyValidityAssessed: false,
      keyOwnerTrustEstablished: false,
      publicKey: pin(key.path, key.body),
      tools: [gpg, gpgv].map((tool, index) => ({
        role: index === 0 ? "gpg" : "gpgv",
        before: tool.before.pin,
        after: after[index].pin,
        version: versions[index],
      })),
      signatures,
    });
  }
  try {
    const outcome = await verify().then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
    const final = [
      await observe(gpg.file, "gpg"),
      await observe(gpgv.file, "gpgv"),
    ];
    if (JSON.stringify([gpg.before, gpgv.before]) !== JSON.stringify(final))
      throw new Error("Native release verifier changed before cleanup");
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
