import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { inventory } from "./inventory.js";
import { mavenHash, mavenLocal } from "./maven.js";
import { cppRequire, cppSame, cppProtectedEnvironment } from "./cpp-tools.js";
import {
  cppDwarf,
  CppToolchainError,
  cppMd5,
  cppFormatStyle,
} from "./cpp-native.js";
import {
  cppExtensionsConfigSchema,
  cppExtensionsScope,
  cppExtensionsCmake,
} from "./cpp-extensions-contract.js";
import {
  cppExtensionsInvocationSchema,
  cppExtensionsPolicyFile,
} from "./cpp-extensions.js";
import {
  cppExtensionsToolNames,
  cppExtensionsCrtDebugPins,
  cppExtensionsSupportedVersion,
  cppExtensionsArtifact,
  cppExtensionsConfigure,
  cppExtensionsUnits,
} from "./cpp-extensions-native.js";
import {
  cppExtensionsSdkBytes,
  cppExtensionsDependencies,
} from "./cpp-extensions-sdk.js";
class CppExtensionsSdkUnavailable extends Error {}
async function regular(file: string, limit = 4 * 1024 * 1024) {
  const stat = await lstat(file);
  cppRequire(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size <= limit &&
      (await realpath(file)) === file,
    "Bounded native regular file required",
  );
  const bytes = await readFile(file);
  cppRequire(bytes.length <= limit, "Native regular file grew");
  return bytes;
}
async function tool(name: string) {
  for (const directory of name === "as" || name === "ld"
    ? ["/usr/bin"]
    : (process.env.PATH ?? "").split(path.delimiter)) {
    const entry = path.resolve(directory, name);
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
  const invocation = cppExtensionsInvocationSchema.parse(
      JSON.parse(process.argv[3]!),
    ),
    mode = z
      .enum(["build", "ctest", "clang-format", "clang-tidy"])
      .parse(process.argv[4]);
  const policy = await regular(
    await mavenLocal(root, project, cppExtensionsPolicyFile),
  );
  cppRequire(
    mavenHash(policy) === invocation.configSha256,
    "Current CMake policy differs",
  );
  const config = cppExtensionsConfigSchema.parse(
    JSON.parse(policy.toString("utf8")),
  );
  cppExtensionsScope(
    config,
    invocation.inputs.map((p) => p.path),
  );
  const verify = async (base: string, relative: string, complete: boolean) => {
    if (complete) {
      const captured = await inventory(base),
        prefix =
          relative && relative !== "."
            ? relative.split(path.sep).join("/") + "/"
            : "";
      cppRequire(
        cppSame(
          captured.files
            .filter((f) => f.startsWith(prefix))
            .map((f) => f.slice(prefix.length)),
          invocation.inputs.map((p) => p.path),
        ),
        "Complete current input inventory differs",
      );
    }
    for (const pin of invocation.inputs) {
      const bytes = await regular(await mavenLocal(base, relative, pin.path));
      cppRequire(
        bytes.length <= 4 * 1024 * 1024 &&
          mavenHash(bytes) === pin.sha256 &&
          cppMd5(bytes) === pin.md5,
        "Current C/C++ input bytes differ",
      );
    }
    for (const [file, text] of Object.entries(cppExtensionsCmake(config)))
      cppRequire(
        (await regular(await mavenLocal(base, relative, file))).toString(
          "utf8",
        ) === text,
        "Finite local CMake declaration differs",
      );
  };
  await verify(root, project, true);
  const temporary = await mkdtemp(
      path.join(process.env.CHECKTRAIL_TEMP || tmpdir(), "cpp-extensions-"),
    ),
    workspace = path.join(temporary, "project"),
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
    }[] = [],
    artifacts: {
      path: string;
      encoding: "utf8" | "base64";
      text: string;
      sha256: string;
      afterSha256: string;
    }[] = [];
  const binaries: {
    path: string;
    bytes: number;
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
    await verify(temporary, "project", true);
    const tools = await Promise.all(cppExtensionsToolNames.map(tool));
    const invoke = (phase: string, name: string, args: string[]) => {
      const executable = tools.find((t) => t.name === name)!.entry,
        result = spawnSync(executable, args, {
          cwd: build,
          env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 4 * 1024 * 1024,
        });
      cppRequire(
        !result.error && !result.signal && result.status !== null,
        "Native command incomplete",
      );
      total +=
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
      cppRequire(total <= 4 * 1024 * 1024, "Native output byte bound");
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
      const bytes = await regular(path.join(build, file)),
        text = bytes.toString(encoding);
      total += Buffer.byteLength(text);
      cppRequire(total <= 4 * 1024 * 1024, "Native artifact byte bound");
      artifacts.push({
        path: file,
        encoding,
        text,
        sha256: mavenHash(bytes),
        afterSha256: "",
      });
    };
    const binaryWitness = async (file: string) => {
      const bytes = await regular(path.join(build, file));
      cppRequire(bytes.length > 0, "Native binary empty");
      binaries.push({
        path: file,
        bytes: bytes.length,
        sha256: mavenHash(bytes),
        afterSha256: "",
      });
    };
    for (const name of cppExtensionsToolNames) {
      const version = invoke(
        "version:" + name,
        name,
        name === "clang" || name === "clang++"
          ? ["--no-default-config", "--version"]
          : ["--version"],
      );
      if (
        version.exitCode !== 0 ||
        version.stderr.trim() ||
        !cppExtensionsSupportedVersion(name, version.stdout)
      )
        throw new CppToolchainError("unsupported-version");
    }
    // Selected SDK bytes and aliases are verified before any project CMake evaluation.
    const sdkBefore = await cppExtensionsSdkBytes(config).catch(() => {
      throw new CppExtensionsSdkUnavailable();
    });
    const query = path.join(build, ".cmake/api/v1/query");
    await mkdir(query, { recursive: true });
    for (const kind of ["codemodel-v2", "cmakeFiles-v1"])
      await writeFile(path.join(query, kind), "");
    const configured = invoke(
      "configure",
      "cmake",
      cppExtensionsConfigure(workspace, build, tools),
    );
    const generated: {
      path: string;
      text: string;
      sha256: string;
      md5: string;
    }[] = [];
    const generatedTree = async () => {
      const values: string[] = [];
      for (const directory of [
        ...new Set(
          config.generatedHeaders.map((g) =>
            path.posix.join(g.directory, path.posix.dirname(g.output)),
          ),
        ),
      ]) {
        const entries = await readdir(path.join(build, directory), {
          withFileTypes: true,
        });
        for (const entry of entries) {
          cppRequire(
            entry.isFile() && !entry.isSymbolicLink(),
            "Generated header tree includes a non-file",
          );
          values.push(path.posix.join(directory, entry.name));
        }
      }
      cppRequire(
        cppSame(
          values,
          config.generatedHeaders.map((g) =>
            path.posix.join(g.directory, g.output),
          ),
        ),
        "Complete generated header tree differs",
      );
      return Promise.all(
        values.sort().map(async (file) => ({
          path: file,
          sha256: mavenHash(await regular(path.join(build, file))),
        })),
      );
    };
    let generatedBefore: { path: string; sha256: string }[] = [];
    if (configured.exitCode === 0) {
      for (const file of (
        await readdir(path.join(build, ".cmake/api/v1/reply"))
      ).sort()) {
        cppRequire(
          /^[A-Za-z0-9_.-]+\.json$/.test(file),
          "Invalid native file API name",
        );
        await artifact(".cmake/api/v1/reply/" + file);
      }
      await artifact("compile_commands.json");
      for (const g of config.generatedHeaders) {
        const template = new TextDecoder("utf-8", { fatal: true }).decode(
            await regular(path.join(workspace, g.template)),
          ),
          names = [...template.matchAll(/@([A-Za-z_][A-Za-z0-9_]*)@/g)].map(
            (m) => m[1]!,
          );
        cppRequire(
          cppSame([...new Set(names)], Object.keys(g.values)) &&
            !template.includes("${") &&
            !template.includes("#cmakedefine"),
          "Generated template variables differ",
        );
        const text = template.replace(
            /@([A-Za-z_][A-Za-z0-9_]*)@/g,
            (_, name: string) => String(g.values[name]),
          ),
          file = path.posix.join(g.directory, g.output);
        cppRequire(
          (await regular(path.join(build, file))).equals(Buffer.from(text)),
          "Generated physical header bytes differ",
        );
        generated.push({
          path: file,
          text,
          sha256: mavenHash(text),
          md5: cppMd5(text),
        });
        await artifact(file);
      }
      generatedBefore = await generatedTree();
      const compiled = invoke("build", "cmake", [
        "--build",
        build,
        "--verbose",
        "--parallel",
        "1",
      ]);
      if (compiled.exitCode === 0) {
        for (const pin of cppExtensionsCrtDebugPins) {
          cppRequire(
            config.sdk.some((p) => p.path === pin),
            "SDK CRT debug bytes undeclared",
          );
          invoke("sdk-dwarf:" + pin, "llvm-dwarfdump", [
            "--debug-line",
            "/" + pin,
          ]);
        }
        for (const unit of cppExtensionsUnits(config)) {
          await artifact(unit.object, "base64");
          await artifact(unit.object + ".d");
          invoke("dwarf:" + unit.object, "llvm-dwarfdump", [
            "--debug-line",
            path.join(build, unit.object),
          ]);
        }
        for (const target of config.targets) {
          const binary = cppExtensionsArtifact(config, target.name);
          if (target.type === "static") await artifact(binary, "base64");
          else {
            await binaryWitness(binary);
            invoke("elf:" + target.name, "llvm-readelf", [
              "--wide",
              "--file-header",
              "--dynamic",
              "--symbols",
              path.join(build, binary),
            ]);
          }
          await artifact(
            path.posix.join(
              target.directory,
              `CMakeFiles/${target.name}.dir/link.txt`,
            ),
          );
          if (target.type === "static")
            invoke("archive:" + target.name, "llvm-ar", [
              "t",
              path.join(build, binary),
            ]);
          else {
            await artifact(
              path.posix.join(
                target.directory,
                `CMakeFiles/${target.name}.dir/link.d`,
              ),
            );
            invoke("dwarf:" + target.name, "llvm-dwarfdump", [
              "--debug-line",
              path.join(build, binary),
            ]);
          }
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
        } else if (mode === "clang-format") {
          for (const pin of invocation.inputs.filter((p) =>
            /\.(?:c|cpp|h|hpp)$/.test(p.path),
          ))
            invoke("format:" + pin.path, "clang-format", [
              `--style=${cppFormatStyle}`,
              "--output-replacements-xml",
              path.join(workspace, pin.path),
            ]);
        } else if (mode === "clang-tidy") {
          invoke("tidy-rules", "clang-tidy", [
            "--config={InheritParentConfig: false}",
            `--checks=-*,${config.tidyRules.join(",")}`,
            "--list-checks",
          ]);
          for (const unit of cppExtensionsUnits(config)) {
            const fixes = `fixes-${unit.target}-${path.basename(unit.file)}.yaml`;
            invoke("tidy:" + unit.file, "clang-tidy", [
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
    const generatedAfter =
      configured.exitCode === 0 ? await generatedTree() : [];
    cppRequire(
      JSON.stringify(generatedAfter) === JSON.stringify(generatedBefore),
      "Generated header tree changed",
    );
    const sdkAfter = await cppExtensionsSdkBytes(config);
    cppRequire(
      JSON.stringify(sdkAfter) === JSON.stringify(sdkBefore),
      "SDK bytes or aliases changed",
    );
    for (const a of artifacts) {
      a.afterSha256 = mavenHash(await regular(path.join(build, a.path)));
      cppRequire(a.afterSha256 === a.sha256, "Observed artifact changed");
    }
    for (const b of binaries) {
      const bytes = await regular(path.join(build, b.path));
      cppRequire(bytes.length === b.bytes, "Native binary size changed");
      b.afterSha256 = mavenHash(bytes);
      cppRequire(b.afterSha256 === b.sha256, "Native binary bytes changed");
    }
    const sdkUsed = new Set<string>();
    for (const a of artifacts.filter(
      (a) => a.path.endsWith(".o.d") || a.path.endsWith("/link.d"),
    )) {
      const record = cppExtensionsDependencies(a.text);
      for (const file of record.files) {
        const absolute = path.resolve(build, path.posix.dirname(a.path), file);
        if (absolute.startsWith("/usr/") || absolute.startsWith("/lib/")) {
          const pin = sdkBefore.observed.find((p) => "/" + p.path === absolute);
          cppRequire(pin, "Native dependency outside pinned SDK");
          sdkUsed.add(pin.path);
        }
      }
    }
    for (const row of receipts.filter((r) => r.phase.startsWith("dwarf:"))) {
      for (const [file] of cppDwarf(row.stdout)) {
        if (file.startsWith("/usr/") || file.startsWith("/lib/")) {
          const pin = sdkBefore.observed.find((p) => "/" + p.path === file);
          cppRequire(pin, "Native checksum outside pinned SDK");
          sdkUsed.add(pin.path);
        }
      }
    }
    await verify(root, project, true);
    await verify(temporary, "project", true);
    for (const pin of tools) {
      cppRequire(
        (await realpath(pin.entry)) === pin.resolved,
        "Selected tool alias changed",
      );
      pin.afterSha256 = mavenHash(
        await regular(pin.resolved, 512 * 1024 * 1024),
      );
      cppRequire(pin.afterSha256 === pin.sha256, "Selected tool bytes changed");
    }
    process.stdout.write(
      JSON.stringify({
        version: 1,
        mode,
        temporary,
        workspace,
        build,
        config,
        configSha256: invocation.configSha256,
        inputSha256: mavenHash(JSON.stringify(invocation.inputs)),
        tools,
        receipts,
        artifacts,
        generated,
        generatedBefore,
        generatedAfter,
        binaries,
        sdkObserved: sdkBefore.observed.filter((p) => sdkUsed.has(p.path)),
        sdkBeforeSha256: sdkBefore.sha256,
        sdkAfterSha256: sdkAfter.sha256,
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch((error) => {
  if (
    error instanceof CppToolchainError ||
    error instanceof CppExtensionsSdkUnavailable
  ) {
    process.stdout.write(
      JSON.stringify({
        unavailable: "cpp-extensions",
        reason:
          error instanceof CppExtensionsSdkUnavailable
            ? "unsupported-sdk"
            : error.reason,
      }),
    );
    process.exitCode = 3;
    return;
  }
  process.stderr.write(
    "C/C++ extension collection unavailable or incomplete\n",
  );
  process.exitCode = 2;
});
