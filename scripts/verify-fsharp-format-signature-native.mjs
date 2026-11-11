import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  readFsharpSignatureCases,
  validateFsharpSignatureNativeReceipt,
} from "./verify-fsharp-format-signature-installed.mjs";
const [pkg, qualified, pin] = process.argv.slice(2);
assert.equal(process.platform, "linux");
assert.equal(process.arch, "arm64");
assert.equal(process.version, "v22.23.2");
assert.ok(path.isAbsolute(pkg) && path.isAbsolute(qualified));
assert.equal(await realpath(pkg), pkg);
assert.equal(await realpath(qualified), qualified);
assert.match(pin, /^[a-f0-9]{64}$/u);
const load = (name) =>
  import(pathToFileURL(path.join(pkg, "dist/src", name)).href);
const { createPlan, validate } = await load("engine.js"),
  { runProcess } = await load("runner.js"),
  { fsharpFormatEvidence } = await load("fsharp-format-evidence.js");
const {
  fsharpNugetPolicy,
  fsharpReleaseProofEnvironment: KEY,
  fsharpReleaseProofFile: PROOF,
  readFsharpReleaseProof,
} = await load("fsharp-format-release-signature.js");
readFsharpReleaseProof(qualified, pin);
const members = [
  ...fsharpNugetPolicy.selected.map((p) => p.file),
  fsharpNugetPolicy.package.file,
  PROOF,
];
const roots = [],
  results = [];
async function fixture(mode = "qualified", broken = false) {
  const root = await realpath(await mkdtemp("/tmp/fsharp-proof-native-"));
  roots.push(root);
  const dir = path.join(
    root,
    ".checktrail",
    mode === "qualified" ? "fsharp-format-signed-tools/" + pin : "formatter",
  );
  await mkdir(dir, { recursive: true });
  for (const file of mode === "qualified"
    ? members
    : fsharpNugetPolicy.selected.map((p) => p.file))
    await copyFile(path.join(qualified, file), path.join(dir, file));
  await writeFile(
    path.join(root, "Original.fsproj"),
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
  );
  await writeFile(
    path.join(root, "checktrail.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["dotnet.format-fsharp"] }],
    }),
  );
  await writeFile(
    path.join(root, "checktrail.fsharp-format.json"),
    JSON.stringify({
      schemaVersion: 1,
      profile: "fantomas-core-default-v1",
      formatterDirectory: path.relative(root, dir),
      files: ["Original.fs", "Other.fs"],
    }),
  );
  await writeFile(
    path.join(root, "Original.fs"),
    broken
      ? "module Original\nlet add a b=a+b\n"
      : "module Original\n\nlet add a b = a + b\n",
  );
  await writeFile(
    path.join(root, "Other.fs"),
    "module Other\n\nlet value = 2\n",
  );
  return { root, dir };
}
async function selected(value, body) {
  const present = Object.hasOwn(process.env, KEY),
    old = process.env[KEY];
  try {
    process.env[KEY] = value;
    return await body();
  } finally {
    if (present) process.env[KEY] = old;
    else delete process.env[KEY];
  }
}
const stage = (id) =>
  process.stderr.write(JSON.stringify({ stage: id }) + "\n");
const nativeOptions = {
  timeoutMs: 120000,
  maxOutputBytes: 4 * 1024 * 1024,
  captureRawOutput: true,
};
try {
  for (const [mode, broken, expected, version] of [
    ["qualified", true, "failed", 2],
    ["qualified", false, "passed", 2],
    ["legacy", false, "passed", 1],
  ]) {
    stage(mode + (broken ? "-broken" : "-fixed"));
    const f = await fixture(mode, broken),
      report = await selected(mode === "qualified" ? pin : "", () =>
        validate(f.root, { trusted: true, timeoutMs: 120000 }),
      ),
      c = report.checks[0];
    assert.equal(c.status, expected, c.reason);
    assert.equal(c.findingsComplete, true);
    assert.equal(report.sourceChanged, false);
    const packet = JSON.parse(c.processes[0].stdout),
      native = JSON.parse(packet.phases[1].stdout);
    assert.equal(packet.version, version);
    assert.equal(native.documents.length, 2);
    assert.ok(
      native.documents.every((d) => d.validationInvoked && d.formattingInvoked),
    );
    if (mode === "qualified")
      assert.equal(packet.releaseSignatureProof.proofSha256, pin);
    else assert.equal(Object.hasOwn(packet, "releaseSignatureProof"), false);
    results.push({
      id: mode + (broken ? "-broken" : "-fixed"),
      status: c.status,
      packetVersion: packet.version,
    });
  }
  stage("captured-authority-runtime-and-final");
  const f = await fixture();
  await selected(pin, async () => {
    const { source, plan } = await createPlan(f.root),
      check = plan.checks[0];
    assert.equal(check.commands[0].env[KEY], pin);
    const ignored = await createPlan(f.root, {
      environment: { [KEY]: "0".repeat(64) },
    });
    assert.equal(ignored.plan.checks[0].commands[0].env[KEY], pin);
    assert.deepEqual(ignored.plan.checks[0].environment ?? [], []);
    const collision = await fixture();
    await writeFile(
      path.join(collision.root, "checktrail.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          { path: ".", checks: ["dotnet.format-fsharp"], environment: [KEY] },
        ],
      }),
    );
    await assert.rejects(
      createPlan(collision.root, { environment: { [KEY]: "0".repeat(64) } }),
      /conflicts with protected adapter settings/u,
    );
    process.env[KEY] = "0".repeat(64);
    const p = await runProcess(source.root, check.commands[0], nativeOptions);
    assert.equal(p.exitCode, 0, p.stderr || p.stdout);
    assert.equal(
      fsharpFormatEvidence(check, [p], source.root).status,
      "passed",
    );
    const packet = JSON.parse(p.stdout);
    packet.releaseSignatureProof.policySha256 = "0".repeat(64);
    assert.equal(
      fsharpFormatEvidence(
        check,
        [{ ...p, stdout: JSON.stringify(packet) }],
        source.root,
      ).status,
      "inconclusive",
    );
    const borrowed = globalThis.structuredClone(check);
    borrowed.commands[0].env[KEY] = "0".repeat(64);
    assert.equal(
      fsharpFormatEvidence(borrowed, [p], source.root).status,
      "inconclusive",
    );
    const file = path.join(f.dir, PROOF),
      saved = await readFile(file);
    try {
      await writeFile(file, Buffer.concat([saved, Buffer.from(" ")]));
      assert.equal(
        fsharpFormatEvidence(check, [p], source.root).status,
        "inconclusive",
      );
    } finally {
      await writeFile(file, saved);
    }
    assert.equal(
      fsharpFormatEvidence(check, [p], source.root).status,
      "passed",
    );
  });
  const legacy = await fixture("legacy");
  await selected("", async () => {
    const { plan } = await createPlan(legacy.root, {
      environment: { [KEY]: pin },
    });
    assert.equal(plan.checks[0].commands[0].env[KEY], "");
  });
  for (const malformed of [" ", "A".repeat(64), "0".repeat(63)])
    await selected(malformed, async () =>
      assert.equal(
        (await createPlan(f.root)).plan.checks[0].commands.length,
        0,
      ),
    );
  results.push({
    id: "operator-capture-request-collision-borrowed-pin-packet-and-physical-afterchecks",
    passed: true,
  });
  stage("actual-runner-refuses-coherent-wrong-policy");
  const r = await fixture();
  await selected(pin, async () => {
    const { source, plan } = await createPlan(r.root),
      wrong = JSON.parse(await readFile(path.join(r.dir, PROOF), "utf8"));
    wrong.policySha256 = "0".repeat(64);
    const body = Buffer.from(JSON.stringify(wrong) + "\n"),
      wrongPin = createHash("sha256").update(body).digest("hex"),
      dir = path.join(path.dirname(r.dir), wrongPin);
    await mkdir(dir);
    for (const file of members.filter((file) => file !== PROOF))
      await copyFile(path.join(r.dir, file), path.join(dir, file));
    await writeFile(path.join(dir, PROOF), body);
    const configFile = path.join(r.root, "checktrail.fsharp-format.json"),
      config = JSON.parse(await readFile(configFile, "utf8"));
    config.formatterDirectory = path.relative(r.root, dir);
    const configBody = JSON.stringify(config);
    await writeFile(configFile, configBody);
    const check = globalThis.structuredClone(plan.checks[0]),
      invocation = JSON.parse(check.commands[0].args[2]);
    invocation.config = config;
    invocation.inputs[0].bytes = Buffer.byteLength(configBody);
    invocation.inputs[0].sha256 = createHash("sha256")
      .update(configBody)
      .digest("hex");
    check.commands[0].args[2] = JSON.stringify(invocation);
    check.commands[0].env[KEY] = wrongPin;
    const refused = await runProcess(
      source.root,
      check.commands[0],
      nativeOptions,
    );
    assert.equal(
      refused.exitCode,
      2,
      "Actual F# runner must refuse coherently rebound wrong-policy proof",
    );
    assert.equal(refused.stdout, "");
    assert.equal(
      refused.stderr,
      "Native F# formatting evidence could not complete\n",
    );
  });
  results.push({
    id: "actual-runner-refuses-coherent-wrong-policy",
    passed: true,
  });
  stage("actual-cli");
  const cli = path.join(pkg, "dist/src/cli.js");
  for (const broken of [false, true]) {
    const c = await fixture("qualified", broken),
      r = spawnSync(
        process.execPath,
        [
          cli,
          "run",
          "--root",
          c.root,
          "--timeout-ms",
          "120000",
          "--trust-project",
          "--detailed",
        ],
        {
          env: { ...process.env, [KEY]: pin },
          encoding: "utf8",
          timeout: 150000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
    assert.ifError(r.error);
    assert.equal(r.signal, null);
    assert.equal(r.status, broken ? 1 : 0, r.stderr || r.stdout);
    const report = JSON.parse(r.stdout);
    assert.equal(report.checks[0].status, broken ? "failed" : "passed");
    assert.equal(JSON.parse(report.checks[0].processes[0].stdout).version, 2);
    results.push({
      id: "cli-" + (broken ? "broken" : "fixed"),
      exitCode: r.status,
    });
  }
  stage("actual-mcp-startup-authority");
  const { Client } = await import("@modelcontextprotocol/client"),
    { StdioClientTransport } =
      await import("@modelcontextprotocol/client/stdio"),
    m = await fixture();
  const client = new Client(
    { name: "synthetic-fsharp-signature-client", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, "serve", "--root", m.root, "--allow-execution"],
        env: {
          PATH: process.env.PATH ?? "",
          TMPDIR: "/tmp",
          TMP: "/tmp",
          TEMP: "/tmp",
          [KEY]: pin,
        },
        stderr: "pipe",
      }),
    );
    assert.equal(
      (
        await client.callTool({
          name: "validation_run",
          arguments: { trusted: true },
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await client.callTool({
          name: "validation_run",
          arguments: { environment: { [KEY]: "0".repeat(64) } },
        })
      ).isError,
      true,
    );
    const accepted = await client.callTool(
      { name: "validation_run", arguments: { timeoutMs: 120000 } },
      { timeout: 150000 },
    );
    assert.notEqual(accepted.isError, true, JSON.stringify(accepted));
    assert.equal(accepted.structuredContent.outcome, "passed");
    const summary = JSON.stringify(accepted);
    assert.equal(summary.includes(m.root), false);
    assert.equal(summary.includes("Original.fs"), false);
    assert.equal(summary.includes(pin), false);
  } finally {
    await client.close();
  }
  results.push({
    id: "mcp-cannot-promote-authority-and-private-summary",
    passed: true,
  });
  const cases = await readFsharpSignatureCases(),
    receipt = {
      state: "complete-scoped-native-chain",
      packageRoot: pkg,
      cases: results,
      revocationFreshAtRuntime: false,
      fullClosureVerified: false,
      gateAComplete: false,
    };
  validateFsharpSignatureNativeReceipt(receipt, pkg, cases);
  process.stdout.write(JSON.stringify(receipt) + "\n");
} finally {
  for (const root of roots) await rm(root, { recursive: true, force: true });
}
