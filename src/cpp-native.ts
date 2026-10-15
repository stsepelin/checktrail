import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import {
  cppRequire,
  cppSame,
  type CppToolsConfig,
  type CppToolsInvocation,
} from "./cpp-tools.js";
import { swiftXmlText } from "./swift-testing.js";
export const cppFlags = [
  "--no-default-config",
  "-fno-implicit-modules",
  "-fno-implicit-module-maps",
  "-fdebug-macro",
  "-gdwarf-5",
  "-fdiagnostics-format=sarif",
  "-Wno-sarif-format-unstable",
];
export const cppToolNames = [
  "clang",
  "clang++",
  "clang-format",
  "clang-tidy",
  "llvm-dwarfdump",
  "llvm-ar",
  "llvm-ranlib",
  "cmake",
  "ctest",
  "make",
] as const;
export const cppFormatStyle =
  "{BasedOnStyle: LLVM, ColumnLimit: 80, IndentWidth: 2}";
export const cppMd5 = (data: string | Buffer) =>
  createHash("md5").update(data).digest("hex");
export const cppUnits = (c: CppToolsConfig) =>
  c.targets.flatMap((t) =>
    t.sources.map((file) => ({
      target: t.name,
      file,
      compiler: file.endsWith(".c") ? "clang" : "clang++",
      object: `CMakeFiles/${t.name}.dir/${file}.o`,
    })),
  );
export function cppConfigure(
  workspace: string,
  build: string,
  tools: { name: string; entry: string }[],
) {
  const entry = (name: string) => tools.find((t) => t.name === name)!.entry;
  return [
    "-S",
    workspace,
    "-B",
    build,
    "-G",
    "Unix Makefiles",
    `-DCMAKE_MAKE_PROGRAM=${entry("make")}`,
    `-DCMAKE_C_COMPILER=${entry("clang")}`,
    `-DCMAKE_CXX_COMPILER=${entry("clang++")}`,
    `-DCMAKE_AR=${entry("llvm-ar")}`,
    `-DCMAKE_RANLIB=${entry("llvm-ranlib")}`,
    "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
    "-DCMAKE_BUILD_TYPE=Debug",
    `-DCMAKE_C_FLAGS=${cppFlags.join(" ")}`,
    `-DCMAKE_CXX_FLAGS=${cppFlags.join(" ")}`,
  ];
}
export function cppCompileArgs(
  c: CppToolsConfig,
  workspace: string,
  build: string,
  unit: ReturnType<typeof cppUnits>[number],
) {
  return [
    ...c.includeDirectories.map((d) => `-I${path.join(workspace, d)}`),
    ...(c.generatedHeaders.length
      ? [`-I${path.join(build, "generated")}`]
      : []),
    ...cppFlags,
    "-g",
    unit.compiler === "clang" ? "-std=c17" : "-std=c++20",
    "-o",
    unit.object,
    "-c",
    path.join(workspace, unit.file),
  ];
}
/** Passive decoder only: native CMake commands never become an executable shell command. */
export function cppWords(command: string): string[] {
  command = command.trim();
  cppRequire(
    command.length <= 32768 && !/[\r\n'"\\`$;&|<>*?[\]{}()]/.test(command),
    "Unsupported native command spelling",
  );
  const words = command.trim().split(/[ \t]+/);
  cppRequire(
    words.length > 0 &&
      words.length <= 256 &&
      words.every((w) => w && !w.startsWith("@")),
    "Unsupported native argument",
  );
  return words;
}
export function cppGenerated(invocation: CppToolsInvocation) {
  return invocation.config.generatedHeaders.map((g) => {
    const source = invocation.inputs.find((p) => p.path === g.template)!.text;
    const names = [...source.matchAll(/@([A-Za-z_][A-Za-z0-9_]*)@/g)].map(
      (m) => m[1]!,
    );
    cppRequire(
      cppSame([...new Set(names)], Object.keys(g.values)) &&
        !source.includes("${"),
      "Generated header variables differ from declaration",
    );
    const text = source.replace(
      /@([A-Za-z_][A-Za-z0-9_]*)@/g,
      (_, key: string) => String(g.values[key]),
    );
    return { path: g.output, text, md5: cppMd5(text) };
  });
}
export function cppDwarf(text: string): Map<string, string> {
  cppRequire(
    text.length <= 1024 * 1024 &&
      text.includes("file format elf64-littleaarch64") &&
      /version: 5\n/.test(text) &&
      /format: DWARF32\n/.test(text),
    "Unsupported native DWARF profile",
  );
  const files = new Map<string, string>();
  const tables = text.split(/(?=debug_line\[0x[0-9a-f]+\])/).slice(1);
  cppRequire(tables.length > 0, "Missing native line tables");
  for (const table of tables) {
    const directories = new Map<number, string>();
    for (const m of table.matchAll(
      /^include_directories\[\s*(\d+)\] = "([^"\r\n]+)"$/gm,
    )) {
      cppRequire(
        !directories.has(Number(m[1])),
        "Duplicate native directory index",
      );
      directories.set(Number(m[1]), m[2]!);
    }
    const compilationDirectory = directories.get(0);
    cppRequire(
      compilationDirectory && path.isAbsolute(compilationDirectory),
      "Native compilation directory missing",
    );
    const matches = [
      ...table.matchAll(
        /^file_names\[\s*(\d+)\]:\n\s+name: "([^"\r\n]+)"\n\s+dir_index: (\d+)(?:\n[ \t]+md5_checksum: ([a-f0-9]{32}))?$/gm,
      ),
    ];
    cppRequire(
      matches.length > 0 &&
        matches.length === [...table.matchAll(/^file_names\[/gm)].length &&
        new Set(matches.map((m) => m[1])).size === matches.length,
      "Native source checksum table incomplete",
    );
    for (const m of matches) {
      const directory = directories.get(Number(m[3]));
      cppRequire(directory, "Missing native directory");
      const file = path.resolve(compilationDirectory, directory, m[2]!);
      cppRequire(
        !files.has(file) || files.get(file) === (m[4] ?? ""),
        "Conflicting native source hashes",
      );
      files.set(file, m[4] ?? "");
    }
  }
  return files;
}
export function cppFormat(text: string, source: string) {
  cppRequire(
    !/<!DOCTYPE|<!ENTITY|<!--/.test(text) &&
      XMLValidator.validate(text) === true,
    "Malformed format XML",
  );
  const schema = z.strictObject({
    replacements: z.strictObject({
      "#text": z.string().regex(/^\s*$/).optional(),
      "@_xml:space": z.literal("preserve"),
      "@_incomplete_format": z.literal("false"),
      replacement: z
        .array(
          z.strictObject({
            "@_offset": z.string().regex(/^\d+$/),
            "@_length": z.string().regex(/^\d+$/),
            "#text": z.string().optional(),
          }),
        )
        .max(20000)
        .optional(),
    }),
  });
  const parsed = schema.parse(
    new XMLParser({
      ignoreAttributes: false,
      ignoreDeclaration: true,
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: false,
      processEntities: false,
      isArray: (n) => n === "replacement",
    }).parse(text),
  );
  const bytes = Buffer.from(source),
    replacements = parsed.replacements.replacement ?? [];
  let end = 0;
  for (const r of replacements) {
    const offset = Number(r["@_offset"]),
      length = Number(r["@_length"]);
    cppRequire(
      Number.isSafeInteger(offset) &&
        Number.isSafeInteger(length) &&
        offset >= end &&
        offset + length <= bytes.length,
      "Invalid replacement byte range",
    );
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
    new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(offset, offset + length),
    );
    cppRequire(
      !Buffer.from(swiftXmlText(r["#text"] ?? "")).equals(
        bytes.subarray(offset, offset + length),
      ),
      "No-op native replacement",
    );
    end = offset + length;
  }
  return replacements.map((r) => ({
    line: bytes.subarray(0, Number(r["@_offset"])).toString("utf8").split("\n")
      .length,
  }));
}
const count = z
  .string()
  .regex(/^\d+$/)
  .refine((v) => Number(v) <= 20000);
const duration = z.string().regex(/^\d+(?:\.\d+)?(?:e-?\d+)?$/);
export function cppCtest(xml: string, names: string[], exitCode: number) {
  cppRequire(
    !/<!DOCTYPE|<!ENTITY|<!--/.test(xml) && XMLValidator.validate(xml) === true,
    "Malformed CTest XML",
  );
  const schema = z.strictObject({
    testsuite: z.strictObject({
      "#text": z.string().regex(/^\s*$/).optional(),
      "@_name": z.literal("(empty)"),
      "@_tests": count,
      "@_failures": count,
      "@_disabled": count,
      "@_skipped": count,
      "@_hostname": z.literal(""),
      "@_time": duration,
      "@_timestamp": z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/),
      testcase: z
        .array(
          z.strictObject({
            "#text": z.string().regex(/^\s*$/).optional(),
            "@_name": z.string(),
            "@_classname": z.string(),
            "@_time": duration,
            "@_status": z.enum(["run", "fail", "notrun", "disabled"]),
            properties: z.literal(""),
            "system-out": z.string(),
            failure: z.strictObject({ "@_message": z.string() }).optional(),
            skipped: z.strictObject({ "@_message": z.string() }).optional(),
          }),
        )
        .max(64)
        .optional(),
    }),
  });
  const suite = schema.parse(
    new XMLParser({
      ignoreAttributes: false,
      ignoreDeclaration: true,
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: false,
      processEntities: false,
      isArray: (n) => n === "testcase",
    }).parse(xml),
  ).testsuite;
  const cases = suite.testcase ?? [];
  cppRequire(
    names.length > 0 &&
      cppSame(
        cases.map((c) => swiftXmlText(c["@_name"])),
        names,
      ),
    "CTest case scope is empty or different",
  );
  const tests = { total: cases.length, passed: 0, failed: 0, skipped: 0 };
  let disabled = 0;
  for (const c of cases) {
    cppRequire(
      c["@_name"] === c["@_classname"],
      "CTest class identity differs",
    );
    if (c["@_status"] === "run") {
      cppRequire(!c.failure && !c.skipped, "Contradictory passed case");
      tests.passed++;
    } else if (c["@_status"] === "fail") {
      cppRequire(c.failure && !c.skipped, "Missing native failure");
      tests.failed++;
    } else if (c["@_status"] === "disabled") {
      cppRequire(!c.failure && !c.skipped, "Contradictory disabled case");
      tests.skipped++;
      disabled++;
    } else {
      cppRequire(c.skipped && !c.failure, "Missing native skip");
      tests.skipped++;
    }
  }
  cppRequire(
    Number(suite["@_tests"]) === tests.total &&
      Number(suite["@_failures"]) === tests.failed &&
      Number(suite["@_disabled"]) === disabled &&
      Number(suite["@_skipped"]) === tests.skipped - disabled &&
      exitCode === (tests.failed ? 8 : 0),
    "CTest counters/status differ",
  );
  return {
    tests,
    failed: names.filter(
      (n) => cases.find((c) => c["@_name"] === n)?.["@_status"] === "fail",
    ),
  };
}
/** Decode bounded GNU ar members to bind each archived object to the observed compiled bytes. */
export function cppArchive(bytes: Buffer): Map<string, Buffer> {
  cppRequire(
    bytes.length <= 4 * 1024 * 1024 &&
      bytes.subarray(0, 8).toString("ascii") === "!<arch>\n",
    "Unsupported archive format",
  );
  const members = new Map<string, Buffer>();
  let offset = 8,
    names: Buffer | undefined;
  while (offset < bytes.length) {
    cppRequire(offset + 60 <= bytes.length, "Truncated archive header");
    const header = bytes.subarray(offset, offset + 60),
      raw = header.subarray(0, 16).toString("ascii").trim();
    cppRequire(
      header.subarray(58, 60).toString("ascii") === "`\n" &&
        /^\d+\s*$/.test(header.subarray(48, 58).toString("ascii")),
      "Malformed archive header",
    );
    const size = Number(header.subarray(48, 58).toString("ascii"));
    offset += 60;
    cppRequire(
      Number.isSafeInteger(size) && offset + size <= bytes.length,
      "Truncated archive member",
    );
    const content = bytes.subarray(offset, offset + size);
    offset += size + (size % 2);
    if (raw === "//") {
      cppRequire(!names, "Duplicate archive name table");
      names = content;
      continue;
    }
    if (raw === "/") continue;
    let name = raw;
    if (/^\/\d+$/.test(name)) {
      const position = Number(name.slice(1));
      cppRequire(
        names && position < names.length,
        "Invalid archive name offset",
      );
      const end = names.indexOf("/\n", position);
      cppRequire(end >= position, "Unterminated archive name");
      name = names.subarray(position, end).toString("utf8");
    } else {
      cppRequire(name.endsWith("/"), "Unsupported archive member spelling");
      name = name.slice(0, -1);
    }
    cppRequire(
      /^[A-Za-z0-9_.-]+$/.test(name) && !members.has(name),
      "Ambiguous archive member",
    );
    members.set(name, content);
  }
  cppRequire(offset === bytes.length && members.size > 0, "Incomplete archive");
  return members;
}
export function cppSupportedVersion(name: string, output: string) {
  const normalized = output.trim();
  if (name === "clang" || name === "clang++")
    return /^Alpine clang version 22\.1\.3\nTarget: aarch64-alpine-linux-musl\nThread model: posix\nInstalledDir: [^\r\n]+$/.test(
      normalized,
    );
  if (name === "clang-format")
    return normalized === "Alpine clang-format version 22.1.3";
  if (name === "cmake" || name === "ctest")
    return (
      normalized ===
      `${name} version 4.2.3\n\nCMake suite maintained and supported by Kitware (kitware.com/cmake).`
    );
  if (name === "make")
    return normalized.startsWith(
      "GNU Make 4.4.1\nBuilt for aarch64-alpine-linux-musl\n",
    );
  return /^LLVM \(http:\/\/llvm.org\/\):\n[ \t]+LLVM version 22\.1\.3\n[ \t]+Optimized build\.$/.test(
    normalized,
  );
}
export function cppCtestConsole(
  stdout: string,
  stderr: string,
  names: string[],
  counts: { total: number; passed: number; failed: number; skipped: number },
) {
  const rows = [
    ...stdout.matchAll(
      /^(\d+)\/(\d+) Test #(\d+): ([A-Za-z_][A-Za-z0-9_]*) \.{2,}[ \t]*(?:\*\*\*)?(Passed|Failed|Skipped|Not Run \(Disabled\))[ \t]+\d+(?:\.\d+)? sec$/gm,
    ),
  ];
  cppRequire(
    cppSame(
      rows.map((r) => r[4]!),
      names,
    ) &&
      rows.every(
        (r, i) =>
          Number(r[1]) === i + 1 &&
          Number(r[2]) === names.length &&
          Number(r[3]) === names.indexOf(r[4]!) + 1,
      ),
    "Native CTest result counters differ",
  );
  cppRequire(
    rows.filter((r) => r[5] === "Passed").length === counts.passed &&
      rows.filter((r) => r[5] === "Failed").length === counts.failed &&
      rows.filter((r) => r[5] === "Skipped" || r[5] === "Not Run (Disabled)")
        .length === counts.skipped,
    "Native CTest console/case outcomes differ",
  );
  const starts = [
    ...stdout.matchAll(/^[ \t]*Start (\d+): ([A-Za-z_][A-Za-z0-9_]*)$/gm),
  ];
  const executed = rows
    .filter((r) => r[5] !== "Not Run (Disabled)")
    .map((r) => r[4]!);
  cppRequire(
    cppSame(
      starts.map((r) => r[2]!),
      executed,
    ) && starts.every((r) => Number(r[1]) === names.indexOf(r[2]!) + 1),
    "Native CTest callback starts differ",
  );
  const summaries = [
    ...stdout.matchAll(
      /^(\d+)% tests passed, (\d+) tests failed out of (\d+)$/gm,
    ),
  ];
  const denominator =
    counts.total - rows.filter((r) => r[5] === "Not Run (Disabled)").length;
  cppRequire(
    denominator > 0 &&
      summaries.length === 1 &&
      Number(summaries[0]![1]) ===
        Math.round((100 * (denominator - counts.failed)) / denominator) &&
      Number(summaries[0]![2]) === counts.failed &&
      Number(summaries[0]![3]) === denominator,
    "Native CTest summary counters differ",
  );
  cppRequire(
    stderr === (counts.failed ? "Errors while running CTest\n" : ""),
    "Unexpected native CTest error output",
  );
}

export class CppToolchainError extends Error {
  constructor(readonly reason: "missing-tool" | "unsupported-version") {
    super("Native toolchain unavailable");
  }
}

// Observed in the pinned native --list-checks profile: any analyzer selection enables core checkers.
export const cppTidyCoreCheckers = [
  "clang-analyzer-core.BitwiseShift",
  "clang-analyzer-core.CallAndMessage",
  "clang-analyzer-core.DivideZero",
  "clang-analyzer-core.DynamicTypePropagation",
  "clang-analyzer-core.FixedAddressDereference",
  "clang-analyzer-core.NonNullParamChecker",
  "clang-analyzer-core.NonnilStringConstants",
  "clang-analyzer-core.NullDereference",
  "clang-analyzer-core.NullPointerArithm",
  "clang-analyzer-core.StackAddressEscape",
  "clang-analyzer-core.UndefinedBinaryOperatorResult",
  "clang-analyzer-core.VLASize",
  "clang-analyzer-core.builtin.AssumeModeling",
  "clang-analyzer-core.builtin.BuiltinFunctions",
  "clang-analyzer-core.builtin.NoReturnFunctions",
  "clang-analyzer-core.uninitialized.ArraySubscript",
  "clang-analyzer-core.uninitialized.Assign",
  "clang-analyzer-core.uninitialized.Branch",
  "clang-analyzer-core.uninitialized.CapturedBlockVariable",
  "clang-analyzer-core.uninitialized.NewArraySize",
  "clang-analyzer-core.uninitialized.UndefReturn",
] as const;
export function cppTidyEnabled(c: Pick<CppToolsConfig, "tidyRules">): string[] {
  return [
    ...(c.tidyRules.includes("bugprone-use-after-move")
      ? ["bugprone-use-after-move"]
      : []),
    ...(c.tidyRules.includes("clang-analyzer-core.DivideZero")
      ? cppTidyCoreCheckers
      : []),
  ];
}
