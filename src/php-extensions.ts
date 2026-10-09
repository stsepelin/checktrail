import path from "node:path";
import { createHash } from "node:crypto";
import { open, lstat, readdir } from "node:fs/promises";
import { z } from "zod";
import { readProjectFile, withinRoot } from "./inventory.js";
import {
  phpExtensionRuntime,
  phpExtensionToolPins,
} from "./php-extension-pins.js";
import { phpExtensionRunner } from "./php-extension-runner.js";
import type { Check, Inventory, Project } from "./types.js";
const relative = z
  .string()
  .min(1)
  .max(512)
  .regex(
    /^(?![A-Za-z]:)(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\/$)[^\\\0\r\n]+$/,
  );
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const name = z
  .string()
  .regex(/^[A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*$/)
  .max(256);
const attribute = z
  .string()
  .regex(/^[A-Za-z_]\w*$/)
  .max(256);
function validTypedValue(value: unknown, depth = 0): boolean {
  if (
    depth > 16 ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !("type" in value) ||
    !("value" in value)
  )
    return false;
  const type = value.type,
    data = value.value;
  if (type === "null") return data === null;
  if (type === "string") return typeof data === "string";
  if (type === "bool") return typeof data === "boolean";
  if (type === "int")
    return typeof data === "number" && Number.isSafeInteger(data);
  if (type === "float")
    return typeof data === "number" && Number.isFinite(data);
  if (type !== "array" || !Array.isArray(data) || data.length > 1024)
    return false;
  const keys = new Set<string>();
  return data.every((entry: unknown) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      Object.keys(entry).length !== 2 ||
      !("key" in entry) ||
      !("value" in entry) ||
      !validTypedValue(entry.key, depth + 1) ||
      !validTypedValue(entry.value, depth + 1)
    )
      return false;
    const key = entry.key as { type: string; value: unknown };
    if (key.type !== "int" && key.type !== "string") return false;
    const encoded = JSON.stringify(key);
    if (keys.has(encoded)) return false;
    keys.add(encoded);
    return true;
  });
}
export const phpTypedValueSchema = z
  .strictObject({
    type: z.enum(["null", "string", "int", "float", "bool", "array"]),
    value: z.json(),
  })
  .superRefine((value, context) => {
    if (!validTypedValue(value))
      context.addIssue({
        code: "custom",
        message:
          "PHP typed data must retain exact scalar types and ordered unique array keys.",
      });
  });
export const phpModelDefaultsSchema = z.strictObject({
  table: z.string(),
  connection: z.string().nullable(),
  keyName: z.string(),
  keyType: z.string(),
  incrementing: z.boolean(),
  timestamps: z.boolean(),
  perPage: z.number().int().min(1).max(1000000),
  eagerLoads: z.array(z.string()).max(1024),
  eagerCounts: z.array(z.string()).max(1024),
  casts: z.record(z.string(), z.string()),
  attributes: z.record(z.string(), phpTypedValueSchema),
  appends: z.array(z.string()).max(1024),
  fillable: z.array(z.string()).max(1024),
  guarded: z.array(z.string()).max(1024),
});
export const phpExtensionsConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  nativeExtensions: z.array(z.string().min(1).max(128)).min(1).max(128),
  classes: z
    .array(
      z.strictObject({
        class: name,
        path: relative,
        sha256: hash,
        generated: z.boolean(),
      }),
    )
    .min(2)
    .max(32),
  models: z
    .array(
      z.strictObject({
        class: name,
        expectedClass: name,
        defaults: phpModelDefaultsSchema,
        probes: z
          .array(
            z.strictObject({
              attribute,
              attributes: z.record(attribute, z.json()),
              expected: phpTypedValueSchema,
            }),
          )
          .min(1)
          .max(32),
      }),
    )
    .min(1)
    .max(16),
});
export const phpExtensionFileSchema = z.strictObject({
  path: relative,
  bytes: z
    .number()
    .int()
    .min(0)
    .max(8 * 1048576),
  sha256: hash,
});
export const phpExtensionManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sourceFingerprint: hash,
  config: phpExtensionsConfigSchema,
  bindings: z.array(phpExtensionFileSchema).min(1).max(256),
  toolPins: z
    .array(
      z.strictObject({
        package: z.string(),
        version: z.string(),
        path: relative,
        bytes: z
          .number()
          .int()
          .positive()
          .max(64 * 1048576),
        sha256: hash,
      }),
    )
    .min(1)
    .max(32),
});
export const phpExtensionsFlags = [
  "-d",
  "opcache.enable_cli=0",
  "-d",
  "opcache.preload=",
  "-d",
  "auto_prepend_file=",
  "-d",
  "auto_append_file=",
  "-d",
  "enable_dl=0",
  "-r",
] as const;
export function validatePhpProbeData(value: unknown): void {
  let remaining = 4096;
  const walk = (value: unknown, depth = 0): void => {
    if (depth > 16 || --remaining < 0)
      throw Error("PHP probe data exceeds its shape bound");
    if (
      typeof value === "number" &&
      (!Number.isFinite(value) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value)))
    )
      throw Error(
        "PHP probe number is not finite or exceeds the exact integer bound",
      );
    if (value !== null && typeof value === "object")
      for (const child of Object.values(value)) walk(child, depth + 1);
  };
  walk(value);
  if (Buffer.byteLength(JSON.stringify(value)) > 32768)
    throw Error("PHP probe data exceeds 32 KiB");
}
export async function phpExtensionsCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const check: Check = {
    id: "php.extensions",
    adapter: project.adapter,
    project: project.path,
    scope: [],
    kind: "analysis",
    parser: "php-extension-json",
    commands: [],
    reason:
      "Verify the declared native PHP extension closure and initialized model/proxy reflection, defaults and accessor witnesses.",
  };
  if (!project.files.includes("checktrail.php.json")) {
    check.unavailableReason =
      "PHP extension evidence requires checktrail.php.json.";
    return check;
  }
  const config = phpExtensionsConfigSchema.parse(
    JSON.parse(
      await readProjectFile(
        source.root,
        path.posix.join(project.path, "checktrail.php.json"),
      ),
    ),
  );
  validatePhpProbeData(config);
  try {
    if (
      JSON.stringify(config.nativeExtensions) !==
      JSON.stringify(phpExtensionRuntime.extensions.map((e) => e.name))
    )
      throw Error(
        "Declare the complete selected native PHP extension list in canonical order",
      );
    if (
      new Set(config.classes.map((c) => c.class.toLowerCase())).size !==
        config.classes.length ||
      new Set(config.classes.map((c) => c.path)).size !==
        config.classes.length ||
      !config.classes.some((c) => c.generated)
    )
      throw Error(
        "Unique declared classes/files and a generated proxy are required",
      );
    const classes = new Set(config.classes.map((c) => c.class));
    if (
      new Set(config.models.map((m) => m.class)).size !==
        config.models.length ||
      config.models.some(
        (m) =>
          !classes.has(m.class) ||
          !classes.has(m.expectedClass) ||
          new Set(m.probes.map((p) => JSON.stringify(p))).size !==
            m.probes.length,
      )
    )
      throw Error(
        "Model/proxy selectors and accessor probes must be declared and unique",
      );
    if (!project.files.includes("bootstrap/app.php"))
      throw Error("An inventoried Laravel bootstrap is required");
    const files = new Set([
      "checktrail.php.json",
      ...project.files.filter(
        (f) =>
          f.endsWith(".php") ||
          f.endsWith(".neon") ||
          f === "composer.json" ||
          f === "composer.lock",
      ),
      ...config.classes.map((c) => c.path),
      "vendor/autoload.php",
      "vendor/composer/installed.json",
      "vendor/composer/ClassLoader.php",
    ]);
    const composer = await withinRoot(
      source.root,
      path.posix.join(project.path, "vendor/composer"),
    );
    for (const file of (await readdir(composer)).sort())
      if (/^autoload_[A-Za-z_]+\.php$/.test(file))
        files.add("vendor/composer/" + file);
    if (files.size > 256) throw Error("PHP input collection exceeds its bound");
    let total = 0;
    const bindings = [];
    for (const file of [...files].sort()) {
      const lexical = path.resolve(source.root, project.path, file),
        full = await withinRoot(
          source.root,
          path.posix.join(project.path, file),
        );
      if ((await lstat(lexical)).isSymbolicLink())
        throw Error("PHP binding is a link");
      const stream = await open(full, "r");
      try {
        const stat = await stream.stat();
        if (
          !stat.isFile() ||
          stat.size > 8 * 1048576 ||
          stat.size > 64 * 1048576 - total
        )
          throw Error("PHP input exceeds its byte bound");
        const bytes = Buffer.alloc(stat.size + 1);
        let count = 0;
        while (count < bytes.length) {
          const next = await stream.read(
            bytes,
            count,
            bytes.length - count,
            null,
          );
          if (!next.bytesRead) break;
          count += next.bytesRead;
        }
        if (count !== stat.size)
          throw Error("PHP input changed during planning");
        total += count;
        bindings.push({
          path: file,
          bytes: count,
          sha256: createHash("sha256")
            .update(bytes.subarray(0, count))
            .digest("hex"),
        });
      } finally {
        await stream.close();
      }
    }
    for (const entry of config.classes)
      if (
        !entry.path.endsWith(".php") ||
        bindings.find((b) => b.path === entry.path)?.sha256 !== entry.sha256
      )
        throw Error("Declared model/proxy source bytes changed");
    const manifest = phpExtensionManifestSchema.parse({
      schemaVersion: 1,
      sourceFingerprint: source.fingerprint,
      config,
      bindings,
      toolPins: phpExtensionToolPins,
    });
    const encoded = JSON.stringify(manifest);
    if (Buffer.byteLength(encoded) > 128 * 1024)
      throw Error("PHP extension manifest exceeds 128 KiB");
    check.scope = config.classes.map((c) => c.path);
    check.commands = [
      {
        executable: "php",
        args: [...phpExtensionsFlags, phpExtensionRunner, "--", encoded],
        cwd: project.path,
        temporaryDirectory: true,
        env: { APP_ENV: "testing", APP_DEBUG: "false" },
      },
    ];
  } catch (error) {
    check.unavailableReason =
      error instanceof Error
        ? error.message
        : "PHP extension inputs are unavailable";
  }
  return check;
}
