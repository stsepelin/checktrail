import { constants } from "node:fs";
import { access, lstat, readFile, realpath, readdir } from "node:fs/promises";
import path from "node:path";
import { mavenHash } from "./maven.js";
import { swiftRequire } from "./swift-native.js";
import { swiftExtensionsSdkRoots } from "./swift-extensions-sdk.js";
import type { SwiftExtensionsConfig } from "./swift-extensions-contract.js";
export async function swiftExtensionsRegular(
  file: string,
  bound = 4 * 1024 * 1024,
) {
  const stat = await lstat(file);
  swiftRequire(
    path.isAbsolute(file) &&
      (await realpath(file)) === file &&
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size <= bound,
    "Swift extension artifact is not bounded and regular",
  );
  const data = await readFile(file);
  swiftRequire(
    data.length === stat.size && data.length <= bound,
    "Swift extension artifact changed size",
  );
  return data;
}
export async function swiftExtensionsTool(name: string) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const entry = path.resolve(directory, name);
    try {
      await access(entry, constants.X_OK);
    } catch {
      continue;
    }
    const resolved = await realpath(entry),
      bytes = await swiftExtensionsRegular(resolved, 512 * 1024 * 1024);
    return { name, entry, resolved, sha256: mavenHash(bytes), afterSha256: "" };
  }
  throw Error("Swift extension pinned executable unavailable");
}
export async function swiftExtensionsSdkBytes(config: SwiftExtensionsConfig) {
  swiftRequire(
    (await realpath("/usr/lib/swift/clang")) === "/usr/lib/clang/17",
    "Swift extension Clang directory alias differs",
  );
  for (const root of Object.values(swiftExtensionsSdkRoots))
    swiftRequire(
      (await realpath(root)) === root,
      "Swift extension SDK root is not canonical",
    );
  const result = [];
  let total = 0;
  for (const pin of config.sdk) {
    const file = path.join(swiftExtensionsSdkRoots[pin.root], pin.path),
      resolved = await realpath(file);
    swiftRequire(
      Object.values(swiftExtensionsSdkRoots).some((root) =>
        resolved.startsWith(root + "/"),
      ),
      "Swift extension SDK file alias escapes selected roots",
    );
    const bytes = await swiftExtensionsRegular(resolved, 128 * 1024 * 1024);
    total += bytes.length;
    swiftRequire(
      total <= 512 * 1024 * 1024 &&
        bytes.length === pin.bytes &&
        mavenHash(bytes) === pin.sha256,
      "Swift extension SDK bytes differ from policy",
    );
    result.push({ ...pin, bytes: bytes.length, sha256: mavenHash(bytes) });
  }
  return result;
}

/** Every generated output is regular, canonical and in a bounded complete tree. */
export async function swiftExtensionsTree(directory: string) {
  let entries = 0;
  const walk = async (file: string, depth: number): Promise<string[]> => {
    swiftRequire(
      depth <= 32 && (await realpath(file)) === file,
      "Swift generated directory address/depth differs",
    );
    const values: string[] = [];
    for (const entry of await readdir(file, { withFileTypes: true })) {
      swiftRequire(
        ++entries <= 1024 && !entry.isSymbolicLink(),
        "Swift generated output entry/alias bound",
      );
      const absolute = path.join(file, entry.name);
      if (entry.isDirectory())
        values.push(...(await walk(absolute, depth + 1)));
      else {
        swiftRequire(entry.isFile(), "Swift generated output not regular");
        values.push(absolute);
      }
      swiftRequire(values.length <= 256, "Swift generated output file bound");
    }
    return values;
  };
  return walk(directory, 0);
}
