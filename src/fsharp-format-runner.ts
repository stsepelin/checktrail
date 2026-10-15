import path from "node:path";
import { tmpdir } from "node:os";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  fsharpFormatInvocationSchema,
  fsharpFormatConfigSchema,
  fsharpRegular,
  fsharpRequire,
  verifyFsharpFormatter,
  verifyFsharpSdk,
} from "./fsharp-format.js";
import { fsharpFormatterPins, fsharpSdkPins } from "./fsharp-format-pins.js";
import { fsharpFormatNativeSource } from "./fsharp-format-native.js";
import {
  fsharpCompileArguments,
  fsharpCompileWarnings,
  fsharpNativeSchema,
  fsharpPacketSchema,
  fsharpRuntimeConfig,
} from "./fsharp-format-contract.js";
import { mavenHash, mavenLocal } from "./maven.js";
import { jvmInvoker } from "./jvm-invoke.js";
import { captureProcessOutput } from "./process-output.js";
async function sdkInstallation() {
  for (const directory of (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)) {
    try {
      const tool = await realpath(path.join(directory, "dotnet")),
        root = path.dirname(tool);
      fsharpRequire(
        path.basename(tool) === "dotnet",
        "Selected dotnet executable",
      );
      await verifyFsharpSdk(root);
      return root;
    } catch {
      /* Only exact selected bytes are admitted, never an executed version guess. */
    }
  }
  throw Error("Selected F# runtime is unavailable");
}
async function main() {
  let sdkRoot: string;
  try {
    sdkRoot = await sdkInstallation();
  } catch {
    process.stdout.write(
      JSON.stringify({ unavailable: "selected-fsharp-toolchain" }),
    );
    process.exitCode = 3;
    return;
  }
  const root = await realpath(process.argv[2]!),
    project = path.relative(root, await realpath(process.cwd())) || ".",
    serialized = process.argv[3]!,
    request = fsharpFormatInvocationSchema.parse(JSON.parse(serialized));
  const sourceNames = [
    "checktrail.fsharp-format.json",
    ...request.config.files,
  ];
  fsharpRequire(
    new Set(sourceNames).size === sourceNames.length &&
      JSON.stringify(request.inputs.map((i) => i.file)) ===
        JSON.stringify(sourceNames),
    "Exact input cohort required",
  );
  const formatter = await verifyFsharpFormatter(
    root,
    project,
    request.config.formatterDirectory,
  );
  if (process.argv[4] === "--version") {
    process.stdout.write("Fantomas 8.0.7 (SDK 10.0.401; runtime 10.0.12)\n");
    return;
  }
  const temporary = await mkdtemp(
    path.join(
      process.env.CHECKTRAIL_TEMP ?? tmpdir(),
      "checktrail-fsharp-format-",
    ),
  );
  const observer = path.join(temporary, "observer"),
    workspace = path.join(temporary, "workspace"),
    home = path.join(temporary, "home");
  const owned = new Map<string, string>();
  const stage = async (file: string, bytes: Buffer | string) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    owned.set(file, mavenHash(bytes));
  };
  const mirrored: Buffer[] = [],
    phases: Array<unknown> = [];
  let observedBytes = 0;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    LANG: "C.UTF-8",
    DOTNET_CLI_UI_LANGUAGE: "en-US",
    HOME: home,
    TMPDIR: home,
    TMP: home,
    TEMP: home,
    DOTNET_CLI_HOME: home,
    DOTNET_ROOT: sdkRoot,
    DOTNET_MULTILEVEL_LOOKUP: "0",
    DOTNET_ROLL_FORWARD: "Disable",
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_NOLOGO: "1",
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    DOTNET_EnableDiagnostics: "0",
  };
  const native = jvmInvoker(env, true, (chunk) => {
    observedBytes += chunk.length;
    mirrored.push(Buffer.from(chunk));
  });
  const invoke = async (phase: string, args: string[], cwd: string) => {
    fsharpRequire(phases.length < 2, "Native formatter call budget");
    const tool = path.join(sdkRoot, "dotnet"),
      result = await native(tool, args, cwd);
    fsharpRequire(
      result.status === 0 &&
        result.signal === null &&
        observedBytes <= 2 * 1024 * 1024,
      "Native formatter did not complete",
    );
    const { error, ...fields } = result;
    fsharpRequire(!error, "Native formatter invocation failed");
    phases.push({
      phase,
      tool,
      args,
      cwd,
      ...fields,
      capturedOutput: captureProcessOutput(
        Buffer.from(result.stdout),
        Buffer.from(result.stderr),
        result.stdoutBytes + result.stderrBytes,
        true,
      ),
    });
    return result;
  };
  try {
    await mkdir(observer);
    await mkdir(workspace);
    await mkdir(home);
    for (const input of request.inputs) {
      const bytes = await fsharpRegular(
        await mavenLocal(root, project, input.file),
        65536,
      );
      fsharpRequire(
        bytes.length === input.bytes && mavenHash(bytes) === input.sha256,
        "Input changed before native formatting",
      );
      await stage(path.join(workspace, input.file), bytes);
    }
    fsharpRequire(
      JSON.stringify(
        fsharpFormatConfigSchema.parse(
          JSON.parse(
            (
              await readFile(
                path.join(workspace, "checktrail.fsharp-format.json"),
              )
            ).toString("utf8"),
          ),
        ),
      ) === JSON.stringify(request.config),
      "Formatting configuration changed",
    );
    for (const pin of fsharpFormatterPins)
      await stage(
        path.join(observer, pin.file),
        await fsharpRegular(path.join(formatter, pin.file), 32 * 1024 * 1024),
      );
    const source = path.join(observer, "ChecktrailFsharpFormat.cs"),
      helper = path.join(observer, "ChecktrailFsharpFormat.dll"),
      runtime = path.join(
        observer,
        "ChecktrailFsharpFormat.runtimeconfig.json",
      ),
      requestFile = path.join(observer, "request.json"),
      markerFile = path.join(observer, "body-entered.json");
    await stage(source, fsharpFormatNativeSource);
    await stage(runtime, fsharpRuntimeConfig);
    const documents = request.config.files.map((file) => ({
      file: path.join(workspace, file),
      signature: file.endsWith(".fsi"),
    }));
    await stage(requestFile, JSON.stringify({ documents }));
    const references = (
      await readdir(
        path.join(
          sdkRoot,
          "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0",
        ),
      )
    )
      .filter((f) => f.endsWith(".dll"))
      .sort()
      .map((f) =>
        path.join(
          sdkRoot,
          "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0",
          f,
        ),
      );
    const compiled = await invoke(
      "compile-observer",
      fsharpCompileArguments(sdkRoot, temporary, references),
      observer,
    );
    fsharpRequire(
      compiled.stderrBytes === 0 && fsharpCompileWarnings(compiled.stdout),
      "Observer compilation warning accounting differs",
    );
    owned.set(helper, mavenHash(await fsharpRegular(helper, 1024 * 1024)));
    const formatted = await invoke(
      "format-documents",
      ["exec", helper, requestFile, markerFile],
      workspace,
    );
    fsharpRequire(
      formatted.stderrBytes === 0,
      "Native formatting emitted unaccounted errors",
    );
    const report = fsharpNativeSchema.parse(JSON.parse(formatted.stdout));
    fsharpRequire(
      report.processId === formatted.pid &&
        report.helperSha256 === owned.get(helper),
      "Formatter process/helper identity differs",
    );
    const marker = JSON.parse(
      (await fsharpRegular(markerFile, 1024)).toString("utf8"),
    );
    for (const [file, hash] of owned)
      fsharpRequire(
        mavenHash(await fsharpRegular(file, 32 * 1024 * 1024)) === hash,
        "Owned native input changed",
      );
    for (const input of request.inputs) {
      const bytes = await fsharpRegular(
        await mavenLocal(root, project, input.file),
        65536,
      );
      fsharpRequire(
        bytes.length === input.bytes && mavenHash(bytes) === input.sha256,
        "Source changed during native formatting",
      );
    }
    await verifyFsharpFormatter(
      root,
      project,
      request.config.formatterDirectory,
    );
    await verifyFsharpSdk(sdkRoot);
    const packet = fsharpPacketSchema.parse({
      version: 1,
      profile: request.config.profile,
      requestSha256: mavenHash(serialized),
      sdkRoot,
      sdkPinsSha256: mavenHash(JSON.stringify(fsharpSdkPins)),
      temporary,
      helperSourceSha256: mavenHash(fsharpFormatNativeSource),
      helperSha256: owned.get(helper),
      runtimeConfigSha256: mavenHash(fsharpRuntimeConfig),
      requestFileSha256: owned.get(requestFile),
      marker,
      firstDocument: JSON.parse(
        (
          await fsharpRegular(markerFile + ".first-document.json", 16384)
        ).toString("utf8"),
      ),
      phases,
      mirroredBytes: observedBytes,
      mirroredSha256: mavenHash(Buffer.concat(mirrored)),
      complete: true,
    });
    process.stdout.write(JSON.stringify(packet));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch(() => {
  process.stderr.write("Native F# formatting evidence could not complete\n");
  process.exitCode = 2;
});
