import { createHash } from "node:crypto";
import { access, lstat, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { externalPathSchema } from "./external-schema.js";
import { withinRoot } from "./inventory.js";
import { jvmWrapperPins, jvmWrapperArchives } from "./jvm-wrapper-pins.js";
import { jvmToolchainPins } from "./jvm-toolchain-pins.js";
const identifier = z
  .string()
  .regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/);
const modulePath = z.union([z.literal("."), externalPathSchema]);
export const jvmExtensionsSchema = z.strictObject({
  profile: z.literal("linux-arm64-wrappers-v1"),
  archive: externalPathSchema,
  generators: z
    .array(
      z.strictObject({
        module: modulePath,
        source: externalPathSchema,
        className: identifier,
        outputs: z
          .array(
            z.strictObject({ file: externalPathSchema, className: identifier }),
          )
          .min(1)
          .max(32),
      }),
    )
    .max(8),
  jpms: z
    .array(
      z.strictObject({
        module: modulePath,
        name: identifier,
        requires: z.array(identifier).max(32),
        exports: z.array(identifier).max(32),
      }),
    )
    .max(64),
});
export type JvmExtensions = z.infer<typeof jvmExtensionsSchema>;
export type JvmKind = "maven" | "gradle";
export const jvmWrapperSourceFiles = (kind: JvmKind): string[] =>
  jvmWrapperPins.filter((pin) => pin.kind === kind).map((pin) => pin.path);
export const jvmGeneratorSourceFiles = (extensions?: JvmExtensions) =>
  new Set(extensions?.generators.map((generator) => generator.source) ?? []);

export function validateJvmExtensionScope(
  extensions: JvmExtensions,
  inputs: string[],
  modules: { path: string; executable: boolean }[],
) {
  const used = new Set<string>();
  for (const generator of extensions.generators) {
    if (
      !modules.some((m) => m.path === generator.module && m.executable) ||
      !inputs.includes(generator.source) ||
      !generator.source.startsWith("generators/") ||
      path.posix.basename(generator.source) !==
        generator.className.split(".").at(-1) + ".java" ||
      used.has(generator.source)
    )
      throw Error(
        "Declare unique inventoried Java generators and executable modules",
      );
    used.add(generator.source);
    for (const output of generator.outputs) {
      const file = path.posix.join(generator.module, output.file);
      if (
        output.file !==
          "src/main/java/" + output.className.replaceAll(".", "/") + ".java" ||
        inputs.includes(file) ||
        used.has(file)
      )
        throw Error(
          "Generated Java outputs must be unique fresh conventional class sources",
        );
      used.add(file);
    }
  }
  const names = new Set<string>(),
    declarations = new Set<string>();
  for (const module of extensions.jpms) {
    if (
      !modules.some((m) => m.path === module.module && m.executable) ||
      !inputs.includes(
        path.posix.join(module.module, "src/main/java/module-info.java"),
      ) ||
      names.has(module.name) ||
      declarations.has(module.module) ||
      new Set(module.requires).size !== module.requires.length ||
      new Set(module.exports).size !== module.exports.length ||
      module.requires.includes("java.base") ||
      module.name === "java.base"
    )
      throw Error("JPMS modules require unique native descriptor contracts");
    names.add(module.name);
    declarations.add(module.module);
  }
  for (const file of inputs.filter(
    (f) => path.posix.basename(f) === "module-info.java",
  ))
    if (
      !extensions.jpms.some(
        (m) =>
          file === path.posix.join(m.module, "src/main/java/module-info.java"),
      )
    )
      throw Error(
        "Declare every selected main JPMS descriptor; test descriptors are unsupported",
      );
}

async function regular(root: string, project: string, file: string) {
  const requested = path.resolve(root, project, file);
  const canonical = await withinRoot(root, path.relative(root, requested));
  const stat = await lstat(requested);
  if (canonical !== requested || !stat.isFile() || stat.isSymbolicLink())
    throw Error(
      "JVM extension artifacts must be contained regular files without links",
    );
  return requested;
}
export async function verifyJvmFile(
  file: string,
  pin: { bytes: number; sha256: string },
) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== pin.bytes)
    throw Error("JVM artifact size or regular-file identity changed");
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== pin.bytes)
      throw Error("Opened JVM artifact identity changed");
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(1048576);
    let bytes = 0;
    while (true) {
      const next = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, pin.bytes - bytes + 1),
        null,
      );
      if (!next.bytesRead) break;
      bytes += next.bytesRead;
      if (bytes > pin.bytes)
        throw Error("JVM artifact exceeds its declared size");
      hash.update(buffer.subarray(0, next.bytesRead));
    }
    if (bytes !== pin.bytes || hash.digest("hex") !== pin.sha256)
      throw Error("JVM artifact checksum changed");
  } finally {
    await handle.close();
  }
}
export async function verifyJvmWrapper(
  root: string,
  project: string,
  kind: JvmKind,
  extensions: JvmExtensions,
) {
  for (const pin of jvmWrapperPins.filter((pin) => pin.kind === kind))
    await verifyJvmFile(await regular(root, project, pin.path), pin);
  const archive = await regular(root, project, extensions.archive);
  await verifyJvmFile(archive, jvmWrapperArchives[kind]);
  return archive;
}
export async function verifyJvmToolchain() {
  if (process.platform !== "linux" || process.arch !== "arm64")
    throw Error("The selected JVM extension toolchain requires Linux ARM64");
  const resolved = new Map<string, string>();
  for (const name of ["java", "javac", "jar"]) {
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!path.isAbsolute(directory)) continue;
      const candidate = path.join(directory, name);
      try {
        await access(candidate, constants.X_OK);
        resolved.set(name, await realpath(candidate));
        break;
      } catch {
        /* An absent PATH entry cannot resolve this selected executable. */
      }
    }
  }
  const java = resolved.get("java");
  if (!java) throw Error("The selected Java launcher is absent");
  const prefix = path.dirname(path.dirname(java));
  for (const pin of jvmToolchainPins) {
    if (
      pin.path.startsWith("bin/") &&
      resolved.get(path.basename(pin.path)) !== path.join(prefix, pin.path)
    )
      throw Error(
        "JVM executable resolutions do not share the selected toolchain",
      );
    await verifyJvmFile(path.join(prefix, pin.path), pin);
  }
  return prefix;
}
