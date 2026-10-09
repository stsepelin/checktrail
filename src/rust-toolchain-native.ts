import { createHash } from "node:crypto";
import { access, lstat, open, readlink, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { rustNativeToolchainPins } from "./rust-toolchain-pins.js";
async function executable(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const file = path.join(directory, name);
    try {
      await access(file, constants.X_OK);
      if ((await lstat(file)).isFile() || (await lstat(file)).isSymbolicLink())
        return await realpath(file);
    } catch {
      // An absent or inaccessible PATH entry cannot identify this executable.
    }
  }
  throw Error("Declared native executable is absent");
}
export async function rustNativeToolchainMatches(): Promise<boolean> {
  if (process.platform !== "linux" || process.arch !== "arm64") return false;
  try {
    const rustc = await executable("rustc");
    const prefix = path.dirname(path.dirname(rustc));
    for (const pin of rustNativeToolchainPins.filter((p) =>
      p.path.startsWith("bin/"),
    ))
      if (
        (await executable(path.basename(pin.path))) !==
        path.join(prefix, pin.path)
      )
        return false;
    const buffer = Buffer.alloc(1048576);
    for (const pin of rustNativeToolchainPins) {
      const file = path.join(prefix, pin.path),
        stat = await lstat(file);
      if (
        pin.link === null
          ? !stat.isFile()
          : !stat.isSymbolicLink() || (await readlink(file)) !== pin.link
      )
        return false;
      const canonical = await realpath(file),
        relative = path.relative(prefix, canonical);
      if (
        !relative ||
        relative === ".." ||
        relative.startsWith(".." + path.sep) ||
        path.isAbsolute(relative)
      )
        return false;
      const handle = await open(file, "r");
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size !== pin.bytes) return false;
        const hash = createHash("sha256");
        let bytes = 0;
        while (true) {
          const read = await handle.read(
            buffer,
            0,
            Math.min(buffer.length, pin.bytes - bytes + 1),
            null,
          );
          if (!read.bytesRead) break;
          bytes += read.bytesRead;
          if (bytes > pin.bytes) return false;
          hash.update(buffer.subarray(0, read.bytesRead));
        }
        if (bytes !== pin.bytes || hash.digest("hex") !== pin.sha256)
          return false;
      } finally {
        await handle.close();
      }
    }
    return true;
  } catch {
    return false;
  }
}
