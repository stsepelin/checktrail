import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import {
  fsharpFormatInvocationSchema,
  fsharpFormatConfigSchema,
  fsharpRequire,
} from "./fsharp-format.js";
import { fsharpFormatterPins, fsharpSdkPins } from "./fsharp-format-pins.js";
import { fsharpFormatNativeSource } from "./fsharp-format-native.js";
import {
  fsharpCompileArguments,
  fsharpCompileWarnings,
  fsharpNativeSchema,
  fsharpPacketSchema,
  fsharpRuntimeConfig,
} from "./fsharp-format-contract.js";
import { mavenHash } from "./maven.js";
import { parseCapturedProcessOutput } from "./process-output.js";
import type { Check, CheckResult, Finding, ProcessResult } from "./types.js";
const need = (value: unknown) =>
  fsharpRequire(value, "F# native evidence does not reconcile");
function physical(file: string, expected: { bytes: number; sha256: string }) {
  need(path.isAbsolute(file) && realpathSync(file) === file);
  const stat = lstatSync(file);
  need(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size === expected.bytes &&
      stat.size <= 64 * 1024 * 1024,
  );
  const bytes = readFileSync(file);
  need(bytes.length === expected.bytes && mavenHash(bytes) === expected.sha256);
  return bytes;
}
export function fsharpFormatEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "F# formatting evidence lacks complete current source, formatter, SDK, native diagnostic or document participation bindings.",
    findingsComplete: false,
  };
  if (!root || processes.length !== 1) return incomplete;
  const result = processes[0]!;
  if (
    result.exitCode === 3 &&
    result.stdout === '{"unavailable":"selected-fsharp-toolchain"}' &&
    !result.stderr
  )
    return {
      status: "unavailable",
      reason:
        "The selected F# formatter SDK/runtime components are missing or incompatible.",
      findingsComplete: false,
    };
  if (result.exitCode !== 0) return incomplete;
  try {
    const serialized = check.commands[0]!.args[2]!,
      request = fsharpFormatInvocationSchema.parse(JSON.parse(serialized)),
      packet = fsharpPacketSchema.parse(JSON.parse(result.stdout));
    need(
      realpathSync(root) === root &&
        packet.requestSha256 === mavenHash(serialized) &&
        packet.sdkPinsSha256 === mavenHash(JSON.stringify(fsharpSdkPins)) &&
        path.isAbsolute(packet.temporary) &&
        path.isAbsolute(packet.sdkRoot),
    );
    need(
      new Set(request.config.files).size === request.config.files.length &&
        request.config.files.every((f) => /\.(?:fs|fsi|fsx)$/.test(f)) &&
        isDeepStrictEqual(
          [...request.config.files].sort(),
          [...check.scope].sort(),
        ),
    );
    need(
      isDeepStrictEqual(
        request.inputs.map((i) => i.file),
        ["checktrail.fsharp-format.json", ...request.config.files],
      ),
    );
    const inputs = new Map<string, Buffer>();
    for (const input of request.inputs) {
      const file = path.resolve(root, check.project, input.file);
      need(file.startsWith(root + path.sep));
      inputs.set(input.file, physical(file, input));
    }
    const config = fsharpFormatConfigSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          inputs.get("checktrail.fsharp-format.json"),
        ),
      ),
    );
    need(isDeepStrictEqual(config, request.config));
    const tools = path.resolve(root, check.project, config.formatterDirectory);
    need(
      tools.startsWith(root + path.sep) &&
        realpathSync(tools) === tools &&
        isDeepStrictEqual(
          readdirSync(tools).sort(),
          fsharpFormatterPins.map((p) => p.file).sort(),
        ),
    );
    for (const pin of fsharpFormatterPins)
      physical(path.join(tools, pin.file), pin);
    for (const directory of ["host/fxr", "shared/Microsoft.NETCore.App"])
      need(
        isDeepStrictEqual(
          readdirSync(path.join(packet.sdkRoot, directory)).sort(),
          ["10.0.12"],
        ),
      );
    const groups = new Map<string, string[]>();
    for (const pin of fsharpSdkPins) {
      physical(path.join(packet.sdkRoot, pin.file), pin);
      if (pin.file !== "dotnet") {
        const dir = path.posix.dirname(pin.file),
          files = groups.get(dir) ?? [];
        files.push(path.posix.basename(pin.file));
        groups.set(dir, files);
      }
    }
    for (const [dir, files] of groups)
      need(
        isDeepStrictEqual(
          readdirSync(path.join(packet.sdkRoot, dir))
            .filter((f) => /\.(dll|so|json)$/.test(f))
            .sort(),
          files.sort(),
        ),
      );
    const observer = path.join(packet.temporary, "observer"),
      workspace = path.join(packet.temporary, "workspace"),
      helper = path.join(observer, "ChecktrailFsharpFormat.dll"),
      requestFile = path.join(observer, "request.json"),
      markerFile = path.join(observer, "body-entered.json");
    const documents = config.files.map((file) => ({
      file: path.join(workspace, file),
      signature: file.endsWith(".fsi"),
    }));
    need(
      packet.helperSourceSha256 === mavenHash(fsharpFormatNativeSource) &&
        packet.runtimeConfigSha256 === mavenHash(fsharpRuntimeConfig) &&
        packet.requestFileSha256 === mavenHash(JSON.stringify({ documents })),
    );
    const references = fsharpSdkPins
      .filter(
        (p) =>
          p.file.startsWith(
            "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/",
          ) && p.file.endsWith(".dll"),
      )
      .map((p) => path.join(packet.sdkRoot, p.file))
      .sort();
    const compiler = packet.phases[0]!,
      formatter = packet.phases[1]!;
    need(
      compiler.phase === "compile-observer" &&
        compiler.tool === path.join(packet.sdkRoot, "dotnet") &&
        compiler.cwd === observer &&
        isDeepStrictEqual(
          compiler.args,
          fsharpCompileArguments(packet.sdkRoot, packet.temporary, references),
        ) &&
        compiler.stderrBytes === 0 &&
        fsharpCompileWarnings(compiler.stdout),
    );
    need(
      formatter.phase === "format-documents" &&
        formatter.tool === compiler.tool &&
        formatter.cwd === workspace &&
        isDeepStrictEqual(formatter.args, [
          "exec",
          helper,
          requestFile,
          markerFile,
        ]) &&
        formatter.stderrBytes === 0,
    );
    let nativeBytes = 0;
    for (const phase of packet.phases) {
      const captured = parseCapturedProcessOutput(phase.capturedOutput);
      need(
        captured.completeForObservedStreams &&
          captured.stdout.bytes === phase.stdoutBytes &&
          captured.stderr.bytes === phase.stderrBytes &&
          captured.stdout.sha256 === phase.stdoutSha256 &&
          captured.stderr.sha256 === phase.stderrSha256 &&
          Buffer.from(captured.stdout.base64, "base64").toString("utf8") ===
            phase.stdout &&
          Buffer.from(captured.stderr.base64, "base64").toString("utf8") ===
            phase.stderr,
      );
      nativeBytes += captured.observedBytes;
    }
    need(
      packet.mirroredBytes === nativeBytes &&
        Buffer.byteLength(result.stderr) === nativeBytes &&
        mavenHash(result.stderr) === packet.mirroredSha256,
    );
    // These phases each write only stdout, so mirror order is fully determined.
    need(result.stderr === compiler.stdout + formatter.stdout);
    const native = fsharpNativeSchema.parse(JSON.parse(formatter.stdout));
    need(
      native.processId === formatter.pid &&
        native.helperSha256 === packet.helperSha256 &&
        packet.marker.processId === formatter.pid &&
        packet.marker.runtime === native.runtime &&
        packet.marker.fantomas === native.fantomas,
    );
    need(
      packet.firstDocument.processId === formatter.pid &&
        packet.firstDocument.file === documents[0]!.file &&
        packet.firstDocument.sourceSha256 ===
          native.documents[0]!.sourceSha256 &&
        packet.firstDocument.formatterReturned ===
          (native.documents[0]!.error === null),
    );
    need(
      new Set(native.loaded.map((a) => a.name)).size === native.loaded.length,
    );
    need(
      ["System.Private.CoreLib", "System.Runtime", "System.Text.Json"].every(
        (name) => native.loaded.some((assembly) => assembly.name === name),
      ),
    );
    const loadedPins = new Map(
      fsharpSdkPins
        .filter(
          (p) =>
            p.file.startsWith("shared/Microsoft.NETCore.App/10.0.12/") &&
            p.file.endsWith(".dll"),
        )
        .map((p) => [path.join(packet.sdkRoot, p.file), p]),
    );
    const coreNames = new Set(
      fsharpFormatterPins.map((p) => p.file.replace(/\.dll$/, "")),
    );
    let ownHelper = 0;
    for (const assembly of native.loaded) {
      if (assembly.file === helper) {
        need(
          assembly.name === "ChecktrailFsharpFormat" &&
            assembly.version === "0.0.0.0",
        );
        ownHelper++;
        continue;
      }
      const core = fsharpFormatterPins.find(
        (p) => assembly.file === path.join(observer, p.file),
      );
      if (core) {
        need(
          assembly.name === core.file.replace(/\.dll$/, "") &&
            assembly.version ===
              (assembly.name === "FSharp.Core" ? "10.1.0.0" : "8.0.7.0"),
        );
        coreNames.delete(assembly.name);
        continue;
      }
      const pin = loadedPins.get(assembly.file);
      need(
        pin &&
          assembly.name + ".dll" === path.basename(assembly.file) &&
          assembly.version ===
            (assembly.name === "netstandard" ? "2.1.0.0" : "10.0.0.0"),
      );
    }
    need(
      ownHelper === 1 &&
        coreNames.size === 0 &&
        native.documents.length === documents.length,
    );
    const findings: Finding[] = [],
      seen = new Set<string>();
    for (const [i, document] of native.documents.entries()) {
      const declared = documents[i]!,
        relative = config.files[i]!,
        bytes = inputs.get(relative)!,
        bom = bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])),
        text = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes.subarray(bom ? 3 : 0)),
        lines = text.split(/\r\n|\r|\n/);
      need(
        document.file === declared.file &&
          document.signature === declared.signature &&
          document.sourceBytes === bytes.length &&
          document.sourceSha256 === mavenHash(bytes) &&
          document.utf8Bom === bom &&
          document.text === text &&
          document.textSha256 === mavenHash(text),
      );
      const address = path.posix.join(check.project, relative),
        diagnostics = [
          ...document.diagnostics,
          ...(document.error?.diagnostics ?? []),
        ];
      for (const diagnostic of diagnostics) {
        const range = diagnostic.range;
        if (range)
          need(
            range.file === (document.signature ? "tmp.fsi" : "tmp.fsx") &&
              range.startLine <= lines.length &&
              range.endLine <= lines.length &&
              range.startColumn <= lines[range.startLine - 1]!.length &&
              range.endColumn <= lines[range.endLine - 1]!.length &&
              (range.startLine < range.endLine ||
                (range.startLine === range.endLine &&
                  range.startColumn <= range.endColumn)),
          );
        const key = JSON.stringify([address, diagnostic]);
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          ruleId:
            "fsharp/parser-" +
            (diagnostic.code === null
              ? "unclassified"
              : "FS" + String(diagnostic.code).padStart(4, "0")),
          level:
            diagnostic.severity === "Error"
              ? "error"
              : diagnostic.severity === "Warning"
                ? "warning"
                : "note",
          message:
            "The native F# parser reported " +
            diagnostic.severity.toLowerCase() +
            " diagnostic for this source-bound document.",
          file: address,
          ...(range ? { line: range.startLine } : {}),
        });
      }
      if (document.error) {
        need(
          document.after === null &&
            document.afterSha256 === null &&
            !document.changed,
        );
        const error = document.error;
        need(
          error.type ===
            "Fantomas.Core." +
              (error.kind === "parse"
                ? "ParseException"
                : error.kind === "define-parse"
                  ? "DefineParseException"
                  : "FormatException"),
        );
        if (error.kind === "format") return incomplete;
        need(
          !document.isValid &&
            document.diagnostics.some((d) => d.severity === "Error"),
        );
        if (error.kind === "parse")
          need(error.combinations.length === 0 && error.diagnostics.length > 0);
        else
          need(
            error.diagnostics.length === 0 &&
              error.combinations.length > 0 &&
              new Set(error.combinations).size === error.combinations.length &&
              error.message ===
                "Parsing failed for define combination(s): " +
                  error.combinations.join(", ") +
                  ".",
          );
        findings.push({
          ruleId: "fsharp/" + error.kind,
          level: "error",
          message:
            "The native formatter refused this source-bound document; all returned diagnostics and failing conditional combinations are retained in its native receipt.",
          file: address,
        });
      } else {
        need(
          document.isValid &&
            !document.diagnostics.some((d) => d.severity === "Error") &&
            document.after !== null &&
            document.afterSha256 === mavenHash(document.after) &&
            document.changed === (text !== document.after),
        );
        if (document.changed) {
          let first = 0;
          while (
            first < text.length &&
            first < document.after!.length &&
            text[first] === document.after![first]
          )
            first++;
          findings.push({
            ruleId: "fsharp/format",
            level: "error",
            message:
              "This document differs from the pinned native default formatter output; source files were not rewritten.",
            file: address,
            line: Math.min(
              lines.length,
              text.slice(0, first).split(/\r\n|\r|\n/).length,
            ),
          });
        }
      }
    }
    return {
      status: findings.some((f) => f.level === "error") ? "failed" : "passed",
      reason:
        "Every selected F# implementation, signature and script reconciled with current inputs and native default formatting or complete parse failures.",
      findings,
      findingsComplete: true,
    };
  } catch {
    return incomplete;
  }
}
