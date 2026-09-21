import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  externalInvocationSchema,
  externalReferenceSchema,
  externalRequestSchema,
  externalScope,
  loadExternalAdapter,
} from "./external-adapter.js";
import { inventory, withinRoot } from "./inventory.js";

async function main() {
  if (process.argv[2] === "--version") {
    const adapter = await loadExternalAdapter(
      externalReferenceSchema.parse(JSON.parse(process.argv[3]!)),
    );
    process.stdout.write(`${adapter.identity.version}\n`);
    return;
  }
  const invocation = externalInvocationSchema.parse(
    JSON.parse(process.argv[3]!),
  );
  const adapter = await loadExternalAdapter(invocation.reference, true);
  if (
    JSON.stringify(adapter.identity) !== JSON.stringify(invocation.identity) ||
    adapter.manifest.runtime !== invocation.runtime
  )
    throw new Error("External adapter identity changed");
  const definition = adapter.manifest.checks.find(
    (check) => `${adapter.identity.id}.${check.id}` === invocation.checkId,
  );
  if (
    !definition ||
    definition.kind !== invocation.kind ||
    definition.failOn !== invocation.failOn
  )
    throw new Error("External check definition changed");
  const source = await inventory(process.argv[2]!);
  if (source.fingerprint !== invocation.sourceFingerprint)
    throw new Error("External check source changed before execution");
  const cwd = await withinRoot(source.root, invocation.project);
  if (cwd !== (await realpath(process.cwd())))
    throw new Error(
      "External adapter project does not match its working directory",
    );
  for (const file of invocation.scope) {
    const relative = path.posix.join(invocation.project, file);
    if (
      !source.files.includes(relative) ||
      (await withinRoot(source.root, relative)) !==
        path.resolve(source.root, relative)
    )
      throw new Error(
        "External scope contains missing or symbolic-link inputs",
      );
  }
  if (
    JSON.stringify(
      externalScope(
        {
          path: invocation.project,
          adapter: adapter.identity.id,
          markers: [],
          files: invocation.scope,
        },
        definition,
      ),
    ) !== JSON.stringify(invocation.scope)
  )
    throw new Error("External scope does not match its declared selectors");
  const temporary =
    process.env.CHECKTRAIL_TEMP ||
    (await mkdtemp(path.join(tmpdir(), "checktrail-external-")));
  try {
    const bundle = path.join(temporary, "bundle");
    for (const [file, content] of adapter.contents) {
      const output = path.join(bundle, file);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, content, { flag: "wx", mode: 0o600 });
    }
    const entry = path.join(bundle, adapter.manifest.entry);
    const request = path.join(temporary, "request.json");
    await writeFile(
      request,
      JSON.stringify(
        externalRequestSchema.parse({
          protocolVersion: 1,
          root: source.root,
          identity: invocation.identity,
          project: invocation.project,
          runtime: invocation.runtime,
          checkId: invocation.checkId,
          kind: invocation.kind,
          failOn: invocation.failOn,
          scope: invocation.scope,
          sourceFingerprint: invocation.sourceFingerprint,
        }),
      ),
      { mode: 0o600 },
    );
    let executable: string;
    let args: string[];
    switch (adapter.manifest.runtime) {
      case "node":
        executable = process.execPath;
        args = [entry, request];
        break;
      case "python3":
        executable = "python3";
        args = ["-I", "-B", entry, request];
        break;
      case "php":
        executable = "php";
        args = ["-n", entry, request];
        break;
      case "native":
        executable = entry;
        args = [request];
        await chmod(entry, 0o700);
        break;
    }
    const result = spawnSync(executable, args, {
      cwd,
      env: { ...process.env, NODE_OPTIONS: "" },
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    if (
      result.error &&
      (result.error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      process.stdout.write(JSON.stringify({ unavailable: "external-runtime" }));
      process.exitCode = 3;
      return;
    }
    if (
      result.error ||
      result.signal ||
      result.status === null ||
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) >
        1024 * 1024
    )
      throw new Error(
        "External adapter process did not complete within evidence bounds",
      );
    await loadExternalAdapter(invocation.reference);
    if (
      (await inventory(source.root)).fingerprint !==
      invocation.sourceFingerprint
    )
      throw new Error("External check source changed during execution");
    process.stdout.write(
      JSON.stringify({
        exitCode: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch(() => {
  process.stderr.write(
    "External adapter evidence collection could not complete\n",
  );
  process.exitCode = 2;
});
