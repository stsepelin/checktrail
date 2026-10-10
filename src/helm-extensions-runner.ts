import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { mavenHash } from "./maven.js";
import {
  helmRequire,
  helmBinarySha256,
  helmVersionArgs,
  helmRenderArgs,
} from "./helm.js";
import {
  helmExtensionsInvocationSchema,
  helmExtensionsVerify,
  helmExtensionsRegular,
  helmExtensionsJson,
} from "./helm-extensions-physical.js";
import { helmExtensionsLintArgs } from "./helm-extensions-contract.js";
class HelmExtensionsUnavailable extends Error {}
async function selectedTool() {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const entry = path.resolve(directory, "helm");
    try {
      await access(entry, constants.X_OK);
    } catch {
      continue;
    }
    try {
      const resolved = await realpath(entry),
        bytes = helmExtensionsRegular(resolved, 128 * 1024 * 1024);
      if (mavenHash(bytes) !== helmBinarySha256)
        throw new HelmExtensionsUnavailable();
      return {
        entry,
        resolved,
        bytes: bytes.length,
        sha256: mavenHash(bytes),
        afterSha256: "",
      };
    } catch {
      throw new HelmExtensionsUnavailable();
    }
  }
  throw new HelmExtensionsUnavailable();
}
async function tree(base: string) {
  const files: string[] = [];
  let entries = 0,
    total = 0;
  const walk = async (relative: string, depth: number) => {
    helmRequire(depth <= 32, "Native chart depth bound");
    for (const e of await readdir(path.join(base, relative), {
      withFileTypes: true,
    })) {
      helmRequire(
        ++entries <= 4096 && !e.isSymbolicLink(),
        "Native chart entry/alias bound",
      );
      const f = path.posix.join(relative, e.name);
      if (e.isDirectory()) await walk(f, depth + 1);
      else {
        total += helmExtensionsRegular(path.join(base, f)).length;
        helmRequire(
          files.length < 128 && total <= 8 * 1024 * 1024,
          "Native chart file/byte bound",
        );
        files.push(f);
      }
    }
  };
  await walk("", 0);
  return files.toSorted();
}
async function main() {
  if (process.platform !== "linux" || process.arch !== "arm64")
    throw new HelmExtensionsUnavailable();
  const root = await realpath(process.argv[2]!),
    directory = await realpath(process.cwd());
  helmRequire(
    directory === root || directory.startsWith(root + path.sep),
    "Project escapes configured root",
  );
  const invocation = helmExtensionsInvocationSchema.parse(
      helmExtensionsJson(process.argv[3]!),
    ),
    current = helmExtensionsVerify(directory, invocation),
    tool = await selectedTool();
  const temporary = await mkdtemp(
      path.join(process.env.CHECKTRAIL_TEMP ?? tmpdir(), "helm-extensions-"),
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
      const f = path.join(source, input.path);
      await mkdir(path.dirname(f), { recursive: true });
      await writeFile(
        f,
        helmExtensionsRegular(path.join(directory, input.path)),
        { flag: "wx" },
      );
    }
    for (const [f, text] of Object.entries(current.rendered)) {
      const target = path.join(chart, f);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, text, { flag: "wx" });
    }
    const verifyCopies = async () => {
      helmRequire(
        isDeepStrictEqual(
          await tree(source),
          invocation.inputs.map((i) => i.path).toSorted(),
        ),
        "Frozen source copy cohort differs",
      );
      for (const i of invocation.inputs)
        helmRequire(
          mavenHash(helmExtensionsRegular(path.join(source, i.path))) ===
            i.sha256,
          "Frozen source copy changed",
        );
      helmRequire(
        isDeepStrictEqual(
          await tree(chart),
          Object.keys(current.rendered).toSorted(),
        ),
        "Native chart cohort differs",
      );
      for (const [f, text] of Object.entries(current.rendered))
        helmRequire(
          helmExtensionsRegular(path.join(chart, f)).equals(Buffer.from(text)),
          "Native chart copy changed",
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
    let outputBytes = 0;
    const invoke = (phase: string, args: string[]) => {
      const r = spawnSync(tool.entry, args, {
        cwd: workspace,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 1024 * 1024,
      });
      helmRequire(
        !r.error && !r.signal && r.status !== null,
        "Native Helm process did not complete",
      );
      outputBytes += Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr);
      helmRequire(outputBytes <= 1024 * 1024, "Native Helm output bound");
      return {
        phase,
        executable: tool.entry,
        args,
        exitCode: r.status,
        stdout: r.stdout,
        stderr: r.stderr,
        stdoutSha256: mavenHash(r.stdout),
        stderrSha256: mavenHash(r.stderr),
      };
    };
    const version = invoke("version", helmVersionArgs);
    if (version.exitCode !== 0 || version.stdout !== "v4.3.0" || version.stderr)
      throw new HelmExtensionsUnavailable();
    const receipts =
      process.argv[4] === "--version"
        ? [version]
        : [
            version,
            invoke("lint", helmExtensionsLintArgs),
            invoke("render", helmRenderArgs),
            invoke("debug", [...helmRenderArgs, "--debug"]),
          ];
    helmExtensionsVerify(directory, invocation);
    await verifyCopies();
    helmRequire(
      (await realpath(tool.entry)) === tool.resolved,
      "Native executable alias changed",
    );
    tool.afterSha256 = mavenHash(
      helmExtensionsRegular(tool.resolved, 128 * 1024 * 1024),
    );
    helmRequire(
      tool.afterSha256 === tool.sha256,
      "Native executable bytes changed",
    );
    if (process.argv[4] === "--version") {
      process.stdout.write("v4.3.0");
      return;
    }
    process.stdout.write(
      JSON.stringify({
        schemaVersion: 1,
        temporary,
        source,
        workspace,
        chart,
        inputSha256: mavenHash(JSON.stringify(invocation)),
        tool,
        sourceInputs: invocation.inputs.map((i) => ({
          ...i,
          afterSha256: mavenHash(
            helmExtensionsRegular(path.join(source, i.path)),
          ),
        })),
        nativeInputs: Object.entries(current.rendered)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([f, text]) => ({
            path: f,
            sha256: mavenHash(text),
            afterSha256: mavenHash(helmExtensionsRegular(path.join(chart, f))),
          })),
        sourceFiles: await tree(source),
        nativeFiles: await tree(chart),
        receipts,
      }) + "\n",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch((error) => {
  if (error instanceof HelmExtensionsUnavailable) {
    process.stdout.write(
      JSON.stringify({
        unavailable: "helm-extensions",
        reason: "pinned-prerequisite",
      }) + "\n",
    );
    process.exitCode = 3;
  } else {
    process.stderr.write("Helm extension collection did not complete\n");
    process.exitCode = 2;
  }
});
