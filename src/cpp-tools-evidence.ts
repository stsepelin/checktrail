import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parse as yaml } from "yaml";
import {
  cppToolsInvocationSchema,
  cppScope,
  cppCmake,
  cppRequire,
  cppSame,
} from "./cpp-tools.js";
import {
  cppToolNames,
  cppTidyEnabled,
  cppSupportedVersion,
  cppArchive,
  cppConfigure,
  cppUnits,
  cppCompileArgs,
  cppFlags,
  cppWords,
  cppGenerated,
  cppDwarf,
  cppFormat,
  cppCtest,
  cppCtestConsole,
  cppFormatStyle,
  cppMd5,
} from "./cpp-native.js";
import { cppCmakeEvidence, cppCTestScope } from "./cpp-cmake.js";
import { mavenHash } from "./maven.js";
import type { Check, CheckResult, ProcessResult, Finding } from "./types.js";
const text = z.string().max(4 * 1024 * 1024),
  file = z.string().min(1).max(8192),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
export const cppToolsPacketSchema = z.strictObject({
  version: z.literal(1),
  mode: z.enum(["build", "ctest", "clang-format", "clang-tidy"]),
  temporary: file,
  workspace: file,
  build: file,
  inputSha256: digest,
  tools: z
    .array(
      z.strictObject({
        name: z.enum(cppToolNames),
        entry: file,
        resolved: file,
        sha256: digest,
        afterSha256: digest,
      }),
    )
    .length(cppToolNames.length),
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
    .min(cppToolNames.length)
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
});
export function cppToolsEvidence(
  check: Check,
  processes: ProcessResult[],
): Pick<
  CheckResult,
  "status" | "reason" | "findings" | "tests" | "findingsComplete"
> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "C/C++ native evidence is incomplete or inconsistent with declared inputs, commands, targets or cases",
    findingsComplete: false,
  };
  try {
    cppRequire(
      check.commands.length === 1 && processes.length === 1,
      "Native process accounting differs",
    );
    const process = processes[0]!;
    if (
      process.exitCode === 3 &&
      !process.stderr.trim() &&
      !process.truncated &&
      !process.cancelled &&
      !process.timedOut &&
      !process.signal &&
      !process.errorCode
    ) {
      z.strictObject({
        unavailable: z.literal("cpp-tools"),
        reason: z.enum(["missing-tool", "unsupported-version"]),
      }).parse(JSON.parse(process.stdout));
      return {
        status: "unavailable",
        reason:
          "Required C/C++ tools are missing or outside the verified native profile",
        findingsComplete: false,
      };
    }
    cppRequire(
      process.exitCode === 0 &&
        !process.stderr.trim() &&
        !process.signal &&
        !process.cancelled &&
        !process.timedOut &&
        !process.truncated &&
        !process.errorCode,
      "Native collection incomplete",
    );
    const invocation = cppToolsInvocationSchema.parse(
        JSON.parse(check.commands[0]!.args[2]!),
      ),
      c = invocation.config;
    const packet = cppToolsPacketSchema.parse(JSON.parse(process.stdout)),
      { workspace, build } = packet;
    cppScope(
      c,
      invocation.inputs.map((p) => p.path),
    );
    cppRequire(
      invocation.inputs.every(
        (p) => p.sha256 === mavenHash(p.text) && p.md5 === cppMd5(p.text),
      ) &&
        invocation.inputs.find((p) => p.path === "CMakeLists.txt")!.text ===
          cppCmake(c) &&
        JSON.stringify(
          JSON.parse(
            invocation.inputs.find(
              (p) => p.path === "checktrail.cpp-tools.json",
            )!.text,
          ),
        ) === JSON.stringify(c),
      "Native declaration/input identity differs",
    );
    cppRequire(
      check.id === `cpp.${packet.mode}` &&
        check.commands[0]!.args[3] === packet.mode &&
        packet.inputSha256 === mavenHash(JSON.stringify(invocation.inputs)),
      "Native check identity differs",
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
        [...cppToolNames],
      ) &&
        packet.tools.every(
          (t) =>
            path.isAbsolute(t.entry) &&
            path.isAbsolute(t.resolved) &&
            t.sha256 === t.afterSha256,
        ),
      "Native tool identity differs",
    );
    for (const row of packet.receipts)
      cppRequire(
        row.stdoutSha256 === mavenHash(row.stdout) &&
          row.stderrSha256 === mavenHash(row.stderr),
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
        cppRequire(indexes.length === 1, "File API index ambiguous");
        file = indexes[0]!.path;
      }
      const a = packet.artifacts.find((a) => a.path === file);
      cppRequire(a && a.encoding === encoding, "Missing native artifact");
      usedArtifacts.add(file);
      return a.text;
    };
    const completeArtifacts = () =>
      cppRequire(
        packet.artifacts.every((a) => usedArtifacts.has(a.path)),
        "Unreconciled native artifact",
      );
    let position = 0;
    const receipt = (phase: string, name: string, args: string[]) => {
      const row = packet.receipts[position++],
        tool = packet.tools.find((t) => t.name === name)!;
      cppRequire(
        row &&
          row.phase === phase &&
          row.executable === tool.entry &&
          JSON.stringify(row.args) === JSON.stringify(args),
        "Native phase/argument sequence differs",
      );
      return row;
    };
    for (const name of cppToolNames) {
      const row = receipt(
        `version:${name}`,
        name,
        name === "clang" || name === "clang++"
          ? ["--no-default-config", "--version"]
          : ["--version"],
      );
      if (
        row.exitCode !== 0 ||
        row.stderr.trim() ||
        !cppSupportedVersion(name, row.stdout)
      )
        return {
          status: "unavailable",
          reason:
            "C/C++ native tool versions are outside the verified Linux ARM64 profile",
          findingsComplete: false,
        };
    }
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
      cppRequire(
        invocation.inputs.some((p) => p.path === relative) &&
          Number.isSafeInteger(line) &&
          line > 0,
        "Native diagnostic source point outside inputs",
      );
      findings.push({
        ruleId,
        level,
        message: message
          .replaceAll(workspace, "<project>")
          .replaceAll(build, "<build>"),
        file: path.posix.join(check.project, relative),
        line,
      });
    };
    if (packet.mode === "clang-format") {
      const inputs = invocation.inputs.filter((p) =>
        /\.(?:c|cpp|h|hpp)$/.test(p.path),
      );
      cppRequire(
        cppSame(
          inputs.map((p) => p.path),
          check.scope,
        ),
        "Formatter scope differs",
      );
      for (const pin of inputs) {
        const row = receipt(`format:${pin.path}`, "clang-format", [
          `--style=${cppFormatStyle}`,
          "--output-replacements-xml",
          path.join(workspace, pin.path),
        ]);
        cppRequire(
          row.exitCode === 0 && !row.stderr.trim(),
          "Formatter incomplete",
        );
        for (const r of cppFormat(row.stdout, pin.text))
          finding(
            "clang-format/replacement",
            "Native formatting replacement required",
            path.join(workspace, pin.path),
            r.line,
          );
      }
      cppRequire(
        position === packet.receipts.length && packet.artifacts.length === 0,
        "Unexpected formatting evidence",
      );
      return {
        status: findings.length ? "failed" : "passed",
        reason:
          "Native formatting replacements were checked for every declared C/C++ source and header",
        findings,
        findingsComplete: true,
      };
    }
    const configured = receipt(
      "configure",
      "cmake",
      cppConfigure(workspace, build, packet.tools),
    );
    cppRequire(
      configured.exitCode === 0,
      "Native configuration did not complete",
    );
    cppCmakeEvidence(c, workspace, build, packet.tools, artifact);
    for (const g of cppGenerated(invocation))
      cppRequire(artifact(g.path) === g.text, "Generated input differs");
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
          run.tool.driver.rules[d.ruleIndex]?.id === d.ruleId,
          "SARIF rule identity differs",
        );
        if (d.level === "error") errors++;
        const location = d.locations?.[0]?.physicalLocation;
        if (location)
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
        errors > 0 && position === packet.receipts.length,
        "Unexplained or partial native build failure",
      );
      completeArtifacts();
      return {
        status: "failed",
        reason:
          "Native compiler errors prevent complete build, analysis or test evidence",
        findings,
        findingsComplete: false,
      };
    }
    cppRequire(
      errors === 0 && diagnostics.length === cppUnits(c).length,
      "Successful native build lacks complete SARIF accounting",
    );
    const expectedHashes = new Map(
      invocation.inputs
        .filter((p) => /\.(?:c|cpp|h|hpp)$/.test(p.path))
        .map((p) => [path.join(workspace, p.path), p.md5]),
    );
    for (const g of cppGenerated(invocation))
      expectedHashes.set(path.join(build, g.path), g.md5);
    const observed = new Set<string>();
    const dwarf = (phase: string, file: string, required: string[]) => {
      const row = receipt(phase, "llvm-dwarfdump", [
        "--debug-line",
        path.join(build, file),
      ]);
      cppRequire(
        row.exitCode === 0 && !row.stderr.trim(),
        "Native checksum observation incomplete",
      );
      const files = cppDwarf(row.stdout);
      for (const [source, md5] of files) {
        if (
          source.startsWith(workspace + "/") ||
          source.startsWith(build + "/")
        ) {
          cppRequire(
            expectedHashes.get(source) === md5,
            "Compiler-consumed source or header checksum differs",
          );
          observed.add(source);
        }
      }
      for (const f of required)
        cppRequire(
          files.get(path.join(workspace, f)) ===
            expectedHashes.get(path.join(workspace, f)),
          "Native object/link omits a compiled source",
        );
    };
    for (const unit of cppUnits(c)) {
      const words = cppCompileArgs(c, workspace, build, unit),
        insert = words.indexOf("-o");
      const expected = [
        packet.tools.find((t) => t.name === unit.compiler)!.entry,
        ...words.slice(0, insert),
        "-MD",
        "-MT",
        unit.object,
        "-MF",
        unit.object + ".d",
        ...words.slice(insert),
      ];
      cppRequire(
        compiled.stdout
          .split("\n")
          .some(
            (l) =>
              l.startsWith(expected[0]! + " ") &&
              JSON.stringify(cppWords(l)) === JSON.stringify(expected),
          ),
        "Native build omitted or changed compile command",
      );
      cppRequire(
        Buffer.from(artifact(unit.object, "base64"), "base64").length > 0,
        "Native object empty",
      );
      dwarf(`dwarf:${unit.object}`, unit.object, [unit.file]);
    }
    for (const target of c.targets) {
      const binary =
        target.type === "static" ? `lib${target.name}.a` : target.name;
      cppRequire(
        Buffer.from(artifact(binary, "base64"), "base64").length > 0,
        "Native target artifact empty",
      );
      const link = artifact(`CMakeFiles/${target.name}.dir/link.txt`),
        objectFiles = cppUnits(c)
          .filter((u) => u.target === target.name)
          .map((u) => u.object);
      if (target.type === "static") {
        const members = cppArchive(
          Buffer.from(artifact(binary, "base64"), "base64"),
        );
        cppRequire(
          cppSame(
            [...members.keys()],
            objectFiles.map((f) => path.basename(f)),
          ) &&
            objectFiles.every((f) =>
              members
                .get(path.basename(f))!
                .equals(Buffer.from(artifact(f, "base64"), "base64")),
            ),
          "Archived object bytes differ from compiled units",
        );
        const rows = link.trim().split("\n").map(cppWords);
        cppRequire(
          rows.some(
            (r) =>
              JSON.stringify(r) ===
              JSON.stringify([
                packet.tools.find((t) => t.name === "llvm-ar")!.entry,
                "qc",
                binary,
                ...objectFiles,
              ]),
          ) &&
            rows.some(
              (r) =>
                JSON.stringify(r) ===
                JSON.stringify([
                  packet.tools.find((t) => t.name === "llvm-ranlib")!.entry,
                  binary,
                ]),
            ),
          "Native archive commands differ",
        );
        const row = receipt(`archive:${target.name}`, "llvm-ar", [
          "t",
          path.join(build, binary),
        ]);
        cppRequire(
          row.exitCode === 0 &&
            !row.stderr.trim() &&
            cppSame(
              row.stdout.trim().split("\n"),
              objectFiles.map((f) => path.basename(f)),
            ),
          "Native archive members differ",
        );
      } else {
        const linkedSources = [
          ...target.sources,
          ...target.dependencies.flatMap(
            (n) => c.targets.find((t) => t.name === n)!.sources,
          ),
        ];
        const compiler = linkedSources.some((f) => f.endsWith(".cpp"))
          ? "clang++"
          : "clang";
        const expected = [
          packet.tools.find((t) => t.name === compiler)!.entry,
          ...cppFlags,
          "-g",
          "-Xlinker",
          `--dependency-file=CMakeFiles/${target.name}.dir/link.d`,
          ...objectFiles,
          "-o",
          binary,
          ...target.dependencies.map((n) => `lib${n}.a`),
        ];
        cppRequire(
          JSON.stringify(cppWords(link)) === JSON.stringify(expected) &&
            compiled.stdout
              .split("\n")
              .some(
                (l) =>
                  l.startsWith(expected[0]! + " ") &&
                  JSON.stringify(cppWords(l)) === JSON.stringify(expected),
              ),
          "Native link command differs",
        );
        dwarf(`dwarf:${target.name}`, binary, target.sources);
      }
    }
    cppRequire(
      cppSame([...observed], [...expectedHashes.keys()]),
      "Native compiler scope omits inventoried or generated headers",
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
      const names = cppCTestScope(listed.stdout, c, workspace, build);
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
      for (const name of result.failed)
        finding(
          "ctest/callback",
          `Registered CTest callback ${name} failed; this location registers the executable, and does not identify its failing assertion`,
          path.join(workspace, "CMakeLists.txt"),
          cppCmake(c)
            .split("\n")
            .findIndex((l) => l.startsWith(`add_test(NAME ${name} `)) + 1,
        );
      cppRequire(
        position === packet.receipts.length,
        "Unexpected CTest phases",
      );
      completeArtifacts();
      return {
        status: result.tests.failed
          ? "failed"
          : result.tests.skipped
            ? "inconclusive"
            : "passed",
        reason:
          "Native CTest registrations, executed callback outcomes and all counters reconciled; executable assertion counts are unknown",
        tests: result.tests,
        findings,
        findingsComplete: result.tests.skipped === 0,
      };
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
      for (const unit of cppUnits(c)) {
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
        const data = z
          .object({
            MainSourceFile: z.literal(path.join(workspace, unit.file)),
            Diagnostics: z
              .array(
                z.object({
                  DiagnosticName: z.string(),
                  DiagnosticMessage: z.object({
                    Message: z.string(),
                    FilePath: z.string(),
                    FileOffset: z.number().int().nonnegative(),
                    Replacements: z.array(z.unknown()).length(0),
                  }),
                  Notes: z.array(z.unknown()).optional(),
                  Level: z.literal("Error"),
                  BuildDirectory: z.literal(build),
                }),
              )
              .min(1),
          })
          .parse(yaml(artifact(fixes)));
        cppRequire(
          row.exitCode === 1 &&
            data.Diagnostics.every(
              (d) =>
                cppTidyEnabled(c).includes(d.DiagnosticName) &&
                row.stdout.includes(
                  `[${d.DiagnosticName},-warnings-as-errors]`,
                ),
            ),
          "Analyzer diagnostic/status/rule differs",
        );
        for (const d of data.Diagnostics) {
          const relative = path
            .relative(workspace, d.DiagnosticMessage.FilePath)
            .split(path.sep)
            .join("/");
          const input = invocation.inputs.find((p) => p.path === relative);
          cppRequire(
            input &&
              d.DiagnosticMessage.FileOffset < Buffer.byteLength(input.text),
            "Analyzer diagnostic offset outside source",
          );
          finding(
            `clang-tidy/${d.DiagnosticName}`,
            d.DiagnosticMessage.Message,
            d.DiagnosticMessage.FilePath,
            Buffer.from(input.text)
              .subarray(0, d.DiagnosticMessage.FileOffset)
              .toString("utf8")
              .split("\n").length,
          );
        }
      }
    }
    cppRequire(position === packet.receipts.length, "Unexpected C/C++ phases");
    completeArtifacts();
    return {
      status: findings.some((f) => f.level === "error") ? "failed" : "passed",
      reason:
        "Native CMake compilation, archive/link participation and consumed source/header checksums reconcile with the finite declared profile",
      findings,
      findingsComplete: true,
    };
  } catch {
    return incomplete;
  }
}
