import { Buffer } from "node:buffer";
import process from "node:process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
  readdir,
  open,
} from "node:fs/promises";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";
import { terraformExtensionsProvider as provider } from "../dist/src/terraform-extensions-contract.js";
import { mavenHash } from "../dist/src/maven.js";
import { requestPinnedArtifactBytes } from "./request-pinned-artifact.mjs";
import { encodeReleaseSignatureProof } from "../dist/src/release-signature-proof.js";
import {
  randomReleaseSignaturePolicy as signaturePolicy,
  randomReleaseProofFile,
  randomPreparedIdentity,
  randomPreparedFileNames,
  readRandomReleaseProof,
} from "../dist/src/terraform-release-signature.js";
import { verifyDetachedReleaseSignatures } from "./release-signature-preparation.mjs";

const args = process.argv.slice(2);
assert.ok(
  args.length === 0 ||
    (args.length === 2 && args[0] === "--verify-release-signature"),
  "Usage: prepare-terraform-extensions-runtime.mjs [--verify-release-signature ABSOLUTE_INPUT_DIRECTORY]",
);
const qualified = args.length === 2;
const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const checktrail = path.join(root, ".checktrail");
await mkdir(checktrail, { recursive: true });
assert.equal(await realpath(checktrail), checktrail);
const legacy = path.join(checktrail, "terraform-extensions-tools");
if (!qualified) await assert.rejects(lstat(legacy), { code: "ENOENT" });
const asset =
  "https://releases.hashicorp.com/terraform-provider-random/3.9.1/" +
  provider.archive;
const local = process.env.CHECKTRAIL_TERRAFORM_RANDOM_ARCHIVE;
async function boundedRead(file, bound) {
  assert.equal(await realpath(file), file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    assert.ok(info.isFile() && info.size > 0 && info.size <= bound);
    const buffer = Buffer.allocUnsafe(info.size + 1);
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
    assert.ok(
      eof && used === info.size,
      "Prepared input grew beyond its read bound",
    );
    const body = buffer.subarray(0, used);
    const after = await handle.stat();
    for (const key of ["dev", "ino", "mode", "size", "mtimeMs", "ctimeMs"])
      assert.equal(after[key], info[key]);
    return body;
  } finally {
    await handle.close();
  }
}

async function regular(file, expected) {
  const body = await boundedRead(file, expected.bytes);
  assert.equal(body.length, expected.bytes);
  assert.equal(mavenHash(body), expected.sha256);
  return body;
}

const bytes =
  local === undefined
    ? await requestPinnedArtifactBytes({
        asset,
        bytes: provider.archiveBytes,
        sha256: provider.archiveSha256,
      })
    : await regular(path.resolve(local), {
        bytes: provider.archiveBytes,
        sha256: provider.archiveSha256,
      });
assert.equal(bytes.length, provider.archiveBytes);
assert.equal(mavenHash(bytes), provider.archiveSha256);
const namespace = qualified
  ? path.join(checktrail, "terraform-extensions-signed-tools")
  : checktrail;
await mkdir(namespace, { recursive: true });
assert.equal(await realpath(namespace), namespace);
const temporary = await mkdtemp(
  path.join(namespace, ".terraform-extensions-preparation-"),
);
let destination;
try {
  const archive = path.join(temporary, provider.archive);
  await writeFile(archive, bytes, { flag: "wx", mode: 0o644 });
  const listed = execFileSync("unzip", ["-Z", "-1", archive], {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 4096,
  })
    .trim()
    .split("\n");
  assert.deepEqual(
    listed.toSorted(),
    provider.members.map((member) => member.path).toSorted(),
  );
  for (const member of provider.members) {
    const content = execFileSync("unzip", ["-p", archive, member.path], {
      timeout: 30000,
      maxBuffer: member.bytes + 4096,
    });
    assert.equal(content.length, member.bytes);
    assert.equal(mavenHash(content), member.sha256);
    await writeFile(path.join(temporary, member.path), content, {
      flag: "wx",
      mode: member.path.startsWith("terraform-provider-") ? 0o755 : 0o644,
    });
  }
  let proofPin = "",
    proof;
  if (qualified) {
    assert.ok(
      path.isAbsolute(args[1]),
      "Absolute operator signature input directory required",
    );
    const inputRoot = await realpath(args[1]);
    assert.equal(inputRoot, args[1]);
    const key = await regular(
      path.join(inputRoot, signaturePolicy.publicKey.path),
      signaturePolicy.publicKey,
    );
    const declaration = signaturePolicy.signatures[0];
    const subject = await regular(
      path.join(inputRoot, declaration.subject.path),
      declaration.subject,
    );
    const signature = await regular(
      path.join(inputRoot, declaration.signature.path),
      declaration.signature,
    );
    const matches = subject
      .toString("utf8")
      .split("\n")
      .filter((line) => line.endsWith("  " + provider.archive));
    assert.deepEqual(
      matches,
      [provider.archiveSha256 + "  " + provider.archive],
      "Original release checksum row differs",
    );
    const verification = await verifyDetachedReleaseSignatures({
      publicKey: { path: signaturePolicy.publicKey.path, body: key },
      signatures: [
        {
          subject: { path: declaration.subject.path, body: subject },
          signature: { path: declaration.signature.path, body: signature },
        },
      ],
      signerFingerprint: declaration.signerFingerprint,
      primaryFingerprint: declaration.primaryFingerprint,
    });
    const proofBytes = encodeReleaseSignatureProof(
      signaturePolicy,
      verification,
    );
    proofPin = createHash("sha256").update(proofBytes).digest("hex");
    await writeFile(path.join(temporary, randomReleaseProofFile), proofBytes, {
      flag: "wx",
      mode: 0o644,
    });
    proof = readRandomReleaseProof(temporary, proofPin);
  }
  const identity = randomPreparedIdentity(
    local === undefined ? asset : "operator-prepared-artifact",
    proof,
  );
  await writeFile(
    path.join(temporary, "identity.json"),
    JSON.stringify(identity, null, 2) + "\n",
    { flag: "wx", mode: 0o644 },
  );
  destination = qualified ? path.join(namespace, proofPin) : legacy;
  async function verifyCohort(directory) {
    const info = await lstat(directory);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
    assert.equal(await realpath(directory), directory);
    assert.deepEqual(
      (await readdir(directory)).toSorted(),
      randomPreparedFileNames(proofPin),
    );
    await regular(path.join(directory, provider.archive), {
      bytes: provider.archiveBytes,
      sha256: provider.archiveSha256,
    });
    for (const member of provider.members)
      await regular(path.join(directory, member.path), member);
    const text = (
      await boundedRead(path.join(directory, "identity.json"), 64 * 1024)
    ).toString("utf8");
    const actual = JSON.parse(text),
      documents = parseAllDocuments(text, {
        strict: true,
        uniqueKeys: true,
        prettyErrors: false,
      });
    assert.ok(
      documents.length === 1 &&
        !documents[0].errors.length &&
        !documents[0].warnings.length,
      "Prepared identity JSON is ambiguous",
    );
    assert.ok(
      [asset, "operator-prepared-artifact"].includes(actual.archiveSource),
    );
    const observed = readRandomReleaseProof(directory, proofPin);
    assert.deepEqual(
      actual,
      randomPreparedIdentity(actual.archiveSource, observed),
    );
  }
  await verifyCohort(temporary);
  await chmod(temporary, 0o755);
  const exists = await lstat(destination).then(
    () => true,
    (error) => {
      if (error.code !== "ENOENT") throw error;
      return false;
    },
  );
  if (exists) {
    assert.ok(qualified, "Legacy prepared cache already exists");
    await verifyCohort(destination);
  } else {
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (!qualified || !["EEXIST", "ENOTEMPTY"].includes(error.code))
        throw error;
      await verifyCohort(destination);
    }
  }
  process.stdout.write(
    JSON.stringify({
      preparedProvider: provider.address,
      version: provider.version,
      archiveSha256: provider.archiveSha256,
      memberCount: provider.members.length,
      releaseSignatureVerified: qualified,
      ...(qualified
        ? {
            providerRoot: destination,
            proofSha256: proofPin,
            scope: "selected-release-checksum-signature",
            keyOwnerTrustEstablished: false,
            publisherAndLicenseClosureVerified: false,
          }
        : {}),
    }) + "\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
