import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
/** Runtime JS plus package declaration. Dependency bytes and loaded-module identity remain unverified. */
export function observeReviewEngineDigest(): string {
  const root = fileURLToPath(new URL("./", import.meta.url));
  const files = readdirSync(root)
    .filter((name) => name.endsWith(".js"))
    .sort();
  if (!files.length || files.length > 512)
    throw new Error("Unsupported review engine runtime inventory");
  const hash = createHash("sha256");
  let total = 0;
  for (const [name, filename] of [
    ...files.map((name) => [name, path.join(root, name)]),
    [
      "package.json",
      fileURLToPath(new URL("../../package.json", import.meta.url)),
    ],
  ]) {
    const fd = openSync(
      filename!,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = fstatSync(fd);
      if (
        !before.isFile() ||
        before.size > 2_097_152 ||
        (total += before.size) > 33_554_432
      )
        throw new Error("Unsupported review engine runtime file");
      const bytes = Buffer.alloc(before.size);
      let read = 0;
      while (read < bytes.length) {
        const n = readSync(fd, bytes, read, bytes.length - read, read);
        if (!n) throw new Error("Engine runtime read ended early");
        read += n;
      }
      const after = fstatSync(fd),
        linked = lstatSync(filename!);
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        after.dev !== linked.dev ||
        after.ino !== linked.ino
      )
        throw new Error("Engine runtime changed while observing");
      hash.update(
        JSON.stringify([
          name,
          bytes.length,
          createHash("sha256").update(bytes).digest("hex"),
        ]) + "\n",
      );
    } finally {
      closeSync(fd);
    }
  }
  if (
    JSON.stringify(files) !==
    JSON.stringify(
      readdirSync(root)
        .filter((name) => name.endsWith(".js"))
        .sort(),
    )
  )
    throw new Error("Engine runtime inventory changed while observing");
  return hash.digest("hex");
}
