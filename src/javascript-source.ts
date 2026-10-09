import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { withinRoot } from "./inventory.js";
export async function javascriptSource(root: string, file: string) {
  const resolved = await withinRoot(root, file);
  const handle = await open(resolved, "r");
  try {
    const limit = 8 * 1024 * 1024;
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit)
      throw new Error("Unsupported JavaScript source size");
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== stat.size || (await handle.stat()).size !== length)
      throw new Error("JavaScript source changed while reading");
    const bytes = buffer.subarray(0, length);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes))
      throw new Error("JavaScript source must be canonical UTF-8");
    return {
      identity: {
        path: file,
        bytes: length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      text,
      resolved,
    };
  } finally {
    await handle.close();
  }
}
