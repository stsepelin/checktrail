import { constants, openSync, closeSync, fstatSync, readSync } from "node:fs";
import { open } from "node:fs/promises";
const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const unchanged = (a: import("node:fs").Stats, b: import("node:fs").Stats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
export async function kotlinRead(
  file: string,
  maximum: number,
): Promise<Buffer> {
  const handle = await open(file, flags);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximum)
      throw Error("Kotlin input byte bound");
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset !== before.size || !unchanged(before, await handle.stat()))
      throw Error("Kotlin input changed while read");
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
export function kotlinReadSync(file: string, maximum: number): Buffer {
  const handle = openSync(file, flags);
  try {
    const before = fstatSync(handle);
    if (!before.isFile() || before.size > maximum)
      throw Error("Kotlin input byte bound");
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(
        handle,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!read) break;
      offset += read;
    }
    if (offset !== before.size || !unchanged(before, fstatSync(handle)))
      throw Error("Kotlin input changed while read");
    return bytes.subarray(0, offset);
  } finally {
    closeSync(handle);
  }
}
