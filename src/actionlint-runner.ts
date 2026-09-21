import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { actionlintInputs } from "./actionlint-inputs.js";
import {
  actionlintInvocationSchema,
  workflowRoot,
  workflowPath,
} from "./actionlint.js";
import { inventory, withinRoot } from "./inventory.js";

let nativeBytes = 0;
function invoke(args: string[], cwd: string) {
  const result = spawnSync("actionlint", args, {
    cwd,
    env: { PATH: process.env.PATH ?? "" },
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  nativeBytes +=
    Buffer.byteLength(result.stdout ?? "") +
    Buffer.byteLength(result.stderr ?? "");
  if (
    result.error ||
    result.signal ||
    result.status === null ||
    nativeBytes > 4 * 1024 * 1024
  )
    throw new Error("Actionlint evidence exceeded process limits");
  return result;
}

async function main() {
  const temporary = await realpath(
    await mkdtemp(path.join(tmpdir(), "repo-verifier-actionlint-")),
  );
  try {
    try {
      const result = invoke(["-version"], temporary);
      if (
        result.status !== 0 ||
        result.stderr ||
        !/^1\.7\.12\ninstalled by downloading from release page\nbuilt with go[^\r\n]+ compiler for (?:darwin|linux)\/(?:arm64|amd64)\n$/.test(
          result.stdout,
        )
      )
        throw new Error("Unverified actionlint toolchain");
    } catch {
      process.stdout.write(
        JSON.stringify({ unavailable: "actionlint-toolchain" }),
      );
      process.exitCode = 3;
      return;
    }
    if (process.argv[2] === "--version") {
      process.stdout.write("1.7.12\n");
      return;
    }
    const root = await realpath(process.argv[2]!);
    const projectRoot = await realpath(process.cwd());
    const project =
      path.relative(root, projectRoot).split(path.sep).join("/") || ".";
    const invocation = actionlintInvocationSchema.parse(
      JSON.parse(process.argv[3]!),
    );
    const source = await inventory(root);
    if (source.fingerprint !== invocation.fingerprint)
      throw new Error("Workflow source changed after planning");
    const prefix = project === "." ? "" : `${project}/`;
    const scope = source.files
      .filter((file) => workflowRoot(file) === project)
      .map((file) => file.slice(prefix.length));
    if (JSON.stringify(scope) !== JSON.stringify(invocation.scope))
      throw new Error("Workflow scope changed after planning");
    const files = new Map<string, Buffer>();
    let bytes = 0;
    for (const file of source.files.filter((file) => file.startsWith(prefix))) {
      const relative = file.slice(prefix.length);
      if (
        relative.split("/").some((part) => part.toLowerCase() === ".git") ||
        /(?:^|\/)\.github\/actionlint\.ya?ml$/i.test(relative)
      )
        continue;
      if (!workflowPath(relative))
        throw new Error("Workflow input paths contain unsupported characters");
      const resolved = await withinRoot(root, file);
      if (resolved !== path.resolve(root, file))
        throw new Error("Workflow inputs must not traverse symbolic links");
      const content = await readFile(resolved);
      bytes += content.length;
      if (content.length > 8 * 1024 * 1024 || bytes > 64 * 1024 * 1024)
        throw new Error("Workflow copy exceeds inventory bounds");
      files.set(relative, content);
    }
    const preflight = actionlintInputs(files, scope);
    const results: {
      file: string;
      exitCode: number;
      stdout: string;
      stderr: string;
    }[] = [];
    if (!preflight.unavailable && !preflight.findings.length) {
      const snapshot = path.join(temporary, "project");
      await mkdir(path.join(snapshot, ".git"), { recursive: true });
      for (const [file, content] of files) {
        const output = path.join(snapshot, file);
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, content, { flag: "wx" });
      }
      const configFile = path.join(temporary, "actionlint.json");
      await writeFile(
        configFile,
        JSON.stringify({
          "self-hosted-runner": { labels: invocation.config.runnerLabels },
          "config-variables": invocation.config.variables,
        }),
      );
      for (const file of scope) {
        const result = invoke(
          [
            "-verbose",
            "-format",
            "{{json .}}",
            "-shellcheck=",
            "-pyflakes=",
            "-no-color",
            "-config-file",
            configFile,
            file,
          ],
          snapshot,
        );
        results.push({
          file,
          exitCode: result.status!,
          stdout: result.stdout.replaceAll(snapshot, "<project>"),
          stderr: result.stderr.replaceAll(snapshot, "<project>"),
        });
      }
    }
    if ((await inventory(root)).fingerprint !== invocation.fingerprint)
      throw new Error("Workflow inputs changed during validation");
    process.stdout.write(
      JSON.stringify({ version: "1.7.12", ...invocation, preflight, results }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch(() => {
  process.stderr.write("Workflow evidence collection could not complete\n");
  process.exitCode = 2;
});
