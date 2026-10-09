import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
/** Byte identity for the selected Node router bundles, not a whole dependency/publisher/license closure. */
export const vueRouterAssemblyRuntimePins = [
  {
    file: "vue-router.node.mjs",
    bytes: 74,
    sha256: "8e81cc52d7e609d9d5547664ca746d5223616d04ec35451d4fa606b7df84ef4c",
  },
  {
    file: "dist/vue-router.js",
    bytes: 57788,
    sha256: "274a8d36d942e3102a961c7be15bfb6dcc41a69b5e8a72f0f36f91eb8c8556cb",
  },
  {
    file: "dist/devtools-CN5uWJaH.js",
    bytes: 36524,
    sha256: "7d8c7fbe4944d717d70b9b026ca4dce118b96f61136b9af1f223d32a344aac4c",
  },
  {
    file: "dist/useApi-BPuI6ZR9.js",
    bytes: 21759,
    sha256: "9056b6e651a58c60aab83d5dc19a052a876f0efebc861fae5e4d022837a20f3b",
  },
  {
    file: "dist/navigation-guard-Csroba8S.js",
    bytes: 10257,
    sha256: "0928108e820a0c38246811df16a00f6473383e173c49e9afa586f6e84817a464",
  },
] as const;
export async function vueRouterAssemblyRuntimeMatches(entry: string) {
  try {
    for (const pin of vueRouterAssemblyRuntimePins) {
      const file = path.join(path.dirname(entry), pin.file),
        stat = await lstat(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size !== pin.bytes ||
        (await realpath(file)) !== file
      )
        return false;
      const bytes = await readFile(file);
      if (
        bytes.length !== pin.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== pin.sha256
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}
