import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  realpath,
  readFile,
  mkdtemp,
  mkdir,
  cp,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  terraformInvocationSchema,
  terraformModules,
  terraformBinarySha256,
  terraformRequire,
} from "./terraform.js";
import { mavenHash, mavenLocal } from "./maven.js";
class ToolUnavailable extends Error {}
async function regular(file: string, limit = 1024 * 1024) {
  const stat = await lstat(file);
  terraformRequire(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size <= limit &&
      (await realpath(file)) === file,
    "Not a bounded canonical regular file",
  );
  const bytes = await readFile(file);
  terraformRequire(bytes.length <= limit, "File grew");
  return bytes;
}
async function tool() {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const entry = path.resolve(directory, "terraform");
    try {
      await access(entry, constants.X_OK);
    } catch {
      continue;
    }
    const resolved = await realpath(entry),
      sha256 = mavenHash(await regular(resolved, 128 * 1024 * 1024));
    if (sha256 !== terraformBinarySha256) throw new ToolUnavailable();
    return { entry, resolved, sha256, afterSha256: "" };
  }
  throw new ToolUnavailable();
}
async function main() {
  if (process.platform !== "linux" || process.arch !== "arm64")
    throw new ToolUnavailable();
  const root = await realpath(process.argv[2]!),
    project = path.relative(root, process.cwd());
  const invocation = terraformInvocationSchema.parse(
      JSON.parse(process.argv[3]!),
    ),
    modules = terraformModules(invocation),
    binary = await tool();
  const verify = async (base: string, relative: string) => {
    for (const input of invocation.inputs)
      terraformRequire(
        mavenHash(
          await regular(await mavenLocal(base, relative, input.path)),
        ) === input.sha256,
        "Input changed",
      );
  };
  await verify(root, project);
  const temporary = await mkdtemp(
    path.join(process.env.CHECKTRAIL_TEMP || tmpdir(), "terraform-"),
  );
  const source = path.join(temporary, "source"),
    workspace = path.join(temporary, "native"),
    home = path.join(temporary, "home"),
    scratch = path.join(temporary, "tmp");
  try {
    for (const dir of [source, workspace, home, scratch])
      await mkdir(dir, { recursive: true });
    for (const input of invocation.inputs) {
      const target = path.join(source, input.path);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(await mavenLocal(root, project, input.path), target, {
        force: false,
        errorOnExist: true,
      });
    }
    for (const input of invocation.inputs.filter((i) =>
      invocation.config.files.includes(i.path),
    ))
      await cp(
        await mavenLocal(root, project, input.path),
        path.join(workspace, input.path),
        { force: false, errorOnExist: true },
      );
    const verifyNative = async () => {
      terraformRequire(
        JSON.stringify((await readdir(workspace)).sort()) ===
          JSON.stringify([...invocation.config.files].sort()),
        "Native module scope changed",
      );
      for (const module of modules)
        terraformRequire(
          mavenHash(await regular(path.join(workspace, module.file))) ===
            module.sha256,
          "Native copied module changed",
        );
    };
    await verifyNative();
    const cliConfig = path.join(home, "terraform.rc");
    await writeFile(cliConfig, "", { flag: "wx" });
    await verify(temporary, "source");
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      TMPDIR: scratch,
      LANG: "C",
      LC_ALL: "C",
      NO_COLOR: "1",
      TF_CLI_CONFIG_FILE: cliConfig,
      TF_DATA_DIR: path.join(temporary, "data"),
      TF_IN_AUTOMATION: "1",
      TF_INPUT: "0",
      TF_WORKSPACE: "default",
      CHECKPOINT_DISABLE: "1",
    };
    let total = 0;
    const invoke = (phase: string, args: string[]) => {
      const result = spawnSync(binary.entry, args, {
        cwd: workspace,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 1024 * 1024,
      });
      terraformRequire(
        !result.error && !result.signal && result.status !== null,
        "Native process incomplete",
      );
      total +=
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
      terraformRequire(total <= 1024 * 1024, "Native output exceeded bound");
      return {
        phase,
        executable: binary.entry,
        args,
        exitCode: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        stdoutSha256: mavenHash(result.stdout),
        stderrSha256: mavenHash(result.stderr),
      };
    };
    const version = invoke("version", ["version", "-json"]);
    if (
      version.exitCode !== 0 ||
      version.stderr ||
      JSON.parse(version.stdout).terraform_version !== "1.16.5" ||
      JSON.parse(version.stdout).platform !== "linux_arm64"
    )
      throw new ToolUnavailable();
    if (process.argv[4] === "--version") {
      terraformRequire(
        mavenHash(await regular(binary.resolved, 128 * 1024 * 1024)) ===
          binary.sha256,
        "Tool bytes changed",
      );
      process.stdout.write("Terraform v1.16.5\n");
      return;
    }
    const validation = invoke("validate", ["validate", "-json", "-no-color"]);
    await verify(root, project);
    await verify(temporary, "source");
    await verifyNative();
    const observed = [];
    for (const module of modules) {
      const afterSha256 = mavenHash(
        await regular(path.join(workspace, module.file)),
      );
      terraformRequire(afterSha256 === module.sha256, "Copied module changed");
      observed.push({ ...module, afterSha256 });
    }
    terraformRequire(
      (await regular(cliConfig)).length === 0,
      "CLI configuration changed",
    );
    terraformRequire(
      (await realpath(binary.entry)) === binary.resolved,
      "Tool path changed",
    );
    binary.afterSha256 = mavenHash(
      await regular(binary.resolved, 128 * 1024 * 1024),
    );
    terraformRequire(
      binary.afterSha256 === binary.sha256,
      "Tool bytes changed",
    );
    process.stdout.write(
      JSON.stringify({
        version: 1,
        temporary,
        workspace,
        source,
        inputSha256: mavenHash(JSON.stringify(invocation.inputs)),
        tool: binary,
        modules: observed,
        cliConfig: {
          file: cliConfig,
          sha256: mavenHash(""),
          afterSha256: mavenHash(""),
        },
        receipts: [version, validation],
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch((error) => {
  if (error instanceof ToolUnavailable) {
    process.stdout.write(
      JSON.stringify({ unavailable: "terraform-toolchain" }),
    );
    process.exitCode = 3;
  } else {
    process.stderr.write(
      "Terraform native collection unavailable or incomplete\n",
    );
    process.exitCode = 2;
  }
});
