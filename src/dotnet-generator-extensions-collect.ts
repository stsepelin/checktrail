import path from "node:path";
import { copyFile, writeFile } from "node:fs/promises";
import type { SpawnSyncReturns } from "node:child_process";
import type { z } from "zod";
import type { dotnetBuildInvocationSchema } from "./dotnet-build.js";
import { mavenHash } from "./maven.js";
import { dotnetGeneratorExtensionsNativeSource } from "./dotnet-generator-extensions-native.js";
import {
  dotnetGeneratorIdentityNativeSchema,
  dotnetGeneratorIdentityCaptureSchema,
} from "./dotnet-generator-extensions-contract.js";
interface Context {
  sdk: string;
  workspace: string;
  repository: string;
  observer: string;
  references: string[];
  invocation: z.infer<typeof dotnetBuildInvocationSchema>;
  ownedPins: Map<string, string>;
  invoke: (
    phase: string,
    args: string[],
    cwd: string,
  ) => SpawnSyncReturns<string>;
  observe: (file: string) => Promise<{ bytes: number; sha256: string }>;
  regular: (file: string, bound: number) => Promise<Buffer>;
}
export const dotnetGeneratorCompileWarning =
  "warning CS1701: Assuming assembly reference 'System.Runtime, Version=8.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a' used by 'nunit.framework' matches identity 'System.Runtime, Version=10.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a' of 'System.Runtime', you may need to supply runtime policy\n";
export async function collectDotnetGeneratorIdentities(context: Context) {
  const {
    sdk,
    workspace,
    repository,
    observer,
    references,
    invocation,
    ownedPins,
    invoke,
    observe,
    regular,
  } = context;
  const source = path.join(observer, "ChecktrailGeneratorIdentity.cs"),
    helper = path.join(observer, "ChecktrailGeneratorIdentity.dll"),
    framework = path.join(
      repository,
      "nunit/4.6.1/lib/net8.0/nunit.framework.dll",
    ),
    runtimeconfig = path.join(
      observer,
      "ChecktrailGeneratorIdentity.runtimeconfig.json",
    );
  await observe(framework);
  await writeFile(source, dotnetGeneratorExtensionsNativeSource, {
    flag: "wx",
  });
  const compiled = invoke(
    "generator-identity-observer-compile",
    [
      "exec",
      path.join(sdk, "Roslyn/bincore/csc.dll"),
      "-nologo",
      "-noconfig",
      "-nostdlib+",
      "-target:exe",
      "-langversion:14",
      `-out:${helper}`,
      ...references.map((f) => `-r:${f}`),
      `-r:${framework}`,
      source,
    ],
    observer,
  );
  if (
    compiled.status !== 0 ||
    compiled.stdout !== dotnetGeneratorCompileWarning ||
    compiled.stderr
  )
    throw Error(
      "Native method observer did not compile with exactly the retained framework warning",
    );
  await copyFile(framework, path.join(observer, "nunit.framework.dll"));
  await writeFile(
    runtimeconfig,
    JSON.stringify({
      runtimeOptions: {
        tfm: "net10.0",
        framework: { name: "Microsoft.NETCore.App", version: "10.0.12" },
        rollForward: "Disable",
      },
    }),
    { flag: "wx" },
  );
  for (const file of [
    source,
    helper,
    runtimeconfig,
    path.join(observer, "nunit.framework.dll"),
  ])
    ownedPins.set(file, mavenHash(await regular(file, 4 * 1024 * 1024)));
  const metadata: Array<z.infer<typeof dotnetGeneratorIdentityCaptureSchema>> =
      [],
    discovery: Array<z.infer<typeof dotnetGeneratorIdentityCaptureSchema>> = [];
  for (const mode of ["metadata", "discovery"] as const)
    for (const project of invocation.config.projects.filter(
      (p) => mode === "metadata" || p.kind === "test",
    )) {
      const base = path.join(
          workspace,
          path.dirname(project.file),
          "bin/Debug/net10.0",
        ),
        assembly = path.join(base, project.assemblyName + ".dll"),
        pdb = path.join(base, project.assemblyName + ".pdb");
      await observe(assembly);
      await observe(pdb);
      const native = invoke(
        `generator-identity-${mode}:${project.file}`,
        ["exec", helper, mode, assembly, pdb],
        workspace,
      );
      if (native.status !== 0 || native.stderr)
        throw Error("Complete native method identity observation required");
      const result = dotnetGeneratorIdentityNativeSchema.parse(
        JSON.parse(native.stdout),
      );
      if (result.mode !== mode)
        throw Error("Exact native identity mode required");
      for (const module of result.modules) {
        if (
          module.artifact.file === helper ||
          module.artifact.file === path.join(observer, "nunit.framework.dll")
        ) {
          if (ownedPins.get(module.artifact.file) !== module.artifact.sha256)
            throw Error("Owned method observer changed");
        } else {
          const pin = await observe(module.artifact.file);
          if (
            pin.bytes !== module.artifact.bytes ||
            pin.sha256 !== module.artifact.sha256
          )
            throw Error("Native identity loaded module changed");
        }
      }
      (mode === "metadata" ? metadata : discovery).push(
        dotnetGeneratorIdentityCaptureSchema.parse({
          native: result,
          stdout: native.stdout,
          stderr: native.stderr,
          launcherPid: native.pid,
        }),
      );
    }
  return {
    observerSourceSha256: ownedPins.get(source)!,
    observerSha256: ownedPins.get(helper)!,
    runtimeconfigSha256: ownedPins.get(runtimeconfig)!,
    metadata,
    discovery,
  };
}
