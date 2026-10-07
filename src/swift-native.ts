import path from "node:path";
import { z } from "zod";
import type { SwiftToolsConfig } from "./swift-tools.js";
export const swiftRequire = (value: unknown, message: string): void => {
  if (!value) throw Error(message);
};
export const swiftSame = (a: string[], b: string[]) =>
  new Set(a).size === a.length &&
  new Set(b).size === b.length &&
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const names = z.array(z.string().min(1).max(8192)).max(2048);
const empty = z.array(z.never()).length(0);
const product = z.strictObject({
  name: z.string(),
  targets: names,
  type: z.union([
    z.strictObject({ library: z.tuple([z.literal("automatic")]) }),
    z.strictObject({ executable: z.null() }),
  ]),
});
const dependency = z.union([
  z.strictObject({ byName: z.tuple([z.string(), z.null()]) }),
  z.strictObject({ target: z.tuple([z.string(), z.null()]) }),
]);
const manifestSchema = z.strictObject({
  cLanguageStandard: z.null(),
  cxxLanguageStandard: z.null(),
  dependencies: empty,
  name: z.string(),
  packageKind: z.strictObject({ root: z.tuple([z.string()]) }),
  pkgConfig: z.null(),
  platforms: empty,
  products: z
    .array(product.extend({ settings: empty }))
    .min(1)
    .max(32),
  providers: z.null(),
  swiftLanguageVersions: z.null(),
  traits: empty,
  targets: z
    .array(
      z.strictObject({
        dependencies: z.array(dependency).max(32),
        exclude: empty,
        name: z.string(),
        packageAccess: z.literal(true),
        resources: empty,
        settings: empty,
        type: z.enum(["regular", "executable", "test"]),
        path: z.string().optional(),
        sources: names.optional(),
      }),
    )
    .min(1)
    .max(64),
  toolsVersion: z.strictObject({ _version: z.literal("6.2.0") }),
});
const describeSchema = z.strictObject({
  dependencies: empty,
  manifest_display_name: z.string(),
  name: z.string(),
  path: z.string(),
  platforms: empty,
  products: z.array(product).min(1).max(32),
  tools_version: z.literal("6.2"),
  targets: z
    .array(
      z.strictObject({
        c99name: z.string(),
        module_type: z.literal("SwiftTarget"),
        name: z.string(),
        path: z.string(),
        sources: names,
        target_dependencies: names.optional(),
        product_memberships: names.optional(),
        type: z.enum(["library", "executable", "test"]),
      }),
    )
    .min(1)
    .max(64),
});
/** Inspect native SwiftPM data only after operator-authorized execution. */
export function swiftNativeScope(
  config: SwiftToolsConfig,
  workspace: string,
  manifestText: string,
  describeText: string,
) {
  const manifest = manifestSchema.parse(JSON.parse(manifestText)),
    describe = describeSchema.parse(JSON.parse(describeText));
  swiftRequire(
    manifest.name === config.packageName &&
      describe.name === config.packageName &&
      describe.manifest_display_name === config.packageName &&
      describe.path === workspace &&
      manifest.packageKind.root[0] === workspace,
    "Swift native package identity differs",
  );
  for (const products of [manifest.products, describe.products]) {
    swiftRequire(
      swiftSame(
        products.map((p) => p.name),
        config.products.map((p) => p.name),
      ),
      "Swift native product scope differs",
    );
    for (const p of products) {
      const declared = config.products.find((d) => d.name === p.name)!;
      swiftRequire(
        swiftSame(p.targets, declared.targets) &&
          Object.hasOwn(p.type, declared.type),
        "Swift native product targets differ",
      );
    }
  }
  for (const targets of [manifest.targets, describe.targets])
    swiftRequire(
      swiftSame(
        targets.map((t) => t.name),
        config.targets.map((t) => t.name),
      ),
      "Swift native target scope differs",
    );
  for (const declared of config.targets) {
    const m = manifest.targets.find((t) => t.name === declared.name)!,
      d = describe.targets.find((t) => t.name === declared.name)!;
    swiftRequire(
      m.type === declared.type &&
        d.type === (declared.type === "regular" ? "library" : declared.type) &&
        d.c99name === declared.name &&
        d.path === declared.path &&
        (m.path === undefined || m.path === declared.path),
      "Swift native target identity differs",
    );
    swiftRequire(
      swiftSame(
        d.sources.map((f) => path.posix.join(d.path, f)),
        declared.sources,
      ) &&
        (m.sources === undefined ||
          swiftSame(
            m.sources.map((f) => path.posix.join(d.path, f)),
            declared.sources,
          )),
      "Swift native source scope differs",
    );
    swiftRequire(
      swiftSame(d.target_dependencies ?? [], declared.dependencies) &&
        swiftSame(
          m.dependencies.map((dependency) =>
            "byName" in dependency
              ? dependency.byName[0]
              : dependency.target[0],
          ),
          declared.dependencies,
        ),
      "Swift native dependency scope differs",
    );
    swiftRequire(
      swiftSame(
        d.product_memberships ?? [],
        config.products
          .filter((p) => p.targets.includes(d.name))
          .map((p) => p.name),
      ),
      "Swift native product memberships differ",
    );
  }
  return describe;
}
/** Decode logged compiler arguments; never evaluate a shell string. */
export function swiftWords(text: string) {
  const words: string[] = [];
  let current = "",
    quote = "",
    started = false;
  swiftRequire(
    text.length <= 65536 && !/[\n\r\0]/.test(text),
    "Swift compiler command bound",
  );
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\" && quote !== "'") {
      swiftRequire(i + 1 < text.length, "Swift compiler escape");
      current += text[++i]!;
      started = true;
    } else if (quote) {
      if (c === quote) quote = "";
      else current += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else {
      current += c;
      started = true;
    }
  }
  swiftRequire(!quote, "Swift compiler quote");
  if (started) words.push(current);
  swiftRequire(words.length <= 4096, "Swift compiler argument bound");
  return words;
}
export function swiftCompiled(
  config: SwiftToolsConfig,
  workspace: string,
  frontend: string,
  output: string,
) {
  const compiled: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith(frontend + " ")) continue;
    const args = swiftWords(line);
    if (args[1] !== "-frontend" || !args.includes("-c")) continue;
    const moduleAt = args.indexOf("-module-name"),
      targetAt = args.indexOf("-target");
    swiftRequire(
      moduleAt > 0 && targetAt > 0 && args[targetAt + 1] === config.platform,
      "Swift compiler module/platform differs",
    );
    const target = config.targets.find((t) => t.name === args[moduleAt + 1]);
    if (!target) continue; // SwiftPM's generated discovery and runner modules are separately owned.
    for (let i = 1; i < args.length; i++)
      if (args[i] === "-primary-file") {
        const file = args[++i]!;
        const relative = path
          .relative(workspace, file)
          .split(path.sep)
          .join("/");
        swiftRequire(
          file === path.join(workspace, relative) &&
            target.sources.includes(relative),
          "Swift compiler source escapes declared target",
        );
        compiled.push(relative);
      }
  }
  swiftRequire(
    swiftSame(
      compiled,
      config.targets.flatMap((t) => t.sources),
    ),
    "Swift native compiler participation differs",
  );
  return compiled;
}
export const swiftLintOptions = (config: SwiftToolsConfig) =>
  "only_rules:\n" +
  config.rules.map((r) => "  - " + r + "\n").join("") +
  "force_try:\n  severity: error\nforce_unwrapping:\n  severity: error\n";
export const swiftCommon = (workspace: string, temporary: string) => [
  "--package-path",
  workspace,
  "--cache-path",
  path.join(temporary, "cache"),
  "--config-path",
  path.join(temporary, "config"),
  "--security-path",
  path.join(temporary, "security"),
  "--scratch-path",
  path.join(temporary, "scratch"),
  "--disable-dependency-cache",
  "--manifest-cache",
  "none",
  "--disable-prefetching",
  "--disable-automatic-resolution",
  "--disable-netrc",
  "--disable-keychain",
  "--disable-experimental-prebuilts",
];

export const swiftAstArgs = (
  config: SwiftToolsConfig,
  workspace: string,
  temporary: string,
  target: SwiftToolsConfig["targets"][number],
  file: string,
  frontend: string,
) => [
  "-frontend",
  "-typecheck",
  "-dump-ast",
  "-enable-testing",
  ...(config.tests.framework === "swift-testing"
    ? [
        "-in-process-plugin-server-path",
        path.resolve(
          path.dirname(frontend),
          "../lib/swift/host/libSwiftInProcPluginServer.so",
        ),
        "-plugin-path",
        path.resolve(path.dirname(frontend), "../lib/swift/host/plugins"),
        "-plugin-path",
        "/usr/local/lib/swift/host/plugins",
      ]
    : []),
  "-module-name",
  target.name,
  "-I",
  path.join(temporary, "scratch", config.platform, "debug", "Modules"),
  "-primary-file",
  path.join(workspace, file),
  ...target.sources
    .filter((f) => f !== file)
    .map((f) => path.join(workspace, f)),
];
