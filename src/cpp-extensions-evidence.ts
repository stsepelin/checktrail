import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual as equal } from "node:util";
import { z } from "zod";
import { cppExtensionsTidyDiagnostics } from "./cpp-extensions-tidy.js";
import { cppRequire, cppSame } from "./cpp-tools.js";
import {
  cppCtest,
  cppCtestConsole,
  cppFormat,
  cppFormatStyle,
  cppMd5,
  cppTidyEnabled,
} from "./cpp-native.js";
import { mavenHash } from "./maven.js";
import { cppExtensionsCmake } from "./cpp-extensions-contract.js";
import { cppExtensionsFreshness } from "./cpp-extensions-freshness.js";
import { cppExtensionsPacketSchema } from "./cpp-extensions-packet.js";
import {
  cppExtensionsToolNames,
  cppExtensionsSupportedVersion,
  cppExtensionsConfigure,
  cppExtensionsUnits,
} from "./cpp-extensions-native.js";
import {
  cppExtensionsGraph,
  cppExtensionsCTestScope,
} from "./cpp-extensions-graph.js";
import { cppExtensionsPhysical } from "./cpp-extensions-physical.js";
import type { Check, CheckResult, ProcessResult, Finding } from "./types.js";
export function cppExtensionsEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<
  CheckResult,
  "status" | "reason" | "findings" | "tests" | "findingsComplete"
> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "C/C++ extension evidence is missing, unsupported, stale or inconsistent with complete declared physical inputs.",
    findingsComplete: false,
  };
  try {
    cppRequire(
      check.commands.length === 1 && processes.length === 1,
      "Extension process denominator differs",
    );
    const process = processes[0]!;
    cppRequire(
      !process.stderr.trim() &&
        !process.signal &&
        !process.cancelled &&
        !process.timedOut &&
        !process.truncated &&
        !process.errorCode,
      "Extension collection incomplete",
    );
    // Even unavailable evidence must refer to the current physical declaration.
    const {
      config: c,
      invocation,
      directory,
      read,
    } = cppExtensionsFreshness(check, root);
    if (process.exitCode === 3) {
      z.strictObject({
        unavailable: z.literal("cpp-extensions"),
        reason: z.enum([
          "missing-tool",
          "unsupported-version",
          "unsupported-sdk",
        ]),
      }).parse(JSON.parse(process.stdout));
      return {
        status: "unavailable",
        reason:
          "Required C/C++ extension tools or selected SDK files are missing or outside the verified native profile.",
        findingsComplete: false,
      };
    }
    cppRequire(process.exitCode === 0, "Extension collector did not complete");
    const packet = cppExtensionsPacketSchema.parse(JSON.parse(process.stdout)),
      { workspace, build } = packet;
    cppRequire(
      equal(packet.config, c) &&
        packet.configSha256 === invocation.configSha256 &&
        packet.inputSha256 === mavenHash(JSON.stringify(invocation.inputs)) &&
        check.id === `cpp.${packet.mode}-extensions` &&
        check.commands[0]!.args[3] === packet.mode,
      "Extension declaration/check identity differs",
    );
    cppRequire(
      path.isAbsolute(packet.temporary) &&
        path.normalize(packet.temporary) === packet.temporary &&
        workspace === path.join(packet.temporary, "project") &&
        build === path.join(packet.temporary, "build"),
      "Owned native directory differs",
    );
    cppRequire(
      cppSame(
        packet.tools.map((t) => t.name),
        [...cppExtensionsToolNames],
      ) &&
        packet.tools.every(
          (t) =>
            path.isAbsolute(t.entry) &&
            (!(t.name === "as" || t.name === "ld") ||
              t.entry === "/usr/bin/" + t.name) &&
            path.isAbsolute(t.resolved) &&
            t.sha256 === t.afterSha256,
        ) &&
        packet.sdkBeforeSha256 === mavenHash(JSON.stringify(c.sdk)) &&
        packet.sdkBeforeSha256 === packet.sdkAfterSha256,
      "Extension tool or complete SDK identity differs",
    );
    for (const r of packet.receipts)
      cppRequire(
        r.stdoutSha256 === mavenHash(r.stdout) &&
          r.stderrSha256 === mavenHash(r.stderr),
        "Native output bytes differ",
      );
    for (const a of packet.artifacts)
      cppRequire(
        a.sha256 === a.afterSha256 &&
          a.sha256 === mavenHash(Buffer.from(a.text, a.encoding)) &&
          (a.encoding === "utf8" ||
            Buffer.from(a.text, "base64").toString("base64") === a.text),
        "Native artifact bytes differ",
      );
    cppRequire(
      new Set(packet.artifacts.map((a) => a.path)).size ===
        packet.artifacts.length,
      "Duplicate native artifact",
    );
    const usedArtifacts = new Set<string>();
    const artifact = (file: string, encoding: "utf8" | "base64" = "utf8") => {
      if (file === "file-api-index") {
        const indexes = packet.artifacts.filter((a) =>
          /^\.cmake\/api\/v1\/reply\/index-[A-Za-z0-9_.-]+\.json$/.test(a.path),
        );
        cppRequire(indexes.length === 1, "Native graph index ambiguous");
        file = indexes[0]!.path;
      }
      const a = packet.artifacts.find((a) => a.path === file);
      cppRequire(a && a.encoding === encoding, "Missing native artifact");
      usedArtifacts.add(file);
      return a.text;
    };
    let position = 0;
    const receipt = (phase: string, name: string, args: string[]) => {
      const row = packet.receipts[position++],
        tool = packet.tools.find((t) => t.name === name);
      cppRequire(
        row &&
          tool &&
          row.phase === phase &&
          row.executable === tool.entry &&
          equal(row.args, args),
        "Native phase/argument sequence differs",
      );
      return row;
    };
    const finish = (failed: boolean, findingsComplete = true) => {
      cppRequire(
        position === packet.receipts.length &&
          cppSame(
            [...usedArtifacts],
            packet.artifacts.map((a) => a.path),
          ),
        "Unreconciled native phase or artifact",
      );
      return {
        status: failed ? ("failed" as const) : ("passed" as const),
        reason:
          "Declared local CMake interfaces, generated headers, native objects/libraries and selected SDK consumption reconcile.",
        findings,
        findingsComplete,
      };
    };
    for (const name of cppExtensionsToolNames) {
      const row = receipt(
        "version:" + name,
        name,
        name === "clang" || name === "clang++"
          ? ["--no-default-config", "--version"]
          : ["--version"],
      );
      cppRequire(
        row.exitCode === 0 &&
          !row.stderr.trim() &&
          cppExtensionsSupportedVersion(name, row.stdout),
        "Extension native version differs",
      );
    }
    const source = (file: string) => read(path.join(directory, file));
    for (const [file, expected] of Object.entries(cppExtensionsCmake(c)))
      cppRequire(
        source(file).equals(Buffer.from(expected)),
        "Current CMake declaration differs",
      );
    const findings: Finding[] = [];
    const finding = (
      ruleId: string,
      message: string,
      absolute: string,
      line: number,
      level: "error" | "warning" | "note" = "error",
    ) => {
      const relative = path
        .relative(workspace, absolute)
        .split(path.sep)
        .join("/");
      const generated = packet.generated.find(
        (g) => path.join(build, g.path) === absolute,
      );
      const template = generated
        ? c.generatedHeaders.find(
            (g) => path.posix.join(g.directory, g.output) === generated.path,
          )!.template
        : undefined;
      const file = template ?? relative;
      cppRequire(
        path.isAbsolute(absolute) &&
          path.normalize(absolute) === absolute &&
          invocation.inputs.some((p) => p.path === file) &&
          Number.isSafeInteger(line) &&
          line > 0 &&
          line <= source(file).toString("utf8").split("\n").length,
        "Native diagnostic source point outside current inputs",
      );
      findings.push({
        ruleId,
        level,
        message:
          (generated
            ? "Generated header diagnostic; location identifies its physical template: "
            : "") +
          message
            .replaceAll(workspace, "<project>")
            .replaceAll(build, "<build>"),
        file: path.posix.join(check.project, file),
        line,
      });
    };
    const configured = receipt(
      "configure",
      "cmake",
      cppExtensionsConfigure(workspace, build, packet.tools),
    );
    cppRequire(configured.exitCode === 0, "Native CMake evaluation incomplete");
    cppExtensionsGraph(c, workspace, build, packet.tools, artifact);
    const generated = c.generatedHeaders.map((g) => {
      const template = new TextDecoder("utf-8", { fatal: true }).decode(
          source(g.template),
        ),
        names = [...template.matchAll(/@([A-Za-z_][A-Za-z0-9_]*)@/g)].map(
          (m) => m[1]!,
        );
      cppRequire(
        cppSame([...new Set(names)], Object.keys(g.values)) &&
          !template.includes("${") &&
          !template.includes("#cmakedefine"),
        "Generated variable denominator differs",
      );
      const text = template.replace(
        /@([A-Za-z_][A-Za-z0-9_]*)@/g,
        (_, name: string) => String(g.values[name]),
      );
      return {
        path: path.posix.join(g.directory, g.output),
        text,
        sha256: mavenHash(text),
        md5: cppMd5(text),
      };
    });
    const tree = generated
      .map((g) => ({ path: g.path, sha256: g.sha256 }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    cppRequire(
      equal(packet.generated, generated) &&
        equal(packet.generatedBefore, tree) &&
        equal(packet.generatedAfter, tree),
      "Generated physical bytes or complete tree differs",
    );
    for (const g of generated)
      cppRequire(
        artifact(g.path) === g.text,
        "Generated artifact bytes differ",
      );
    const compiled = receipt("build", "cmake", [
      "--build",
      build,
      "--verbose",
      "--parallel",
      "1",
    ]);
    const nativeSarif = z.object({
      version: z.literal("2.1.0"),
      runs: z
        .array(
          z.object({
            tool: z.object({
              driver: z.object({
                name: z.literal("clang"),
                version: z.literal("22.1.3"),
                rules: z.array(z.object({ id: z.string() })),
              }),
            }),
            results: z.array(
              z.object({
                level: z.enum(["error", "warning", "note"]),
                ruleId: z.string(),
                ruleIndex: z.number().int().nonnegative(),
                message: z.object({ text: z.string() }),
                locations: z
                  .array(
                    z.object({
                      physicalLocation: z.object({
                        artifactLocation: z.object({ uri: z.string() }),
                        region: z.object({
                          startLine: z.number().int().positive(),
                        }),
                      }),
                    }),
                  )
                  .min(1)
                  .optional(),
              }),
            ),
          }),
        )
        .length(1),
    });
    const diagnostics = compiled.stderr
      .split("\n")
      .filter((l) => l.startsWith('{"$schema":'))
      .map((l) => nativeSarif.parse(JSON.parse(l)).runs[0]!);

    let errors = 0;
    for (const run of diagnostics)
      for (const d of run.results) {
        cppRequire(
          run.tool.driver.rules[d.ruleIndex]?.id === d.ruleId &&
            d.locations?.length,
          "Native diagnostic rule/location identity differs",
        );
        if (d.level === "error") errors++;
        const location = d.locations![0]!.physicalLocation;
        finding(
          `clang/${d.ruleId}`,
          d.message.text,
          fileURLToPath(location.artifactLocation.uri),
          location.region.startLine,
          d.level,
        );
      }
    if (compiled.exitCode !== 0) {
      cppRequire(
        errors > 0 && !packet.binaries.length && !packet.sdkObserved.length,
        "Unexplained or partial native build failure",
      );
      return finish(true, false);
    }
    cppRequire(
      errors === 0 &&
        diagnostics.length === cppExtensionsUnits(c).length &&
        compiled.stderr
          .split("\n")
          .every((l) => !l.trim() || l.startsWith('{"$schema":')),
      "Successful build lacks complete SARIF accounting",
    );
    cppExtensionsPhysical(
      packet,
      new Map(
        invocation.inputs
          .filter((p) => /\.(?:c|cpp|h|hpp)$/.test(p.path))
          .map((p) => [path.join(workspace, p.path), p.md5]),
      ),
      artifact,
      receipt,
      compiled,
    );
    if (packet.mode === "ctest") {
      const listed = receipt("list", "ctest", [
        "--test-dir",
        build,
        "--show-only=json-v1",
      ]);
      cppRequire(
        listed.exitCode === 0 && !listed.stderr.trim(),
        "Native CTest inventory incomplete",
      );
      const names = cppExtensionsCTestScope(listed.stdout, c, workspace, build);
      const row = receipt("test", "ctest", [
        "--test-dir",
        build,
        "--output-on-failure",
        "--parallel",
        "1",
        "--output-junit",
        path.join(build, "results.xml"),
      ]);
      const result = cppCtest(artifact("results.xml"), names, row.exitCode);
      cppCtestConsole(row.stdout, row.stderr, names, result.tests);
      for (const name of result.failed) {
        const target = c.targets.find(
            (t) => t.name === c.tests.find((t) => t.name === name)!.target,
          )!,
          file = path.posix.join(target.directory, "CMakeLists.txt"),
          registration = cppExtensionsCmake(c)[file]!;
        finding(
          "ctest/callback",
          `Registered CTest callback ${name} failed; this location registers the executable and does not identify its failing assertion`,
          path.join(workspace, file),
          registration
            .split("\n")
            .findIndex((l) => l.startsWith(`add_test(NAME ${name} `)) + 1,
        );
      }
      const complete = finish(
        result.tests.failed > 0,
        result.tests.skipped === 0,
      );
      return {
        ...complete,
        status: result.tests.skipped ? "inconclusive" : complete.status,
        reason:
          "Native CTest registrations, callback outcomes and counters reconciled; executable assertion counts are unknown.",
        tests: result.tests,
      };
    }
    if (packet.mode === "clang-format")
      for (const pin of invocation.inputs.filter((p) =>
        /\.(?:c|cpp|h|hpp)$/.test(p.path),
      )) {
        const row = receipt("format:" + pin.path, "clang-format", [
          `--style=${cppFormatStyle}`,
          "--output-replacements-xml",
          path.join(workspace, pin.path),
        ]);
        cppRequire(
          row.exitCode === 0 && !row.stderr.trim(),
          "Native formatter incomplete",
        );
        for (const r of cppFormat(
          row.stdout,
          new TextDecoder("utf-8", { fatal: true }).decode(source(pin.path)),
        ))
          finding(
            "clang-format/replacement",
            "Native formatting replacement required",
            path.join(workspace, pin.path),
            r.line,
          );
      }
    if (packet.mode === "clang-tidy") {
      const enabled = receipt("tidy-rules", "clang-tidy", [
        "--config={InheritParentConfig: false}",
        `--checks=-*,${c.tidyRules.join(",")}`,
        "--list-checks",
      ]);
      cppRequire(
        enabled.exitCode === 0 &&
          !enabled.stderr.trim() &&
          enabled.stdout.startsWith("Enabled checks:\n") &&
          cppSame(
            enabled.stdout
              .trim()
              .split("\n")
              .slice(1)
              .map((l) => l.trim()),
            cppTidyEnabled(c),
          ),
        "Native enabled analyzer rules differ",
      );
      for (const unit of cppExtensionsUnits(c)) {
        const fixes = `fixes-${unit.target}-${path.basename(unit.file)}.yaml`;
        const row = receipt(`tidy:${unit.file}`, "clang-tidy", [
          "-p",
          build,
          "--config={InheritParentConfig: false}",
          `--checks=-*,${c.tidyRules.join(",")}`,
          "--warnings-as-errors=*",
          "--header-filter=.*",
          `--export-fixes=${path.join(build, fixes)}`,
          path.join(workspace, unit.file),
        ]);
        const a = packet.artifacts.find((a) => a.path === fixes);
        if (!a) {
          cppRequire(
            row.exitCode === 0 && !row.stdout.trim() && !row.stderr.trim(),
            "Analyzer lacks native diagnostics",
          );
          continue;
        }
        cppRequire(row.exitCode === 1, "Analyzer diagnostic/status differs");
        const diagnostics = cppExtensionsTidyDiagnostics(
          c,
          workspace,
          path.join(build, unit.directory),
          unit.file,
          artifact(fixes),
          row.stdout,
          row.stderr,
          source,
        );
        for (const d of diagnostics)
          finding(
            `clang-tidy/${d.rule}`,
            d.message,
            path.join(workspace, d.file),
            d.line,
          );
      }
    }

    return finish(findings.some((f) => f.level === "error"));
  } catch {
    return incomplete;
  }
}
