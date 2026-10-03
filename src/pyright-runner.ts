import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import ts from "typescript";
import { withinRoot } from "./inventory.js";

const version = "1.1.414";
const format = "checktrail-pyright-1";
const comments = String.raw`
import io, json, pathlib, re, sys, tokenize
problems = []
for filename in sys.argv[1:]:
    content = pathlib.Path(filename).read_bytes()
    for token in tokenize.tokenize(io.BytesIO(content).readline):
        if token.type != tokenize.COMMENT:
            continue
        text = token.string
        directive = re.search(r"#\s*pyright:\s*(.*)$", text)
        if directive and directive.group(1).strip() not in ("basic", "standard", "strict"):
            problems.append(filename)
        if re.search(r"#\s*type:\s*ignore\b", text):
            problems.append(filename)
print(json.dumps(sorted(set(problems))))
`;

async function main(): Promise<void> {
  const [entry, root, config, ...files] = process.argv.slice(2);
  if (!entry || !root || !config || !files.length)
    throw new Error("Invalid Pyright arguments");
  const tool = await withinRoot(root, path.relative(root, entry));
  const metadata = JSON.parse(
    await readFile(
      await withinRoot(
        root,
        path.relative(root, path.join(path.dirname(tool), "package.json")),
      ),
      "utf8",
    ),
  ) as { name?: unknown; version?: unknown };
  if (metadata.name !== "pyright" || metadata.version !== version) {
    process.stdout.write(
      JSON.stringify({
        format,
        unavailable:
          "Pyright version is outside the verified CLI contract: " +
          String(metadata.version),
      }) + "\n",
    );
    process.exitCode = 3;
    return;
  }
  const configuredRoot = root;
  const cwd = process.cwd();
  const sources = await Promise.all(
    files.map((file) =>
      withinRoot(root, path.relative(root, path.resolve(cwd, file))),
    ),
  );
  const configFiles: string[] = [];
  const policyProblems: string[] = [];
  const active = new Set<string>();
  async function inspectConfig(file: string, depth = 0): Promise<void> {
    const resolved = await withinRoot(
      configuredRoot,
      path.relative(configuredRoot, file),
    );
    if (depth >= 16 || active.has(resolved))
      throw new Error(
        "Pyright configuration inheritance is cyclic or exceeds 16 files",
      );
    active.add(resolved);
    if ((await stat(resolved)).size > 1024 * 1024)
      throw new Error("Pyright configuration exceeds 1 MiB");
    const bytes = await readFile(resolved);
    if (bytes.length > 1024 * 1024)
      throw new Error("Pyright configuration exceeds 1 MiB");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    let value: unknown;
    if (resolved.endsWith(".toml")) {
      const document = parseToml(text);
      const toolSection = document.tool;
      value =
        typeof toolSection === "object" &&
        toolSection !== null &&
        "pyright" in toolSection
          ? toolSection.pyright
          : {};
    } else {
      const parsed = ts.parseConfigFileTextToJson(resolved, text);
      if (parsed.error) throw new Error("Malformed Pyright JSON configuration");
      value = parsed.config;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("Pyright configuration must be an object");
    const settings = value as Record<string, unknown>;
    if (settings.extends !== undefined) {
      if (typeof settings.extends !== "string" || !settings.extends.length)
        throw new Error("Invalid Pyright configuration inheritance");
      await inspectConfig(
        path.resolve(path.dirname(resolved), settings.extends),
        depth + 1,
      );
    }
    function inspectSettings(options: Record<string, unknown>): void {
      if (
        options.typeCheckingMode === "off" ||
        options.analyzeUnannotatedFunctions === false ||
        (Array.isArray(options.ignore) && options.ignore.length)
      )
        policyProblems.push(resolved);
      for (const [key, setting] of Object.entries(options))
        if (
          /^report[A-Z]/.test(key) &&
          (setting === false || setting === "none")
        )
          policyProblems.push(resolved);
    }
    inspectSettings(settings);
    if (Array.isArray(settings.executionEnvironments))
      for (const environment of settings.executionEnvironments) {
        if (
          typeof environment !== "object" ||
          environment === null ||
          Array.isArray(environment)
        )
          throw new Error("Invalid Pyright execution environment");
        inspectSettings(environment as Record<string, unknown>);
      }
    configFiles.push(resolved);
    active.delete(resolved);
  }
  const configPath = path.resolve(cwd, config);
  await inspectConfig(configPath);
  const commentResult = spawnSync(
    "python3",
    ["-I", "-S", "-c", comments, ...sources],
    { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
  if (
    commentResult.error ||
    commentResult.status !== 0 ||
    commentResult.stderr.trim()
  )
    throw new Error(
      "Python comment-token evidence is unavailable or malformed",
    );
  const suppressed: unknown = JSON.parse(commentResult.stdout);
  if (
    !Array.isArray(suppressed) ||
    suppressed.some(
      (file) => typeof file !== "string" || !sources.includes(file),
    )
  )
    throw new Error("Invalid Python comment-token evidence");
  policyProblems.push(...(suppressed as string[]));
  const native = (args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [tool, "--project", configPath, "--warnings", ...args, ...sources],
      {
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      },
    );
    if (result.error || result.signal || result.status === null)
      throw new Error(
        "Pyright native execution exceeded its limits or did not terminate normally",
      );
    return {
      exitCode: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
  const selection = native(["--dependencies", "--verbose"]);
  const diagnostics = native(["--outputjson"]);
  process.stdout.write(
    JSON.stringify({
      format,
      version,
      configFiles,
      policyProblems: [...new Set(policyProblems)],
      sources,
      selection,
      diagnostics,
    }) + "\n",
  );
  process.exitCode =
    selection.exitCode > 1 || diagnostics.exitCode > 1
      ? 2
      : diagnostics.exitCode;
}
main().catch((error: unknown) => {
  process.stdout.write(
    JSON.stringify({
      format,
      error: error instanceof Error ? error.message : "Pyright checking failed",
    }) + "\n",
  );
  process.exitCode = 2;
});
