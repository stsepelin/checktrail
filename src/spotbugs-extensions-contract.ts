import { z } from "zod";
import { spotbugsCorePatterns } from "./spotbugs-extensions-artifacts.js";
import { javaCompilerEvidenceSchema } from "./java-evidence.js";
import {
  jvmGeneratedSchema,
  jvmModuleWitnessSchema,
} from "./jvm-workspace-extensions.js";
import { capturedProcessOutputSchema } from "./process-output.js";
const file = z.string().min(1).max(16384),
  digest = z.string().regex(/^[a-f0-9]{64}$/),
  name = z.string().regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/),
  type = z.union([
    z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
    z.enum(spotbugsCorePatterns.map((pattern) => pattern.type)),
  ]);
const pin = z.strictObject({
  file,
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(32 * 1024 * 1024),
  sha256: digest,
});
export const spotbugsExtensionCompilerSchema =
  javaCompilerEvidenceSchema.extend({
    classes: z
      .strictObject({
        name: z.union([name, z.literal("module-info")]),
        file,
        output: file,
        sourceFile: file,
        bytes: z
          .number()
          .int()
          .positive()
          .max(32 * 1024 * 1024),
        sha256: digest,
      })
      .array()
      .max(20000),
  });
export const spotbugsExtensionAnalysisSchema = z.strictObject({
  version: z.literal(1),
  runtime: z.literal("25.0.4+7-LTS"),
  vendor: z.literal("Eclipse Adoptium"),
  spotbugs: z.literal("4.10.4"),
  completed: z.boolean(),
  corePlugin: z.string(),
  detectors: name.array().min(1).max(512),
  effective: name.array().max(512).array().min(1).max(16),
  predicted: z.number().int().positive().array().min(1).max(16),
  passes: z
    .strictObject({
      expected: z.number().int().positive(),
      finished: z.number().int().nonnegative(),
      classes: name.array().min(1).max(100000),
    })
    .array()
    .min(1)
    .max(16),
  stats: z.strictObject({ name, source: file }).array().min(1).max(20000),
  bugs: z
    .strictObject({
      type,
      priority: z.number().int().min(1).max(3),
      rank: z.number().int().min(1).max(20),
      className: name,
      source: file,
      line: z.number().int(),
      endLine: z.number().int(),
      message: z.string().min(1).max(65536),
      provider: z.string(),
      abbreviation: z.string(),
      category: z.string(),
    })
    .array()
    .max(2000),
  provenance: z
    .strictObject({
      detector: name,
      plugin: z.string(),
      enabled: z.boolean(),
      defaultEnabled: z.boolean(),
      origin: file,
    })
    .array()
    .min(1)
    .max(512),
  patterns: z
    .strictObject({
      plugin: z.string(),
      type,
      abbreviation: z.string(),
      category: z.string(),
    })
    .array()
    .min(1)
    .max(2000),
  errors: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  errorMessages: z.string().array().max(2000),
  missingClasses: z.string().array().max(2000),
  skipped: z.string().array().max(2000),
  oversized: name.array().max(20000),
  messages: z.string().max(2 * 1024 * 1024),
});
export const spotbugsExtensionInvocationSchema = z.strictObject({
  tool: z.enum(["java", "javac", "jar"]),
  args: file.array().max(256),
  cwd: file,
  status: z.number().int().nullable(),
  signal: z.string().nullable(),
  pid: z.number().int().positive(),
  stdoutBytes: z
    .number()
    .int()
    .nonnegative()
    .max(2 * 1024 * 1024),
  stderrBytes: z
    .number()
    .int()
    .nonnegative()
    .max(2 * 1024 * 1024),
  stdoutSha256: digest,
  stderrSha256: digest,
  stdout: z.string().max(2 * 1024 * 1024),
  stderr: z.string().max(2 * 1024 * 1024),
});
export const spotbugsExtensionsEvidenceSchema = z.strictObject({
  version: z.literal(2),
  requestDigest: digest,
  snapshot: file,
  temporary: file,
  jdkHome: file,
  original: pin
    .extend({ relative: file, nativeFile: file })
    .array()
    .min(1)
    .max(2000),
  after: pin.array().min(1).max(2000),
  configuration: pin.array().length(2),
  libraries: pin.extend({ nativeFile: file }).array().max(128),
  plugins: pin.extend({ nativeFile: file }).array().max(8),
  generated: jvmGeneratedSchema,
  payloads: z
    .strictObject({
      path: file,
      bytes: z.number().int().positive().max(131072),
      sha256: digest,
      base64: z.string().max(174764),
    })
    .array()
    .max(256),
  stages: z
    .strictObject({
      id: z.string(),
      directory: file,
      sourceFiles: file.array().min(1).max(2000),
      classPath: file.array().max(256),
      compiler: spotbugsExtensionCompilerSchema,
    })
    .array()
    .max(64),
  modules: jvmModuleWitnessSchema,
  analysis: spotbugsExtensionAnalysisSchema.nullable(),
  outputsAfter: pin.array().max(20000),
  invocations: spotbugsExtensionInvocationSchema.array().max(128),
  mirrored: capturedProcessOutputSchema,
  stagedArtifactsVerified: z.literal(true),
});
