import path from "node:path";
import { z } from "zod";
import type { SwiftExtensionsConfig } from "./swift-extensions-contract.js";
import { swiftRequire, swiftSame } from "./swift-native.js";
const text = z.string().min(1).max(8192),
  names = z.array(text).max(256),
  empty = z.array(z.never()).length(0);
const product = z.strictObject({
  name: text,
  targets: names,
  type: z.union([
    z.strictObject({ library: z.tuple([z.literal("automatic")]) }),
    z.strictObject({ executable: z.null() }),
  ]),
});
const dependency = z.union([
  z.strictObject({ byName: z.tuple([text, z.null()]) }),
  z.strictObject({ target: z.tuple([text, z.null()]) }),
  z.strictObject({ product: z.tuple([text, text, z.null(), z.null()]) }),
]);
const manifestSchema = z.strictObject({
  cLanguageStandard: z.null(),
  cxxLanguageStandard: z.null(),
  dependencies: z
    .array(
      z.strictObject({
        fileSystem: z.tuple([
          z.strictObject({
            identity: text,
            path: text,
            productFilter: z.null(),
            traits: z.tuple([z.strictObject({ name: z.literal("default") })]),
          }),
        ]),
      }),
    )
    .max(8),
  name: text,
  packageKind: z.strictObject({ root: z.tuple([text]) }),
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
        name: text,
        packageAccess: z.literal(true),
        resources: empty,
        settings: empty,
        type: z.enum(["regular", "executable", "test", "plugin"]),
        path: text.optional(),
        sources: names.optional(),
        pluginUsages: z
          .array(z.strictObject({ plugin: z.tuple([text, z.null()]) }))
          .max(8)
          .optional(),
        pluginCapability: z.strictObject({ buildTool: z.null() }).optional(),
      }),
    )
    .min(1)
    .max(64),
  toolsVersion: z.strictObject({ _version: z.literal("6.2.0") }),
});
const describeSchema = z.strictObject({
  dependencies: z
    .array(
      z.strictObject({
        identity: text,
        path: text,
        type: z.literal("fileSystem"),
      }),
    )
    .max(8),
  manifest_display_name: text,
  name: text,
  path: text,
  platforms: empty,
  products: z.array(product).min(1).max(32),
  tools_version: z.literal("6.2"),
  targets: z
    .array(
      z.strictObject({
        c99name: text,
        module_type: z.enum(["SwiftTarget", "PluginTarget"]),
        name: text,
        path: text,
        sources: names,
        target_dependencies: names.optional(),
        product_dependencies: names.optional(),
        product_memberships: names.optional(),
        type: z.enum(["library", "executable", "test", "plugin"]),
        plugin_capability: z
          .strictObject({ type: z.literal("buildTool") })
          .optional(),
      }),
    )
    .min(1)
    .max(64),
});
const sorted = (values: unknown[]) =>
  values.map((v) => JSON.stringify(v)).sort();
const sameDependencies = (a: unknown[], b: unknown[]) =>
  swiftSame(sorted(a), sorted(b));
/** Reconcile native evaluated declarations, source discovery and transitive membership. */
export function swiftExtensionsNativeGraph(
  config: SwiftExtensionsConfig,
  workspace: string,
  records: { identity: string; manifest: string; describe: string }[],
) {
  swiftRequire(
    swiftSame(
      records.map((r) => r.identity),
      config.packages.map((p) => p.identity),
    ),
    "Swift native package cohort differs",
  );
  for (const p of config.packages) {
    const record = records.find((r) => r.identity === p.identity)!,
      manifest = manifestSchema.parse(JSON.parse(record.manifest)),
      describe = describeSchema.parse(JSON.parse(record.describe));
    const directory = path.join(workspace, p.path);
    swiftRequire(
      manifest.name === p.name &&
        describe.name === p.name &&
        describe.manifest_display_name === p.name &&
        describe.path === directory &&
        manifest.packageKind.root[0] === directory,
      "Swift evaluated package identity differs",
    );
    const expectedDependencies = p.dependencies.map((d) =>
      JSON.stringify([d.identity, path.join(directory, d.path)]),
    );
    swiftRequire(
      swiftSame(
        manifest.dependencies.map((d) =>
          JSON.stringify([d.fileSystem[0].identity, d.fileSystem[0].path]),
        ),
        expectedDependencies,
      ) &&
        swiftSame(
          describe.dependencies.map((d) =>
            JSON.stringify([d.identity, d.path]),
          ),
          expectedDependencies,
        ),
      "Swift evaluated local package dependency differs",
    );
    for (const [products, expected] of [
      [manifest.products, p.products.filter((v) => !v.implicit)],
      [describe.products, p.products],
    ] as const) {
      swiftRequire(
        swiftSame(
          products.map((v) => v.name),
          expected.map((v) => v.name),
        ),
        "Swift declared or implicit product cohort differs",
      );
      for (const product of products) {
        const declared = expected.find((v) => v.name === product.name)!;
        swiftRequire(
          swiftSame(product.targets, declared.targets) &&
            Object.hasOwn(product.type, declared.type),
          "Swift native product target/type differs",
        );
      }
    }
    const targets = new Map(p.targets.map((t) => [t.name, t]));
    for (const names of [
      manifest.targets.map((t) => t.name),
      describe.targets.map((t) => t.name),
    ])
      swiftRequire(
        swiftSame(names, [...targets.keys()]),
        "Swift native target cohort differs",
      );
    const closure = (name: string): Set<string> => {
      const reached = new Set<string>();
      const visit = (n: string) => {
        if (reached.has(n)) return;
        reached.add(n);
        const t = targets.get(n)!;
        for (const d of t.dependencies) if (d.kind === "target") visit(d.name);
        for (const plugin of t.plugins) visit(plugin);
      };
      visit(name);
      return reached;
    };
    for (const t of p.targets) {
      const m = manifest.targets.find((v) => v.name === t.name)!,
        d = describe.targets.find((v) => v.name === t.name)!;
      swiftRequire(
        m.type === t.type &&
          d.type === (t.type === "regular" ? "library" : t.type) &&
          d.c99name === t.name &&
          d.module_type ===
            (t.type === "plugin" ? "PluginTarget" : "SwiftTarget") &&
          d.path === t.path &&
          (m.path === undefined || m.path === t.path),
        "Swift native target identity/path differs",
      );
      swiftRequire(
        swiftSame(
          d.sources.map((f) => path.posix.join(d.path, f)),
          t.sources,
        ) &&
          (m.sources === undefined ||
            swiftSame(
              m.sources.map((f) => path.posix.join(d.path, f)),
              t.sources,
            )),
        "Swift native target source cohort differs",
      );
      const observed = m.dependencies.map((v) =>
        "product" in v
          ? { kind: "product", name: v.product[0], package: v.product[1] }
          : { kind: "target", name: "target" in v ? v.target[0] : v.byName[0] },
      );
      swiftRequire(
        sameDependencies(observed, t.dependencies) &&
          swiftSame(
            (m.pluginUsages ?? []).map((v) => v.plugin[0]),
            t.plugins,
          ),
        "Swift evaluated target dependency/plugin differs",
      );
      swiftRequire(
        swiftSame(d.target_dependencies ?? [], [
          ...t.dependencies
            .filter((v) => v.kind === "target")
            .map((v) => v.name),
          ...t.plugins,
        ]) &&
          swiftSame(
            d.product_dependencies ?? [],
            t.dependencies
              .filter((v) => v.kind === "product")
              .map((v) => v.name),
          ),
        "Swift described target dependency/plugin differs",
      );
      swiftRequire(
        (t.type === "plugin") === (m.pluginCapability !== undefined) &&
          (t.type === "plugin") === (d.plugin_capability !== undefined),
        "Swift native build-tool capability differs",
      );
      const memberships = p.products
        .filter((v) => v.targets.some((n) => closure(n).has(t.name)))
        .map((v) => v.name);
      swiftRequire(
        swiftSame(d.product_memberships ?? [], memberships),
        "Swift transitive product membership differs",
      );
    }
  }
}
