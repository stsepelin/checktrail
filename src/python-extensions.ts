import { z } from "zod";
import { createHash } from "node:crypto";
import { lstat, readdir, open } from "node:fs/promises";
import path from "node:path";
import { readProjectFile, withinRoot } from "./inventory.js";
import type { Check, Inventory, Project } from "./types.js";
import { pythonExtensionRunner } from "./python-extension-runner.js";
import { pythonExtensionPins } from "./python-extension-pins.js";
const relative = z
  .string()
  .min(1)
  .max(512)
  .regex(
    /^(?![A-Za-z]:)(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\/$)[^\\\0\r\n]+$/,
  );
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const plugin = z.strictObject({ path: relative, sha256: hash });
export const pythonConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  moduleRoots: z
    .array(z.union([z.literal("."), relative]))
    .min(1)
    .max(32),
  environment: z
    .strictObject({
      directory: relative,
      dependencies: z
        .array(
          z.strictObject({
            name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
            version: z.string().min(1).max(128),
          }),
        )
        .min(1)
        .max(64),
    })
    .optional(),
  pytestPlugins: z
    .array(
      plugin.extend({
        module: z.string().regex(/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/),
      }),
    )
    .max(16)
    .default([]),
  mypyPlugins: z.array(plugin).max(16).default([]),
});
export const pythonFileSchema = z.strictObject({
  path: relative,
  bytes: z
    .number()
    .int()
    .min(0)
    .max(8 * 1048576),
  sha256: hash,
});
export const pythonManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sourceFingerprint: hash,
  kind: z.enum(["pytest", "mypy"]),
  config: pythonConfigSchema,
  sources: z.array(pythonFileSchema).min(1).max(256),
  bindings: z.array(pythonFileSchema).min(1).max(4096),
  environmentPackages: z
    .array(
      z.strictObject({
        name: z.string(),
        version: z.string(),
        metadata: relative,
        imports: z
          .array(z.string().regex(/^[A-Za-z_]\w*$/))
          .min(1)
          .max(128),
      }),
    )
    .max(64),
  toolPins: z
    .array(
      z.strictObject({
        distribution: z.string(),
        version: z.string(),
        file: z.string(),
        bytes: z.number().int().nonnegative(),
        sha256: hash,
      }),
    )
    .min(1)
    .max(32),
});
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function boundedBytes(root: string, file: string, limit: number) {
  const target = await withinRoot(root, file);
  const handle = await open(target, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit)
      throw new Error("Python binding exceeds its file/aggregate bound");
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const next = await handle.read(bytes, count, bytes.length - count, null);
      if (!next.bytesRead) break;
      count += next.bytesRead;
    }
    if (count !== stat.size)
      throw new Error("Python binding changed while reading");
    return bytes.subarray(0, count);
  } finally {
    await handle.close();
  }
}
async function snapshot(
  source: Inventory,
  project: Project,
  file: string,
  limit: number,
) {
  const bytes = await boundedBytes(
    source.root,
    path.posix.join(project.path, file),
    Math.min(8 * 1048576, limit),
  );
  return { path: file, bytes: bytes.length, sha256: digest(bytes) };
}
export async function pythonExtensionCheck(
  source: Inventory,
  project: Project,
  kind: "pytest" | "mypy",
): Promise<Check | undefined> {
  if (!project.files.includes("checktrail.python.json")) return undefined;
  const config = pythonConfigSchema.parse(
    JSON.parse(
      await readProjectFile(
        source.root,
        path.posix.join(project.path, "checktrail.python.json"),
      ),
    ),
  );
  const selected = project.files.filter(
    (file) =>
      /\.pyi?$/.test(file) &&
      config.moduleRoots.some(
        (root) => root === "." || file.startsWith(root + "/"),
      ),
  );
  const files =
    kind === "pytest"
      ? selected.filter((file) =>
          /(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$/.test(file),
        )
      : selected;
  const check: Check = {
    id: "python." + kind,
    adapter: project.adapter,
    project: project.path,
    scope: files,
    kind: kind === "pytest" ? "test" : "analysis",
    parser: "python-extension-json",
    commands: [],
    reason:
      "Run declared namespace sources, selected virtualenv dependencies and project plugins with native participation and source-bound receipts.",
  };
  try {
    if (!files.length || files.length > 256)
      throw new Error("A nonempty bounded Python source selection is required");
    if (new Set(config.moduleRoots).size !== config.moduleRoots.length)
      throw new Error("Python module roots must be unique");
    for (const directory of config.moduleRoots) {
      const target = await withinRoot(
        source.root,
        path.posix.join(project.path, directory),
      );
      if (!(await lstat(target)).isDirectory())
        throw new Error("A Python module root is not a contained directory");
    }
    let capturedBytes = 0;
    const captured = new Map<string, z.infer<typeof pythonFileSchema>>();
    const capture = async (file: string) => {
      const prior = captured.get(file);
      if (prior) return prior;
      if (captured.size >= 4096)
        throw new Error("Python input collection exceeds its bound");
      const value = await snapshot(
        source,
        project,
        file,
        64 * 1048576 - capturedBytes,
      );
      capturedBytes += value.bytes;
      captured.set(file, value);
      return value;
    };
    const plugins =
      kind === "pytest" ? config.pytestPlugins : config.mypyPlugins;
    if (new Set(plugins.map((p) => p.path)).size !== plugins.length)
      throw new Error("Declared Python plugins must be unique");
    const bindingPaths = new Set(["checktrail.python.json", ...selected]);
    const nativeConfigs =
      kind === "mypy"
        ? ["mypy.ini", ".mypy.ini", "pyproject.toml", "setup.cfg"]
        : [
            "pytest.ini",
            ".pytest.ini",
            "pyproject.toml",
            "tox.ini",
            "setup.cfg",
          ];
    for (const file of nativeConfigs)
      if (project.files.includes(file)) bindingPaths.add(file);
    for (const file of project.files)
      if (/(?:^|\/)conftest\.py$/.test(file)) bindingPaths.add(file);
    for (const p of plugins) {
      if (!project.files.includes(p.path) || !p.path.endsWith(".py"))
        throw new Error(
          "A declared Python plugin must be an inventoried Python file",
        );
      const actual = await capture(p.path);
      if (actual.sha256 !== p.sha256)
        throw new Error("Declared Python plugin bytes changed");
      bindingPaths.add(p.path);
    }
    const environmentPackages: Array<{
      name: string;
      version: string;
      metadata: string;
      imports: string[];
    }> = [];
    let executable = "python3";
    if (config.environment) {
      const { directory, dependencies } = config.environment;
      if (new Set(dependencies.map((d) => d.name)).size !== dependencies.length)
        throw new Error("Selected Python distributions must be unique");
      bindingPaths.add(directory + "/pyvenv.cfg");
      await capture(directory + "/pyvenv.cfg");
      const site = directory + "/lib/python3.12/site-packages";
      const absolute = await withinRoot(
        source.root,
        path.posix.join(project.path, site),
      );
      const entries = await readdir(absolute);
      if (entries.length > 1024)
        throw new Error("Python environment metadata exceeds its bound");
      const metadataEntries = [];
      for (const entry of entries.filter((e) => e.endsWith(".dist-info"))) {
        const metadata = site + "/" + entry + "/METADATA";
        const bytes = await boundedBytes(
          source.root,
          path.posix.join(project.path, metadata),
          65536,
        );
        const content = bytes.toString("utf8");
        if (!Buffer.from(content, "utf8").equals(bytes))
          throw new Error(
            "Python distribution metadata is not canonical UTF-8",
          );
        metadataEntries.push({ metadata, content });
      }
      for (const dependency of dependencies) {
        const matches = [];
        for (const { metadata, content } of metadataEntries) {
          const names = [...content.matchAll(/^Name: (.+)\r?$/gm)].map((m) =>
            m[1]!.toLowerCase().replace(/[_.-]+/g, "-"),
          );
          const versions = [...content.matchAll(/^Version: (.+)\r?$/gm)].map(
            (m) => m[1]!,
          );
          if (
            names.length === 1 &&
            names[0] === dependency.name &&
            versions.length === 1
          )
            matches.push({ metadata, version: versions[0]! });
        }
        if (matches.length !== 1 || matches[0]!.version !== dependency.version)
          throw new Error(
            "Selected virtualenv distribution is absent, ambiguous or incompatible",
          );
        const metadata = matches[0]!.metadata;
        const record = metadata.replace(/METADATA$/, "RECORD");
        const content = (
          await boundedBytes(
            source.root,
            path.posix.join(project.path, record),
            1048576,
          )
        ).toString("utf8");
        bindingPaths.add(metadata);
        bindingPaths.add(record);
        const recordPaths = new Set<string>();
        for (const line of content.trimEnd().split(/\r?\n/)) {
          const parts = line.split(",");
          if (
            parts.length !== 3 ||
            !relative.safeParse(parts[0]).success ||
            parts[0]!.includes('"')
          )
            throw new Error(
              "Selected distribution RECORD is outside the contained literal profile",
            );
          const [file, checksum, size] = parts;
          if (file!.endsWith(".pyc")) continue;
          if (recordPaths.has(file!))
            throw new Error("Python distribution RECORD repeats an input");
          recordPaths.add(file!);
          if (recordPaths.size > 4096)
            throw new Error(
              "Python distribution input count exceeds its bound",
            );
          const target = site + "/" + file;
          const bytes = await capture(target);
          if (file !== record.slice(site.length + 1)) {
            if (
              !/^sha256=[\w-]+$/.test(checksum!) ||
              !/^\d+$/.test(size!) ||
              Number(size) !== bytes.bytes ||
              Buffer.from(checksum!.slice(7), "base64url").toString("hex") !==
                bytes.sha256
            )
              throw new Error(
                "Selected distribution RECORD does not match actual bytes",
              );
          } else if (checksum || size)
            throw new Error(
              "Selected distribution RECORD self entry is invalid",
            );
          bindingPaths.add(target);
        }
        const actualPaths = new Set<string>();
        let entriesSeen = 0;
        const walk = async (
          relativePath: string,
          depth: number,
        ): Promise<void> => {
          if (depth > 32 || ++entriesSeen > 4096)
            throw new Error("Python distribution tree exceeds its bound");
          const absolutePath = path.join(absolute, relativePath);
          const stat = await lstat(absolutePath);
          if (stat.isSymbolicLink())
            throw new Error(
              "Python distribution links are outside this profile",
            );
          if (stat.isDirectory()) {
            for (const entry of await readdir(absolutePath))
              if (entry !== "__pycache__")
                await walk(relativePath + "/" + entry, depth + 1);
          } else if (stat.isFile() && !relativePath.endsWith(".pyc"))
            actualPaths.add(relativePath);
          else if (!stat.isFile())
            throw new Error("Python distribution has an unsupported entry");
        };
        for (const top of new Set(
          [...recordPaths].map((file) => file.split("/")[0]!),
        ))
          await walk(top, 0);
        if (
          actualPaths.size !== recordPaths.size ||
          [...actualPaths].some((file) => !recordPaths.has(file))
        )
          throw new Error("Python distribution RECORD omits an actual file");
        if (
          !recordPaths.has(metadata.slice(site.length + 1)) ||
          !recordPaths.has(record.slice(site.length + 1))
        )
          throw new Error("Python distribution RECORD omits its metadata");
        const imports = [
          ...new Set(
            [...recordPaths]
              .filter((file) => /\.(?:pyi?|so|pyd)$/.test(file))
              .map((file) => file.split("/")[0]!.split(".")[0]!)
              .filter((name) => /^[A-Za-z_]\w*$/.test(name)),
          ),
        ].sort();
        if (!imports.length || imports.length > 128)
          throw new Error(
            "Selected Python distribution has no bounded import roots",
          );
        environmentPackages.push({
          name: dependency.name,
          version: dependency.version,
          metadata,
          imports,
        });
      }
      // Standard virtualenv interpreter symlinks are executed only after operator trust.
      // Planning does not follow or read an external interpreter target.
      executable = path.resolve(
        source.root,
        project.path,
        directory,
        "bin/python3",
      );
      await lstat(executable);
    }
    if (bindingPaths.size > 4096)
      throw new Error("Python input collection exceeds its bound");
    const bindings = [];
    for (const file of [...bindingPaths].sort())
      bindings.push(await capture(file));
    const sources = [];
    for (const file of files) sources.push(await capture(file));
    const manifest = pythonManifestSchema.parse({
      schemaVersion: 1,
      sourceFingerprint: source.fingerprint,
      kind,
      config,
      sources,
      bindings,
      environmentPackages,
      toolPins: pythonExtensionPins,
    });
    const encoded = JSON.stringify(manifest);
    if (Buffer.byteLength(encoded) > 65536)
      throw new Error("Python manifest exceeds its transport bound");
    check.commands = [
      {
        executable,
        args: ["-I", "-B", "-c", pythonExtensionRunner, encoded],
        cwd: project.path,
        env: {
          PYTHONDONTWRITEBYTECODE: "1",
          PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1",
        },
        temporaryDirectory: true,
      },
    ];
  } catch (error) {
    check.unavailableReason =
      error instanceof Error
        ? error.message
        : "Python declaration prerequisites are unavailable";
  }
  return check;
}
