import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readProjectFile, withinRoot } from "./inventory.js";
import type { Check, Inventory, Project } from "./types.js";

const text = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => !value.includes("\0"));
export const clangDatabaseSchema = z
  .array(
    z.strictObject({
      directory: text,
      file: text,
      arguments: z.array(text).min(2).max(256).optional(),
      command: text.optional(),
      output: text.optional(),
    }),
  )
  .min(1)
  .max(64);
export const clangUnitSchema = z.strictObject({
  compiler: z.enum(["clang", "clang++"]),
  cwd: z.string(),
  file: z.string(),
  input: z.string().min(1),
  args: z.array(z.string()),
});
export const clangInvocationSchema = z.strictObject({
  units: z.array(clangUnitSchema).min(1).max(64),
  scope: z.array(z.string()).min(1).max(20_000),
});
export type ClangUnit = z.infer<typeof clangUnitSchema>;
export const clangEnvironment = {
  // Clang treats a leading # as a quiet, empty override list.
  CCC_OVERRIDE_OPTIONS: "#",
  CPATH: "",
  C_INCLUDE_PATH: "",
  CPLUS_INCLUDE_PATH: "",
  OBJC_INCLUDE_PATH: "",
  CLANG_CONFIG_FILE_USER_DIR: "",
  CLANG_CONFIG_FILE_SYSTEM_DIR: "",
};
const sourceExtension = /\.(?:c|cc|cpp|cxx|C|c\+\+)$/;
const inventoriedExtension =
  /\.(?:c|cc|cpp|cxx|C|c\+\+|h|hh|hpp|hxx|h\+\+|inc|ipp|tpp|ixx|cppm)$/;

export async function clangExecutableMatches(
  name: "clang" | "clang++",
  declared: string,
): Promise<boolean> {
  if (declared === name) return true;
  if (!path.isAbsolute(declared) || path.basename(declared) !== name)
    return false;
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.resolve(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return (await realpath(candidate)) === (await realpath(declared));
    } catch {
      /* Keep searching PATH until its first executable is found. */
    }
  }
  return false;
}

async function databaseUnits(
  source: Inventory,
  project: Project,
): Promise<ClangUnit[]> {
  const database = clangDatabaseSchema.parse(
    JSON.parse(
      await readProjectFile(
        source.root,
        path.posix.join(project.path, "compile_commands.json"),
      ),
    ),
  );
  const projectRoot = await withinRoot(source.root, project.path);
  const units: ClangUnit[] = [];
  for (const entry of database) {
    if (!entry.arguments)
      throw new Error(
        "Shell-string compilation databases require an arguments-array export",
      );
    const cwd = await withinRoot(
      source.root,
      path.relative(source.root, path.resolve(projectRoot, entry.directory)),
    );
    if (!(await stat(cwd)).isDirectory())
      throw new Error("Compilation directory must exist");
    const absolute = await withinRoot(
      source.root,
      path.relative(source.root, path.resolve(cwd, entry.file)),
    );
    const file = path.relative(projectRoot, absolute).split(path.sep).join("/");
    if (!sourceExtension.test(file) || !project.files.includes(file))
      throw new Error(
        "Compilation database includes a non-inventoried translation unit",
      );
    const declared = entry.arguments[0]!;
    const compiler = path.basename(declared);
    if (
      (compiler !== "clang" && compiler !== "clang++") ||
      !(await clangExecutableMatches(compiler, declared))
    )
      throw new Error(
        "Compilation database must select the registered PATH Clang executable",
      );
    const args: string[] = [];
    let inputs = 0;
    let input = "";
    let compileOnly = false;
    for (let i = 1; i < entry.arguments.length; i++) {
      const arg = entry.arguments[i]!;
      if (arg === "-c") {
        compileOnly = true;
        continue;
      }
      if (arg === "-o" || arg === "-MF" || arg === "-MT" || arg === "-MQ") {
        if (!entry.arguments[++i])
          throw new Error("Missing compilation output argument");
        continue;
      }
      if (["-MD", "-MMD", "-MP", "-g", "-g0"].includes(arg)) continue;
      if (
        /^-std=(?:c(?:89|90|99|11|17|18|23|2x)|gnu(?:89|90|99|11|17|18|23|2x)|(?:c|gnu)\+\+(?:98|03|11|14|17|20|23|2b|26|2c))$/.test(
          arg,
        ) ||
        /^-O[0-3sgz]$/.test(arg) ||
        ["-fPIC", "-fPIE", "-fno-exceptions", "-fno-rtti", "-pthread"].includes(
          arg,
        ) ||
        /^-W(?:all|extra|error|pedantic|conversion|sign-conversion|shadow|unused|unused-parameter|no-unused-parameter)$/.test(
          arg,
        )
      ) {
        args.push(arg);
        continue;
      }
      const define = /^(-[DU])(.*)$/.exec(arg);
      if (define) {
        const value = define[2] || entry.arguments[++i];
        if (
          !value ||
          !/^[A-Za-z_][A-Za-z0-9_]*(?:=[^\r\n]*)?$/.test(value) ||
          (define[1] === "-U" && value.includes("="))
        )
          throw new Error("Unsupported macro argument");
        args.push(define[1]!, value);
        continue;
      }
      const include = /^(?:-I(.+))$/.exec(arg);
      if (include || ["-I", "-iquote", "-isystem"].includes(arg)) {
        const value = include?.[1] ?? entry.arguments[++i];
        if (!value) throw new Error("Missing include directory");
        const directory = await withinRoot(
          source.root,
          path.relative(source.root, path.resolve(cwd, value)),
        );
        if (!(await stat(directory)).isDirectory())
          throw new Error("Include path must be a directory");
        args.push(include ? "-I" : arg, value);
        continue;
      }
      if (
        arg.startsWith("-") ||
        arg.startsWith("@") ||
        (await withinRoot(
          source.root,
          path.relative(source.root, path.resolve(cwd, arg)),
        )) !== absolute
      )
        throw new Error(
          "Compilation database uses an unsupported compiler flag or input",
        );
      input = arg;
      inputs++;
    }
    if (!compileOnly || inputs !== 1)
      throw new Error(
        "Compilation database must describe exactly one compile-only source input per entry",
      );
    units.push({
      compiler,
      cwd: path.relative(source.root, cwd).split(path.sep).join("/") || ".",
      file,
      input,
      args,
    });
  }
  if (new Set(units.map((unit) => JSON.stringify(unit))).size !== units.length)
    throw new Error("Duplicate compilation database entry");
  return units;
}

export async function clangCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const scope = project.files.filter((file) => inventoriedExtension.test(file));
  const check: Check = {
    id: "cpp.clang-check",
    adapter: project.adapter,
    project: project.path,
    scope,
    kind: "analysis",
    parser: "clang-json",
    commands: [],
    reason:
      "Check prepared Clang compilation database entries without emitting objects; account for native translation-unit and header dependencies.",
  };
  if (!project.files.includes("compile_commands.json"))
    check.unavailableReason =
      "Prepare an inventoried project-root compile_commands.json with arguments arrays; build systems are not run automatically.";
  else if (!scope.length)
    check.unavailableReason = "No C/C++ source was inventoried";
  else if (
    [source.root, project.path, ...scope].some((file) =>
      /[\r\n\\$#:]/.test(file),
    )
  )
    check.unavailableReason =
      "This dependency-file profile does not support newline, backslash, dollar, hash or colon in source paths";
  else if (scope.some((file) => /\.(?:ixx|cppm)$/.test(file)))
    check.unavailableReason =
      "C++ module translation units require a separate verified build profile";
  else {
    try {
      const invocation = JSON.stringify({
        units: await databaseUnits(source, project),
        scope,
      });
      if (Buffer.byteLength(invocation) > 100 * 1024)
        throw new Error(
          "Compilation invocation exceeds the 100 KiB argument limit",
        );
      check.commands.push({
        executable: process.execPath,
        args: [
          fileURLToPath(new URL("./clang-runner.js", import.meta.url)),
          source.root,
          invocation,
        ],
        cwd: project.path,
        env: { ...clangEnvironment, PATH: process.env.PATH ?? "" },
      });
    } catch (error) {
      check.unavailableReason =
        error instanceof Error
          ? error.message
          : "Compilation database could not be prepared";
    }
  }
  return check;
}
