import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import {
  loadGeneratorShards,
  selectGeneratorShard,
  parseGeneratorShardArguments,
  generatorJobContextFromEnvironment,
  captureGeneratorShardHarness,
  requireStableGeneratorShardHarness,
  createGeneratorShardFragment,
  captureGeneratorMutationSources,
} from "./dotnet-generator-shards.mjs";

export async function runDotnetGeneratorShardContainer(args) {
  const id = parseGeneratorShardArguments(args);
  const context = generatorJobContextFromEnvironment(process.env);
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim(),
    context.checkoutSha,
    "Checked-out source differs from job checkout",
  );
  execFileSync("git", ["diff", "--quiet", "HEAD", "--"], {
    cwd: repositoryRoot,
  });
  assert.equal(
    execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }),
    "",
    "Untracked source cannot supply native shard qualification",
  );
  const loaded = await loadGeneratorShards(repositoryRoot);
  const shard = selectGeneratorShard(loaded.manifest, id);
  const harnessBefore = await captureGeneratorShardHarness(repositoryRoot);
  const mutationSources = await captureGeneratorMutationSources(repositoryRoot);
  const repository = fileURLToPath(new URL("../", import.meta.url)),
    selected =
      process.env.CHECKTRAIL_DOTNET_GENERATOR_EXTENSIONS_IMAGE ??
      "checktrail-dotnet-generator-extensions:10.0.401",
    task = process.env.CHECKTRAIL_TEST_TASK;
  const image = execFileSync(
    "docker",
    ["image", "inspect", selected, "--format", "{{.Id}}"],
    { encoding: "utf8" },
  ).trim();
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const cache = execFileSync("npm", ["config", "get", "cache"], {
      encoding: "utf8",
    }).trim(),
    dependencies = await (
      await import("node:fs/promises")
    ).realpath(
      process.env.CHECKTRAIL_DOTNET_BUILD_CACHE ??
        path.join(repository, ".checktrail/dotnet-build-dependencies"),
    );
  assert.ok(path.isAbsolute(cache));
  const base = [
    "run",
    "--rm",
    "--init",
    "--network",
    "none",
    "--read-only",
    "--user",
    "1000:1000",
    "--cpus",
    "2",
    "--memory",
    "4g",
    "--pids-limit",
    "256",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,exec,size=2048m",
    ...(task ? ["--label", "checktrail.task=" + task] : []),
    "--mount",
    `type=bind,src=${repository},target=/workspace,readonly`,
    "--mount",
    `type=bind,src=${cache},target=/prepared-cache,readonly`,
    "--mount",
    `type=bind,src=${dependencies},target=/dependencies,readonly`,
    "--env",
    "npm_config_cache=/tmp/npm-cache",
    "--env",
    "CHECKTRAIL_DOTNET_GENERATOR_JOB_CONTEXT=" + JSON.stringify(context),
    "--env",
    "CHECKTRAIL_DOTNET_BUILD_CACHE=/dependencies",
    "--workdir",
    "/workspace",
    image,
  ];
  const invoke = promisify(execFile);
  const run = async (args) => {
    try {
      return (
        await invoke("docker", [...base, ...args], {
          encoding: "utf8",
          timeout: 2400000,
          maxBuffer: 16 * 1048576,
        })
      ).stdout;
    } catch (error) {
      throw Error(
        ".NET generator/method acceptance stage failed: " +
          String(error.stderr || error.stdout || error.message).slice(-3000),
        { cause: error },
      );
    }
  };
  const timings = {};
  const measured = async (name, action) => {
    const start = performance.now();
    stage(name);
    try {
      return await action();
    } finally {
      timings[name] = Math.round(performance.now() - start);
      process.stderr.write(
        JSON.stringify({ stageCompleted: name, durationMs: timings[name] }) +
          "\n",
      );
    }
  };
  const stage = (name) =>
      process.stderr.write(JSON.stringify({ stage: name }) + "\n"),
    started = performance.now();
  stage("selected-runtime-and-sdk-method-components");
  const runtime = JSON.parse(
    await run([
      "node",
      "--input-type=module",
      "-e",
      `
import {selectedDotnetGeneratorSdk} from './dist/src/dotnet-generator-extensions.js';import {fsharpSdkPins} from './dist/src/fsharp-format-pins.js';import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
const selected=await selectedDotnetGeneratorSdk(),bytes=await readFile(process.execPath);console.log(JSON.stringify({node:{version:process.version,platform:process.platform,arch:process.arch,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},sdk:{version:'10.0.401',runtime:'10.0.12',selectedComponents:fsharpSdkPins.length,selectedBytes:fsharpSdkPins.reduce((n,p)=>n+p.bytes,0),pinsSha256:createHash('sha256').update(JSON.stringify(fsharpSdkPins)).digest('hex'),byteVerified:true,wholeClosureVerified:false},os:await readFile('/etc/os-release','utf8')}));
`,
    ]),
  );
  assert.equal(runtime.node.version, "v22.23.2");
  assert.equal(runtime.node.platform, "linux");
  assert.equal(runtime.node.arch, "arm64");
  const npmVersion = (await run(["npm", "--version"])).trim();
  assert.match(npmVersion, /^\d+\.\d+\.\d+$/);
  runtime.npm = { version: npmVersion };
  runtime.image = { selectedReference: selected, observedImageId: image };
  // The guard driver mutates only its own /tmp copy. Baseline and source/install
  // use separate read-only containers and fresh fixtures; none shares a writable
  // workspace or npm cache. Two concurrent containers cap resources at 4 CPUs/8 GiB.
  const groups = await Promise.allSettled([
    (async () => {
      const baseline = await measured(
        "preserved-dotnet-build-tests-generated-and-method-provenance",
        async () => {
          const baseline = JSON.parse(
            await run([
              "node",
              "scripts/verify-dotnet-generator-shard-tests.mjs",
              "--shard",
              id,
              "baseline",
            ]),
          );
          return baseline;
        },
      );
      const acceptance = await measured(
        "source-and-fresh-offline-production-installation",
        async () => {
          const lines = (
            await run([
              "sh",
              "-c",
              "node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache && CHECKTRAIL_DOTNET_GENERATOR_EXTENSIONS_INSTALL_RECEIPT=/tmp/installed-receipt.json node scripts/verify-dotnet-generator-shard-tests.mjs --shard " +
                id +
                " source" +
                (id === loaded.manifest.installedOwner
                  ? " && cat /tmp/installed-receipt.json"
                  : ""),
            ])
          )
            .trim()
            .split("\n");
          const ownsInstalled = id === loaded.manifest.installedOwner;
          assert.equal(lines.length, ownsInstalled ? 3 : 2);
          const preparedCache = JSON.parse(lines[0]),
            source = JSON.parse(lines[1]),
            installed = ownsInstalled ? JSON.parse(lines[2]) : null;
          return { preparedCache, source, installed };
        },
      );
      return { baseline, ...acceptance };
    })(),
    measured("compiling-guards-and-native-observer-mutations", async () => {
      const guards = JSON.parse(
        await run([
          "sh",
          "-c",
          "mkdir /tmp/guards && cp -R dist /tmp/guards/dist && mkdir /tmp/guards/scripts && cp scripts/verify-dotnet-generator-extensions-guards.mjs scripts/dotnet-generator-shards.mjs scripts/dotnet-generator-shards.v1.json scripts/required-native-tests.json /tmp/guards/scripts/ && cp scripts/dotnet-build-fixture-projects.json /tmp/guards/scripts/ && mkdir /tmp/guards/examples && cp -R examples/dotnet-build /tmp/guards/examples/ && cp package.json /tmp/guards/ && ln -s /workspace/node_modules /tmp/guards/node_modules && cd /tmp/guards && node scripts/verify-dotnet-generator-extensions-guards.mjs --shard " +
            id,
        ]),
      );
      assert.equal(guards.controls.length, shard.controls.length);
      assert.equal(guards.fragmentComplete, true);
      assert.equal(guards.nativeCompileProofIds.length, 1);
      return guards;
    }),
  ]);
  const failures = groups.filter((group) => group.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((group) => group.reason),
      "Required native acceptance groups failed",
    );
  const { baseline, preparedCache, source, installed } = groups[0].value,
    guards = groups[1].value;
  const harness = requireStableGeneratorShardHarness(
    harnessBefore,
    await captureGeneratorShardHarness(repository),
  );
  return createGeneratorShardFragment({
    loaded,
    shardId: id,
    context,
    runtime,
    baseline,
    source,
    installed,
    preparedCache,
    guards,
    mutationSources,
    harness,
    stageDurationMs: timings,
    durationMs: Math.round(performance.now() - started),
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.stdout.write(
    JSON.stringify(
      await runDotnetGeneratorShardContainer(process.argv.slice(2)),
    ) + "\n",
  );
}
