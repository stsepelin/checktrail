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
  kubeconformInvocationSchema,
  kubeDocuments,
  kubeSchemaPinsFor,
  kubeBinarySha256,
  kubeNativeArgs,
  kubeProtectedEnvironment,
  kubeRequire,
} from "./kubeconform.js";
import { mavenHash, mavenLocal } from "./maven.js";
class ToolUnavailable extends Error {}
async function regular(file: string, limit = 1024 * 1024) {
  const stat = await lstat(file);
  kubeRequire(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size <= limit &&
      (await realpath(file)) === file,
    "Not a bounded canonical regular file",
  );
  const bytes = await readFile(file);
  kubeRequire(bytes.length <= limit, "File grew");
  return bytes;
}
async function tool() {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const entry = path.resolve(directory, "kubeconform");
    try {
      await access(entry, constants.X_OK);
    } catch {
      continue;
    }
    const resolved = await realpath(entry),
      sha256 = mavenHash(await regular(resolved, 128 * 1024 * 1024));
    if (sha256 !== kubeBinarySha256) throw new ToolUnavailable();
    return { entry, resolved, sha256, afterSha256: "" };
  }
  throw new ToolUnavailable();
}
async function main() {
  if (process.platform !== "linux" || process.arch !== "arm64")
    throw new ToolUnavailable();
  const root = await realpath(process.argv[2]!),
    project = path.relative(root, process.cwd());
  const invocation = kubeconformInvocationSchema.parse(
      JSON.parse(process.argv[3]!),
    ),
    schemaPins = kubeSchemaPinsFor(invocation.config),
    documents = kubeDocuments(invocation.inputs, invocation.config),
    binary = await tool();
  const verify = async (base: string, relative: string) => {
    for (const input of invocation.inputs)
      kubeRequire(
        mavenHash(
          await regular(await mavenLocal(base, relative, input.path)),
        ) === input.sha256,
        "Input changed",
      );
  };
  const verifySchemas = async (
    base: string,
    relative: string,
    directory: string,
  ) => {
    for (const pin of schemaPins) {
      const bytes = await regular(
        await mavenLocal(base, relative, directory + "/" + pin.file),
      );
      kubeRequire(
        bytes.length === pin.bytes && mavenHash(bytes) === pin.sha256,
        "Schema changed",
      );
    }
  };
  await verify(root, project);
  await verifySchemas(root, project, invocation.config.schemaDirectory);
  const temporary = await mkdtemp(
    path.join(process.env.CHECKTRAIL_TEMP || tmpdir(), "kubeconform-"),
  );
  const source = path.join(temporary, "source"),
    workspace = path.join(temporary, "native"),
    home = path.join(temporary, "home"),
    scratch = path.join(temporary, "tmp");
  try {
    for (const dir of [
      source,
      workspace,
      home,
      scratch,
      path.join(workspace, "schemas"),
      path.join(workspace, "documents"),
    ])
      await mkdir(dir, { recursive: true });
    for (const input of invocation.inputs) {
      const target = path.join(source, input.path);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(await mavenLocal(root, project, input.path), target, {
        force: false,
        errorOnExist: true,
      });
    }
    for (const pin of schemaPins)
      await cp(
        await mavenLocal(
          root,
          project,
          invocation.config.schemaDirectory + "/" + pin.file,
        ),
        path.join(workspace, "schemas", pin.file),
        { force: false, errorOnExist: true },
      );
    for (const [index, doc] of documents.entries())
      await writeFile(
        path.join(workspace, "documents", index + ".yaml"),
        doc.text,
        { flag: "wx" },
      );
    await verify(temporary, "source");
    await verifySchemas(temporary, "native", "schemas");
    const env = { ...process.env };
    for (const name of kubeProtectedEnvironment) delete env[name];
    Object.assign(env, {
      HOME: home,
      TMPDIR: scratch,
      LANG: "C",
      LC_ALL: "C",
      NO_COLOR: "1",
    });
    let total = 0;
    const invoke = (phase: string, args: string[]) => {
      const result = spawnSync(binary.entry, args, {
        cwd: workspace,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 1024 * 1024,
      });
      kubeRequire(
        !result.error && !result.signal && result.status !== null,
        "Native process incomplete",
      );
      total +=
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
      kubeRequire(total <= 1024 * 1024, "Native output exceeded bound");
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
    const version = invoke("version", ["-v"]);
    if (
      version.exitCode !== 0 ||
      version.stdout !== "v0.8.0\n" ||
      version.stderr
    )
      throw new ToolUnavailable();
    const validation = invoke(
      "validate",
      kubeNativeArgs(invocation.config, workspace, documents.length),
    );
    await verify(root, project);
    await verify(temporary, "source");
    await verifySchemas(root, project, invocation.config.schemaDirectory);
    await verifySchemas(temporary, "native", "schemas");
    kubeRequire(
      (await readdir(path.join(workspace, "documents"))).length ===
        documents.length,
      "Document output scope changed",
    );
    const observed = [];
    for (const [index, doc] of documents.entries()) {
      const afterSha256 = mavenHash(
        await regular(path.join(workspace, "documents", index + ".yaml")),
      );
      kubeRequire(afterSha256 === doc.sha256, "Native document changed");
      observed.push({
        file: `documents/${index}.yaml`,
        source: doc.file,
        index: doc.index,
        sha256: doc.sha256,
        afterSha256,
      });
    }
    kubeRequire(
      (await realpath(binary.entry)) === binary.resolved,
      "Tool path changed",
    );
    binary.afterSha256 = mavenHash(
      await regular(binary.resolved, 128 * 1024 * 1024),
    );
    kubeRequire(binary.afterSha256 === binary.sha256, "Tool bytes changed");
    process.stdout.write(
      JSON.stringify({
        version: 1,
        temporary,
        workspace,
        source,
        inputSha256: mavenHash(JSON.stringify(invocation.inputs)),
        tool: binary,
        schemas: schemaPins.map((p) => ({
          file: p.file,
          sha256: p.sha256,
          afterSha256: p.sha256,
        })),
        documents: observed,
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
      JSON.stringify({ unavailable: "kubeconform-toolchain" }),
    );
    process.exitCode = 3;
  } else {
    process.stderr.write(
      "Kubernetes native collection unavailable or incomplete\n",
    );
    process.exitCode = 2;
  }
});
