import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { dotnetCompilerSource } from "./dotnet-compiler.js";
import { dotnetInvocationSchema, dotnetReferences } from "./dotnet.js";
import { withinRoot } from "./inventory.js";

const sdkVersion = "10.0.401";
const runtimeVersion = "10.0.12";
const compilerVersion =
  "5.9.0-1.26423.113 (e34a38d2ae1fc26406a317517196e55c68ff83ab)";
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "",
  DOTNET_CLI_TELEMETRY_OPTOUT: "1",
  DOTNET_NOLOGO: "1",
  DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
  DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: "1",
  DOTNET_EnableDiagnostics: "0",
  DOTNET_GCHeapHardLimit: "10000000",
};
let nativeBytes = 0;
function invoke(args: string[], cwd: string) {
  const result = spawnSync("dotnet", args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  nativeBytes +=
    Buffer.byteLength(result.stdout ?? "") +
    Buffer.byteLength(result.stderr ?? "");
  if (
    result.error ||
    result.signal ||
    result.status === null ||
    nativeBytes > 4 * 1024 * 1024
  )
    throw new Error(".NET invocation did not complete within evidence limits");
  return result;
}
async function fingerprint(files: string[]) {
  const hash = createHash("sha256");
  let total = 0;
  if (files.length > 512)
    throw new Error(".NET reference pack exceeds file limits");
  for (const file of files) {
    const info = await stat(file);
    total += info.size;
    if (
      !info.isFile() ||
      info.size > 32 * 1024 * 1024 ||
      total > 128 * 1024 * 1024
    )
      throw new Error(".NET reference pack exceeds byte limits");
    hash
      .update(path.basename(file))
      .update("\0")
      .update(
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      )
      .update("\0");
  }
  return hash.digest("hex");
}
async function main() {
  const temporary = await mkdtemp(path.join(tmpdir(), "repo-verifier-dotnet-"));
  try {
    let sdk: string;
    try {
      const list = invoke(["--list-sdks"], temporary);
      const matches = list.stdout
        .split(/\r?\n/)
        .flatMap((line) => /^10\.0\.401 \[([^\r\n]+)\]$/.exec(line)?.[1] ?? []);
      if (list.status !== 0 || list.stderr || matches.length !== 1)
        throw new Error("Missing verified SDK");
      sdk = await realpath(path.join(matches[0]!, sdkVersion));
      const version = invoke(
        ["exec", path.join(sdk, "Roslyn/bincore/csc.dll"), "-version"],
        temporary,
      );
      if (
        version.status !== 0 ||
        version.stderr ||
        version.stdout.trim() !== compilerVersion
      )
        throw new Error("Unverified Roslyn compiler");
    } catch {
      process.stdout.write(JSON.stringify({ unavailable: "dotnet-toolchain" }));
      process.exitCode = 3;
      return;
    }
    if (process.argv[2] === "--version") {
      process.stdout.write(`${sdkVersion}\n`);
      return;
    }
    const installation = path.resolve(sdk, "../..");
    const referencePack = path.join(
      installation,
      "packs/Microsoft.NETCore.App.Ref",
      runtimeVersion,
      "ref/net10.0",
    );
    const builtins = (await readdir(referencePack))
      .filter((file) => file.endsWith(".dll"))
      .sort()
      .map((file) => path.join(referencePack, file));
    if (
      !["System.Runtime.dll", "mscorlib.dll"].every((file) =>
        builtins.includes(path.join(referencePack, file)),
      )
    )
      throw new Error("Incomplete .NET reference pack");
    const compiler = path.join(sdk, "Roslyn/bincore");
    const compilerLibraries = [
      "Microsoft.CodeAnalysis.dll",
      "Microsoft.CodeAnalysis.CSharp.dll",
    ].map((file) => path.join(compiler, file));
    const toolFiles = [
      ...builtins,
      ...compilerLibraries,
      path.join(compiler, "csc.dll"),
    ];
    const before = await fingerprint(toolFiles);
    const root = await realpath(process.argv[2]!);
    const project = path.relative(root, await realpath(process.cwd())) || ".";
    const invocation = dotnetInvocationSchema.parse(
      JSON.parse(process.argv[3]!),
    );
    const references = await dotnetReferences(root, project, invocation.config);
    const sources = await Promise.all(
      invocation.scope.map((file) =>
        withinRoot(root, path.join(project, file)),
      ),
    );
    const helper = path.join(temporary, "VerifierCompiler.cs");
    const output = path.join(temporary, "VerifierCompiler.dll");
    await writeFile(helper, dotnetCompilerSource);
    const bootstrap = invoke(
      [
        "exec",
        path.join(compiler, "csc.dll"),
        "-nologo",
        "-noconfig",
        "-nostdlib+",
        "-langversion:14",
        "-nullable:enable",
        "-warnaserror+",
        "-target:exe",
        `-out:${output}`,
        ...[...builtins, ...compilerLibraries].map((file) => `-r:${file}`),
        helper,
      ],
      temporary,
    );
    if (bootstrap.status !== 0 || bootstrap.stderr || bootstrap.stdout.trim())
      throw new Error("Owned .NET compiler helper could not be prepared");
    for (const file of compilerLibraries)
      await copyFile(file, path.join(temporary, path.basename(file)));
    await writeFile(
      path.join(temporary, "VerifierCompiler.runtimeconfig.json"),
      JSON.stringify({
        runtimeOptions: {
          tfm: "net10.0",
          framework: { name: "Microsoft.NETCore.App", version: runtimeVersion },
          rollForward: "Disable",
        },
      }),
    );
    const input = path.join(temporary, "invocation.json");
    await writeFile(
      input,
      JSON.stringify({
        config: invocation.config,
        sources,
        references: [...builtins, ...references],
      }),
    );
    const result = invoke(["exec", output, input], temporary);
    if (result.status !== 0 || result.stderr.trim())
      throw new Error(".NET compiler did not complete evidence collection");
    await dotnetReferences(root, project, invocation.config);
    if ((await fingerprint(toolFiles)) !== before)
      throw new Error(
        ".NET reference pack or compiler changed during compilation",
      );
    process.stdout.write(
      JSON.stringify({
        sdkVersion,
        runtimeReferenceVersion: runtimeVersion,
        referenceFiles: builtins.length,
        compilerAndReferencesSha256: before,
        compilation: JSON.parse(result.stdout) as unknown,
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch(() => {
  process.stderr.write(".NET evidence collection could not complete\n");
  process.exitCode = 2;
});
