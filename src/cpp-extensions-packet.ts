import { z } from "zod";
import { cppExtensionsConfigSchema } from "./cpp-extensions-contract.js";
import { cppExtensionsToolNames } from "./cpp-extensions-native.js";
const file = z.string().min(1).max(8192),
  text = z.string().max(4 * 1024 * 1024),
  digest = z.string().regex(/^[a-f0-9]{64}$/),
  md5 = z.string().regex(/^[a-f0-9]{32}$/),
  bytes = z
    .number()
    .int()
    .nonnegative()
    .max(128 * 1024 * 1024);
const generatedTree = z
  .array(z.strictObject({ path: file, sha256: digest }))
  .max(16);
export const cppExtensionsPacketSchema = z.strictObject({
  version: z.literal(1),
  mode: z.enum(["build", "ctest", "clang-format", "clang-tidy"]),
  temporary: file,
  workspace: file,
  build: file,
  config: cppExtensionsConfigSchema,
  configSha256: digest,
  inputSha256: digest,
  tools: z
    .array(
      z.strictObject({
        name: z.enum(cppExtensionsToolNames),
        entry: file,
        resolved: file,
        sha256: digest,
        afterSha256: digest,
      }),
    )
    .length(cppExtensionsToolNames.length),
  receipts: z
    .array(
      z.strictObject({
        phase: file,
        executable: file,
        args: z.array(file).max(256),
        exitCode: z.number().int().min(0).max(255),
        stdout: text,
        stderr: text,
        stdoutSha256: digest,
        stderrSha256: digest,
      }),
    )
    .min(cppExtensionsToolNames.length)
    .max(512),
  artifacts: z
    .array(
      z.strictObject({
        path: file,
        encoding: z.enum(["utf8", "base64"]),
        text,
        sha256: digest,
        afterSha256: digest,
      }),
    )
    .max(512),
  binaries: z
    .array(
      z.strictObject({
        path: file,
        bytes: bytes.refine((n) => n > 0),
        sha256: digest,
        afterSha256: digest,
      }),
    )
    .max(32),
  generated: z
    .array(z.strictObject({ path: file, text, sha256: digest, md5 }))
    .max(16),
  generatedBefore: generatedTree,
  generatedAfter: generatedTree,
  sdkObserved: z
    .array(
      z.strictObject({
        path: file,
        resolved: file,
        bytes,
        sha256: digest,
        md5,
      }),
    )
    .max(8192),
  sdkBeforeSha256: digest,
  sdkAfterSha256: digest,
});
export type CppExtensionsPacket = z.infer<typeof cppExtensionsPacketSchema>;
