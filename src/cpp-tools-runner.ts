import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  readFile,
  mkdir,
  mkdtemp,
  cp,
  rm,
  writeFile,
  realpath,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  cppToolsInvocationSchema,
  cppProtectedEnvironment,
  cppScope,
  cppCmake,
  cppRequire,
} from "./cpp-tools.js";
import {
  cppToolNames,
  CppToolchainError,
  cppSupportedVersion,
  cppConfigure,
  cppUnits,
  cppGenerated,
  cppFormatStyle,
  cppMd5,
} from "./cpp-native.js";
import { mavenHash, mavenLocal } from "./maven.js";
async function regular(file: string, limit = 4 * 1024 * 1024) {
  const stat = await lstat(file);
  cppRequire(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size <= limit &&
      (await realpath(file)) === file,
    "Native artifact is not a bounded regular file",
  );
  const bytes = await readFile(file);
  cppRequire(bytes.length <= limit, "Native artifact grew");
  return bytes;
}
async function tool(name: string) {
  for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
    const entry = path.resolve(d, name);
    try {
      await access(entry, constants.X_OK);
    } catch {
      continue;
    }
    const resolved = await realpath(entry);
    return {
      name,
      entry,
      resolved,
      sha256: mavenHash(await regular(resolved, 512 * 1024 * 1024)),
      afterSha256: "",
    };
  }
  throw new CppToolchainError("missing-tool");
}
async function main() {
  const root = await realpath(process.argv[2]!),
    project = path.relative(root, process.cwd());
  const invocation = cppToolsInvocationSchema.parse(
      JSON.parse(process.argv[3]!),
    ),
    config = invocation.config;
  const mode = z
    .enum(["build", "ctest", "clang-format", "clang-tidy"])
    .parse(process.argv[4]);
  cppScope(
    config,
    invocation.inputs.map((p) => p.path),
  );
  cppRequire(
    invocation.inputs.find((p) => p.path === "CMakeLists.txt")!.text ===
      cppCmake(config),
    "CMake declaration differs",
  );
  const verify = async (base: string, relative: string) => {
    for (const pin of invocation.inputs) {
      const bytes = await regular(await mavenLocal(base, relative, pin.path));
      cppRequire(
        pin.sha256 === mavenHash(bytes) &&
          pin.md5 === cppMd5(bytes) &&
          Buffer.from(pin.text).equals(bytes),
        "C/C++ source changed during execution",
      );
    }
  };
  await verify(root, project);
  const temporary = await mkdtemp(
    path.join(process.env.CHECKTRAIL_TEMP || tmpdir(), "cpp-tools-"),
  );
  const workspace = path.join(temporary, "project"),
    build = path.join(temporary, "build");
  cppRequire(
    !/[\s'"\\`$;&|<>]/.test(temporary),
    "Unsupported owned native path spelling",
  );
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env))
    if (
      cppProtectedEnvironment.includes(key) ||
      /^(?:CMAKE_|CTEST_|DYLD_)/.test(key)
    )
      delete env[key];
  Object.assign(env, {
    HOME: path.join(temporary, "home"),
    TMPDIR: path.join(temporary, "tmp"),
    LC_ALL: "C",
    LANG: "C",
    NO_COLOR: "1",
    CCC_OVERRIDE_OPTIONS: "#",
    CLANG_CONFIG_FILE_USER_DIR: "",
    CLANG_CONFIG_FILE_SYSTEM_DIR: "",
    CPATH: "",
    C_INCLUDE_PATH: "",
    CPLUS_INCLUDE_PATH: "",
  });
  const receipts: {
    phase: string;
    executable: string;
    args: string[];
    exitCode: number;
    stdout: string;
    stderr: string;
    stdoutSha256: string;
    stderrSha256: string;
  }[] = [];
  const artifacts: {
    path: string;
    encoding: "utf8" | "base64";
    text: string;
    sha256: string;
    afterSha256: string;
  }[] = [];
  let total = 0;
  try {
    for (const directory of [workspace, build, env.HOME!, env.TMPDIR!])
      await mkdir(directory, { recursive: true });
    for (const pin of invocation.inputs) {
      const target = path.join(workspace, pin.path);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(await mavenLocal(root, project, pin.path), target, {
        force: false,
        errorOnExist: true,
      });
    }
    await verify(temporary, "project");
    const tools = await Promise.all(cppToolNames.map(tool));
    const invoke = (phase: string, name: string, args: string[]) => {
      const executable = tools.find((t) => t.name === name)!.entry;
      const result = spawnSync(executable, args, {
        cwd: build,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 4 * 1024 * 1024,
      });
      cppRequire(
        !result.error && !result.signal && result.status !== null,
        "Native process incomplete",
      );
      total +=
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
      cppRequire(
        total <= 4 * 1024 * 1024,
        "Native output exceeded aggregate bound",
      );
      const row = {
        phase,
        executable,
        args,
        exitCode: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        stdoutSha256: mavenHash(result.stdout),
        stderrSha256: mavenHash(result.stderr),
      };
      receipts.push(row);
      return row;
    };
    const artifact = async (
      file: string,
      encoding: "utf8" | "base64" = "utf8",
    ) => {
      const bytes = await regular(path.join(build, file));
      const text = bytes.toString(encoding);
      total += Buffer.byteLength(text);
      cppRequire(
        total <= 4 * 1024 * 1024,
        "Native artifact output exceeded bound",
      );
      artifacts.push({
        path: file,
        encoding,
        text,
        sha256: mavenHash(bytes),
        afterSha256: "",
      });
    };
    for (const name of cppToolNames) {
      const version = invoke(
        `version:${name}`,
        name,
        name === "clang" || name === "clang++"
          ? ["--no-default-config", "--version"]
          : ["--version"],
      );
      if (
        version.exitCode !== 0 ||
        version.stderr.trim() ||
        !cppSupportedVersion(name, version.stdout)
      )
        throw new CppToolchainError("unsupported-version");
    }
    if (mode === "clang-format") {
      for (const pin of invocation.inputs.filter((p) =>
        /\.(?:c|cpp|h|hpp)$/.test(p.path),
      ))
        invoke(`format:${pin.path}`, "clang-format", [
          `--style=${cppFormatStyle}`,
          "--output-replacements-xml",
          path.join(workspace, pin.path),
        ]);
    } else {
      const query = path.join(build, ".cmake/api/v1/query");
      await mkdir(query, { recursive: true });
      for (const kind of ["codemodel-v2", "cmakeFiles-v1"])
        await writeFile(path.join(query, kind), "");
      const configure = invoke(
        "configure",
        "cmake",
        cppConfigure(workspace, build, tools),
      );
      if (configure.exitCode === 0) {
        const reply = ".cmake/api/v1/reply";
        for (const file of (await readdir(path.join(build, reply))).sort()) {
          cppRequire(
            /^[A-Za-z0-9_.-]+\.json$/.test(file),
            "Unexpected file API artifact",
          );
          await artifact(path.posix.join(reply, file));
        }
        await artifact("compile_commands.json");
        for (const g of cppGenerated(invocation)) {
          const bytes = await regular(path.join(build, g.path));
          cppRequire(
            Buffer.from(g.text).equals(bytes),
            "Generated header differs",
          );
          await artifact(g.path);
        }
        const compiled = invoke("build", "cmake", [
          "--build",
          build,
          "--verbose",
          "--parallel",
          "1",
        ]);
        if (compiled.exitCode === 0) {
          for (const unit of cppUnits(config)) {
            await artifact(unit.object, "base64");
            invoke(`dwarf:${unit.object}`, "llvm-dwarfdump", [
              "--debug-line",
              path.join(build, unit.object),
            ]);
          }
          for (const target of config.targets) {
            const binary =
              target.type === "static" ? `lib${target.name}.a` : target.name;
            await artifact(binary, "base64");
            await artifact(`CMakeFiles/${target.name}.dir/link.txt`);
            if (target.type === "static")
              invoke(`archive:${target.name}`, "llvm-ar", [
                "t",
                path.join(build, binary),
              ]);
            else
              invoke(`dwarf:${target.name}`, "llvm-dwarfdump", [
                "--debug-line",
                path.join(build, binary),
              ]);
          }
          if (mode === "ctest") {
            const listed = invoke("list", "ctest", [
              "--test-dir",
              build,
              "--show-only=json-v1",
            ]);
            if (listed.exitCode === 0) {
              invoke("test", "ctest", [
                "--test-dir",
                build,
                "--output-on-failure",
                "--parallel",
                "1",
                "--output-junit",
                path.join(build, "results.xml"),
              ]);
              await artifact("results.xml");
            }
          } else if (mode === "clang-tidy") {
            invoke("tidy-rules", "clang-tidy", [
              "--config={InheritParentConfig: false}",
              `--checks=-*,${config.tidyRules.join(",")}`,
              "--list-checks",
            ]);
            for (const unit of cppUnits(config)) {
              const fixes = `fixes-${unit.target}-${path.basename(unit.file)}.yaml`;
              invoke(`tidy:${unit.file}`, "clang-tidy", [
                "-p",
                build,
                "--config={InheritParentConfig: false}",
                `--checks=-*,${config.tidyRules.join(",")}`,
                "--warnings-as-errors=*",
                "--header-filter=.*",
                `--export-fixes=${path.join(build, fixes)}`,
                path.join(workspace, unit.file),
              ]);
              try {
                await access(path.join(build, fixes));
              } catch {
                continue;
              }
              await artifact(fixes);
            }
          }
        }
      }
    }
    for (const a of artifacts) {
      a.afterSha256 = mavenHash(await regular(path.join(build, a.path)));
      cppRequire(
        a.afterSha256 === a.sha256,
        "Native artifact changed after observation or execution",
      );
    }
    await verify(root, project);
    await verify(temporary, "project");
    for (const pin of tools) {
      cppRequire(
        (await realpath(pin.entry)) === pin.resolved,
        "Tool executable path changed",
      );
      pin.afterSha256 = mavenHash(
        await regular(pin.resolved, 512 * 1024 * 1024),
      );
      cppRequire(
        pin.afterSha256 === pin.sha256,
        "Tool executable bytes changed",
      );
    }
    process.stdout.write(
      JSON.stringify({
        version: 1,
        mode,
        temporary,
        workspace,
        build,
        inputSha256: mavenHash(JSON.stringify(invocation.inputs)),
        tools,
        receipts,
        artifacts,
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch((error) => {
  if (error instanceof CppToolchainError) {
    process.stdout.write(
      JSON.stringify({ unavailable: "cpp-tools", reason: error.reason }),
    );
    process.exitCode = 3;
    return;
  }
  process.stderr.write("C/C++ native collection unavailable or incomplete\n");
  process.exitCode = 2;
});
