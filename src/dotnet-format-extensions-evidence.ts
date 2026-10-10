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
  dotnetFormatExtensionsConfigSchema,
  dotnetFormatterRequire as need,
  validateDotnetFormattingRules,
} from "./dotnet-format-extensions.js";
import {
  dotnetFormatExtensionsPacketSchema,
  dotnetFormatExtensionsNativeSchema,
  dotnetFormatExtensionsRuntimeConfig,
  dotnetFormatExtensionsConstructorParameters,
  dotnetFormattingCompileArguments,
  dotnetFormattingCompileWarning,
} from "./dotnet-format-extensions-contract.js";
import { dotnetFormatExtensionsNativeSource } from "./dotnet-format-extensions-native.js";
import {
  dotnetFormatterSdkPins,
  dotnetFormatterRuleCatalogue,
} from "./dotnet-formatter-pins.js";
import { fsharpSdkPins } from "./fsharp-format-pins.js";
import { mavenHash } from "./maven.js";
import { parseCapturedProcessOutput } from "./process-output.js";
import type { Check, CheckResult, Finding, ProcessResult } from "./types.js";
type Pin = { file: string; bytes: number; sha256: string };
const formatterPins: ReadonlyArray<Pin> = dotnetFormatterSdkPins;
const runtimePins: ReadonlyArray<Pin> = fsharpSdkPins;
const same = (a: string[], b: string[]) =>
  new Set(a).size === a.length &&
  new Set(b).size === b.length &&
  isDeepStrictEqual([...a].sort(), [...b].sort());
function bytes(file: string, bound: number, hash?: string, size?: number) {
  need(
    path.isAbsolute(file) && realpathSync(file) === file,
    "Canonical evidence file",
  );
  const stat = lstatSync(file);
  need(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= bound,
    "Bounded regular evidence file",
  );
  const result = readFileSync(file);
  need(
    result.length <= bound &&
      (size === undefined || result.length === size) &&
      (hash === undefined || mavenHash(result) === hash),
    "Current physical evidence bytes",
  );
  return result;
}
function walk(root: string, directory: string) {
  const files: string[] = [];
  let entries = 0;
  const visit = (relative: string) => {
    const file = path.join(root, relative),
      stat = lstatSync(file);
    need(
      !stat.isSymbolicLink() &&
        realpathSync(file) === file &&
        ++entries <= 4096,
      "Bounded canonical selected directory",
    );
    if (stat.isDirectory())
      for (const name of readdirSync(file))
        visit(path.posix.join(relative, name));
    else {
      need(stat.isFile(), "Regular selected component");
      files.push(relative);
    }
  };
  visit(directory);
  return files.sort();
}
function currentSdk(root: string) {
  need(realpathSync(root) === root, "Current SDK root");
  for (const pin of [...runtimePins, ...formatterPins])
    bytes(path.join(root, pin.file), 64 * 1024 * 1024, pin.sha256, pin.bytes);
  for (const directory of [
    "sdk/10.0.401/DotnetTools/dotnet-format",
    "sdk/10.0.401/Sdks/Microsoft.NET.Sdk/analyzers",
    "packs/Microsoft.NETCore.App.Ref/10.0.12/analyzers",
  ])
    need(
      same(
        walk(root, directory),
        formatterPins
          .filter((p) => p.file.startsWith(directory + "/"))
          .map((p) => p.file),
      ),
      "Exact selected SDK formatting component inventory",
    );
  const sdk = "sdk/10.0.401";
  need(
    same(
      readdirSync(path.join(root, sdk)).filter((f) =>
        /\.(?:dll|json|config)$/.test(f),
      ),
      formatterPins
        .filter((p) => path.posix.dirname(p.file) === sdk)
        .map((p) => path.posix.basename(p.file)),
    ),
    "Exact selected SDK root files",
  );
  const groups = new Map<string, string[]>();
  for (const pin of runtimePins)
    if (pin.file !== "dotnet") {
      const group = path.posix.dirname(pin.file);
      groups.set(group, [
        ...(groups.get(group) ?? []),
        path.posix.basename(pin.file),
      ]);
    }
  for (const [directory, files] of groups)
    need(
      same(
        readdirSync(path.join(root, directory)).filter((f) =>
          /\.(?:dll|so|json)$/.test(f),
        ),
        files,
      ),
      "Exact selected SDK runtime/reference/compiler file inventory",
    );
}
function position(text: string, offset: number) {
  need(offset >= 0 && offset <= text.length, "UTF-16 native source span");
  let line = 1,
    start = 0;
  for (const match of text.matchAll(/\r\n|[\r\n\u0085\u2028\u2029]/g)) {
    const next = match.index + match[0].length;
    if (next > offset) break;
    line++;
    start = next;
  }
  return { line, column: offset - start + 1 };
}
function offset(text: string, line: number, column: number) {
  const breaks = [...text.matchAll(/\r\n|[\r\n\u0085\u2028\u2029]/g)];
  need(
    line > 0 && line <= breaks.length + 1 && column > 0,
    "Native mapping source line",
  );
  const start =
      line === 1 ? 0 : breaks[line - 2]!.index + breaks[line - 2]![0].length,
    end =
      line <= breaks.length
        ? breaks[line - 1]!.index + breaks[line - 1]![0].length
        : text.length;
  need(start + column - 1 <= end, "Native mapping source column");
  return start + column - 1;
}
export function dotnetFormatExtensionsEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    findingsComplete: false,
    reason:
      "SDK formatting evidence lacks complete current compiler, policy, native diagnostic, edit or generated-document bindings.",
  };
  if (!root || processes.length !== 1) return incomplete;
  const result = processes[0]!;
  if (
    result.signal ||
    result.errorCode ||
    result.timedOut ||
    result.cancelled ||
    result.truncated
  )
    return incomplete;
  if (result.exitCode !== 0) return dotnetBuildEvidence(check, processes);
  try {
    const raw = JSON.parse(result.stdout);
    if (raw.prerequisiteFailure || raw.generatedScopeFailure)
      return dotnetBuildEvidence(check, processes);
    const packet = dotnetFormatExtensionsPacketSchema.parse(raw),
      build = packet.build,
      mappedNative = packet.extensions
        ? dotnetFormatExtensionsNativeSchema.parse(
            JSON.parse(packet.extensions.phases[1]!.stdout),
          )
        : undefined,
      nativeMappedDocuments = new Map(
        build.modules.map(
          (module) =>
            [
              module.file,
              new Set(
                (mappedNative?.phases[0]?.documents ?? [])
                  .filter(
                    (doc) =>
                      doc.project === path.join(build.workspace, module.file),
                  )
                  .flatMap((doc) =>
                    doc.lineMappings.flatMap((mapping) =>
                      mapping.pdbFile ? [mapping.pdbFile] : [],
                    ),
                  ),
              ),
            ] as const,
        ),
      ),
      built = dotnetBuildEvidence(
        check,
        [{ ...result, stdout: JSON.stringify(build) }],
        new Map(
          formatterPins
            .filter(
              (p) =>
                p.file.startsWith(
                  "sdk/10.0.401/Sdks/Microsoft.NET.Sdk/analyzers/build/config/",
                ) && p.file.endsWith(".globalconfig"),
            )
            .map((p) => [
              path.join(path.resolve(build.sdk, "../.."), p.file),
              p,
            ]),
        ),
        nativeMappedDocuments,
      );
    if (build.buildExitCode !== 0) {
      const invocation = dotnetBuildInvocationSchema.parse(
        JSON.parse(check.commands[0]!.args[2]!),
      );
      need(realpathSync(root) === root, "Current failed compilation root");
      for (const pin of invocation.inputs) {
        const file = path.resolve(root, check.project, pin.path);
        need(
          file.startsWith(root + path.sep),
          "Current failed compilation source boundary",
        );
        bytes(file, 4 * 1024 * 1024, pin.sha256);
      }
      const repositoryRoot = path.join(
          root,
          check.project,
          invocation.config.repository,
        ),
        manifest = bytes(
          path.join(root, check.project, invocation.config.repositoryManifest),
          1024 * 1024,
          invocation.config.repositorySha256,
        ),
        repository = dotnetBuildRepositorySchema.parse(
          JSON.parse(manifest.toString("utf8")),
        );
      need(
        manifest.toString("utf8") === build.repositoryManifest &&
          same(
            walk(repositoryRoot, "."),
            repository.files.map((p) => p.path),
          ),
        "Current failed compilation dependency closure",
      );
      for (const pin of repository.files)
        bytes(
          path.join(repositoryRoot, pin.path),
          32 * 1024 * 1024,
          pin.sha256,
          pin.bytes,
        );
      currentSdk(path.resolve(build.sdk, "../.."));
      return built;
    }
    if (built.status !== "passed") return built;
    need(packet.extensions, "Native formatting phase reached");
    const f = packet.extensions,
      invocation = dotnetBuildInvocationSchema.parse(
        JSON.parse(check.commands[0]!.args[2]!),
      ),
      config = dotnetFormatExtensionsConfigSchema.parse(
        JSON.parse(check.commands[0]!.args[4]!),
      );
    validateDotnetFormattingRules(
      config,
      invocation.config.projects.map((p) => p.language),
    );
    need(
      check.commands[0]!.args[3] === "--format-extensions" &&
        check.commands[0]!.args.length === 5 &&
        realpathSync(root) === root &&
        f.sdkRoot === path.resolve(build.sdk, "../..") &&
        build.sdk === path.join(f.sdkRoot, "sdk/10.0.401") &&
        path.isAbsolute(f.temporary) &&
        build.workspace === path.join(f.temporary, "workspace") &&
        f.observerDirectory ===
          path.join(f.temporary, "observer/format-extensions") &&
        f.sdkPinsSha256 === mavenHash(JSON.stringify(dotnetFormatterSdkPins)),
      "Selected native formatting invocation and roots",
    );
    const inputPins = new Map(invocation.inputs.map((p) => [p.path, p.sha256]));
    need(
      inputPins.size === invocation.inputs.length &&
        inputPins.has("checktrail.dotnet-format.json"),
      "Unique complete current inputs",
    );
    for (const pin of invocation.inputs) {
      const file = path.resolve(root, check.project, pin.path);
      need(
        file.startsWith(root + path.sep),
        "Current repository input boundary",
      );
      bytes(file, 4 * 1024 * 1024, pin.sha256);
    }
    const policyBytes = bytes(
      path.resolve(root, check.project, "checktrail.dotnet-format.json"),
      65536,
      inputPins.get("checktrail.dotnet-format.json"),
    );
    need(
      f.policySha256 === mavenHash(policyBytes) &&
        isDeepStrictEqual(
          config,
          dotnetFormatExtensionsConfigSchema.parse(
            JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(policyBytes),
            ),
          ),
        ),
      "Current formatting policy identity",
    );
    const repositoryRoot = path.join(
        root,
        check.project,
        invocation.config.repository,
      ),
      repositoryBytes = bytes(
        path.join(root, check.project, invocation.config.repositoryManifest),
        1024 * 1024,
        invocation.config.repositorySha256,
      ),
      repository = dotnetBuildRepositorySchema.parse(
        JSON.parse(repositoryBytes.toString("utf8")),
      ),
      nativeRepository = path.join(f.temporary, "repository");
    need(
      repositoryBytes.toString("utf8") === build.repositoryManifest &&
        same(
          walk(repositoryRoot, "."),
          repository.files.map((p) => p.path),
        ),
      "Current complete dependency closure",
    );
    for (const pin of repository.files)
      bytes(
        path.join(repositoryRoot, pin.path),
        32 * 1024 * 1024,
        pin.sha256,
        pin.bytes,
      );
    currentSdk(f.sdkRoot);
    const helper = path.join(
        f.observerDirectory,
        "ChecktrailFormattingExtensions.dll",
      ),
      requestFile = path.join(f.observerDirectory, "request.json"),
      markerFile = path.join(f.observerDirectory, "body-entered.json"),
      firstFile = path.join(f.observerDirectory, "first-document.json"),
      completedFile = path.join(f.observerDirectory, "completed.json"),
      sourceNames = build.compiledSources.map((p) => p.file).sort(),
      selectedSources = invocation.config.projects
        .flatMap((p) => [
          ...p.sources,
          ...p.generatedSources,
          ...p.roslynGeneratedSources.map((g) => g.file),
        ])
        .map((file) => path.join(build.workspace, file))
        .sort();
    need(
      new Set(sourceNames).size === sourceNames.length &&
        f.helperSourceSha256 ===
          mavenHash(dotnetFormatExtensionsNativeSource) &&
        f.runtimeConfigSha256 ===
          mavenHash(dotnetFormatExtensionsRuntimeConfig) &&
        f.requestFileSha256 ===
          mavenHash(
            JSON.stringify({
              solution: path.join(build.workspace, invocation.config.solution),
              repository: nativeRepository,
              sources: selectedSources,
              styleDiagnostics: config.styleDiagnostics,
              analyzerDiagnostics: config.analyzerDiagnostics,
              severity: { info: "Info", warn: "Warning", error: "Error" }[
                config.severity
              ],
            }),
          ),
      "Original native helper/request/runtime inputs",
    );
    const compile = f.phases[0]!,
      formatted = f.phases[1]!;
    const references = runtimePins
      .filter(
        (p) =>
          p.file.startsWith(
            "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/",
          ) && p.file.endsWith(".dll"),
      )
      .map((p) => path.join(f.sdkRoot, p.file))
      .sort();
    need(
      compile.phase === "compile-formatting-observer" &&
        compile.tool === path.join(f.sdkRoot, "dotnet") &&
        compile.cwd === f.observerDirectory &&
        isDeepStrictEqual(
          compile.args,
          dotnetFormattingCompileArguments(
            build.sdk,
            f.observerDirectory,
            references,
          ),
        ) &&
        compile.stdout === dotnetFormattingCompileWarning &&
        !compile.stderr &&
        formatted.phase === "formatting-documents" &&
        formatted.tool === compile.tool &&
        formatted.cwd === build.workspace &&
        isDeepStrictEqual(formatted.args, [
          "exec",
          helper,
          build.sdk,
          requestFile,
          markerFile,
          firstFile,
          completedFile,
        ]) &&
        !formatted.stderr,
      "Exact native compile/format call closure",
    );
    let nativeBytes = 0;
    for (const phase of f.phases) {
      const capture = parseCapturedProcessOutput(phase.capturedOutput);
      need(
        capture.completeForObservedStreams &&
          capture.stdout.bytes === phase.stdoutBytes &&
          capture.stderr.bytes === phase.stderrBytes &&
          capture.stdout.sha256 === phase.stdoutSha256 &&
          capture.stderr.sha256 === phase.stderrSha256 &&
          Buffer.from(capture.stdout.base64, "base64").toString("utf8") ===
            phase.stdout &&
          Buffer.from(capture.stderr.base64, "base64").toString("utf8") ===
            phase.stderr,
        "Complete physical native formatting streams",
      );
      nativeBytes += capture.observedBytes;
    }
    need(
      f.mirroredBytes === nativeBytes &&
        Buffer.byteLength(result.stderr) === nativeBytes &&
        f.mirroredSha256 === mavenHash(result.stderr) &&
        result.stderr === compile.stdout + formatted.stdout,
      "Exact ordered native raw-stream mirror",
    );
    const native = dotnetFormatExtensionsNativeSchema.parse(
      JSON.parse(formatted.stdout),
    );
    need(
      native.processId === formatted.pid &&
        native.helperSha256 === f.helperSha256 &&
        f.marker.processId === formatted.pid &&
        f.marker.runtime === native.runtime &&
        f.firstDocument.processId === formatted.pid &&
        native.formatterAssembly ===
          path.join(build.sdk, "DotnetTools/dotnet-format/dotnet-format.dll") &&
        native.formatterSha256 ===
          formatterPins.find(
            (p) => path.join(f.sdkRoot, p.file) === native.formatterAssembly,
          )!.sha256 &&
        isDeepStrictEqual(
          native.constructorParameters,
          dotnetFormatExtensionsConstructorParameters,
        ) &&
        !native.workspaceFailures.length &&
        isDeepStrictEqual(
          native.phases.map((p) => p.mode),
          ["Whitespace", "CodeStyle", "Analyzers"],
        ),
      "Actual observer/native process and selected ABI",
    );
    need(
      f.completed.processId === native.processId &&
        f.completed.helperSha256 === native.helperSha256 &&
        f.completed.observationSha256 === mavenHash(formatted.stdout) &&
        f.completed.allDocuments === native.allDocuments &&
        isDeepStrictEqual(
          f.completed.phases,
          native.phases.map((p) => ({
            mode: p.mode,
            documents: p.documents.length,
            diagnostics: p.diagnostics.length,
            reportRows: p.sdkReport.length,
            changedDocuments: p.documents.filter((d) => d.changed).length,
          })),
        ),
      "Separately captured native observation completion and full phase accounting",
    );
    const sdkPins = new Map(
        [...runtimePins, ...formatterPins].map((p) => [
          path.join(f.sdkRoot, p.file),
          p,
        ]),
      ),
      artifactPins = new Map(build.observedArtifacts.map((p) => [p.file, p])),
      projectOutputs = build.modules.map((p) => p.assembly);
    need(
      new Set(native.loaded.map((p) => p.file)).size === native.loaded.length &&
        [
          "System.Private.CoreLib",
          "System.Runtime",
          "System.Text.Json",
          "Microsoft.CodeAnalysis",
          "dotnet-format",
        ].every((name) => native.loaded.some((p) => p.name === name)),
      "Complete selected native module receipt",
    );
    for (const module of native.loaded) {
      if (module.file === helper)
        need(module.sha256 === f.helperSha256, "Original observer module");
      else if (sdkPins.has(module.file))
        need(
          module.sha256 === sdkPins.get(module.file)!.sha256 &&
            artifactPins.get(module.file)?.sha256 === module.sha256,
          "Selected loaded SDK bytes",
        );
      else if (module.file.startsWith(nativeRepository + path.sep)) {
        const pin = repository.files.find(
          (p) => path.join(nativeRepository, p.path) === module.file,
        );
        need(
          pin &&
            pin.sha256 === module.sha256 &&
            artifactPins.get(module.file)?.sha256 === module.sha256,
          "Declared loaded dependency bytes",
        );
      } else
        need(
          projectOutputs.includes(module.file) &&
            artifactPins.get(module.file)?.sha256 === module.sha256,
          "Declared fresh producer module bytes",
        );
    }
    const findings: Finding[] = [...(built.findings ?? [])];
    let defects = 0;
    const identities = new Map<string, unknown>(),
      projectIds = new Map<string, string>();
    const first = native.phases[0]!.documents.find((d) => d.selected)!;
    need(
      first &&
        new Set(selectedSources).size === selectedSources.length &&
        selectedSources.every((file) => sourceNames.includes(file)),
      "Complete declared formatting scope",
    );
    need(
      f.firstDocument.file === first.file &&
        f.firstDocument.sourceSha256 === first.sourceSha256 &&
        f.firstDocument.beforeSha256 === first.beforeSha256,
      "Reached first native formatting document",
    );
    for (const phase of native.phases) {
      need(
        phase.documents.length === native.allDocuments &&
          !phase.analyzerExceptions.length &&
          phase.nativeDiagnosticsInvoked === (phase.mode !== "Whitespace") &&
          new Set(phase.documents.map((d) => d.documentId)).size ===
            phase.documents.length,
        "Complete unique native document and analyzer participation",
      );
      const docs = new Map(phase.documents.map((d) => [d.documentId, d]));
      need(
        same([...new Set(phase.documents.map((d) => d.file))], sourceNames),
        "Every compiled source reached native formatting",
      );
      for (const project of invocation.config.projects) {
        const file = path.join(build.workspace, project.file),
          documents = phase.documents.filter((d) => d.project === file),
          start = build.events.find(
            (e) => e.type === "compilerStarted" && e.file === file,
          ),
          parameters = build.events.filter(
            (e) =>
              e.type === "parameter" &&
              e.name === "Sources" &&
              isDeepStrictEqual(e.context, start?.context),
          );
        need(
          start && parameters.length === 1 && documents.length > 0,
          "Native compiler project source context",
        );
        const ordinary = z
            .array(z.string())
            .parse(parameters[0]!.values)
            .map((f) =>
              path.resolve(path.dirname(file), f.replaceAll("\\", "/")),
            ),
          generated = project.roslynGeneratedSources.map((g) =>
            path.join(build.workspace, g.file),
          );
        need(
          same(
            documents.filter((d) => !d.sourceGenerated).map((d) => d.file),
            ordinary,
          ) &&
            same(
              documents.filter((d) => d.sourceGenerated).map((d) => d.file),
              generated,
            ) &&
            documents.every(
              (d) =>
                d.language ===
                  (project.language === "csharp" ? "C#" : "Visual Basic") &&
                d.projectId === documents[0]!.projectId,
            ),
          "Every ordinary and declared generated project document",
        );
        const previous = projectIds.get(file);
        need(
          !previous || previous === documents[0]!.projectId,
          "Stable native project identity",
        );
        projectIds.set(file, documents[0]!.projectId);
      }
      need(
        new Set(projectIds.values()).size ===
          invocation.config.projects.length &&
          phase.documents.every((d) => projectIds.has(d.project)),
        "No foreign native project",
      );
      for (const doc of phase.documents) {
        const pin = build.compiledSources.find((p) => p.file === doc.file);
        need(
          pin &&
            pin.bytes === doc.sourceBytes &&
            pin.sha256 === doc.sourceSha256 &&
            doc.selected === selectedSources.includes(doc.file) &&
            (doc.selected || !doc.changed) &&
            mavenHash(doc.before) === doc.beforeSha256 &&
            mavenHash(doc.after) === doc.afterSha256 &&
            Buffer.byteLength(doc.before) + (doc.utf8Bom ? 3 : 0) ===
              pin.bytes &&
            mavenHash(
              Buffer.concat([
                doc.utf8Bom ? Buffer.from([239, 187, 191]) : Buffer.alloc(0),
                Buffer.from(doc.before),
              ]),
            ) === pin.sha256 &&
            doc.changed === (doc.before !== doc.after) &&
            doc.changed === doc.changes.length > 0,
          "Native UTF-8/BOM bytes and independent proposed text",
        );
        if (doc.file.startsWith(nativeRepository + path.sep)) {
          const pin = repository.files.find(
            (p) => path.join(nativeRepository, p.path) === doc.file,
          );
          need(
            pin && pin.sha256 === doc.sourceSha256,
            "Current pinned dependency compiler source",
          );
        } else {
          need(
            doc.file.startsWith(build.workspace + path.sep),
            "Fresh physical native source boundary",
          );
          const input = inputPins.get(
            path.relative(build.workspace, doc.file).replaceAll(path.sep, "/"),
          );
          if (input)
            need(
              input === doc.sourceSha256,
              "Current original compiler source",
            );
        }
        let mappingEnd = 0;
        for (const mapping of doc.lineMappings) {
          const start = offset(
              doc.before,
              mapping.span.startLine,
              mapping.span.startColumn,
            ),
            end = offset(
              doc.before,
              mapping.span.endLine,
              mapping.span.endColumn,
            );
          need(
            start >= mappingEnd &&
              end >= start &&
              mapping.mappedValid === (mapping.mapped !== null) &&
              (!mapping.hasMappedPath || mapping.mappedValid) &&
              mapping.pdbFile ===
                (mapping.hasMappedPath
                  ? path.resolve(
                      path.dirname(doc.project),
                      mapping.mapped!.file,
                    )
                  : null) &&
              (mapping.hasMappedPath ||
                mapping.mapped === null ||
                mapping.mapped.file === ""),
            "Ordered physical source mapping spans and native virtual symbol path",
          );
          mappingEnd = end;
        }
        const identity = {
          project: doc.project,
          projectId: doc.projectId,
          language: doc.language,
          file: doc.file,
          documentId: doc.documentId,
          sourceGenerated: doc.sourceGenerated,
          sourceBytes: doc.sourceBytes,
          sourceSha256: doc.sourceSha256,
          before: doc.before,
          beforeSha256: doc.beforeSha256,
          utf8Bom: doc.utf8Bom,
          lineMappings: doc.lineMappings,
        };
        if (phase.mode === "Whitespace")
          identities.set(doc.documentId, identity);
        else
          need(
            isDeepStrictEqual(identities.get(doc.documentId), identity),
            "Stable independent phase inputs",
          );
        need(
          doc.route ===
            (doc.sourceGenerated
              ? phase.mode === "Whitespace"
                ? "native-generated-whitespace"
                : "native-generated-diagnostics"
              : "sdk-pipeline") &&
            (!doc.sourceGenerated ||
              phase.mode === "Whitespace" ||
              !doc.changed),
          "Explicit generated formatting route and unsupported semantic edit boundary",
        );
        let after = "",
          cursor = 0;
        for (const edit of doc.changes) {
          need(
            edit.start >= cursor &&
              edit.start + edit.length <= doc.before.length &&
              isDeepStrictEqual(position(doc.before, edit.start), {
                line: edit.line,
                column: edit.column,
              }),
            "Ordered UTF-16 native edit and physical address",
          );
          after += doc.before.slice(cursor, edit.start) + edit.newText;
          cursor = edit.start + edit.length;
        }
        after += doc.before.slice(cursor);
        need(
          after === doc.after,
          "Native edits reconstruct the exact proposed result",
        );
        if (doc.changed) {
          defects++;
          findings.push({
            ruleId: `dotnet-format-extensions/${phase.mode}`,
            level: "error",
            message: "The native formatter proposes a source edit",
            ...location(doc.file, doc.changes[0]!.line),
          });
        }
      }
      const wanted =
        phase.mode === "CodeStyle"
          ? config.styleDiagnostics
          : config.analyzerDiagnostics;
      if (phase.mode === "Whitespace")
        need(
          !phase.catalog.length && !phase.diagnostics.length,
          "Whitespace native diagnostic category",
        );
      else {
        need(
          same(
            phase.catalog.map((p) => p.project),
            invocation.config.projects.map((p) =>
              path.join(build.workspace, p.file),
            ),
          ),
          "Complete native analyzer catalogue project cohort",
        );
        for (const catalog of phase.catalog) {
          need(
            catalog.projectId === projectIds.get(catalog.project) &&
              new Set(catalog.supported).size === catalog.supported.length &&
              dotnetFormatterRuleCatalogue[phase.mode][catalog.language].every(
                (id) => catalog.supported.includes(id),
              ) &&
              catalog.selectedAnalyzers.every((an) =>
                native.loaded.some((m) => m.file === an.assembly),
              ),
            "Selected native analyzer compatibility and loaded modules",
          );
        }
      }
      for (const diagnostic of phase.diagnostics) {
        need(
          wanted.includes(diagnostic.id) &&
            diagnostic.projectId === projectIds.get(diagnostic.project) &&
            { Info: 0, Warning: 1, Error: 2 }[diagnostic.severity] >=
              { info: 0, warn: 1, error: 2 }[config.severity],
          "Selected native diagnostic category/severity/project",
        );
        if (diagnostic.locationKind === "None") {
          need(
            diagnostic.file === null &&
              diagnostic.documentId === null &&
              diagnostic.sourceTextSha256 === null &&
              diagnostic.start === 0 &&
              diagnostic.length === 0 &&
              diagnostic.physical.file === "" &&
              diagnostic.mapped.file === "",
            "Native non-source diagnostic has no invented address",
          );
        } else {
          const doc = docs.get(diagnostic.documentId!);
          need(
            doc &&
              doc.file === diagnostic.file &&
              doc.project === diagnostic.project &&
              doc.beforeSha256 === diagnostic.sourceTextSha256 &&
              diagnostic.start + diagnostic.length <= doc.before.length &&
              diagnostic.physical.file === doc.file,
            "Native diagnostic exact physical document and source span",
          );
          const begin = position(doc.before, diagnostic.start),
            end = position(doc.before, diagnostic.start + diagnostic.length);
          need(
            diagnostic.physical.startLine === begin.line &&
              diagnostic.physical.startColumn === begin.column &&
              diagnostic.physical.endLine === end.line &&
              diagnostic.physical.endColumn === end.column,
            "Native diagnostic UTF-16 physical range",
          );
        }
        const inScope =
          diagnostic.documentId === null ||
          docs.get(diagnostic.documentId)!.selected;
        if (inScope) defects++;
        findings.push({
          ruleId: `dotnet-format-extensions/${diagnostic.id}`,
          level: inScope ? "error" : "note",
          message: "A selected native formatting diagnostic remains",
          ...(diagnostic.file
            ? location(diagnostic.file, diagnostic.physical.startLine)
            : {}),
        });
      }
      need(
        new Set(phase.sdkReport.map((r) => JSON.stringify(r))).size ===
          phase.sdkReport.length,
        "Unique native SDK diagnostic/report rows",
      );
      if (phase.mode === "Whitespace")
        need(
          same(
            phase.sdkReport.map((r) => r.DocumentId.Id),
            phase.documents
              .filter((d) => !d.sourceGenerated && d.changed)
              .map((d) => d.documentId),
          ),
          "Every ordinary whitespace edit reconciles with the SDK report",
        );
      for (const row of phase.sdkReport) {
        const doc = docs.get(row.DocumentId.Id);
        need(
          doc &&
            doc.selected &&
            !doc.sourceGenerated &&
            row.DocumentId.ProjectId.Id === doc.projectId &&
            row.FilePath === doc.file &&
            row.FileName === path.basename(doc.file),
          "SDK report physical document identity",
        );
        for (const change of row.FileChanges) {
          // Semantic SDK rows use mapped positions; physical addresses come from
          // the independently retained native diagnostic and current source span.
          if (phase.mode === "Whitespace")
            need(
              change.DiagnosticId === "WHITESPACE" &&
                change.LineNumber === 1 &&
                change.CharNumber === 1 &&
                change.FormatDescription === "Fix whitespace formatting.",
              "Native SDK whitespace row is a document summary; physical edits are bound separately",
            );
          else
            need(
              phase.diagnostics.some(
                (d) =>
                  d.documentId === doc.documentId &&
                  d.id === change.DiagnosticId &&
                  d.mapped.startLine === change.LineNumber &&
                  d.mapped.startColumn === change.CharNumber,
              ),
              "Native mapped SDK row reconciles with a diagnostic bound to current physical source, independently of edit availability",
            );
        }
      }
    }
    return {
      status: defects ? "failed" : "passed",
      findingsComplete: true,
      findings,
      reason: defects
        ? "Selected native formatting diagnostics or proposed source edits remain"
        : "Every declared compiler/generated document reconciles with complete native formatting and diagnostic evidence",
    };
    function location(file: string, line: number) {
      return file.startsWith(build.workspace + path.sep)
        ? {
            file: path.posix.join(
              check.project,
              path.relative(build.workspace, file).replaceAll(path.sep, "/"),
            ),
            line,
          }
        : {};
    }
  } catch {
    return incomplete;
  }
}
