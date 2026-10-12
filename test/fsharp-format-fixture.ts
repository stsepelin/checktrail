import path from "node:path";
import { tmpdir } from "node:os";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { fixture } from "./helpers.js";
import {
  fsharpPacketSchema,
  fsharpNativeSchema,
} from "../src/fsharp-format-contract.js";
import { captureProcessOutput } from "../src/process-output.js";
import { mavenHash } from "../src/maven.js";
import type { ProcessResult, Report } from "../src/types.js";
export const fsharpFormatCache =
  process.env.CHECKTRAIL_FSHARP_FORMAT_CACHE ??
  fileURLToPath(
    new URL("../../.checktrail/fsharp-format-tools", import.meta.url),
  );
const available =
  process.platform === "linux" &&
  process.arch === "arm64" &&
  (await access(path.join(fsharpFormatCache, "Fantomas.Core.dll")).then(
    () => true,
    () => false,
  ));
export const fsharpFormatNative = {
  skip: available
    ? false
    : "The selected Linux ARM64 SDK/runtime and exact formatter cache are not prepared",
  timeout: 120000,
};
export const fsharpOriginalFiles = {
  "implementation.fs": "module Original\nlet add a b=a+b\n",
  "signature.fsi": "module Original\nval add:int->int->int\n",
  "conditional.fs":
    "#if ORIGINAL\nlet chosen = 1\n#else\nlet chosen = 2\n#endif\n",
};
export async function fsharpFormatFixture(
  t: TestContext,
  files: Record<string, string> = fsharpOriginalFiles,
) {
  const root = await fixture(t, {
    "Original.fsproj":
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["dotnet.format-fsharp"] }],
    }),
    ...files,
  });
  const directory = path.join(root, ".checktrail/formatter");
  await mkdir(directory, { recursive: true });
  for (const file of [
    "FSharp.Core.dll",
    "Fantomas.Core.dll",
    "Fantomas.FCS.dll",
  ])
    await copyFile(
      path.join(fsharpFormatCache, file),
      path.join(directory, file),
    );
  await writeFile(
    path.join(root, "checktrail.fsharp-format.json"),
    JSON.stringify({
      schemaVersion: 1,
      profile: "fantomas-core-default-v1",
      formatterDirectory: ".checktrail/formatter",
      files: Object.keys(files),
    }),
  );
  return root;
}
export function fsharpReportPacket(report: Report) {
  return fsharpPacketSchema.parse(
    JSON.parse(report.checks[0]!.processes[0]!.stdout),
  );
}
export function fsharpReportNative(report: Report) {
  return fsharpNativeSchema.parse(
    JSON.parse(fsharpReportPacket(report).phases[1]!.stdout),
  );
}
export async function repairFsharpFormatting(root: string, report: Report) {
  const native = fsharpReportNative(report);
  for (const document of native.documents) {
    if (document.after === null)
      throw Error("Cannot repair a parser failure by rewriting format output");
    const relative = path.relative(
      fsharpReportPacket(report).temporary + "/workspace",
      document.file,
    );
    await writeFile(
      path.join(root, relative),
      (document.utf8Bom ? "\uFEFF" : "") + document.after,
    );
  }
}
export function fsharpRewriteNative(
  process: ProcessResult,
  edit: (value: ReturnType<typeof fsharpNativeSchema.parse>) => void,
) {
  const cloned = JSON.parse(JSON.stringify(process)) as ProcessResult,
    packet = fsharpPacketSchema.parse(JSON.parse(cloned.stdout)),
    phase = packet.phases[1]!,
    native = fsharpNativeSchema.parse(JSON.parse(phase.stdout));
  edit(native);
  phase.stdout = JSON.stringify(native);
  phase.stdoutBytes = Buffer.byteLength(phase.stdout);
  phase.stdoutSha256 = mavenHash(phase.stdout);
  phase.capturedOutput = captureProcessOutput(
    Buffer.from(phase.stdout),
    Buffer.from(phase.stderr),
    phase.stdoutBytes + phase.stderrBytes,
    true,
  );
  cloned.stderr = packet.phases.map((p) => p.stdout + p.stderr).join("");
  packet.mirroredBytes = Buffer.byteLength(cloned.stderr);
  packet.mirroredSha256 = mavenHash(cloned.stderr);
  cloned.stdout = JSON.stringify(packet);
  return cloned;
}
export async function fsharpSourceBytes(root: string, files: string[]) {
  return Promise.all(
    files.map(async (file) => ({
      file,
      sha256: mavenHash(await readFile(path.join(root, file))),
    })),
  );
}
export const fsharpProcessOwnerPrefix = path.join(
  tmpdir(),
  "original-fsharp-formatter-owned-",
);
export function fsharpRewritePacket(
  process: ProcessResult,
  edit: (value: ReturnType<typeof fsharpPacketSchema.parse>) => void,
) {
  const cloned = JSON.parse(JSON.stringify(process)) as ProcessResult,
    packet = fsharpPacketSchema.parse(JSON.parse(cloned.stdout));
  edit(packet);
  cloned.stdout = JSON.stringify(packet);
  return cloned;
}
