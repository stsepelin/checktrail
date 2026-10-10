import path from "node:path";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  dotnetBuildInvocationSchema,
  dotnetBuildRepositorySchema,
} from "./dotnet-build.js";
import { dotnetBuildEvidence } from "./dotnet-build-evidence.js";
import {
  dotnetTestEvidence,
  dotnetTestPacketSchema,
} from "./dotnet-test-evidence.js";
import { dotnetGeneratorIdentitySchema } from "./dotnet-generator-extensions-contract.js";
import {
  dotnetGeneratorExtensionsConfigSchema,
  dotnetGeneratorRequire as need,
  validateDotnetGeneratorPolicy,
} from "./dotnet-generator-extensions.js";
import { dotnetGeneratorExtensionsNativeSource } from "./dotnet-generator-extensions-native.js";
import { dotnetGeneratorCompileWarning } from "./dotnet-generator-extensions-collect.js";
import { fsharpSdkPins } from "./fsharp-format-pins.js";
import { mavenHash } from "./maven.js";
import type { Check, CheckResult, ProcessResult } from "./types.js";
export const dotnetGeneratorExtensionsPacketSchema =
  dotnetTestPacketSchema.extend({
    generatorIdentity: dotnetGeneratorIdentitySchema.nullable(),
  });
const same = (a: string[], b: string[]) =>
  new Set(a).size === a.length &&
  new Set(b).size === b.length &&
  isDeepStrictEqual([...a].sort(), [...b].sort());
function bytes(file: string, bound: number, hash: string, size?: number) {
  need(
    path.isAbsolute(file) && realpathSync(file) === file,
    "Current canonical evidence file",
  );
  const stat = lstatSync(file);
  need(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= bound,
    "Current bounded regular evidence file",
  );
  const b = readFileSync(file);
  need(
    b.length <= bound &&
      mavenHash(b) === hash &&
      (size === undefined || b.length === size),
    "Current byte identity",
  );
  return b;
}
function walk(root: string) {
  let count = 0;
  const files: string[] = [];
  function visit(relative: string) {
    const file = path.join(root, relative),
      s = lstatSync(file);
    need(
      ++count <= 8192 && !s.isSymbolicLink() && realpathSync(file) === file,
      "Current bounded dependency tree",
    );
    if (s.isDirectory())
      for (const n of readdirSync(file)) visit(path.posix.join(relative, n));
    else {
      need(s.isFile(), "Regular dependency artifact");
      files.push(relative);
    }
  }
  visit(".");
  return files.sort();
}
function sdkBytes(root: string) {
  const groups = new Map<string, string[]>();
  for (const p of fsharpSdkPins) {
    bytes(path.join(root, p.file), 64 * 1024 * 1024, p.sha256, p.bytes);
    if (p.file !== "dotnet") {
      const dir = path.posix.dirname(p.file);
      groups.set(dir, [
        ...(groups.get(dir) ?? []),
        path.posix.basename(p.file),
      ]);
    }
  }
  for (const [dir, files] of groups)
    need(
      same(
        readdirSync(path.join(root, dir)).filter((f) =>
          /\.(?:dll|so|json)$/.test(f),
        ),
        files,
      ),
      "Exact current selected SDK component tree",
    );
  for (const dir of ["host/fxr", "shared/Microsoft.NETCore.App"])
    need(
      same(readdirSync(path.join(root, dir)), ["10.0.12"]),
      "Exact current selected runtime inventory",
    );
}
export function dotnetGeneratorExtensionsEvidence(
  check: Check,
  processes: ProcessResult[],
  root?: string,
): Pick<
  CheckResult,
  "status" | "reason" | "tests" | "findings" | "findingsComplete"
> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Native generator, project-reference and compiled-method witnesses do not reconcile with current inputs and every test",
    findingsComplete: false,
  };
  if (!root || processes.length !== 1) return incomplete;
  const process = processes[0]!;
  if (
    process.exitCode !== 0 ||
    process.cancelled ||
    process.timedOut ||
    process.truncated
  )
    return incomplete;
  try {
    const raw = JSON.parse(process.stdout);
    if (raw.prerequisiteFailure) return dotnetBuildEvidence(check, processes);
    const data = dotnetGeneratorExtensionsPacketSchema.parse(raw),
      build = data.build,
      invocation = dotnetBuildInvocationSchema.parse(
        JSON.parse(check.commands[0]!.args[2]!),
      ),
      config = dotnetGeneratorExtensionsConfigSchema.parse(
        JSON.parse(check.commands[0]!.args[4]!),
      );
    need(
      check.id === "dotnet.generator-extensions" &&
        check.commands[0]!.args[3] === "--generator-extensions" &&
        check.commands[0]!.args.length === 5 &&
        realpathSync(root) === root,
      "Exact selected generator invocation",
    );
    validateDotnetGeneratorPolicy(config, invocation);
    for (const p of invocation.inputs) {
      const f = path.resolve(root, check.project, p.path);
      need(f.startsWith(root + path.sep), "Current input boundary");
      bytes(f, 4 * 1024 * 1024, p.sha256);
    }
    need(
      invocation.inputs.some(
        (p) => p.path === "checktrail.dotnet-generator.json",
      ) &&
        isDeepStrictEqual(
          config,
          dotnetGeneratorExtensionsConfigSchema.parse(
            JSON.parse(
              readFileSync(
                path.join(
                  root,
                  check.project,
                  "checktrail.dotnet-generator.json",
                ),
                "utf8",
              ),
            ),
          ),
        ),
      "Current native generator policy",
    );
    const manifest = bytes(
        path.join(root, check.project, invocation.config.repositoryManifest),
        1024 * 1024,
        invocation.config.repositorySha256,
      ),
      repo = dotnetBuildRepositorySchema.parse(
        JSON.parse(manifest.toString("utf8")),
      ),
      repoRoot = path.join(root, check.project, invocation.config.repository);
    need(
      manifest.toString("utf8") === build.repositoryManifest &&
        same(
          walk(repoRoot),
          repo.files.map((p) => p.path),
        ),
      "Current complete dependency tree",
    );
    for (const p of repo.files)
      bytes(path.join(repoRoot, p.path), 32 * 1024 * 1024, p.sha256, p.bytes);
    const sdkRoot = path.resolve(build.sdk, "../..");
    sdkBytes(sdkRoot);
    const built = dotnetBuildEvidence(check, [
      { ...process, stdout: JSON.stringify(build) },
    ]);
    if (built.status !== "passed") return built;
    need(data.generatorIdentity, "Complete native generator identity required");
    const identity = data.generatorIdentity,
      projects = invocation.config.projects,
      testProjects = projects.filter((p) => p.kind === "test"),
      observer = path.join(path.dirname(build.workspace), "observer"),
      helper = path.join(observer, "ChecktrailGeneratorIdentity.dll"),
      framework = path.join(observer, "nunit.framework.dll");
    need(
      identity.observerSourceSha256 ===
        mavenHash(dotnetGeneratorExtensionsNativeSource) &&
        identity.runtimeconfigSha256 ===
          mavenHash(
            JSON.stringify({
              runtimeOptions: {
                tfm: "net10.0",
                framework: {
                  name: "Microsoft.NETCore.App",
                  version: "10.0.12",
                },
                rollForward: "Disable",
              },
            }),
          ),
      "Original native identity observer and runtime configuration",
    );
    const phases = [
        "generator-identity-observer-compile",
        ...projects.map((p) => "generator-identity-metadata:" + p.file),
        ...testProjects.map((p) => "generator-identity-discovery:" + p.file),
      ],
      receipts = data.nativeReceipts.slice(-phases.length);
    need(
      isDeepStrictEqual(
        receipts.map((r) => r.phase),
        phases,
      ) && receipts.every((r) => r.exitCode === 0),
      "Exact complete native identity phase ledger",
    );
    const compiled = receipts[0]!;
    need(
      compiled.stdoutBytes ===
        Buffer.byteLength(dotnetGeneratorCompileWarning) &&
        compiled.stdoutSha256 === mavenHash(dotnetGeneratorCompileWarning) &&
        compiled.stderrBytes === 0 &&
        compiled.stderrSha256 === mavenHash(""),
      "Exact retained NUnit compiler warning",
    );
    const nativeRepository = path.join(
        path.dirname(build.workspace),
        "repository",
      ),
      frameworkPin = build.observedArtifacts.find(
        (p) =>
          p.file ===
          path.join(
            nativeRepository,
            "nunit/4.6.1/lib/net8.0/nunit.framework.dll",
          ),
      );
    need(frameworkPin, "Selected NUnit framework artifact");
    const artifact = (file: string) => {
      const a = build.observedArtifacts.filter((p) => p.file === file);
      need(a.length === 1, "One exact observed artifact");
      return a[0]!;
    };
    const metadata = new Map<
      string,
      z.infer<
        typeof dotnetGeneratorIdentitySchema
      >["metadata"][number]["native"] & { mode: "metadata" }
    >();
    need(
      identity.metadata.length === projects.length &&
        identity.discovery.length === testProjects.length,
      "Every declared module and test project has native identity",
    );
    for (const [captures, selected, mode] of [
      [identity.metadata, projects, "metadata"],
      [identity.discovery, testProjects, "discovery"],
    ] as const) {
      for (let index = 0; index < selected.length; index++) {
        const project = selected[index]!,
          capture = captures[index]!,
          n = capture.native,
          base = path.join(
            build.workspace,
            path.dirname(project.file),
            "bin/Debug/net10.0",
          ),
          assembly = path.join(base, project.assemblyName + ".dll"),
          pdb = path.join(base, project.assemblyName + ".pdb"),
          r = receipts.find(
            (r) => r.phase === `generator-identity-${mode}:${project.file}`,
          )!;
        need(
          n.mode === mode &&
            n.processId === capture.launcherPid &&
            n.workingDirectory === build.workspace &&
            isDeepStrictEqual(n.arguments, [mode, assembly, pdb]) &&
            isDeepStrictEqual(n, JSON.parse(capture.stdout)) &&
            r.stdoutBytes === Buffer.byteLength(capture.stdout) &&
            r.stdoutSha256 === mavenHash(capture.stdout) &&
            r.stderrBytes === 0 &&
            r.stderrSha256 === mavenHash(""),
          "Native identity process, arguments and exact raw capture",
        );
        need(
          n.helper.file === helper &&
            n.helper.sha256 === identity.observerSha256 &&
            n.framework.file === framework &&
            n.framework.sha256 === frameworkPin.sha256 &&
            n.framework.bytes === frameworkPin.bytes &&
            n.assembly.file === assembly &&
            isDeepStrictEqual(n.assembly, artifact(assembly)) &&
            n.pdb.file === pdb &&
            isDeepStrictEqual(n.pdb, artifact(pdb)),
          "Native helper, framework, assembly and PDB artifact identity",
        );
        need(
          same(
            n.modules.map((m) => m.artifact.file),
            n.modules.map((m) => m.artifact.file),
          ) &&
            n.modules.some(
              (m) =>
                m.artifact.file === helper &&
                m.artifact.sha256 === identity.observerSha256,
            ) &&
            n.modules.some(
              (m) =>
                m.artifact.file === framework &&
                m.artifact.sha256 === frameworkPin.sha256,
            ),
          "Unique native loaded helper and framework modules",
        );
        for (const m of n.modules) {
          if (m.artifact.file === helper)
            need(
              m.artifact.sha256 === identity.observerSha256,
              "Loaded original helper bytes",
            );
          else if (m.artifact.file === framework)
            need(
              m.artifact.sha256 === frameworkPin.sha256 &&
                m.artifact.bytes === frameworkPin.bytes,
              "Loaded original framework bytes",
            );
          else if (m.artifact.file.startsWith(sdkRoot + path.sep)) {
            const p = fsharpSdkPins.find(
              (p) => path.join(sdkRoot, p.file) === m.artifact.file,
            );
            need(
              p &&
                p.bytes === m.artifact.bytes &&
                p.sha256 === m.artifact.sha256,
              "Loaded selected SDK/runtime module bytes",
            );
          } else
            need(
              isDeepStrictEqual(m.artifact, artifact(m.artifact.file)) &&
                m.artifact.file.startsWith(build.workspace + path.sep),
              "Loaded source/dependency module in the fresh workspace",
            );
        }
        if (n.mode === "metadata") {
          const legacy = build.modules.find(
            (m) => m.file === project.file,
          )?.metadata;
          need(
            legacy &&
              n.observation.assemblyName === project.assemblyName &&
              isDeepStrictEqual(n.observation.documents, legacy.documents),
            "Native assembly and complete portable source document cohort",
          );
          need(
            same(
              n.observation.types.map((t) => String(t.token)),
              n.observation.types.map((t) => String(t.token)),
            ) &&
              same(
                n.observation.types.flatMap((t) =>
                  t.methods.map((m) => String(m.token)),
                ),
                n.observation.types.flatMap((t) =>
                  t.methods.map((m) => String(m.token)),
                ),
              ),
            "Unique PE type and method tokens",
          );
          metadata.set(project.file, n);
        }
      }
    }
    need(
      new Set([...metadata.values()].map((n) => n.observation.mvid)).size ===
        projects.length,
      "Distinct complete module identities",
    );
    const compilerParameters = (
      project: (typeof projects)[number],
      name: string,
    ) => {
      const compiler = build.events.filter(
        (e) =>
          e.type === "compilerStarted" &&
          e.file === path.join(build.workspace, project.file),
      );
      need(
        compiler.length === 1,
        "One native compiler for each declared project",
      );
      const rows = build.events.filter(
        (e) =>
          e.type === "parameter" &&
          e.name === name &&
          isDeepStrictEqual(e.context, compiler[0]!.context),
      );
      need(rows.length === 1, "One complete native compiler parameter cohort");
      return z
        .array(z.string())
        .parse(rows[0]!.values)
        .map((f) =>
          path.resolve(
            build.workspace,
            path.dirname(project.file),
            f.replaceAll("\\", "/"),
          ),
        );
    };
    const observedEdges: string[] = [];
    for (const consumer of projects)
      for (const [parameter, kind] of [
        ["References", "assembly"],
        ["Analyzers", "analyzer"],
      ] as const) {
        if (parameter === "Analyzers" && consumer.language === "fsharp")
          continue;
        const paths = compilerParameters(consumer, parameter);
        for (const producer of projects) {
          const base = path.join(build.workspace, path.dirname(producer.file)),
            candidate = paths.filter((f) =>
              [
                path.join(
                  base,
                  "obj/Debug/net10.0/ref",
                  producer.assemblyName + ".dll",
                ),
                path.join(
                  base,
                  "bin/Debug/net10.0",
                  producer.assemblyName + ".dll",
                ),
              ].includes(f),
            );
          if (candidate.length) {
            need(
              candidate.length === 1 && producer.file !== consumer.file,
              "One source producer artifact per native edge",
            );
            artifact(candidate[0]!);
            observedEdges.push(
              JSON.stringify({
                consumer: consumer.file,
                producer: producer.file,
                kind,
              }),
            );
          }
        }
      }
    need(
      same(
        observedEdges,
        config.projectReferences.map((r) => JSON.stringify(r)),
      ),
      "Complete exact native producer/consumer reference graph",
    );
    for (const g of config.incrementalGenerators) {
      const module = build.modules.find((m) => m.file === g.project),
        types = module?.metadata?.types.filter(
          (t) => t.className === g.className,
        );
      need(
        types?.length === 1 &&
          types[0]!.interfaces.includes(
            "Microsoft.CodeAnalysis.IIncrementalGenerator",
          ) &&
          types[0]!.methods.some((m) => m.name === "Initialize") &&
          build.generatedSources.some(
            (s) =>
              s.generatorProject === g.project &&
              s.generatorClass === g.className,
          ),
        "Declared compiled incremental generator participates in actual native outputs",
      );
    }
    const caseBindings = new Map<
      string,
      ReadonlyMap<
        string,
        {
          file: string;
          fixtureType: string;
          declaringType: string;
          methodName: string;
        }
      >
    >();
    for (let index = 0; index < testProjects.length; index++) {
      const project = testProjects[index]!,
        n = identity.discovery[index]!.native;
      need(n.mode === "discovery", "Exact native method discovery");
      const cases = n.observation.cases;
      need(
        n.observation.count === cases.length &&
          n.observation.nodeCount >= cases.length &&
          same(
            cases.map((c) => c.id),
            cases.map((c) => c.id),
          ) &&
          same(
            cases.map((c) => c.fullName),
            cases.map((c) => c.fullName),
          ),
        "Every native method case occurs exactly once",
      );
      const files = new Map<
        string,
        {
          file: string;
          fixtureType: string;
          declaringType: string;
          methodName: string;
        }
      >();
      for (const c of cases) {
        const fixture = metadata.get(project.file)!;
        need(
          c.fixtureAssembly === fixture.assembly.file &&
            c.fixtureMvid === fixture.observation.mvid &&
            c.className === c.declaringType &&
            c.baseChain[0]?.className === c.fixtureType &&
            c.baseChain[0]?.token === c.fixtureToken &&
            c.baseChain[0]?.mvid === c.fixtureMvid &&
            c.baseChain[0]?.assembly === c.fixtureAssembly,
          "Exact receiver fixture and inheritance root",
        );
        const receiver = fixture.observation.types.find(
            (t) => t.token === c.fixtureToken,
          ),
          role = project.testClasses.find((t) => t.className === c.fixtureType);
        need(
          receiver?.className === c.fixtureType &&
            role &&
            receiver.methods.some((m) =>
              m.files.includes(path.join(build.workspace, role.file)),
            ),
          "Declared source-bound receiver class",
        );
        need(
          new Set(c.baseChain.map((b) => b.mvid + "/" + b.token)).size ===
            c.baseChain.length,
          "Unique complete native base chain",
        );
        for (let i = 0; i < c.baseChain.length; i++) {
          const b = c.baseChain[i]!,
            module = [...metadata.values()].find(
              (m) => m.observation.mvid === b.mvid,
            ),
            t = module?.observation.types.find((t) => t.token === b.token),
            loaded = n.modules.find((m) => m.artifact.file === b.assembly);
          need(
            module &&
              t?.className === b.className &&
              loaded?.mvid === b.mvid &&
              loaded.artifact.sha256 === module.assembly.sha256 &&
              loaded.artifact.bytes === module.assembly.bytes,
            "Every native base class is a fresh declared compiled type",
          );
          const next = c.baseChain[i + 1];
          if (next) {
            const parent = [...metadata.values()].find(
              (m) => m.observation.mvid === next.mvid,
            );
            need(
              parent &&
                t.baseTypeClass === next.className &&
                t.baseTypeAssembly === parent.observation.assemblyName,
              "Native receiver ancestry agrees with the PE base definition",
            );
          } else
            need(
              t.baseTypeClass === "System.Object",
              "Complete declared ancestry terminates at System.Object",
            );
        }
        const owners = [...metadata.entries()].filter(
          ([, m]) => m.observation.mvid === c.methodMvid,
        );
        need(owners.length === 1, "Unique compiled declaring module");
        const [ownerFile, owner] = owners[0]!,
          type = owner.observation.types.find(
            (t) => t.className === c.declaringType,
          ),
          method = type?.methods.find((m) => m.token === c.methodToken),
          loaded = n.modules.find((m) => m.artifact.file === c.methodAssembly);
        need(
          method &&
            method.name === c.methodName &&
            method.parameterCount === c.parameterTypes.length &&
            c.arguments.length === method.parameterCount &&
            method.signature === c.methodSignature &&
            isDeepStrictEqual(
              method.parameterSignatures,
              c.parameterSignatures,
            ) &&
            method.returnSignature === c.returnSignature &&
            method.genericParameters === c.genericArguments.length &&
            loaded?.mvid === c.methodMvid &&
            loaded.artifact.sha256 === owner.assembly.sha256 &&
            loaded.artifact.bytes === owner.assembly.bytes &&
            path.basename(c.methodAssembly) ===
              path.basename(owner.assembly.file),
          "Native overload token, signature arity and fresh declaring assembly bytes",
        );
        const legacyType = build.modules
          .find((m) => m.file === ownerFile)!
          .metadata!.types.find((t) => t.className === c.declaringType);
        const sourceAgrees =
          legacyType?.methods.some(
            (m) => m.name === method.name && same(m.files, method.files),
          ) &&
          method.points.every(
            (p) => p.file === null || method.files.includes(p.file),
          );
        need(
          sourceAgrees,
          "Selected method source agrees with the independent build metadata capture",
        );
        need(
          c.baseChain.some(
            (b) =>
              b.className === c.declaringType &&
              b.mvid === c.methodMvid &&
              b.token === type!.token &&
              b.assembly === c.methodAssembly,
          ),
          "Inherited method belongs to the receiver's native base chain",
        );
        const p = projects.find((p) => p.file === ownerFile)!;
        const source = method.files.filter((f) =>
          [
            ...p.sources,
            ...p.generatedSources,
            ...p.roslynGeneratedSources.map((s) => s.file),
          ].some((s) => path.join(build.workspace, s) === f),
        );
        need(
          source.length === 1 &&
            method.files.length === 1 &&
            method.points.some((p) => !p.hidden),
          "Unique physical source document for the actual compiled test method",
        );
        files.set(c.fullName, {
          file: path
            .relative(build.workspace, source[0]!)
            .split(path.sep)
            .join("/"),
          fixtureType: c.fixtureType,
          declaringType: c.declaringType,
          methodName: c.methodName,
        });
      }
      caseBindings.set(project.file, files);
    }
    const ordinary = dotnetTestPacketSchema.parse(
      Object.fromEntries(
        Object.entries(data).filter(([key]) => key !== "generatorIdentity"),
      ),
    );
    return dotnetTestEvidence(
      check,
      [{ ...process, stdout: JSON.stringify(ordinary) }],
      { caseBindings, additionalNativePhases: phases },
    );
  } catch {
    return incomplete;
  }
}
