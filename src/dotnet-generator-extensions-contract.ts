import { z } from "zod";
const file = z.string().min(1).max(8192),
  name = z.string().min(1).max(65536),
  digest = z.string().regex(/^[a-f0-9]{64}$/),
  guid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/),
  token = z.number().int().min(1).max(0x7fffffff);
export const dotnetGeneratorArtifactSchema = z.strictObject({
  file,
  bytes: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 * 1024),
  sha256: digest,
});
export const dotnetGeneratorMetadataSchema = z.strictObject({
  assemblyName: name,
  mvid: guid,
  documents: z
    .array(
      z.strictObject({
        file,
        algorithm: guid,
        hash: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
      }),
    )
    .max(4096),
  types: z
    .array(
      z.strictObject({
        token,
        className: name,
        baseTypeToken: z.number().int().nonnegative().max(0x7fffffff),
        baseTypeClass: name,
        baseTypeAssembly: name,
        methods: z
          .array(
            z.strictObject({
              token,
              name,
              parameterSignatures: z.array(name).max(256),
              returnSignature: name,
              parameterCount: z.number().int().nonnegative().max(256),
              genericParameters: z.number().int().nonnegative().max(64),
              signature: z
                .string()
                .regex(/^(?:[a-f0-9]{2})+$/)
                .max(65536),
              files: z.array(file).max(4096),
              points: z
                .array(
                  z.strictObject({
                    file: file.nullable(),
                    offset: z.number().int().nonnegative(),
                    hidden: z.boolean(),
                    startLine: z.number().int().nonnegative(),
                    startColumn: z.number().int().nonnegative(),
                    endLine: z.number().int().nonnegative(),
                    endColumn: z.number().int().nonnegative(),
                  }),
                )
                .max(100000),
            }),
          )
          .max(20000),
      }),
    )
    .max(4096),
  references: z
    .array(
      z.strictObject({
        token,
        name,
        version: name,
        culture: z.string().max(256),
        flags: z.number().int().nonnegative(),
        publicKeyOrToken: z
          .string()
          .regex(/^(?:[a-f0-9]{2})*$/)
          .max(1024),
      }),
    )
    .max(512),
});
export const dotnetGeneratorDiscoverySchema = z.strictObject({
  count: z.number().int().positive().max(20000),
  nodeCount: z.number().int().positive().max(20000),
  cases: z
    .array(
      z.strictObject({
        id: name,
        name,
        fullName: name,
        className: name,
        methodName: name,
        runState: z.enum([
          "Runnable",
          "NotRunnable",
          "Explicit",
          "Skipped",
          "Ignored",
        ]),
        fixtureType: name,
        fixtureToken: token,
        fixtureMvid: guid,
        fixtureAssembly: file,
        declaringType: name,
        methodToken: token,
        methodMvid: guid,
        methodAssembly: file,
        methodSignature: z
          .string()
          .regex(/^(?:[a-f0-9]{2})+$/)
          .max(65536),
        parameterSignatures: z.array(name).max(256),
        returnSignature: name,
        parameterTypes: z.array(name).max(256),
        returnType: name,
        genericArguments: z.array(name).max(64),
        arguments: z
          .array(
            z.strictObject({
              type: name,
              value: z.string().max(4096).nullable(),
            }),
          )
          .max(256),
        baseChain: z
          .array(
            z.strictObject({
              className: name,
              token,
              mvid: guid,
              assembly: file,
            }),
          )
          .min(1)
          .max(64),
      }),
    )
    .min(1)
    .max(20000),
});
const common = {
  schemaVersion: z.literal(1),
  processId: z.number().int().positive(),
  runtime: z.literal("10.0.12"),
  arguments: z.array(file).length(3),
  workingDirectory: file,
  helper: dotnetGeneratorArtifactSchema,
  framework: dotnetGeneratorArtifactSchema,
  assembly: dotnetGeneratorArtifactSchema,
  pdb: dotnetGeneratorArtifactSchema,
  modules: z
    .array(
      z.strictObject({
        name,
        mvid: guid,
        artifact: dotnetGeneratorArtifactSchema,
      }),
    )
    .min(1)
    .max(512),
};
export const dotnetGeneratorIdentityNativeSchema = z.discriminatedUnion(
  "mode",
  [
    z.strictObject({
      ...common,
      mode: z.literal("metadata"),
      observation: dotnetGeneratorMetadataSchema,
    }),
    z.strictObject({
      ...common,
      mode: z.literal("discovery"),
      observation: dotnetGeneratorDiscoverySchema,
    }),
  ],
);
export const dotnetGeneratorIdentityCaptureSchema = z.strictObject({
  native: dotnetGeneratorIdentityNativeSchema,
  stdout: z
    .string()
    .min(1)
    .max(1024 * 1024),
  stderr: z.literal(""),
  launcherPid: z.number().int().positive(),
});
export const dotnetGeneratorIdentitySchema = z.strictObject({
  observerSourceSha256: digest,
  observerSha256: digest,
  runtimeconfigSha256: digest,
  metadata: z.array(dotnetGeneratorIdentityCaptureSchema).min(1).max(64),
  discovery: z.array(dotnetGeneratorIdentityCaptureSchema).min(1).max(64),
});
