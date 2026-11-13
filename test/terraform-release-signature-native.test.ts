import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createPlan } from "../src/engine.js";
import { runProcess } from "../src/runner.js";
import { terraformExtensionsEvidence } from "../src/terraform-extensions-evidence.js";
import { mavenHash } from "../src/maven.js";
import {
  randomPreparedIdentity,
  randomReleaseProofEnvironment as key,
  randomReleaseProofFile,
  randomReleaseProofSummary,
} from "../src/terraform-release-signature.js";
import { terraformExtensionsPacketSchema } from "../src/terraform-extensions-packet.js";
import { terraformExtensionsFiles } from "./terraform-extensions-fixture.js";
import { fixture } from "./helpers.js";
const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const selected = {
  skip:
    process.env.CHECKTRAIL_RANDOM_RELEASE_PROOF_NATIVE === "1" &&
    process.platform === "linux" &&
    process.arch === "arm64" &&
    /^[a-f0-9]{64}$/.test(process.env[key] ?? "")
      ? false
      : "Explicit signed Random native cohort not selected",
  timeout: 180000,
};
const providerKey = "CHECKTRAIL_TERRAFORM_EXTENSIONS_PROVIDER_ROOT";

test(
  "Random signed native collector and final admission independently bind the externally selected proof and both payload members",
  selected,
  async (t) => {
    const root = await realpath(await fixture(t, terraformExtensionsFiles()));
    const { plan, source } = await createPlan(root),
      check = plan.checks[0]!,
      command = check.commands[0]!,
      original = process.env[key];
    let result;
    try {
      process.env[key] = "0".repeat(64);
      result = await runProcess(source.root, command, {
        timeoutMs: 120000,
        maxOutputBytes: 2 * 1024 * 1024,
      });
    } finally {
      process.env[key] = original;
    }
    assert.equal(
      result.exitCode,
      0,
      result.stderr + result.stdout.slice(-3000),
    );
    assert.equal(
      terraformExtensionsEvidence(check, [result], source.root).status,
      "passed",
    );
    const packet = terraformExtensionsPacketSchema.parse(
      JSON.parse(result.stdout),
    );
    assert.ok(packet.releaseSignatureProof);
    assert.equal(packet.releaseSignatureProof.proofSha256, original);
    assert.equal(
      packet.releaseSignatureProof.publisherAndLicenseClosureVerified,
      false,
    );
    assert.equal(packet.artifacts.length, 5);
    assert.equal(packet.providerMembers.length, 2);
    assert.ok(packet.receipts[1]!.stdout.includes("(unauthenticated)"));
    for (const change of [
      (value: typeof packet) => {
        delete value.releaseSignatureProof;
      },
      (value: typeof packet) => {
        value.artifacts.pop();
      },
      (value: typeof packet) => {
        value.providerMembers.pop();
      },
      (value: typeof packet) => {
        value.providerMembers[1]!.sha256 = "0".repeat(64);
      },
    ]) {
      const value = structuredClone(packet);
      change(value);
      assert.equal(
        terraformExtensionsEvidence(
          check,
          [{ ...result, stdout: JSON.stringify(value) }],
          source.root,
        ).status,
        "inconclusive",
      );
    }
    const cache = await realpath(await fixture(t, {}));
    await cp(command.env![providerKey]!, cache, { recursive: true });
    const proofFile = path.join(cache, randomReleaseProofFile),
      validBytes = await readFile(proofFile);
    // Rebind all carrier hashes and the captured external pin. Only the compiled
    // policy binding is wrong; this must fail even with a coherent outer packet.
    const proof = JSON.parse(validBytes.toString("utf8"));
    proof.policySha256 = "0".repeat(64);
    const wrongBytes = Buffer.from(JSON.stringify(proof) + "\n"),
      wrongPin = mavenHash(wrongBytes),
      summary = randomReleaseProofSummary(wrongPin),
      identity = Buffer.from(
        JSON.stringify(
          randomPreparedIdentity("operator-prepared-artifact", summary),
        ) + "\n",
      );
    await writeFile(proofFile, wrongBytes);
    await writeFile(path.join(cache, "identity.json"), identity);
    const rebound = structuredClone(packet),
      reboundCheck = structuredClone(check);
    reboundCheck.commands[0]!.env![providerKey] = cache;
    reboundCheck.commands[0]!.env![key] = wrongPin;
    rebound.preparedProvider = cache;
    rebound.releaseSignatureProof = summary;
    for (const item of rebound.artifacts)
      item.entry = path.join(cache, item.path);
    for (const [index, bytes] of [
      [3, identity],
      [4, wrongBytes],
    ] as const) {
      Object.assign(rebound.artifacts[index]!, {
        bytes: bytes.length,
        sha256: mavenHash(bytes),
        afterSha256: mavenHash(bytes),
      });
    }
    const reboundResult = {
      ...result,
      command: reboundCheck.commands[0]!,
      stdout: JSON.stringify(rebound),
    };
    assert.equal(
      terraformExtensionsEvidence(reboundCheck, [reboundResult], source.root)
        .status,
      "inconclusive",
    );
    const runtimeRefused = await runProcess(
      source.root,
      reboundCheck.commands[0]!,
      { timeoutMs: 120000, maxOutputBytes: 2 * 1024 * 1024 },
    );
    assert.equal(runtimeRefused.exitCode, 3);
    assert.deepEqual(JSON.parse(runtimeRefused.stdout), {
      unavailable: "terraform-extensions",
      reason: "pinned-prerequisite",
    });
    const unpinned = structuredClone(check.commands[0]!);
    unpinned.env![key] = "";
    const noPromotion = await runProcess(source.root, unpinned, {
      timeoutMs: 120000,
    });
    assert.equal(
      noPromotion.exitCode,
      3,
      "A signed five-file cache cannot silently become legacy",
    );
  },
);

test(
  "Random signed native CLI and MCP preserve actual mixed diagnostics and operator-only proof authority",
  selected,
  async (t) => {
    const root = await realpath(await fixture(t, terraformExtensionsFiles())),
      env = { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" };
    const invoke = () =>
      exec(
        process.execPath,
        [
          cli,
          "run",
          "--root",
          root,
          "--trust-project",
          "--timeout-ms",
          "120000",
        ],
        { env, timeout: 150000 },
      );
    const passed = JSON.parse((await invoke()).stdout);
    assert.equal(passed.outcome, "passed");
    const configFile = path.join(root, "checktrail.terraform-extensions.json"),
      original = await readFile(configFile, "utf8"),
      config = JSON.parse(original);
    config.modules[2].resources.selected.max = "synthetic_wrong_number";
    // The physical HCL must match its declared model; render via the public fixture.
    const { terraformExtensionsWriteConfig } =
      await import("./terraform-extensions-fixture.js");
    await terraformExtensionsWriteConfig(root, config);
    const client = new Client(
      { name: "synthetic-random-native-client", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            cli,
            "serve",
            "--root",
            root,
            "--allow-execution",
            "--detailed",
          ],
          env: Object.fromEntries(
            Object.entries(env).filter(
              (row): row is [string, string] => row[1] !== undefined,
            ),
          ),
          stderr: "pipe",
        }),
      );
      const failed = await client.callTool(
        { name: "validation_run", arguments: { timeoutMs: 120000 } },
        { timeout: 150000 },
      );
      assert.notEqual(failed.isError, true);
      const report = failed.structuredContent as {
        outcome: string;
        checks: { findings: unknown[]; findingsComplete: boolean }[];
      };
      assert.equal(report.outcome, "failed");
      assert.equal(report.checks[0]!.findings.length, 2);
      assert.equal(report.checks[0]!.findingsComplete, true);
      const promoted = await client
        .callTool({
          name: "validation_run",
          arguments: { environment: { [key]: "0".repeat(64) } },
        })
        .catch(() => ({ isError: true }));
      assert.equal(promoted.isError, true);
      await terraformExtensionsWriteConfig(root, JSON.parse(original));
      const fixed = await client.callTool(
        { name: "validation_run", arguments: { timeoutMs: 120000 } },
        { timeout: 150000 },
      );
      assert.equal(
        (fixed.structuredContent as { outcome: string }).outcome,
        "passed",
      );
      for (const value of [
        root,
        process.env[providerKey]!,
        "provider-public-key.asc",
        "GNUPG",
      ])
        assert.ok(!JSON.stringify(passed).includes(value), value);
    } finally {
      await client.close();
    }
  },
);

test(
  "Random legacy native mode stays explicitly unverified and captured blank overrides a request proof",
  selected,
  async (t) => {
    const root = await realpath(await fixture(t, terraformExtensionsFiles())),
      cache = await realpath(await fixture(t, {})),
      previousProvider = process.env[providerKey],
      previousProof = process.env[key];
    await cp(previousProvider!, cache, { recursive: true });
    await rm(path.join(cache, randomReleaseProofFile));
    await writeFile(
      path.join(cache, "identity.json"),
      JSON.stringify(randomPreparedIdentity("operator-prepared-artifact")) +
        "\n",
    );
    let planned;
    try {
      process.env[providerKey] = cache;
      process.env[key] = "";
      planned = await createPlan(root);
    } finally {
      process.env[providerKey] = previousProvider;
      process.env[key] = previousProof;
    }
    const check = planned.plan.checks[0]!,
      command = check.commands[0]!;
    assert.equal(command.env![key], "");
    const result = await runProcess(planned.source.root, command, {
      timeoutMs: 120000,
      maxOutputBytes: 2 * 1024 * 1024,
      environment: { [key]: previousProof! },
    });
    assert.equal(result.exitCode, 0, result.stderr + result.stdout);
    const packet = terraformExtensionsPacketSchema.parse(
      JSON.parse(result.stdout),
    );
    assert.equal(packet.releaseSignatureProof, undefined);
    assert.equal(packet.artifacts.length, 4);
    assert.equal(packet.providerMembers.length, 2);
    assert.equal(
      terraformExtensionsEvidence(check, [result], planned.source.root).status,
      "passed",
    );
    const falseClaim = {
      ...packet,
      releaseSignatureProof: randomReleaseProofSummary(previousProof!),
    };
    assert.equal(
      terraformExtensionsEvidence(
        check,
        [{ ...result, stdout: JSON.stringify(falseClaim) }],
        planned.source.root,
      ).status,
      "inconclusive",
    );
  },
);
