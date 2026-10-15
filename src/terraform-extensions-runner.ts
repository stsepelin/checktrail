import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  open,
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
import { parseAllDocuments } from "yaml";
import { terraformBinarySha256, terraformRequire } from "./terraform.js";
import {
  terraformExtensionsProvider as provider,
  terraformExtensionsModules,
  terraformExtensionsLock,
} from "./terraform-extensions-contract.js";
import {
  terraformExtensionsInvocationSchema,
  terraformExtensionsVerify,
  terraformExtensionsRegular,
} from "./terraform-extensions-physical.js";
class TerraformExtensionsUnavailable extends Error {}
const json = (text: string) => {
  const documents = parseAllDocuments(text, {
    strict: true,
    uniqueKeys: true,
    prettyErrors: false,
  });
  terraformRequire(
    documents.length === 1 &&
      !documents[0]!.errors.length &&
      !documents[0]!.warnings.length,
    "Strict native JSON required",
  );
  return JSON.parse(text);
};
async function selectedTool() {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const entry = path.resolve(directory, "terraform");
    try {
      await access(entry, constants.X_OK);
    } catch {
      continue;
    }
    try {
      const resolved = await realpath(entry),
        bytes = terraformExtensionsRegular(resolved, 128 * 1024 * 1024);
      if (mavenHash(bytes) !== terraformBinarySha256)
        throw new TerraformExtensionsUnavailable();
      return {
        entry,
        resolved,
        bytes: bytes.length,
        sha256: mavenHash(bytes),
        afterSha256: "",
      };
    } catch {
      throw new TerraformExtensionsUnavailable();
    }
  }
  throw new TerraformExtensionsUnavailable();
}
function preparedProvider(directory: string) {
  try {
    terraformRequire(
      path.isAbsolute(directory),
      "Absolute operator provider cache required",
    );
    const expected = [
      provider.archive,
      "identity.json",
      ...provider.members.map((member) => member.path),
    ].toSorted();
    terraformRequire(
      isDeepStrictEqual(readdirSyncNames(directory), expected),
      "Exact prepared provider cohort required",
    );
    const identityBytes = terraformExtensionsRegular(
      path.join(directory, "identity.json"),
      64 * 1024,
    );
    const identity = json(identityBytes.toString("utf8"));
    terraformRequire(
      [
        "operator-prepared-artifact",
        "https://releases.hashicorp.com/terraform-provider-random/3.9.1/" +
          provider.archive,
      ].includes(identity.archiveSource),
      "Prepared artifact origin differs",
    );
    terraformRequire(
      isDeepStrictEqual(identity, {
        schemaVersion: 1,
        provider,
        archiveSource: identity.archiveSource,
        completeMembersObserved: true,
        releaseSignatureVerified: false,
        publisherAndLicenseClosureVerified: false,
        nativeExecutionReached: false,
      }),
      "Prepared provider metadata differs",
    );
    return [
      {
        path: provider.archive,
        bytes: provider.archiveBytes,
        sha256: provider.archiveSha256,
      },
      ...provider.members,
      {
        path: "identity.json",
        bytes: identityBytes.length,
        sha256: mavenHash(identityBytes),
      },
    ].map((pin) => {
      const file = path.join(directory, pin.path),
        bytes = terraformExtensionsRegular(file, 32 * 1024 * 1024);
      terraformRequire(
        bytes.length === pin.bytes && mavenHash(bytes) === pin.sha256,
        "Pinned provider artifact differs",
      );
      return { ...pin, entry: file, afterSha256: "" };
    });
  } catch {
    throw new TerraformExtensionsUnavailable();
  }
}
// Prepared artifacts must form the exact flat, canonical cohort checked above.
import { readdirSync } from "node:fs";
const readdirSyncNames = (directory: string) =>
  readdirSync(directory).toSorted();
async function main() {
  if (process.platform !== "linux" || process.arch !== "arm64")
    throw new TerraformExtensionsUnavailable();
  const root = await realpath(process.argv[2]!),
    directory = await realpath(process.cwd());
  terraformRequire(
    directory === root || directory.startsWith(root + path.sep),
    "Project outside configured root",
  );
  const invocation = terraformExtensionsInvocationSchema.parse(
    json(process.argv[3]!),
  );
  const current = terraformExtensionsVerify(directory, invocation),
    tool = await selectedTool();
  const prepared = process.env.CHECKTRAIL_TERRAFORM_EXTENSIONS_PROVIDER_ROOT;
  if (!prepared) throw new TerraformExtensionsUnavailable();
  const artifacts = preparedProvider(prepared);
  const temporary = await mkdtemp(
    path.join(process.env.CHECKTRAIL_TEMP ?? tmpdir(), "terraform-extensions-"),
  );
  const workspace = path.join(temporary, "native"),
    source = path.join(temporary, "source"),
    home = path.join(temporary, "home"),
    scratch = path.join(temporary, "tmp"),
    data = path.join(temporary, "data"),
    mirror = path.join(temporary, "mirror"),
    cliConfig = path.join(home, "terraform.tfrc");
  let scratchHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    for (const dir of [workspace, source, home, scratch])
      await mkdir(dir, { recursive: true });
    // Linux provider sockets have a short pathname limit. The open directory is
    // still inside the engine-owned tree; parent death closes it and tree cleanup
    // removes every physical artifact after descendant termination.
    scratchHandle = await open(
      scratch,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    const nativeTemporary = `/proc/${process.pid}/fd/${scratchHandle.fd}`;
    terraformRequire(
      (await realpath(nativeTemporary)) === scratch,
      "Owned native temporary alias differs",
    );
    for (const input of invocation.inputs) {
      const file = path.join(source, input.path);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        file,
        terraformExtensionsRegular(path.join(directory, input.path)),
        { flag: "wx" },
      );
    }
    for (const [relative, text] of Object.entries(current.rendered)) {
      const file = path.join(workspace, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text, { flag: "wx" });
    }
    const copiedArchive = path.join(
      mirror,
      "registry.terraform.io/hashicorp/random",
      provider.archive,
    );
    await mkdir(path.dirname(copiedArchive), { recursive: true });
    await writeFile(
      copiedArchive,
      terraformExtensionsRegular(artifacts[0]!.entry, 32 * 1024 * 1024),
      { flag: "wx" },
    );
    const configText = `provider_installation {\n  filesystem_mirror {\n    path = ${JSON.stringify(mirror)}\n    include = ["registry.terraform.io/hashicorp/random"]\n  }\n}\n`;
    await writeFile(cliConfig, configText, { flag: "wx" });
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      TMPDIR: nativeTemporary,
      LANG: "C",
      LC_ALL: "C",
      NO_COLOR: "1",
      TF_CLI_CONFIG_FILE: cliConfig,
      TF_DATA_DIR: data,
      TF_IN_AUTOMATION: "1",
      TF_INPUT: "0",
      TF_WORKSPACE: "default",
      CHECKPOINT_DISABLE: "1",
    };
    let outputBytes = 0;
    const invoke = (phase: string, args: string[]) => {
      const result = spawnSync(tool.entry, args, {
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
      outputBytes +=
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
      terraformRequire(outputBytes <= 1024 * 1024, "Native output bound");
      return {
        phase,
        executable: tool.entry,
        args,
        exitCode: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        stdoutSha256: mavenHash(result.stdout),
        stderrSha256: mavenHash(result.stderr),
      };
    };
    const version = invoke("version", ["version", "-json"]);
    const versionIdentity = json(version.stdout);
    if (
      version.exitCode !== 0 ||
      version.stderr ||
      versionIdentity.terraform_version !== "1.16.5" ||
      versionIdentity.platform !== "linux_arm64" ||
      !isDeepStrictEqual(versionIdentity.provider_selections, {
        [provider.address]: provider.version,
      })
    )
      throw new TerraformExtensionsUnavailable();
    if (process.argv[4] === "--version") {
      terraformExtensionsVerify(directory, invocation);
      terraformRequire(
        mavenHash(
          terraformExtensionsRegular(tool.resolved, 128 * 1024 * 1024),
        ) === tool.sha256,
        "Tool bytes changed",
      );
      preparedProvider(prepared);
      process.stdout.write("Terraform v1.16.5\n");
      return;
    }
    const initialization = invoke("init", [
      "init",
      "-json",
      "-no-color",
      "-backend=false",
      "-input=false",
      "-upgrade=false",
      "-lockfile=readonly",
    ]);
    terraformRequire(
      initialization.exitCode === 0 && !initialization.stderr,
      "Native local initialization did not complete",
    );
    const providerDirectory = path.join(
      data,
      "providers",
      provider.address,
      provider.version,
      "linux_arm64",
    );
    const providerMembers = provider.members.map((pin) => {
      const entry = path.join(providerDirectory, pin.path),
        bytes = terraformExtensionsRegular(entry, 32 * 1024 * 1024);
      terraformRequire(
        bytes.length === pin.bytes && mavenHash(bytes) === pin.sha256,
        "Installed provider member differs",
      );
      return { ...pin, entry, afterSha256: "" };
    });
    await access(providerMembers[1]!.entry, constants.X_OK);
    const modulesFile = path.join(data, "modules/modules.json"),
      modulesText = terraformExtensionsRegular(modulesFile, 64 * 1024).toString(
        "utf8",
      );
    const expectedModules = terraformExtensionsModules(current.config)
      .map((instance) => ({
        Key: instance.key,
        Source: instance.source,
        Dir: instance.directory,
      }))
      .sort((a, b) => a.Key.localeCompare(b.Key, "en"));
    const parsedModules = json(modulesText);
    terraformRequire(
      Object.keys(parsedModules).length === 1 &&
        Array.isArray(parsedModules.Modules) &&
        isDeepStrictEqual(
          parsedModules.Modules.toSorted(
            (a: { Key: string }, b: { Key: string }) =>
              a.Key.localeCompare(b.Key, "en"),
          ),
          expectedModules,
        ),
      "Installed native local module cohort differs",
    );
    const selectedVersion = invoke("selected-version", ["version", "-json"]),
      schema = invoke("provider-schema", ["providers", "schema", "-json"]);
    terraformRequire(
      schema.exitCode === 0 &&
        !schema.stderr &&
        mavenHash(schema.stdout) === provider.schemaSha256,
      "Full pinned native schema cohort differs",
    );
    const validation = invoke("validate", ["validate", "-json", "-no-color"]);
    terraformExtensionsVerify(directory, invocation);
    for (const input of invocation.inputs)
      terraformRequire(
        mavenHash(terraformExtensionsRegular(path.join(source, input.path))) ===
          input.sha256,
        "Frozen source bytes changed",
      );
    const tree = async (base: string): Promise<string[]> => {
      const files: string[] = [];
      let entries = 0,
        total = 0;
      const walk = async (relative: string, depth: number): Promise<void> => {
        terraformRequire(depth <= 32, "Native output depth bound");
        for (const entry of await readdir(path.join(base, relative), {
          withFileTypes: true,
        })) {
          terraformRequire(++entries <= 4096, "Native output entry bound");
          const file = path.posix.join(relative, entry.name);
          terraformRequire(
            !entry.isSymbolicLink(),
            "Native output alias unsupported",
          );
          if (entry.isDirectory()) await walk(file, depth + 1);
          else {
            total += terraformExtensionsRegular(
              path.join(base, file),
              128 * 1024 * 1024,
            ).length;
            terraformRequire(
              files.length < 128 && total <= 128 * 1024 * 1024,
              "Native output file/byte bound",
            );
            files.push(file);
          }
        }
      };
      await walk("", 0);
      return files.toSorted();
    };
    terraformRequire(
      isDeepStrictEqual(
        await tree(workspace),
        Object.keys(current.rendered).toSorted(),
      ),
      "Native workspace cohort differs",
    );
    for (const [file, text] of Object.entries(current.rendered))
      terraformRequire(
        terraformExtensionsRegular(path.join(workspace, file)).equals(
          Buffer.from(text),
        ),
        "Native copied source or pinned lock changed",
      );
    const expectedData = [
      "modules/modules.json",
      ...provider.members.map((member) =>
        path.posix.join(
          "providers",
          provider.address,
          provider.version,
          "linux_arm64",
          member.path,
        ),
      ),
    ].toSorted();
    terraformRequire(
      isDeepStrictEqual(await tree(data), expectedData),
      "Native data/provider cohort differs",
    );
    for (const artifact of artifacts) {
      const bytes = terraformExtensionsRegular(
        artifact.entry,
        32 * 1024 * 1024,
      );
      artifact.afterSha256 = mavenHash(bytes);
      terraformRequire(
        bytes.length === artifact.bytes &&
          artifact.afterSha256 === artifact.sha256,
        "Prepared provider artifact bytes changed",
      );
    }
    for (const member of providerMembers) {
      member.afterSha256 = mavenHash(
        terraformExtensionsRegular(member.entry, 32 * 1024 * 1024),
      );
      terraformRequire(
        member.afterSha256 === member.sha256,
        "Installed provider bytes changed",
      );
    }
    terraformRequire(
      isDeepStrictEqual(
        readdirSyncNames(prepared),
        [
          provider.archive,
          "identity.json",
          ...provider.members.map((member) => member.path),
        ].toSorted(),
      ),
      "Prepared provider cohort changed",
    );
    terraformRequire(
      mavenHash(terraformExtensionsRegular(copiedArchive, 32 * 1024 * 1024)) ===
        provider.archiveSha256,
      "Owned mirror archive changed",
    );
    terraformRequire(
      terraformExtensionsRegular(cliConfig).equals(Buffer.from(configText)),
      "CLI installation policy changed",
    );
    terraformRequire(
      terraformExtensionsRegular(modulesFile).equals(Buffer.from(modulesText)),
      "Native modules metadata changed",
    );
    terraformRequire(
      (await realpath(tool.entry)) === tool.resolved,
      "Native executable alias changed",
    );
    tool.afterSha256 = mavenHash(
      terraformExtensionsRegular(tool.resolved, 128 * 1024 * 1024),
    );
    terraformRequire(tool.afterSha256 === tool.sha256, "Tool bytes changed");
    process.stdout.write(
      JSON.stringify({
        schemaVersion: 1,
        temporary,
        nativeTemporary: {
          path: nativeTemporary,
          before: scratch,
          after: await realpath(nativeTemporary),
        },
        workspace,
        source,
        data,
        mirror,
        preparedProvider: prepared,
        inputSha256: mavenHash(JSON.stringify(invocation)),
        tool,
        artifacts,
        providerMembers,
        modules: {
          file: modulesFile,
          text: modulesText,
          sha256: mavenHash(modulesText),
          afterSha256: mavenHash(terraformExtensionsRegular(modulesFile)),
        },
        lock: {
          file: path.join(workspace, ".terraform.lock.hcl"),
          sha256: mavenHash(terraformExtensionsLock),
          afterSha256: mavenHash(
            terraformExtensionsRegular(
              path.join(workspace, ".terraform.lock.hcl"),
            ),
          ),
        },
        cliConfig: {
          file: cliConfig,
          text: configText,
          sha256: mavenHash(configText),
          afterSha256: mavenHash(terraformExtensionsRegular(cliConfig)),
        },
        copiedArchive: {
          file: copiedArchive,
          sha256: provider.archiveSha256,
          afterSha256: mavenHash(
            terraformExtensionsRegular(copiedArchive, 32 * 1024 * 1024),
          ),
        },
        sourceInputs: invocation.inputs.map((input) => ({
          ...input,
          afterSha256: mavenHash(
            terraformExtensionsRegular(path.join(source, input.path)),
          ),
        })),
        nativeFiles: await tree(workspace),
        dataFiles: expectedData,
        receipts: [
          version,
          initialization,
          selectedVersion,
          schema,
          validation,
        ],
      }) + "\n",
    );
  } finally {
    try {
      await scratchHandle?.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
main().catch((error) => {
  if (error instanceof TerraformExtensionsUnavailable) {
    process.stdout.write(
      JSON.stringify({
        unavailable: "terraform-extensions",
        reason: "pinned-prerequisite",
      }) + "\n",
    );
    process.exitCode = 3;
  } else {
    process.stderr.write("Terraform extension collection did not complete\n");
    process.exitCode = 2;
  }
});
