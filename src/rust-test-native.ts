import { realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { rustTestList, rustTestProcessSchema } from "./rust-test-events.js";

export const rustTestTargetSchema = z.object({
  name: z.string(),
  src_path: z.string(),
  kind: z.array(z.string()).min(1),
  test: z.boolean(),
  doctest: z.boolean(),
});
export const rustTestArtifactSchema = z.object({
  reason: z.literal("compiler-artifact"),
  package_id: z.string(),
  target: rustTestTargetSchema,
  profile: z.object({ test: z.boolean() }),
  fresh: z.boolean(),
  executable: z.string().nullable(),
});
export const rustTestGroupSchema = z.strictObject({
  kind: z.enum(["libtest", "doctest"]),
  target: rustTestTargetSchema,
  executable: z.string().nullable(),
  listed: rustTestProcessSchema.nullable(),
  ignoredListed: rustTestProcessSchema.nullable(),
  execution: rustTestProcessSchema.nullable(),
});
export const rustTestNativeSchema = z.strictObject({
  outputDirectory: z.string(),
  build: rustTestProcessSchema,
  groups: z.array(rustTestGroupSchema).max(100),
  error: z
    .enum(["build", "artifact", "listing", "execution", "limits"])
    .nullable(),
});
export type RustTestNative = z.infer<typeof rustTestNativeSchema>;
type Invoke = (
  executable: string,
  args: string[],
) => { status: number | null; stdout: string; stderr: string };
export async function rustTestsNative(
  invoke: Invoke,
  config: string[],
  directory: string,
  packageId: string,
  targets: z.infer<typeof rustTestTargetSchema>[],
): Promise<RustTestNative> {
  const native = (executable: string, args: string[]) => {
    const result = invoke(executable, args);
    if (result.status === null)
      throw new Error("Native test process did not exit");
    return {
      exitCode: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
  const build = native("cargo", [
    "test",
    "--no-run",
    "--all-targets",
    "--offline",
    "--locked",
    "--message-format=json",
    "--color=never",
    "--target-dir",
    directory,
    ...config,
  ]);
  const result: RustTestNative = {
    outputDirectory: directory,
    build,
    groups: [],
    error: null,
  };
  if (build.exitCode !== 0) {
    result.error = "build";
    return result;
  }
  try {
    const events = z
      .array(z.object({ reason: z.string() }).passthrough())
      .max(20000)
      .parse(
        build.stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      );
    if (
      events.at(-1)?.reason !== "build-finished" ||
      events.filter((e) => e.reason === "build-finished").length !== 1 ||
      events.at(-1)?.success !== true
    )
      throw new Error("Incomplete native test build");
    const artifacts = events
      .filter((e) => e.reason === "compiler-artifact")
      .map((e) => rustTestArtifactSchema.parse(e))
      .filter(
        (e) =>
          e.package_id === packageId &&
          e.profile.test &&
          e.executable !== null &&
          !e.target.kind.includes("custom-build"),
      );
    const identities = new Set<string>();
    for (const artifact of artifacts) {
      if (
        artifact.fresh ||
        !targets.some(
          (t) =>
            t.name === artifact.target.name &&
            t.src_path === artifact.target.src_path &&
            JSON.stringify(t.kind) === JSON.stringify(artifact.target.kind),
        )
      )
        throw new Error("Stale or undeclared test artifact");
      const file = await realpath(artifact.executable!);
      const relative = path.relative(directory, file);
      if (
        !relative ||
        relative.startsWith(".." + path.sep) ||
        path.isAbsolute(relative) ||
        file !== artifact.executable ||
        identities.has(file)
      )
        throw new Error("Unsupported test executable");
      identities.add(file);
      result.groups.push({
        kind: "libtest",
        target: artifact.target,
        executable: file,
        listed: null,
        ignoredListed: null,
        execution: null,
      });
    }
    if (
      targets.some(
        (t) =>
          t.test &&
          !t.kind.includes("custom-build") &&
          !result.groups.some(
            (g) =>
              g.target.name === t.name &&
              g.target.src_path === t.src_path &&
              JSON.stringify(g.target.kind) === JSON.stringify(t.kind),
          ),
      )
    )
      throw new Error("Missing native test target");
    const docs = targets.filter((t) => t.doctest);
    if (docs.length > 1)
      throw new Error("Unsupported documentation target selection");
    for (const target of docs)
      result.groups.push({
        kind: "doctest",
        target,
        executable: null,
        listed: null,
        ignoredListed: null,
        execution: null,
      });
    if (result.groups.length > 100) {
      result.error = "limits";
      return result;
    }
  } catch {
    result.error = "artifact";
    return result;
  }
  let selected = 0;
  for (const group of result.groups) {
    const command = group.kind === "libtest" ? group.executable! : "cargo";
    const args =
      group.kind === "libtest"
        ? []
        : [
            "test",
            "--doc",
            "--offline",
            "--locked",
            "--color=never",
            "--target-dir",
            directory,
            ...config,
            "--",
          ];
    try {
      group.listed = native(command, [...args, "--list", "--format=terse"]);
      group.ignoredListed = native(command, [
        ...args,
        "--list",
        "--ignored",
        "--format=terse",
      ]);
      const names = rustTestList(group.listed, group.kind === "doctest");
      const ignored = rustTestList(
        group.ignoredListed,
        group.kind === "doctest",
      );
      selected += names.length;
      if (selected > 1000) {
        result.error = "limits";
        return result;
      }
      if (ignored.some((name) => !names.includes(name)))
        throw new Error("Ignored test not in native inventory");
    } catch {
      result.error = "listing";
      return result;
    }
    try {
      group.execution = native(command, [
        ...args,
        "--test-threads=1",
        "--color=never",
        "--format=pretty",
      ]);
    } catch {
      result.error = "execution";
      return result;
    }
  }
  return result;
}
