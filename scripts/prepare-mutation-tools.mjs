import assert from "node:assert/strict";
import {
  readFile,
  lstat,
  mkdir,
  mkdtemp,
  writeFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { createHash } from "node:crypto";
import { selectJavaScriptToolsLock } from "./prepare-javascript-tools.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)),
  destination = path.join(root, ".checktrail/mutation-javascript-tools");
const rootLock = await readFile(path.join(root, "package-lock.json"), "utf8"),
  { manifest, lock } = selectJavaScriptToolsLock(
    { dependencies: { vitest: "5.0.1", jest: "30.5.2" } },
    JSON.parse(rootLock),
  );
await assert.rejects(lstat(destination), { code: "ENOENT" });
await mkdir(path.dirname(destination), { recursive: true });
const temporary = await mkdtemp(
  path.join(path.dirname(destination), "mutation-tools-"),
);
let published = false;
try {
  await writeFile(
    path.join(temporary, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx" },
  );
  await writeFile(
    path.join(temporary, "package-lock.json"),
    JSON.stringify(lock, null, 2) + "\n",
    { flag: "wx" },
  );
  await rename(temporary, destination);
  published = true;
} finally {
  if (!published) await rm(temporary, { recursive: true, force: true });
}
process.stdout.write(
  JSON.stringify({
    rootLockSha256: createHash("sha256").update(rootLock).digest("hex"),
    selectedLockSha256: createHash("sha256")
      .update(JSON.stringify(lock))
      .digest("hex"),
    packages: Object.keys(lock.packages).length - 1,
    rangeResolutionPerformed: false,
  }) + "\n",
);
