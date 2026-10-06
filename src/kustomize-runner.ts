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
  kubeSchemaPins,
  kubeBinarySha256,
  kubeNativeArgs,
  kubeRequire,
} from "./kubeconform.js";
import { parseAllDocuments } from "yaml";
import {
  kustomizeInvocationSchema,
  kustomizeResources,
  kustomizeCanonical,
  kustomizeBinarySha256,
} from "./kustomize.js";
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
async function tool(name: string, pin: string) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const entry = path.resolve(directory, name);
    try {
      await access(entry, constants.X_OK);
    } catch {
      continue;
    }
    const resolved = await realpath(entry),
      sha256 = mavenHash(await regular(resolved, 128 * 1024 * 1024));
    if (sha256 !== pin) throw new ToolUnavailable();
    return { entry, resolved, sha256, afterSha256: "" };
  }
  throw new ToolUnavailable();
}
async function main() {
  if (process.platform !== "linux" || process.arch !== "arm64")
    throw new ToolUnavailable();
  const root = await realpath(process.argv[2]!),
    project = path.relative(root, process.cwd());
  const invocation = kustomizeInvocationSchema.parse(
      JSON.parse(process.argv[3]!),
    ),
    expected = kustomizeResources(invocation),
    binary = await tool("kustomize", kustomizeBinarySha256),
    validator = await tool("kubeconform", kubeBinarySha256);
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
    for (const pin of kubeSchemaPins) {
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
    path.join(process.env.CHECKTRAIL_TEMP || tmpdir(), "kustomize-"),
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
    for (const pin of kubeSchemaPins)
      await cp(
        await mavenLocal(
          root,
          project,
          invocation.config.schemaDirectory + "/" + pin.file,
        ),
        path.join(workspace, "schemas", pin.file),
        { force: false, errorOnExist: true },
      );
    for (const input of invocation.inputs.filter(
      (i) => i.path !== "checktrail.kustomize.json",
    )) {
      const target = path.join(workspace, input.path);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(await mavenLocal(root, project, input.path), target, {
        force: false,
        errorOnExist: true,
      });
    }
    await verify(temporary, "source");
    await verifySchemas(temporary, "native", "schemas");
    const verifyNativeCopies = async () => {
      for (const input of invocation.inputs.filter(
        (i) => i.path !== "checktrail.kustomize.json",
      ))
        kubeRequire(
          mavenHash(await regular(path.join(workspace, input.path))) ===
            input.sha256,
          "Native copied source changed",
        );
    };
    await verifyNativeCopies();
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      TMPDIR: scratch,
      LANG: "C",
      LC_ALL: "C",
      NO_COLOR: "1",
      KUBECONFIG: path.join(home, "no-cluster"),
    };
    let total = 0;
    const invoke = (entry: string, phase: string, args: string[]) => {
      const result = spawnSync(entry, args, {
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
        executable: entry,
        args,
        exitCode: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        stdoutSha256: mavenHash(result.stdout),
        stderrSha256: mavenHash(result.stderr),
      };
    };
    const version = invoke(binary.entry, "kustomize-version", ["version"]),
      schemaVersion = invoke(validator.entry, "kubeconform-version", ["-v"]);
    if (
      version.exitCode !== 0 ||
      version.stdout !== "v5.8.2\n" ||
      version.stderr ||
      schemaVersion.exitCode !== 0 ||
      schemaVersion.stdout !== "v0.8.0\n" ||
      schemaVersion.stderr
    )
      throw new ToolUnavailable();
    if (
      process.argv[4] === "--version=kustomize" ||
      process.argv[4] === "--version=kubeconform"
    ) {
      await verify(root, project);
      await verify(temporary, "source");
      await verifySchemas(root, project, invocation.config.schemaDirectory);
      await verifySchemas(temporary, "native", "schemas");
      await verifyNativeCopies();
      for (const t of [binary, validator])
        kubeRequire(
          mavenHash(await regular(t.resolved, 128 * 1024 * 1024)) === t.sha256,
          "Tool bytes changed",
        );
      process.stdout.write(
        process.argv[4] === "--version=kustomize"
          ? version.stdout
          : schemaVersion.stdout,
      );
      return;
    }
    const build = invoke(binary.entry, "build", [
      "build",
      invocation.config.root,
      "--load-restrictor",
      "LoadRestrictionsRootOnly",
    ]);
    kubeRequire(
      build.exitCode === 0 && !build.stderr,
      "Native build incomplete",
    );
    const parsed = parseAllDocuments(build.stdout, {
      strict: true,
      uniqueKeys: true,
      prettyErrors: false,
    });
    kubeRequire(
      parsed.length === expected.length,
      "Native rendered scope differs",
    );
    const nativeRendered = [],
      documents = [];
    const remaining = new Set(expected.map((_e, i) => i));
    for (const [index, doc] of parsed.entries()) {
      kubeRequire(
        doc.range && doc.contents && !doc.errors.length && !doc.warnings.length,
        "Native rendered syntax incomplete",
      );
      const value = doc.toJS({ maxAliasCount: 0 }) as unknown,
        canonical = kustomizeCanonical(value),
        found = [...remaining].filter(
          (i) => kustomizeCanonical(expected[i]!.value) === canonical,
        );
      kubeRequire(found.length === 1, "Native rendered assembly differs");
      remaining.delete(found[0]!);
      const text = build.stdout.slice(doc.range[0], doc.range[2]),
        sha256 = mavenHash(text),
        file = `documents/${index}.yaml`;
      await writeFile(path.join(workspace, file), text, { flag: "wx" });
      documents.push({ file, sha256 });
      nativeRendered.push({
        file,
        source: expected[found[0]!]!.source.file,
        sha256,
        afterSha256: "",
      });
    }
    const validation = invoke(
      validator.entry,
      "validate",
      kubeNativeArgs(
        { ...invocation.config, manifests: documents.map((d) => d.file) },
        workspace,
        documents.length,
      ),
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
    await verifyNativeCopies();
    for (const doc of nativeRendered) {
      doc.afterSha256 = mavenHash(
        await regular(path.join(workspace, doc.file)),
      );
      kubeRequire(
        doc.afterSha256 === doc.sha256,
        "Native rendered bytes changed",
      );
    }
    for (const t of [binary, validator]) {
      kubeRequire(
        (await realpath(t.entry)) === t.resolved,
        "Tool path changed",
      );
      t.afterSha256 = mavenHash(await regular(t.resolved, 128 * 1024 * 1024));
      kubeRequire(t.afterSha256 === t.sha256, "Tool bytes changed");
    }
    process.stdout.write(
      JSON.stringify({
        version: 1,
        temporary,
        workspace,
        source,
        inputSha256: mavenHash(JSON.stringify(invocation.inputs)),
        tools: [binary, validator],
        schemas: kubeSchemaPins.map((p) => ({
          file: p.file,
          sha256: p.sha256,
          afterSha256: p.sha256,
        })),
        documents: nativeRendered,
        receipts: [version, schemaVersion, build, validation],
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch((error) => {
  if (error instanceof ToolUnavailable) {
    process.stdout.write(
      JSON.stringify({ unavailable: "kustomize-toolchain" }),
    );
    process.exitCode = 3;
  } else {
    process.stderr.write(
      "Kustomize native collection unavailable or incomplete\n",
    );
    process.exitCode = 2;
  }
});
