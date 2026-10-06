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
  rm,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { mavenHash, mavenLocal } from "./maven.js";
import {
  helmInvocationSchema,
  helmInputs,
  helmRequire,
  helmBinarySha256,
  helmVersionArgs,
  helmLintArgs,
  helmRenderArgs,
} from "./helm.js";
class ToolUnavailable extends Error {}
async function regular(file: string, limit = 65536) {
  const stat = await lstat(file);
  helmRequire(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size <= limit &&
      (await realpath(file)) === file,
    "Not a canonical bounded regular file",
  );
  const bytes = await readFile(file);
  helmRequire(bytes.length <= limit, "File grew");
  return bytes;
}
async function tool() {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const entry = path.resolve(directory, "helm");
    try {
      await access(entry, constants.X_OK);
    } catch {
      continue;
    }
    const resolved = await realpath(entry),
      sha256 = mavenHash(await regular(resolved, 128 * 1024 * 1024));
    if (sha256 !== helmBinarySha256) throw new ToolUnavailable();
    return { entry, resolved, sha256, afterSha256: "" };
  }
  throw new ToolUnavailable();
}
async function tree(
  root: string,
  ignoreOperatorArtifacts = false,
): Promise<string[]> {
  const files: string[] = [];
  let seen = 0;
  async function walk(folder: string, prefix: string) {
    for (const name of await readdir(folder)) {
      if (
        ignoreOperatorArtifacts &&
        !prefix &&
        [".git", ".checktrail"].includes(name)
      )
        continue;
      helmRequire(
        ++seen <= 64 && prefix.split("/").length <= 4,
        "Chart tree bound exceeded",
      );
      const file = path.join(folder, name),
        relative = prefix + name,
        stat = await lstat(file);
      helmRequire(!stat.isSymbolicLink(), "Unexpected link");
      if (stat.isDirectory()) await walk(file, relative + "/");
      else {
        helmRequire(stat.isFile(), "Unexpected entry");
        files.push(relative);
      }
    }
  }
  await walk(root, "");
  return files.sort();
}
async function main() {
  if (process.platform !== "linux" || process.arch !== "arm64")
    throw new ToolUnavailable();
  const root = await realpath(process.argv[2]!),
    project = path.relative(root, process.cwd()),
    invocation = helmInvocationSchema.parse(JSON.parse(process.argv[3]!)),
    model = helmInputs(invocation),
    binary = await tool();
  const verify = async (base: string, relative: string) => {
    for (const input of invocation.inputs)
      helmRequire(
        mavenHash(
          await regular(await mavenLocal(base, relative, input.path)),
        ) === input.sha256,
        "Input changed",
      );
  };
  const verifyOriginalClosure = async () => {
    const files = await tree(process.cwd(), true),
      expected = invocation.inputs.map((i) => i.path);
    if (files.includes("checktrail.json")) expected.push("checktrail.json");
    helmRequire(
      JSON.stringify(files) === JSON.stringify(expected.sort()),
      "Original chart closure differs",
    );
  };
  await verifyOriginalClosure();
  await verify(root, project);
  const temporary = await mkdtemp(
      path.join(process.env.CHECKTRAIL_TEMP || tmpdir(), "helm-"),
    ),
    source = path.join(temporary, "source"),
    workspace = path.join(temporary, "native"),
    chart = path.join(workspace, "chart"),
    home = path.join(temporary, "home"),
    scratch = path.join(temporary, "tmp");
  try {
    for (const dir of [source, chart, home, scratch])
      await mkdir(dir, { recursive: true });
    for (const input of invocation.inputs) {
      {
        const target = path.join(source, input.path);
        await mkdir(path.dirname(target), { recursive: true });
        await cp(await mavenLocal(root, project, input.path), target, {
          force: false,
          errorOnExist: true,
        });
      }
      if (input.path !== "checktrail.helm.json") {
        const target = path.join(chart, input.path);
        await mkdir(path.dirname(target), { recursive: true });
        await cp(await mavenLocal(root, project, input.path), target, {
          force: false,
          errorOnExist: true,
        });
      }
    }
    const verifyCopies = async () => {
      await verify(temporary, "source");
      helmRequire(
        JSON.stringify(await tree(source)) ===
          JSON.stringify(invocation.inputs.map((i) => i.path).sort()),
        "Source copy closure differs",
      );
      helmRequire(
        JSON.stringify(await tree(chart)) ===
          JSON.stringify([...model.scope].sort()),
        "Native chart closure differs",
      );
      for (const file of model.scope)
        helmRequire(
          mavenHash(await regular(path.join(chart, file))) ===
            model.get(file).sha256,
          "Native source changed",
        );
    };
    await verifyCopies();
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      TMPDIR: scratch,
      LANG: "C",
      LC_ALL: "C",
      NO_COLOR: "1",
      KUBECONFIG: path.join(home, "no-cluster"),
      HELM_CACHE_HOME: path.join(home, "cache"),
      HELM_CONFIG_HOME: path.join(home, "config"),
      HELM_DATA_HOME: path.join(home, "data"),
      HELM_PLUGINS: path.join(home, "no-plugins"),
      HELM_REGISTRY_CONFIG: path.join(home, "registry.json"),
      HELM_REPOSITORY_CONFIG: path.join(home, "repositories.yaml"),
      HELM_REPOSITORY_CACHE: path.join(home, "repository-cache"),
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
      helmRequire(
        !result.error && !result.signal && result.status !== null,
        "Native process incomplete",
      );
      total +=
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
      helmRequire(total <= 1024 * 1024, "Native output bound exceeded");
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
    const version = invoke("version", helmVersionArgs);
    if (version.exitCode !== 0 || version.stdout !== "v4.3.0" || version.stderr)
      throw new ToolUnavailable();
    const receipts =
      process.argv[4] === "--version"
        ? [version]
        : [
            version,
            invoke("lint", helmLintArgs),
            invoke("render", helmRenderArgs),
          ];
    await verifyOriginalClosure();
    await verify(root, project);
    await verifyCopies();
    helmRequire(
      (await realpath(binary.entry)) === binary.resolved,
      "Tool path changed",
    );
    binary.afterSha256 = mavenHash(
      await regular(binary.resolved, 128 * 1024 * 1024),
    );
    helmRequire(binary.afterSha256 === binary.sha256, "Tool changed");
    if (process.argv[4] === "--version") {
      process.stdout.write(version.stdout);
      return;
    }
    process.stdout.write(
      JSON.stringify({
        version: 1,
        temporary,
        workspace,
        source,
        inputSha256: mavenHash(JSON.stringify(invocation.inputs)),
        tool: binary,
        inputs: invocation.inputs.map((i) => ({
          file: i.path,
          originalAfterSha256: i.sha256,
          sourceAfterSha256: i.sha256,
          ...(i.path !== "checktrail.helm.json"
            ? { nativeAfterSha256: i.sha256 }
            : {}),
        })),
        receipts,
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch((error) => {
  if (error instanceof ToolUnavailable) {
    process.stdout.write(JSON.stringify({ unavailable: "helm-toolchain" }));
    process.exitCode = 3;
  } else {
    process.stderr.write("Helm native collection unavailable or incomplete\n");
    process.exitCode = 2;
  }
});
