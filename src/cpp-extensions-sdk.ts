import path from "node:path";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { cppRequire, cppSame } from "./cpp-tools.js";
import { cppMd5 } from "./cpp-native.js";
import { mavenHash } from "./maven.js";
import type { CppExtensionsConfig } from "./cpp-extensions-contract.js";
export const cppExtensionsSdkRoots = [
  "/usr/include",
  "/usr/lib/llvm22/lib/clang/22/include",
];
export async function cppExtensionsSdkBytes(config: CppExtensionsConfig) {
  const observed = [];
  for (const pin of config.sdk) {
    const entry = path.join("/", pin.path),
      resolved = path.join("/", pin.resolved);
    cppRequire(
      (await realpath(entry)) === resolved &&
        (await realpath(resolved)) === resolved,
      "Pinned SDK physical alias differs",
    );
    const stat = await lstat(resolved);
    cppRequire(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.size === pin.bytes &&
        stat.size <= 128 * 1024 * 1024,
      "Pinned SDK file size/type differs",
    );
    const bytes = await readFile(resolved);
    cppRequire(
      bytes.length === pin.bytes && mavenHash(bytes) === pin.sha256,
      "Pinned SDK physical bytes differ",
    );
    observed.push({
      path: pin.path,
      resolved: pin.resolved,
      bytes: bytes.length,
      sha256: mavenHash(bytes),
      md5: cppMd5(bytes),
    });
  }
  const inventory: string[] = [];
  let entries = 0;
  for (const root of cppExtensionsSdkRoots) {
    cppRequire(
      (await realpath(root)) === root,
      "Selected SDK root alias differs",
    );
    const walk = async (directory: string, depth: number) => {
      cppRequire(depth <= 32, "SDK depth bound");
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        cppRequire(++entries <= 20000, "SDK entry bound");
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file, depth + 1);
        else {
          cppRequire(
            entry.isFile() || entry.isSymbolicLink(),
            "SDK entry type differs",
          );
          inventory.push(file.slice(1));
        }
      }
    };
    await walk(root, 0);
  }
  cppRequire(
    cppSame(
      inventory,
      config.sdk
        .filter((p) =>
          cppExtensionsSdkRoots.some((r) => ("/" + p.path).startsWith(r + "/")),
        )
        .map((p) => p.path),
    ),
    "Complete selected SDK header tree differs",
  );
  return {
    observed,
    sha256: mavenHash(
      JSON.stringify(
        observed.map((pin) => ({
          path: pin.path,
          resolved: pin.resolved,
          bytes: pin.bytes,
          sha256: pin.sha256,
        })),
      ),
    ),
  };
}
/** Decode bounded Make dependency records as data; never execute their spelling. */
export function cppExtensionsDependencies(raw: string) {
  cppRequire(
    raw.length > 0 && raw.length <= 1024 * 1024 && !/[\r`$;|<>]/.test(raw),
    "Unsupported native dependency record",
  );
  const lines = raw
    .replace(/\\\n[ \t]*/g, " ")
    .trimEnd()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  cppRequire(
    lines.length > 0 &&
      lines.every(
        (l) => !/[\\]/.test(l) && l.indexOf(":") === l.lastIndexOf(":"),
      ),
    "Malformed native dependency continuation",
  );
  const primary = lines[0]!,
    colon = primary.indexOf(":");
  cppRequire(colon > 0, "Native dependency target missing");
  const output = primary.slice(0, colon).trim(),
    files = primary
      .slice(colon + 1)
      .trim()
      .split(/[ \t]+/);
  cppRequire(
    files.length > 0 &&
      files.length <= 8192 &&
      files.every((f) => f && !/["'&*?[\]{}()]/.test(f)),
    "Native dependency paths differ",
  );
  const phony = lines.slice(1).map((l) => {
    cppRequire(
      l.endsWith(":") && !/[ \t]/.test(l),
      "Native dependency phony target differs",
    );
    return l.slice(0, -1);
  });
  if (phony.length)
    cppRequire(
      JSON.stringify(phony) === JSON.stringify(files),
      "Native linker phony denominator differs",
    );
  // The linker may visit an archive repeatedly while resolving symbol groups.
  // Preserve that multiplicity; compiler dependency files normally have no phony rules.
  return { output, files, phony };
}
