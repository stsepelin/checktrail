import {
  acceptanceConsumerLock,
  runAcceptanceNpm,
} from "./install-acceptance-package.mjs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { fileURLToPath, URL } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "checktrail-cache-"));
try {
  const [packed] = JSON.parse(
    runAcceptanceNpm(
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      { cwd: repository, encoding: "utf8" },
    ),
  );
  const consumer = path.join(temporary, "consumer");
  await mkdir(consumer);
  const tarball = path.join(temporary, packed.filename);
  const [manifest, lock, bytes] = await Promise.all([
    readFile(path.join(repository, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(repository, "package-lock.json"), "utf8").then(
      JSON.parse,
    ),
    readFile(tarball),
  ]);
  const prepared = acceptanceConsumerLock(
    manifest,
    lock,
    tarball,
    "sha512-" + createHash("sha512").update(bytes).digest("base64"),
  );
  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify(prepared.manifest),
  );
  await writeFile(
    path.join(consumer, "package-lock.json"),
    JSON.stringify(prepared.lock),
  );
  runAcceptanceNpm(
    ["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"],
    { cwd: consumer, stdio: "inherit" },
  );
  process.stdout.write(
    "Locked production package-install cache prepared with network access; offline verification runs separately.\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
