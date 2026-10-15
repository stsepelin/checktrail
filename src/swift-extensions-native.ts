import path from "node:path";
import { z } from "zod";
import type { SwiftExtensionsConfig } from "./swift-extensions-contract.js";
import { swiftExtensionsConfigSchema } from "./swift-extensions-contract.js";
import { swiftWords, swiftRequire, swiftSame } from "./swift-native.js";
const text = z.string().max(4 * 1024 * 1024),
  file = z.string().min(1).max(8192),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
export const swiftExtensionsUnavailableSchema = z.strictObject({
  version: z.literal(1),
  mode: z.enum(["build", "xctest", "testing", "swiftlint"]),
  inputSha256: digest,
  prerequisite: z.literal("unavailable"),
});
export const swiftExtensionsPacketSchema = z.strictObject({
  version: z.literal(1),
  mode: z.enum(["build", "xctest", "testing", "swiftlint"]),
  temporary: file,
  workspace: file,
  inputSha256: digest,
  config: swiftExtensionsConfigSchema,
  optionsSha256: digest,
  tools: z
    .array(
      z.strictObject({
        name: z.enum(["swift", "swiftc", "swift-frontend", "swiftlint"]),
        entry: file,
        resolved: file,
        sha256: digest,
        afterSha256: digest,
      }),
    )
    .length(4),
  sdkBeforeSha256: digest,
  sdkAfterSha256: digest,
  generatedBefore: z.array(file).max(256),
  generatedAfter: z.array(file).max(256),
  receipts: z
    .array(
      z.strictObject({
        phase: file,
        executable: file,
        args: z.array(file).max(4096),
        exitCode: z.number().int().min(0).max(255),
        stdout: text,
        stderr: text,
        stdoutSha256: digest,
        stderrSha256: digest,
        durationMs: z.number().int().nonnegative(),
      }),
    )
    .min(8)
    .max(600),
  artifacts: z
    .array(z.strictObject({ path: file, text, sha256: digest }))
    .max(512),
});
export function swiftExtensionsTargets(config: SwiftExtensionsConfig) {
  return config.packages.flatMap((p) =>
    p.targets.map((t) => ({
      ...t,
      package: p.identity,
      sources: t.sources.map((f) => path.posix.join(p.path, f)),
    })),
  );
}
export function swiftExtensionsGenerated(
  config: SwiftExtensionsConfig,
  temporary: string,
) {
  return config.generated.map((g) => ({
    ...g,
    path: path.join(
      temporary,
      "scratch/plugins/outputs",
      g.package,
      g.target,
      "destination",
      g.plugin,
      g.file,
    ),
  }));
}
export function swiftExtensionsScanArgs(
  config: SwiftExtensionsConfig,
  workspace: string,
  temporary: string,
  target: ReturnType<typeof swiftExtensionsTargets>[number],
) {
  const generated = swiftExtensionsGenerated(config, temporary).filter(
      (g) => g.package === target.package && g.target === target.name,
    ),
    sources = [
      ...target.sources.map((f) => path.join(workspace, f)),
      ...generated.map((g) => g.path),
    ];
  return [
    "-frontend",
    "-scan-dependencies",
    "-dump-clang-diagnostics",
    "-in-process-plugin-server-path",
    "/usr/lib/swift/host/libSwiftInProcPluginServer.so",
    "-plugin-path",
    "/usr/lib/swift/host/plugins",
    "-plugin-path",
    "/usr/local/lib/swift/host/plugins",
    "-module-name",
    target.name,
    "-o",
    path.join(temporary, "sdk", target.name + ".json"),
    "-target",
    config.platform,
    "-I",
    path.join(temporary, "scratch", config.platform, "debug", "Modules"),
    ...(target.type === "plugin"
      ? [
          "-I",
          "/usr/lib/swift/pm/PluginAPI",
          "-package-description-version",
          config.toolsVersion,
        ]
      : []),
    ...sources,
  ];
}
/** Compiler participation is keyed by target, physical source and tool/destination role. */
export function swiftExtensionsCompiled(
  config: SwiftExtensionsConfig,
  workspace: string,
  temporary: string,
  frontend: string,
  output: string,
) {
  const targets = swiftExtensionsTargets(config),
    generated = swiftExtensionsGenerated(config, temporary),
    observed: string[] = [],
    expected: string[] = [];
  for (const t of targets) {
    const roles =
      t.type === "plugin"
        ? ["plugin"]
        : config.generated.some(
              (g) => g.generator === t.name && g.package === t.package,
            )
          ? ["tool", "destination"]
          : ["destination"];
    for (const role of roles)
      for (const f of [
        ...t.sources.map((f) => path.join(workspace, f)),
        ...generated
          .filter((g) => g.package === t.package && g.target === t.name)
          .map((g) => g.path),
      ])
        expected.push(JSON.stringify([t.name, role, f]));
  }
  for (const raw of output.split("\n")) {
    const line = raw.startsWith("info: ") ? raw.slice(6) : raw;
    if (!line.startsWith(frontend + " ")) continue;
    const args = swiftWords(line);
    if (args[1] !== "-frontend" || !args.includes("-c")) continue;
    const module = args[args.indexOf("-module-name") + 1],
      t = targets.find((t) => t.name === module);
    if (!t) continue;
    swiftRequire(
      args[args.indexOf("-target") + 1] === config.platform,
      "Swift extension compiler platform differs",
    );
    const role =
      t.type === "plugin"
        ? "plugin"
        : args.some(
              (a) => a.includes("/Modules-tool") || a.includes("-tool.build/"),
            )
          ? "tool"
          : "destination";
    for (let i = 2; i < args.length; i++)
      if (args[i] === "-primary-file")
        observed.push(JSON.stringify([t.name, role, args[++i]]));
  }
  // SwiftPM 6.2.3 can repeat the plugin compile in its verbose stream. Keep
  // that multiplicity, while requiring every physical role and rejecting extra
  // destination/tool compilation claims.
  const counts = new Map<string, number>();
  for (const key of observed) counts.set(key, (counts.get(key) ?? 0) + 1);
  swiftRequire(
    swiftSame([...counts.keys()], expected) &&
      [...counts].every(
        ([key, count]) =>
          count === 1 || (JSON.parse(key)[1] === "plugin" && count === 2),
      ),
    "Swift extension physical compiler cohort differs",
  );
  return observed;
}
