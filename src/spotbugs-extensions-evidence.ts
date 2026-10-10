import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { spotbugsInvocationSchema, spotbugsConfigSchema } from "./spotbugs.js";
import { javaConfigSchema } from "./java.js";
import { spotbugsExtensionsEvidenceSchema } from "./spotbugs-extensions-contract.js";
import { spotbugsHash } from "./spotbugs-extensions-inputs.js";
import { validateSpotbugsExtensionScope } from "./spotbugs-extensions.js";
import { verifySpotbugsPluginMetadata } from "./spotbugs-plugin-jar.js";
import {
  spotbugsCoreFactories,
  spotbugsCorePatterns,
  spotbugsCorePluginId,
} from "./spotbugs-extensions-artifacts.js";
import { spotbugsArtifacts } from "./spotbugs-artifacts.js";
import { spotbugsLibraries } from "./spotbugs-archive.js";
import { jvmToolchainPins } from "./jvm-toolchain-pins.js";
import { kotlinJar } from "./kotlin-jar.js";
import { kotlinReadSync } from "./kotlin-io.js";
import { parseCapturedProcessOutput } from "./process-output.js";
import type { Check, CheckResult, Finding, ProcessResult } from "./types.js";
const need = (value: unknown) => {
  if (!value) throw Error("Analyzer extension evidence does not reconcile");
};
const same = (left: string[], right: string[]) =>
  new Set(left).size === left.length &&
  new Set(right).size === right.length &&
  JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
const physical = (
  file: string,
  maximum: number,
  expected: { bytes: number; sha256: string },
) => {
  need(realpathSync(file) === file);
  const bytes = kotlinReadSync(file, maximum);
  need(
    bytes.length === expected.bytes && spotbugsHash(bytes) === expected.sha256,
  );
  return bytes;
};
const origin = (file: string) =>
  pathToFileURL(file).href.replace(/^file:\/\/\//, "file:/");
export function spotbugsExtensionsEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Analyzer evidence lacks current sources, fresh compiler cohorts, native class and rule provenance or complete pass accounting",
    findingsComplete: false,
  };
  if (!root || processes.length !== 1) return incomplete;
  const process = processes[0]!;
  if (process.exitCode !== 0)
    return {
      status: "error",
      reason: "Analyzer extension native collection did not complete",
      findingsComplete: false,
    };
  try {
    const serialized = check.commands[0]!.args[2]!,
      request = spotbugsInvocationSchema.parse(JSON.parse(serialized));
    need(request.config.profile === "core-default-max-class-scopes-plugins-v1");
    if (request.config.profile !== "core-default-max-class-scopes-plugins-v1")
      return incomplete;
    const extensions = request.config.extensions;
    validateSpotbugsExtensionScope(extensions, check.scope);
    need(JSON.stringify(request.scope) === JSON.stringify(check.scope));
    const data = spotbugsExtensionsEvidenceSchema.parse(
      JSON.parse(process.stdout),
    );
    need(
      data.requestDigest === spotbugsHash(serialized) &&
        path.isAbsolute(data.temporary) &&
        data.snapshot === path.join(data.temporary, "snapshot") &&
        path.isAbsolute(data.jdkHome),
    );
    for (const tool of jvmToolchainPins)
      physical(path.join(data.jdkHome, tool.path), tool.bytes, tool);
    const archiveFile = path.resolve(
      root,
      check.project,
      request.config.archive,
    );
    const archiveBytes = physical(archiveFile, 15831983, {
      bytes: 15831983,
      sha256: request.config.sha256,
    });
    for (const [i, relative] of [
      "checktrail.spotbugs.json",
      "checktrail.java.json",
    ].entries()) {
      const expected = i === 0 ? request.config : request.compiler,
        file = path.resolve(root, check.project, relative),
        pin = data.configuration[i]!;
      need(pin.file === file);
      const bytes = physical(file, 100 * 1024, pin),
        parsed = (i === 0 ? spotbugsConfigSchema : javaConfigSchema).parse(
          JSON.parse(bytes.toString("utf8")),
        );
      need(JSON.stringify(parsed) === JSON.stringify(expected));
    }
    need(
      data.libraries.length === request.compiler.classPath.length &&
        data.plugins.length === extensions.plugins.length,
    );
    let libraryBytes = 0,
      pluginBytes = 0;
    for (const [i, pin] of data.libraries.entries()) {
      const declared = request.compiler.classPath[i]!;
      need(
        pin.file === path.resolve(root, check.project, declared.path) &&
          pin.sha256 === declared.sha256 &&
          pin.nativeFile ===
            path.join(data.temporary, "libraries", String(i), "library.jar"),
      );
      const bytes = physical(pin.file, 32 * 1024 * 1024, pin);
      need(kotlinJar(bytes).classPath.length === 0);
      libraryBytes += bytes.length;
    }
    for (const [i, pin] of data.plugins.entries()) {
      const declared = extensions.plugins[i]!;
      need(
        pin.file === path.resolve(root, check.project, declared.path) &&
          pin.sha256 === declared.sha256 &&
          pin.nativeFile ===
            path.join(data.temporary, "plugins", String(i), "plugin.jar"),
      );
      const bytes = physical(pin.file, 32 * 1024 * 1024, pin);
      verifySpotbugsPluginMetadata(bytes, declared);
      pluginBytes += bytes.length;
    }
    need(libraryBytes <= 128 * 1024 * 1024 && pluginBytes <= 128 * 1024 * 1024);
    need(
      data.original.length === check.scope.length &&
        data.after.length === check.scope.length,
    );
    const sourceBindings = new Map<
      string,
      { relative: string; file: string; lines: number; generator?: string }
    >();
    let totalSourceBytes = 0;
    for (const [i, relative] of check.scope.entries()) {
      const before = data.original[i]!,
        after = data.after[i]!,
        file = path.resolve(root, check.project, relative),
        nativeFile = path.join(data.snapshot, relative);
      need(
        before.relative === relative &&
          before.file === file &&
          before.nativeFile === nativeFile &&
          after.file === file &&
          after.bytes === before.bytes &&
          after.sha256 === before.sha256,
      );
      const bytes = physical(file, 1024 * 1024, before);
      totalSourceBytes += bytes.length;
      sourceBindings.set(nativeFile, {
        relative,
        file,
        lines: new TextDecoder("utf-8", { fatal: true })
          .decode(bytes)
          .split(/\r\n?|\n/).length,
      });
    }
    need(
      totalSourceBytes <= 16 * 1024 * 1024 &&
        data.generated.length === extensions.generators.length &&
        same(
          data.generated.map((g) => g.source),
          extensions.generators.map((g) => g.source),
        ),
    );
    const outputs = data.generated.flatMap((g) => g.outputs),
      payloads = data.payloads;
    need(
      same(
        payloads.map((p) => p.path),
        outputs.map((o) => o.path),
      ),
    );
    let generatedBytes = 0;
    for (const generator of extensions.generators) {
      const capture = data.generated.find(
          (g) => g.source === generator.source,
        )!,
        before = data.original.find((p) => p.relative === generator.source)!;
      need(
        capture.sourceSha256 === before.sha256 &&
          same(
            capture.outputs.map((o) => o.path),
            generator.outputs.map((o) =>
              path.posix.join(generator.module, o.file),
            ),
          ),
      );
      for (const declared of generator.outputs) {
        const relative = path.posix.join(generator.module, declared.file),
          output = capture.outputs.find((o) => o.path === relative)!,
          payload = payloads.find((p) => p.path === relative)!,
          bytes = Buffer.from(payload.base64, "base64");
        need(
          output.className === declared.className &&
            bytes.toString("base64") === payload.base64 &&
            bytes.length === payload.bytes &&
            payload.bytes === output.bytes &&
            spotbugsHash(bytes) === payload.sha256 &&
            payload.sha256 === output.sha256,
        );
        generatedBytes += bytes.length;
        sourceBindings.set(path.join(data.snapshot, relative), {
          relative,
          file: path.resolve(root, check.project, relative),
          lines: new TextDecoder("utf-8", { fatal: true })
            .decode(bytes)
            .split(/\r\n?|\n/).length,
          generator: generator.source,
        });
      }
    }
    need(
      generatedBytes <= 2 * 1024 * 1024 &&
        data.stages.length > 0 &&
        data.stages.length <= extensions.stages.length,
    );
    const classes = new Map<
        string,
        {
          cohort: string;
          source: ReturnType<typeof sourceBindings.get>;
          output: string;
          sourceFile: string;
          bytes: number;
          sha256: string;
          analyze: boolean;
        }
      >(),
      findings: Finding[] = [];
    let classBytes = 0,
      failedCompilation = false;
    for (const [i, stage] of data.stages.entries()) {
      const declared = extensions.stages[i]!,
        expectedSources = [
          ...declared.sources,
          ...extensions.generators
            .filter((g) => g.module === declared.path)
            .flatMap((g) =>
              g.outputs.map((o) => path.posix.join(g.module, o.file)),
            ),
        ].map((f) => path.join(data.snapshot, f)),
        compiler = stage.compiler;
      need(
        stage.id === declared.id &&
          stage.directory === path.join(data.temporary, "cohorts", stage.id) &&
          same(stage.sourceFiles, expectedSources) &&
          same(stage.classPath, [
            ...data.libraries.map((p) => p.nativeFile),
            ...declared.dependsOn.map((id) =>
              path.join(data.temporary, "cohorts", id),
            ),
          ]) &&
          compiler.finished === 1 &&
          !compiler.extra.trim(),
      );
      need(
        same(
          compiler.sources.map((s) => s.file),
          expectedSources,
        ) && compiler.sources.every((s) => s.parsed === 1),
      );
      for (const diagnostic of compiler.diagnostics) {
        const source = diagnostic.file
          ? sourceBindings.get(diagnostic.file)
          : undefined;
        need(diagnostic.kind !== "OTHER");
        const globalWarning =
          diagnostic.kind === "ERROR" &&
          diagnostic.code === "compiler.err.warnings.and.werror" &&
          request.compiler.warningsAsErrors &&
          diagnostic.line === -1 &&
          compiler.diagnostics.some((d) => d.kind.endsWith("WARNING")) &&
          (diagnostic.file === null ||
            (source && expectedSources.includes(diagnostic.file))) &&
          compiler.diagnostics.filter(
            (d) => d.code === "compiler.err.warnings.and.werror",
          ).length === 1;
        need(
          (source &&
            expectedSources.includes(diagnostic.file!) &&
            diagnostic.line > 0 &&
            diagnostic.line <= source.lines) ||
            globalWarning,
        );
        findings.push({
          ruleId: "javac/" + diagnostic.code,
          level:
            diagnostic.kind === "ERROR"
              ? "error"
              : diagnostic.kind.endsWith("WARNING")
                ? "warning"
                : "note",
          message: source?.generator
            ? `${source.relative}:${diagnostic.line}: ${diagnostic.message}`
            : diagnostic.message,
          ...(source
            ? {
                file: source.generator
                  ? path.posix.join(check.project, source.generator)
                  : path.relative(root, source.file).split(path.sep).join("/"),
                ...(source.generator || diagnostic.line < 1
                  ? {}
                  : { line: diagnostic.line }),
              }
            : {}),
        });
      }
      const errors = compiler.diagnostics.filter((d) => d.kind === "ERROR");
      if (!compiler.success) {
        need(
          errors.length > 0 &&
            i === data.stages.length - 1 &&
            data.analysis === null &&
            data.modules.length === 0,
        );
        failedCompilation = true;
      } else {
        need(!errors.length);
        for (const source of compiler.sources) {
          const descriptor = path.basename(source.file) === "module-info.java";
          need(
            descriptor
              ? source.declared.length === 0 &&
                  same(source.analyzed, [
                    extensions.jpms.find((m) => m.module === declared.path)!
                      .name + ".module-info",
                  ])
              : source.declared.length > 0 &&
                  same(source.declared, source.analyzed),
          );
        }
      }
      need(
        new Set(compiler.classes.map((c) => c.name)).size ===
          compiler.classes.length,
      );
      for (const output of compiler.classes) {
        const source = sourceBindings.get(output.file);
        need(
          source &&
            expectedSources.includes(output.file) &&
            output.output ===
              path.join(
                stage.directory,
                output.name.replaceAll(".", "/") + ".class",
              ) &&
            output.sourceFile === path.basename(output.file),
        );
        const descriptor = output.name === "module-info";
        if (descriptor)
          need(
            path.basename(output.file) === "module-info.java" &&
              extensions.jpms.some((m) => m.module === declared.path),
          );
        else {
          need(!classes.has(output.name));
          const parsed = compiler.sources.find((s) => s.file === output.file)!;
          need(
            parsed.declared.some(
              (name) =>
                output.name === name || output.name.startsWith(name + "$"),
            ),
          );
          classes.set(output.name, {
            cohort: stage.id,
            source,
            output: output.output,
            sourceFile: output.sourceFile,
            bytes: output.bytes,
            sha256: output.sha256,
            analyze: declared.analyze,
          });
        }
        classBytes += output.bytes;
      }
      if (compiler.success)
        for (const source of compiler.sources)
          need(
            source.declared.every((name) =>
              compiler.classes.some(
                (c) => c.name === name && c.file === source.file,
              ),
            ),
          );
    }
    need(classBytes <= 32 * 1024 * 1024);
    const emitted = data.stages.flatMap((s) => s.compiler.classes);
    need(
      same(
        data.outputsAfter.map((p) => p.file),
        emitted.map((c) => c.output),
      ),
    );
    for (const output of emitted) {
      const after = data.outputsAfter.find((p) => p.file === output.output)!;
      need(after.bytes === output.bytes && after.sha256 === output.sha256);
    }
    if (!failedCompilation) {
      need(
        data.stages.length === extensions.stages.length &&
          data.modules.length === extensions.jpms.length &&
          same(
            data.modules.map((m) => m.module),
            extensions.jpms.map((m) => m.module),
          ),
      );
      for (const expected of extensions.jpms) {
        const module = data.modules.find((m) => m.module === expected.module)!,
          cohort = data.stages.find(
            (s) =>
              extensions.stages.find((c) => c.id === s.id)!.path ===
              expected.module,
          )!,
          output = cohort.compiler.classes.find(
            (c) => c.name === "module-info",
          )!;
        need(
          output &&
            module.name === expected.name &&
            same(module.requires, ["java.base", ...expected.requires]) &&
            same(module.exports, expected.exports) &&
            module.bytes === output.bytes &&
            module.sha256 === output.sha256,
        );
      }
    }
    // Physical invocation streams must contain the exact native compiler/module/analysis packets.
    let nativeBytes = 0;
    for (const invocation of data.invocations) {
      need(
        invocation.status === 0 &&
          !invocation.signal &&
          invocation.stdoutBytes === Buffer.byteLength(invocation.stdout) &&
          invocation.stderrBytes === Buffer.byteLength(invocation.stderr) &&
          invocation.stdoutSha256 === spotbugsHash(invocation.stdout) &&
          invocation.stderrSha256 === spotbugsHash(invocation.stderr) &&
          path.isAbsolute(invocation.cwd),
      );
      nativeBytes += invocation.stdoutBytes + invocation.stderrBytes;
    }
    const mirror = parseCapturedProcessOutput(data.mirrored);
    need(
      mirror.completeForObservedStreams &&
        mirror.stdout.bytes === 0 &&
        mirror.stderr.bytes === Buffer.byteLength(process.stderr) &&
        mirror.stderr.sha256 === spotbugsHash(process.stderr) &&
        nativeBytes === mirror.stderr.bytes &&
        nativeBytes <= 2 * 1024 * 1024,
    );
    const nativePacket = (value: unknown) =>
      data.invocations.filter((i) => {
        try {
          return (
            i.tool === "java" && isDeepStrictEqual(JSON.parse(i.stdout), value)
          );
        } catch {
          return false;
        }
      });
    need(
      data.invocations.length ===
        1 +
          extensions.generators.length * 2 +
          data.stages.length +
          (!failedCompilation && extensions.jpms.length ? 1 : 0) +
          (!failedCompilation ? 1 : 0),
    );
    const toolLibraries = [...spotbugsLibraries(archiveBytes).keys()].map(
      (name) => path.join(data.temporary, "tools", name),
    );
    const helperDirectory = path.join(data.temporary, "helpers"),
      helperClasses = path.join(helperDirectory, "classes"),
      nativeHome = path.join(data.temporary, "home"),
      javaArgs = [
        "-Xmx512m",
        "-Dfile.encoding=UTF-8",
        "-Duser.language=en",
        "-Duser.country=US",
        "-Duser.home=" + nativeHome,
        "-Dfindbugs.home=" + nativeHome,
        "-Dlog4j2.loggerContextFactory=org.apache.logging.log4j.simple.SimpleLoggerContextFactory",
        "-Dlog4j2.simplelogLevel=WARN",
        "-Dlog4j2.simplelogLogFile=system.err",
        "-cp",
        [helperClasses, ...toolLibraries].join(path.delimiter),
      ];
    const setup = data.invocations[0]!;
    need(
      setup.tool === "javac" &&
        setup.cwd === data.temporary &&
        !setup.stdoutBytes &&
        !setup.stderrBytes &&
        JSON.stringify(setup.args) ===
          JSON.stringify([
            "-proc:none",
            "-encoding",
            "UTF-8",
            "-cp",
            toolLibraries.join(path.delimiter),
            "-d",
            helperClasses,
            ...[
              "VerifierSpotbugsCompiler.java",
              "VerifierSpotbugs.java",
              "VerifierJvmModules.java",
            ].map((file) => path.join(helperDirectory, file)),
          ]),
    );
    for (const [i, generator] of extensions.generators.entries()) {
      const directory = path.join(data.temporary, "generator-" + i),
        compiler = data.invocations[1 + i * 2]!,
        executed = data.invocations[2 + i * 2]!;
      need(
        compiler.tool === "javac" &&
          compiler.cwd === directory &&
          JSON.stringify(compiler.args) ===
            JSON.stringify([
              "-proc:none",
              "-encoding",
              "UTF-8",
              "-d",
              path.join(directory, "classes"),
              path.join(data.snapshot, generator.source),
            ]),
      );
      need(
        executed.tool === "java" &&
          executed.cwd === directory &&
          JSON.stringify(executed.args) ===
            JSON.stringify([
              "--enable-native-access=ALL-UNNAMED",
              "-cp",
              path.join(directory, "classes"),
              generator.className,
              path.join(directory, "output"),
            ]),
      );
    }
    for (const stage of data.stages) {
      const captures = nativePacket(stage.compiler);
      need(
        captures.length === 1 &&
          captures[0]!.cwd === data.temporary &&
          JSON.stringify(captures[0]!.args) ===
            JSON.stringify([
              ...javaArgs,
              "VerifierSpotbugsCompiler",
              path.join(data.temporary, "cohorts", stage.id + ".txt"),
              stage.directory,
              ...(extensions.jpms.length ? ["module"] : []),
            ]),
      );
    }
    if (!failedCompilation && extensions.jpms.length) {
      const captures = nativePacket(data.modules);
      need(
        captures.length === 1 &&
          JSON.stringify(captures[0]!.args) ===
            JSON.stringify([
              ...javaArgs,
              "VerifierJvmModules",
              ...extensions.jpms.flatMap((module) => [
                module.module,
                path.join(
                  data.stages.find(
                    (stage) =>
                      extensions.stages.find((c) => c.id === stage.id)!.path ===
                      module.module,
                  )!.directory,
                  "module-info.class",
                ),
              ]),
            ]),
      );
    }
    if (failedCompilation)
      return {
        status: "failed",
        reason:
          "Current source compiler errors prevent complete bytecode analysis",
        findings,
        findingsComplete: false,
      };
    const analysis = data.analysis;
    need(analysis && nativePacket(analysis).length === 1);
    if (!analysis) return incomplete;
    need(
      JSON.stringify(nativePacket(analysis)[0]!.args) ===
        JSON.stringify([
          ...javaArgs,
          "VerifierSpotbugs",
          path.join(data.temporary, "analysis.json"),
          data.temporary,
          ...data.stages.map((stage) => stage.directory),
          ...data.libraries.map((library) => library.nativeFile),
        ]),
    );
    need(
      analysis.completed &&
        analysis.corePlugin === spotbugsCorePluginId &&
        !analysis.errors &&
        !analysis.missing &&
        !analysis.errorMessages.length &&
        !analysis.missingClasses.length &&
        !analysis.skipped.length &&
        !analysis.oversized.length &&
        !analysis.messages.trim(),
    );
    need(
      same(
        analysis.provenance.map((p) => p.detector),
        [
          ...spotbugsCoreFactories.map((f) => f.detector),
          ...extensions.plugins.flatMap((p) =>
            p.detectors.map((d) => d.className),
          ),
        ],
      ),
    );
    for (const factory of spotbugsCoreFactories) {
      const actual = analysis.provenance.find(
        (p) => p.detector === factory.detector,
      )!;
      need(
        actual.plugin === spotbugsCorePluginId &&
          actual.enabled === factory.enabled &&
          actual.defaultEnabled === factory.defaultEnabled &&
          actual.origin ===
            origin(path.join(data.temporary, "tools/spotbugs.jar")),
      );
    }
    for (const [i, plugin] of extensions.plugins.entries())
      for (const detector of plugin.detectors) {
        const actual = analysis.provenance.find(
          (p) => p.detector === detector.className,
        )!;
        need(
          actual.plugin === plugin.id &&
            actual.enabled &&
            actual.defaultEnabled &&
            actual.origin === origin(data.plugins[i]!.nativeFile),
        );
      }
    const expectedPatterns = [
      ...spotbugsCorePatterns.map((pattern) => ({
        ...pattern,
        plugin: spotbugsCorePluginId,
      })),
      ...extensions.plugins.flatMap((p) =>
        p.patterns.map((pattern) => ({ ...pattern, plugin: p.id })),
      ),
    ];
    need(
      same(
        analysis.patterns.map((p) =>
          JSON.stringify([p.plugin, p.type, p.abbreviation, p.category]),
        ),
        expectedPatterns.map((p) =>
          JSON.stringify([p.plugin, p.type, p.abbreviation, p.category]),
        ),
      ) &&
        new Set(analysis.patterns.map((p) => p.type)).size ===
          analysis.patterns.length,
    );
    const enabled = analysis.provenance
        .filter((p) => p.enabled)
        .map((p) => p.detector),
      effective = analysis.effective.flat(),
      custom = new Set(
        extensions.plugins.flatMap((p) => p.detectors.map((d) => d.className)),
      );
    need(
      same(analysis.detectors, enabled) &&
        new Set(effective).size === effective.length &&
        effective.every((name) =>
          analysis.provenance.some((factory) => factory.detector === name),
        ) &&
        [...custom].every(
          (name) => effective.filter((n) => n === name).length === 1,
        ),
    );
    need(
      JSON.stringify(
        analysis.effective
          .map((pass) => pass.filter((name) => !custom.has(name)))
          .filter((pass) => pass.length),
      ) === JSON.stringify(spotbugsArtifacts.effectivePlan),
    );
    const selected = [...classes.entries()].filter(([, c]) => c.analyze),
      names = selected.map(([name]) => name);
    need(
      names.length > 0 &&
        same(
          analysis.stats.map((s) => s.name),
          names,
        ) &&
        analysis.stats.every(
          (s) => classes.get(s.name)!.sourceFile === s.source,
        ) &&
        analysis.predicted.length === analysis.passes.length &&
        analysis.effective.length === analysis.passes.length,
    );
    for (const [i, pass] of analysis.passes.entries()) {
      // The first native pass visits the dependency closure; later passes visit
      // only selected application classes, as in the preserved core profile.
      const seen = new Set(pass.classes);
      need(
        pass.expected === analysis.predicted[i] &&
          pass.finished === pass.expected &&
          pass.classes.length === pass.finished &&
          seen.size === pass.finished &&
          names.every((name) => seen.has(name)) &&
          (i === 0 || seen.size === names.length),
      );
    }
    for (const bug of analysis.bugs) {
      const source = classes.get(bug.className),
        pattern = analysis.patterns.find((p) => p.type === bug.type);
      need(
        source?.analyze &&
          source.source &&
          source.sourceFile === bug.source &&
          bug.line > 0 &&
          bug.endLine >= bug.line &&
          bug.endLine <= source.source.lines &&
          pattern &&
          pattern.plugin === bug.provider &&
          pattern.abbreviation === bug.abbreviation &&
          pattern.category === bug.category,
      );
      if (!source?.source) return incomplete;
      const binding = source.source;
      findings.push({
        ruleId: `spotbugs/${bug.provider}/${bug.type}`,
        level:
          bug.priority === 1
            ? "error"
            : bug.priority === 2
              ? "warning"
              : "note",
        file: binding.generator
          ? path.posix.join(check.project, binding.generator)
          : path.relative(root, binding.file).split(path.sep).join("/"),
        ...(binding.generator ? {} : { line: bug.line }),
        message: binding.generator
          ? `${binding.relative}:${bug.line}: ${bug.message}`
          : bug.message,
      });
    }
    return {
      status: analysis.bugs.length ? "failed" : "passed",
      reason: analysis.bugs.length
        ? "Pinned native rule providers reported selected fresh bytecode defects"
        : "Every selected fresh application class completed native detector passes with current library, module and rule provenance",
      findings,
      findingsComplete: true,
    };
  } catch {
    return incomplete;
  }
}
