import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  writeFile,
  copyFile,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  readScala2SignatureCases,
  validateScala2SignatureNativeReceipt,
} from "./verify-scala2-signature-installed.mjs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { Buffer } from "node:buffer";
const pkg = process.argv[2],
  qualified = process.argv[3],
  pin = process.argv[4];
assert.equal(
  process.platform,
  "linux",
  "Native Scala signature acceptance requires Linux",
);
assert.equal(
  process.arch,
  "arm64",
  "Native Scala signature acceptance requires ARM64",
);
assert.ok(path.isAbsolute(pkg) && path.isAbsolute(qualified));
assert.match(pin, /^[a-f0-9]{64}$/);
assert.equal(await realpath(pkg), pkg);
assert.equal(await realpath(qualified), qualified);
assert.equal(
  process.version,
  "v22.23.2",
  "Pinned Scala signature acceptance requires its selected Node runtime",
);
const load = (name) =>
  import(pathToFileURL(path.join(pkg, "dist/src", name)).href);
const { createPlan, validate } = await load("engine.js");
const { runProcess } = await load("runner.js");
const { scala2Evidence } = await load("scala2-evidence.js");
const { scala2Artifacts } = await load("scala2-artifacts.js");
const {
  scala2ReleaseProofEnvironment: KEY,
  scala2ReleaseArchiveFilename: ZIP,
  scala2ReleaseProofFilename: PROOF,
} = await load("scala2-release-signature.js");
const bases = [];
const results = [];
async function fixture(mode = "qualified", broken = false) {
  const root = await realpath(await mkdtemp("/tmp/scala-proof-native-"));
  bases.push(root);
  const dir =
    mode === "qualified"
      ? path.join(root, ".checktrail/scala-signed-tools", pin)
      : path.join(root, ".checktrail");
  await mkdir(dir, { recursive: true });
  const archive = path.join(dir, mode === "qualified" ? ZIP : "scala2.zip");
  await copyFile(path.join(qualified, ZIP), archive);
  if (mode === "qualified")
    await copyFile(path.join(qualified, PROOF), path.join(dir, PROOF));
  await writeFile(
    path.join(root, "checktrail.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["jvm.scala"] }],
    }),
  );
  await writeFile(
    path.join(root, "checktrail.scala.json"),
    JSON.stringify({
      schemaVersion: 1,
      archive: path.relative(root, archive),
      sha256: scala2Artifacts.archiveSha256,
      profile: scala2Artifacts.profile,
      jvmTarget: "25",
      warningsAsErrors: false,
      classPath: [],
    }),
  );
  await writeFile(
    path.join(root, "Original.scala"),
    broken
      ? 'object Original { val answer:Int="wrong" }\n'
      : "object Original { val answer:Int=4 }\n",
  );
  await writeFile(
    path.join(root, "Other.scala"),
    'object Other { val independent:String="near miss" }\n',
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
try {
  stage("source-broken-fixed-and-legacy");
  for (const [mode, broken, expected, version] of [
    ["qualified", true, "failed", 2],
    ["qualified", false, "passed", 2],
    ["legacy", false, "passed", 1],
  ]) {
    const f = await fixture(mode, broken);
    const c = await selected(
      mode === "qualified" ? pin : "",
      async () =>
        (await validate(f.root, { trusted: true, timeoutMs: 120000 }))
          .checks[0],
    );
    assert.equal(c.status, expected, JSON.stringify(c));
    const packet = JSON.parse(c.processes[0].stdout);
    assert.equal(packet.version, version);
    if (!broken) {
      assert.equal(c.findingsComplete, true);
      assert.equal(packet.native.sources.length, 2);
      assert.ok(
        packet.native.sources.every(
          (s) => s.frontend === 1 && s.complete === 1,
        ),
      );
    }
    if (mode === "qualified")
      assert.equal(packet.releaseSignatureProof.proofSha256, pin);
    else assert.equal(Object.hasOwn(packet, "releaseSignatureProof"), false);
    results.push({
      id: mode + (broken ? "-broken" : "-fixed"),
      status: c.status,
      packetVersion: packet.version,
    });
  }
  stage("captured-authority-and-final-admission");
  const f = await fixture();
  await selected(pin, async () => {
    const { source, plan } = await createPlan(f.root);
    const check = plan.checks[0];
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
        projects: [{ path: ".", checks: ["jvm.scala"], environment: [KEY] }],
      }),
    );
    await assert.rejects(
      () =>
        createPlan(collision.root, { environment: { [KEY]: "0".repeat(64) } }),
      /conflicts with protected adapter settings/,
    );
    process.env[KEY] = "0".repeat(64);
    const p = await runProcess(source.root, check.commands[0], {
      timeoutMs: 120000,
      maxOutputBytes: 4 * 1024 * 1024,
      captureRawOutput: true,
    });
    assert.equal(p.exitCode, 0, p.stderr || p.stdout);
    assert.equal(scala2Evidence(check, [p], source.root).status, "passed");
    const packet = JSON.parse(p.stdout);
    packet.releaseSignatureProof.policySha256 = "0".repeat(64);
    assert.equal(
      scala2Evidence(
        check,
        [{ ...p, stdout: JSON.stringify(packet) }],
        source.root,
      ).status,
      "inconclusive",
    );
    const borrowed = globalThis.structuredClone(check);
    borrowed.commands[0].env[KEY] = "0".repeat(64);
    assert.equal(
      scala2Evidence(borrowed, [p], source.root).status,
      "inconclusive",
    );
    const file = path.join(f.dir, PROOF),
      original = await readFile(file);
    try {
      await writeFile(file, Buffer.concat([original, Buffer.from(" ")]));
      assert.equal(
        scala2Evidence(check, [p], source.root).status,
        "inconclusive",
      );
    } finally {
      await writeFile(file, original);
    }
    assert.equal(scala2Evidence(check, [p], source.root).status, "passed");
  });
  results.push({
    id: "operator-capture-request-collision-borrowed-pin-packet-and-physical-afterchecks",
    passed: true,
  });
  stage("actual-runner-coherent-wrong-policy");
  const runtimeFixture = await fixture();
  await selected(pin, async () => {
    const { source, plan } = await createPlan(runtimeFixture.root);
    const original = JSON.parse(
      await readFile(path.join(runtimeFixture.dir, PROOF), "utf8"),
    );
    original.policySha256 = "0".repeat(64);
    const wrongBytes = Buffer.from(JSON.stringify(original) + "\n");
    const wrongPin = createHash("sha256").update(wrongBytes).digest("hex");
    const wrongDirectory = path.join(
      path.dirname(runtimeFixture.dir),
      wrongPin,
    );
    await mkdir(wrongDirectory);
    await copyFile(
      path.join(runtimeFixture.dir, ZIP),
      path.join(wrongDirectory, ZIP),
    );
    await writeFile(path.join(wrongDirectory, PROOF), wrongBytes);
    const config = JSON.parse(
      await readFile(
        path.join(runtimeFixture.root, "checktrail.scala.json"),
        "utf8",
      ),
    );
    config.archive = path.relative(
      runtimeFixture.root,
      path.join(wrongDirectory, ZIP),
    );
    await writeFile(
      path.join(runtimeFixture.root, "checktrail.scala.json"),
      JSON.stringify(config),
    );
    const check = globalThis.structuredClone(plan.checks[0]);
    const invocation = JSON.parse(check.commands[0].args[2]);
    invocation.config = config;
    check.commands[0].args[2] = JSON.stringify(invocation);
    check.commands[0].env[KEY] = wrongPin;
    const refused = await runProcess(source.root, check.commands[0], {
      timeoutMs: 120000,
      maxOutputBytes: 4 * 1024 * 1024,
      captureRawOutput: true,
    });
    assert.equal(
      refused.exitCode,
      2,
      "Actual Scala runner must refuse a hash-rebound wrong-policy proof",
    );
    assert.deepEqual(JSON.parse(refused.stdout), {
      error: "Scala 2 native collection failed",
    });
  });
  results.push({
    id: "actual-runner-refuses-coherent-wrong-policy",
    passed: true,
  });
  stage("actual-cli");
  const cli = path.join(pkg, "dist/src/cli.js");
  for (const broken of [false, true]) {
    const x = await fixture("qualified", broken);
    const r = spawnSync(
      process.execPath,
      [
        cli,
        "run",
        "--root",
        x.root,
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
  const { Client } = await import("@modelcontextprotocol/client");
  const { StdioClientTransport } =
    await import("@modelcontextprotocol/client/stdio");
  const m = await fixture();
  const client = new Client(
    { name: "synthetic-signature-client", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, "serve", "--root", m.root, "--allow-execution"],
        env: {
          PATH: process.env.PATH ?? "",
          JAVA_HOME: process.env.JAVA_HOME ?? "",
          TMPDIR: "/tmp",
          TMP: "/tmp",
          TEMP: "/tmp",
          [KEY]: pin,
        },
        stderr: "pipe",
      }),
    );
    const denied = await client.callTool({
      name: "validation_run",
      arguments: { trusted: true },
    });
    assert.equal(denied.isError, true);
    const injected = await client.callTool({
      name: "validation_run",
      arguments: { environment: { [KEY]: "0".repeat(64) } },
    });
    assert.equal(injected.isError, true);
    const accepted = await client.callTool(
      { name: "validation_run", arguments: { timeoutMs: 120000 } },
      { timeout: 150000 },
    );
    assert.notEqual(accepted.isError, true, JSON.stringify(accepted));
    assert.equal(accepted.structuredContent.outcome, "passed");
    const summary = JSON.stringify(accepted);
    assert.equal(summary.includes(m.root), false);
    assert.equal(summary.includes("Original.scala"), false);
    assert.equal(summary.includes(pin), false);
  } finally {
    await client.close();
  }
  results.push({
    id: "mcp-cannot-promote-authority-and-private-summary",
    passed: true,
  });
  const cases = await readScala2SignatureCases();
  const receipt = {
    state: "complete-scoped-native-chain",
    packageRoot: pkg,
    cases: results,
    fullClosureVerified: false,
    gateAComplete: false,
  };
  validateScala2SignatureNativeReceipt(receipt, pkg, cases);
  process.stdout.write(JSON.stringify(receipt) + "\n");
} finally {
  for (const b of bases) await rm(b, { recursive: true, force: true });
}
