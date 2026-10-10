import assert from "node:assert/strict";
import { test } from "node:test";
import { dotnetBuildInvocationSchema } from "../src/dotnet-build.js";
import {
  dotnetGeneratorExtensionsConfigSchema,
  validateDotnetGeneratorPolicy,
} from "../src/dotnet-generator-extensions.js";
import { fixture } from "./helpers.js";
import { createPlan, validate } from "../src/engine.js";
const invocation = () =>
  dotnetBuildInvocationSchema.parse({
    config: {
      schemaVersion: 1,
      solution: "Original.slnx",
      repository: ".checktrail/artifacts",
      repositoryManifest: ".checktrail/repository.json",
      repositorySha256: "0".repeat(64),
      projects: [
        {
          file: "Generator/Generator.csproj",
          language: "csharp",
          assemblyName: "Original.Generator",
          targetFramework: "net10.0",
          kind: "library",
          sources: ["Generator/Generator.cs"],
          generatedSources: [],
          testClasses: [],
        },
        {
          file: "Producer/Producer.csproj",
          language: "csharp",
          assemblyName: "Original.Producer",
          targetFramework: "net10.0",
          kind: "library",
          sources: ["Producer/Counter.cs"],
          generatedSources: [],
          testClasses: [],
          roslynGeneratedSources: [
            {
              file: "Producer/obj/Debug/net10.0/generated/Original.Generator/Example.Generator/Counter.g.cs",
              generatorProject: "Generator/Generator.csproj",
              generatorClass: "Example.Generator",
            },
          ],
        },
        {
          file: "Tests/Tests.csproj",
          language: "csharp",
          assemblyName: "Original.Tests",
          targetFramework: "net10.0",
          kind: "test",
          sources: ["Tests/Cases.cs"],
          generatedSources: [],
          testClasses: [{ file: "Tests/Cases.cs", className: "Example.Cases" }],
        },
      ],
    },
    inputs: [{ path: "Original.slnx", sha256: "0".repeat(64) }],
  });
const policy = () =>
  dotnetGeneratorExtensionsConfigSchema.parse({
    schemaVersion: 1,
    profile: "compiled-method-and-project-reference-v1",
    projectReferences: [
      {
        consumer: "Producer/Producer.csproj",
        producer: "Generator/Generator.csproj",
        kind: "analyzer",
      },
      {
        consumer: "Tests/Tests.csproj",
        producer: "Producer/Producer.csproj",
        kind: "assembly",
      },
    ],
    incrementalGenerators: [
      { project: "Generator/Generator.csproj", className: "Example.Generator" },
    ],
  });
test("generator policy accepts a complete declared acyclic producer, analyzer and test graph", () => {
  assert.doesNotThrow(() =>
    validateDotnetGeneratorPolicy(policy(), invocation()),
  );
});
test("generator policy refuses missing or adjacent generator roles, ambiguous assemblies, duplicate and cyclic edges", () => {
  const missing = policy();
  missing.incrementalGenerators[0]!.className = "Example.GeneratorExtra";
  assert.throws(
    () => validateDotnetGeneratorPolicy(missing, invocation()),
    /exact generated output/,
  );
  const omitted = policy();
  omitted.projectReferences = omitted.projectReferences.filter(
    (r) => r.kind !== "analyzer",
  );
  assert.throws(
    () => validateDotnetGeneratorPolicy(omitted, invocation()),
    /exact native analyzer/,
  );
  const duplicate = policy();
  duplicate.projectReferences.push({ ...duplicate.projectReferences[0]! });
  assert.throws(
    () => validateDotnetGeneratorPolicy(duplicate, invocation()),
    /Unique project-reference/,
  );
  const cycle = policy();
  cycle.projectReferences.push({
    consumer: "Generator/Generator.csproj",
    producer: "Tests/Tests.csproj",
    kind: "assembly",
  });
  assert.throws(
    () => validateDotnetGeneratorPolicy(cycle, invocation()),
    /acyclic/,
  );
  const ambiguous = invocation();
  ambiguous.config.projects[2]!.assemblyName =
    ambiguous.config.projects[1]!.assemblyName;
  assert.throws(
    () => validateDotnetGeneratorPolicy(policy(), ambiguous),
    /Distinct declared assembly/,
  );
  assert.equal(
    dotnetGeneratorExtensionsConfigSchema.safeParse({
      ...policy(),
      trust: true,
    }).success,
    false,
  );
  assert.equal(
    dotnetGeneratorExtensionsConfigSchema.safeParse({
      ...policy(),
      profile: "compiled-method-and-project-reference-v1-extra",
    }).success,
    false,
  );
});
test("generator planning remains passive and unavailable without the complete native build declaration", async (t) => {
  const root = await fixture(t, {
    "Original.slnx": "<Solution/>\n",
    "Counter.cs": "public class Counter {}\n",
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["dotnet.generator-extensions"] }],
    }),
  });
  const check = (await createPlan(root)).plan.checks[0]!;
  assert.equal(check.id, "dotnet.generator-extensions");
  assert.equal(check.commands.length, 0);
  assert.ok(check.unavailableReason);
  const result = (await validate(root, { trusted: true })).checks[0]!;
  assert.equal(result.status, "unavailable");
  assert.equal(result.processes.length, 0);
});
