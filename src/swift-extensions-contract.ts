import path from "node:path";
import { z } from "zod";
import { externalPathSchema, externalDigestSchema } from "./external-schema.js";
import { swiftRequire, swiftSame } from "./swift-native.js";
const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const identity = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const packagePath = z.union([z.literal("."), externalPathSchema]);
const product = z.strictObject({
  name,
  type: z.enum(["library", "executable"]),
  targets: z.array(name).min(1).max(32),
  implicit: z.boolean(),
});
const dependency = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("target"), name }),
  z.strictObject({ kind: z.literal("product"), name, package: identity }),
]);
const target = z.strictObject({
  name,
  type: z.enum(["regular", "executable", "test", "plugin"]),
  path: externalPathSchema,
  sources: z.array(externalPathSchema).min(1).max(256),
  dependencies: z.array(dependency).max(32),
  plugins: z.array(name).max(8),
});
export const swiftExtensionsSdkPinSchema = z.strictObject({
  root: z.enum(["swift", "include", "clang"]),
  path: externalPathSchema,
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(128 * 1024 * 1024),
  sha256: externalDigestSchema,
});
export const swiftExtensionsConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("declared-local-packages-build-tool-generated-sdk-v1"),
  swiftVersion: z.literal("6.2.3"),
  toolsVersion: z.literal("6.2.0"),
  platform: z.literal("aarch64-unknown-linux-gnu"),
  packages: z
    .array(
      z.strictObject({
        path: packagePath,
        identity,
        name,
        dependencies: z
          .array(z.strictObject({ identity, path: externalPathSchema }))
          .max(8),
        products: z.array(product).min(1).max(32),
        targets: z.array(target).min(1).max(64),
      }),
    )
    .min(1)
    .max(8),
  generated: z
    .array(
      z.strictObject({
        package: identity,
        target: name,
        plugin: name,
        generator: name,
        file: externalPathSchema,
      }),
    )
    .min(1)
    .max(32),
  tests: z.strictObject({
    xctest: z.array(externalPathSchema).min(1).max(128),
    testing: z.array(externalPathSchema).min(1).max(128),
    support: z.array(externalPathSchema).max(128),
  }),
  swiftlintVersion: z.literal("0.65.1"),
  rules: z
    .array(z.enum(["force_try", "force_unwrapping"]))
    .min(1)
    .max(2),
  sdk: z.array(swiftExtensionsSdkPinSchema).min(1).max(4096),
});
export type SwiftExtensionsConfig = z.infer<typeof swiftExtensionsConfigSchema>;
export const swiftExtensionsInvocationSchema = z.strictObject({
  configSha256: externalDigestSchema,
  inputs: z
    .array(
      z.strictObject({
        path: externalPathSchema,
        sha256: externalDigestSchema,
      }),
    )
    .min(1)
    .max(4096),
});
const unique = (values: string[], label: string) =>
  swiftRequire(
    new Set(values).size === values.length,
    label + " must be unique",
  );
/** Data-only validation: never evaluate Package.swift or execute a plugin. */
export function swiftExtensionsScope(
  config: SwiftExtensionsConfig,
  files: string[],
) {
  unique(
    config.packages.map((p) => p.path),
    "Swift package paths",
  );
  unique(
    config.packages.map((p) => p.identity),
    "Swift package identities",
  );
  unique(
    config.packages.map((p) => p.name),
    "Swift package names",
  );
  unique(config.rules, "Swift lint rules");
  swiftRequire(
    config.packages[0]!.path === "." &&
      config.packages[0]!.identity === "project" &&
      config.packages.slice(1).every((p) => p.path !== "."),
    "Swift root package must be first",
  );
  const packages = new Map(config.packages.map((p) => [p.identity, p]));
  const manifests = config.packages.map((p) =>
    path.posix.join(p.path, "Package.swift"),
  );
  swiftRequire(
    swiftSame(
      manifests,
      files.filter((f) => path.posix.basename(f) === "Package.swift"),
    ),
    "Declare every Swift manifest exactly once",
  );
  const sources: string[] = [],
    tests: string[] = [],
    targetNames: string[] = [];
  const graph = new Map<string, string[]>();
  for (const p of config.packages) {
    const targets = new Map(p.targets.map((t) => [t.name, t]));
    unique(
      p.targets.map((t) => t.name),
      "Swift package target names",
    );
    unique(
      p.products.map((v) => v.name),
      "Swift package product names",
    );
    unique(
      p.dependencies.map((v) => v.identity),
      "Swift local package dependencies",
    );
    graph.set(
      p.identity,
      p.dependencies.map((d) => d.identity),
    );
    for (const d of p.dependencies) {
      const resolved = packages.get(d.identity);
      swiftRequire(
        resolved &&
          resolved !== p &&
          path.posix.join(p.path, d.path) === resolved.path,
        "Swift local dependency must resolve to a declared in-root package",
      );
    }
    for (const t of p.targets) {
      targetNames.push(t.name);
      unique(t.sources, "Swift target sources");
      unique(t.plugins, "Swift plugin usages");
      unique(
        t.dependencies.map((d) => JSON.stringify(d)),
        "Swift target dependencies",
      );
      swiftRequire(
        t.sources.every(
          (f) => f.startsWith(t.path + "/") && f.endsWith(".swift"),
        ),
        "Swift source must belong to its target",
      );
      const owned = t.sources.map((f) => path.posix.join(p.path, f));
      swiftRequire(
        owned.every((f) =>
          config.packages.every(
            (other) =>
              other === p ||
              other.path === "." ||
              !f.startsWith(other.path + "/"),
          ),
        ),
        "Swift source crosses a local package boundary",
      );
      sources.push(...owned);
      if (t.type === "test") tests.push(...owned);
      for (const d of t.dependencies) {
        if (d.kind === "target")
          swiftRequire(
            d.name !== t.name && targets.has(d.name),
            "Swift target dependency is missing or recursive",
          );
        else {
          const other = packages.get(d.package),
            selected = other?.products.find((v) => v.name === d.name);
          swiftRequire(
            p.dependencies.some((v) => v.identity === d.package) &&
              selected &&
              !selected.implicit,
            "Swift product dependency must belong to a declared local package",
          );
        }
      }
      swiftRequire(
        t.plugins.every((n) => targets.get(n)?.type === "plugin"),
        "Swift plugin usage must name a declared build-tool target",
      );
      if (t.type === "plugin")
        swiftRequire(
          t.plugins.length === 0 &&
            t.dependencies.length > 0 &&
            t.dependencies.every(
              (d) =>
                d.kind === "target" &&
                targets.get(d.name)?.type === "executable",
            ),
          "Swift selected plugin must use declared executable generators",
        );
    }
    for (const v of p.products) {
      unique(v.targets, "Swift product targets");
      swiftRequire(
        v.targets.every(
          (n) =>
            targets.has(n) &&
            !["test", "plugin"].includes(targets.get(n)!.type),
        ),
        "Swift product target is missing or unsupported",
      );
      swiftRequire(
        v.type !== "executable" ||
          v.targets.every((n) => targets.get(n)?.type === "executable"),
        "Swift executable product must use executable targets",
      );
      swiftRequire(
        !v.implicit ||
          (v.type === "executable" &&
            v.targets.length === 1 &&
            v.targets[0] === v.name),
        "Swift implicit product must be its executable target",
      );
    }
    const active = new Set<string>(),
      done = new Set<string>();
    const visit = (n: string) => {
      swiftRequire(!active.has(n), "Swift target/plugin dependency cycle");
      if (done.has(n)) return;
      active.add(n);
      const t = targets.get(n)!;
      for (const d of t.dependencies) if (d.kind === "target") visit(d.name);
      for (const plugin of t.plugins) visit(plugin);
      active.delete(n);
      done.add(n);
    };
    for (const n of targets.keys()) visit(n);
  }
  unique(targetNames, "Swift selected module names");
  swiftRequire(
    swiftSame(
      sources,
      files.filter(
        (f) =>
          f.endsWith(".swift") && path.posix.basename(f) !== "Package.swift",
      ),
    ),
    "Declare every inventoried Swift source exactly once",
  );
  swiftRequire(
    swiftSame(
      [
        ...config.tests.xctest,
        ...config.tests.testing,
        ...config.tests.support,
      ],
      tests,
    ),
    "Declare the complete XCTest and Swift Testing source cohort",
  );
  unique(
    config.generated.map((g) => JSON.stringify([g.package, g.target, g.file])),
    "Swift generated outputs",
  );
  for (const g of config.generated) {
    const p = packages.get(g.package),
      t = p?.targets.find((v) => v.name === g.target),
      plugin = p?.targets.find((v) => v.name === g.plugin);
    swiftRequire(
      t?.type === "regular" &&
        t.plugins.includes(g.plugin) &&
        plugin?.type === "plugin" &&
        plugin.dependencies.some(
          (d) => d.kind === "target" && d.name === g.generator,
        ) &&
        g.file.endsWith(".swift"),
      "Swift generated output must join its consumer, build-tool plugin and executable generator",
    );
  }
  for (const p of config.packages)
    for (const t of p.targets)
      for (const plugin of t.plugins)
        swiftRequire(
          config.generated.some(
            (g) =>
              g.package === p.identity &&
              g.target === t.name &&
              g.plugin === plugin,
          ),
          "Swift plugin usage has no declared generated output",
        );
  unique(
    config.sdk.map((s) => s.root + "/" + s.path),
    "Swift SDK pins",
  );
  swiftRequire(
    config.sdk.reduce((n, s) => n + s.bytes, 0) <= 512 * 1024 * 1024,
    "Swift selected SDK byte bound",
  );
  const active = new Set<string>(),
    reached = new Set<string>();
  const visit = (n: string) => {
    swiftRequire(!active.has(n), "Swift local package dependency cycle");
    if (reached.has(n)) return;
    active.add(n);
    for (const d of graph.get(n)!) visit(d);
    active.delete(n);
    reached.add(n);
  };
  visit(config.packages[0]!.identity);
  swiftRequire(
    reached.size === config.packages.length,
    "Swift local package graph has unreachable packages",
  );
  return { packages, manifests, sources, tests };
}
