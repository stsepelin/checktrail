import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import process from "node:process";
import { pathToFileURL } from "node:url";
import { runAcceptanceNpm } from "./install-acceptance-package.mjs";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

/** Operator-only synthetic package upgrade verification. Each CLI, library and
 * MCP phase starts fresh processes. This invokes no model or review trial. */
export async function verifyPackageUpgrade(
  baselineInput,
  candidateInput,
  {
    baselineIdentity,
    candidateVersion,
    baselineInstallation,
    candidateInstallation,
  } = {},
) {
  const baseline = await realpath(baselineInput);
  const candidate = await realpath(candidateInput);
  const digest = async (file) =>
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  const hashes = {
    baseline: await digest(baseline),
    candidate: await digest(candidate),
  };
  if (baselineIdentity)
    assert.equal(
      hashes.baseline,
      baselineIdentity.sha256,
      "Upgrade baseline archive pin differs",
    );
  assert.notEqual(
    hashes.baseline,
    hashes.candidate,
    "Upgrade requires different artifacts",
  );
  assert.equal(
    baselineInstallation === undefined,
    candidateInstallation === undefined,
    "Both locked installation graphs are required together",
  );
  const installations =
    baselineInstallation === undefined
      ? null
      : globalThis.structuredClone({
          baseline: baselineInstallation,
          candidate: candidateInstallation,
        });
  const installationInputs = installations
    ? Object.fromEntries(
        Object.entries(installations).map(([name, input]) => {
          assert.equal(input.lock.lockfileVersion, 3);
          assert.deepEqual(
            input.lock.packages[""].dependencies,
            input.manifest.dependencies,
          );
          const artifact = name === "baseline" ? baseline : candidate,
            bytes = name === "baseline" ? hashes.baseline : hashes.candidate;
          const selected =
            input.lock.packages["node_modules/@stsepelin/checktrail"];
          assert.deepEqual(input.manifest.dependencies, {
            "@stsepelin/checktrail": "file:" + artifact,
          });
          assert.equal(selected.resolved, "file:" + artifact);
          return [
            name,
            {
              manifest: JSON.stringify(input.manifest),
              lock: JSON.stringify(input.lock),
              archiveSha256: bytes,
            },
          ];
        }),
      )
    : null;
  if (installations)
    for (const [name, artifact] of [
      ["baseline", baseline],
      ["candidate", candidate],
    ]) {
      const selected =
        installations[name].lock.packages["node_modules/@stsepelin/checktrail"];
      assert.equal(
        selected.integrity,
        "sha512-" +
          createHash("sha512")
            .update(await readFile(artifact))
            .digest("base64"),
        "Locked upgrade artifact integrity differs",
      );
      assert.equal(
        selected.version,
        name === "baseline" ? baselineIdentity.version : candidateVersion,
      );
    }
  const temporary = await mkdtemp(path.join(tmpdir(), "checktrail-upgrade-"));
  let client;
  try {
    const installation = path.join(temporary, "installation");
    const project = path.join(temporary, "project");
    await mkdir(installation);
    await mkdir(project);
    await writeFile(
      path.join(installation, "package.json"),
      JSON.stringify({ private: true }),
    );
    const marker = path.join(temporary, "reached-native-bodies.jsonl");
    const reached = async () => {
      const bytes = await readFile(marker, "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      return bytes.length
        ? bytes
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
    };
    const bodies = (rows) => {
      assert.equal(
        rows.length,
        2,
        "Each native validation must execute both original test bodies",
      );
      assert.deepEqual(rows.map((row) => row.name).sort(), [
        "arithmetic",
        "quota",
      ]);
      assert.deepEqual(rows.map((row) => row.serial).sort(), [1, 2]);
      assert.ok(
        rows.every((row) => Number.isSafeInteger(row.pid) && row.pid > 0),
      );
      assert.equal(new Set(rows.map((row) => row.pid)).size, 1);
    };
    const source = {
      "package.json": JSON.stringify({
        private: true,
        type: "module",
        scripts: { test: "node --test" },
      }),
      "checktrail.json": JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: ".", checks: ["javascript.node-test"] }],
        workspace: { complete: true, dependencies: [] },
      }),
      "example.test.js": `import{test}from'node:test';import assert from'node:assert/strict';import{appendFileSync}from'node:fs';let serial=0;const reached=name=>appendFileSync(${JSON.stringify(marker)},JSON.stringify({name,pid:process.pid,serial:++serial})+String.fromCharCode(10));test('arithmetic',()=>{reached('arithmetic');assert.equal(2+3,5);});test('quota',()=>{reached('quota');assert.equal([{enabled:true},{enabled:true},{enabled:false}].filter(row=>row.enabled).length,2);});\n`,
      ".mcp.json": JSON.stringify({
        mcpServers: {
          existing: { command: "synthetic-existing-server", args: [] },
        },
      }),
    };
    for (const [name, value] of Object.entries(source))
      await writeFile(path.join(project, name), value);
    const binary = path.join(
      installation,
      "node_modules/@stsepelin/checktrail/dist/src/cli.js",
    );
    const invoke = (args) =>
      execFileSync(process.execPath, [binary, ...args], {
        cwd: installation,
        encoding: "utf8",
        timeout: 30_000,
      });
    const stages = [];
    let baselineReport;
    for (const [phase, tarball] of [
      ["baseline", baseline],
      ["upgrade", candidate],
      ["rollback", baseline],
    ]) {
      const locked =
        installationInputs?.[phase === "upgrade" ? "candidate" : "baseline"];
      if (locked) {
        await writeFile(
          path.join(installation, "package.json"),
          locked.manifest,
        );
        await writeFile(
          path.join(installation, "package-lock.json"),
          locked.lock,
        );
        runAcceptanceNpm(
          [
            "ci",
            "--offline",
            "--ignore-scripts",
            "--omit=dev",
            "--no-audit",
            "--no-fund",
          ],
          { cwd: installation, stdio: "pipe", timeout: 60000 },
        );
        assert.equal(
          await readFile(path.join(installation, "package.json"), "utf8"),
          locked.manifest,
        );
        assert.equal(
          await readFile(path.join(installation, "package-lock.json"), "utf8"),
          locked.lock,
        );
        for (const [name, entry] of Object.entries(
          JSON.parse(locked.lock).packages,
        )) {
          if (!name || entry.optional) continue;
          assert.equal(
            JSON.parse(
              await readFile(
                path.join(installation, name, "package.json"),
                "utf8",
              ),
            ).version,
            entry.version,
            "Locked installed upgrade version differs",
          );
        }
      } else {
        runAcceptanceNpm(
          [
            "install",
            "--offline",
            "--ignore-scripts",
            "--omit=dev",
            "--no-audit",
            "--no-fund",
            tarball,
          ],
          { cwd: installation, stdio: "pipe", timeout: 60_000 },
        );
      }
      const version = invoke(["--version"]).trim();
      if (baselineIdentity && phase !== "upgrade")
        assert.equal(version, baselineIdentity.version);
      if (candidateVersion && phase === "upgrade")
        assert.equal(version, candidateVersion);
      const legacyUnavailable =
        process.platform === "win32" &&
        phase !== "upgrade" &&
        baselineIdentity !== undefined;
      await rm(marker, { force: true });
      const plan = JSON.parse(
        invoke(["plan", "--root", project, "--detailed"]),
      );
      assert.deepEqual(
        plan.checks.map((check) => check.id),
        ["javascript.node-test"],
      );
      assert.deepEqual(
        await reached(),
        [],
        "Planning must not execute a project body",
      );
      let report;
      try {
        report = JSON.parse(
          invoke(["run", "--root", project, "--trust-project", "--detailed"]),
        );
        assert.equal(
          legacyUnavailable,
          false,
          "The pinned older Windows backend must remain unavailable",
        );
      } catch (error) {
        if (!legacyUnavailable || error.status !== 2 || error.signal)
          throw error;
        report = JSON.parse(String(error.stdout));
      }
      const verify = (value) => {
        if (legacyUnavailable) {
          assert.equal(value.outcome, "incomplete");
          assert.equal(value.checks[0].status, "unavailable");
          const processes = value.checks.flatMap(
            (check) => check.processes ?? [],
          );
          assert.ok(processes.length > 0);
          assert.ok(
            processes.every(
              (process) => process.errorCode === "UNSUPPORTED_PLATFORM",
            ),
          );
        } else {
          assert.equal(value.outcome, "passed");
          assert.equal(value.checks[0].status, "passed");
          assert.deepEqual(value.checks[0].tests, {
            total: 2,
            passed: 2,
            failed: 0,
            skipped: 0,
          });
        }
      };
      verify(report);
      if (legacyUnavailable) assert.deepEqual(await reached(), []);
      else bodies(await reached());
      const libraryCode = `import assert from'node:assert/strict';import{readFile}from'node:fs/promises';import*as api from ${JSON.stringify(pathToFileURL(path.join(installation, "node_modules/@stsepelin/checktrail/dist/src/index.js")).href)};const root=${JSON.stringify(project)},marker=${JSON.stringify(marker)};const read=()=>readFile(marker,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});const before=await read();const {plan}=await api.createPlan(root);assert.deepEqual(plan.checks.map(check=>check.id),['javascript.node-test']);assert.equal(await read(),before,'Library planning executed project code');const report=await api.validate(root,{trusted:true});process.stdout.write(JSON.stringify(report));`;
      const library = JSON.parse(
        execFileSync(
          process.execPath,
          ["--input-type=module", "-e", libraryCode],
          {
            cwd: installation,
            encoding: "utf8",
            timeout: 30000,
            maxBuffer: 4 * 1048576,
          },
        ),
      );
      verify(library);
      assert.equal(library.sourceFingerprint, report.sourceFingerprint);
      const observedBodies = await reached();
      if (legacyUnavailable) assert.deepEqual(observedBodies, []);
      else {
        assert.equal(observedBodies.length, 4);
        bodies(observedBodies.slice(0, 2));
        bodies(observedBodies.slice(2));
      }
      if (phase === "baseline") baselineReport = report;
      if (phase === "upgrade") {
        assert.notEqual(version, stages[0].version);
        assert.equal(
          JSON.parse(invoke(["init", "--root", project, "--write"])).status,
          "preserved",
        );
        assert.equal(
          JSON.parse(invoke(["doctor", "--root", project])).status,
          "no-static-blockers",
        );
        await writeFile(
          path.join(project, "prior-report.json"),
          "{ Original malformed report input",
        );
        assert.throws(
          () =>
            invoke([
              "export-sarif",
              "--root",
              project,
              "--input",
              "prior-report.json",
            ]),
          (error) => error.status === 2 && !error.signal,
          "Malformed prior report must be refused before restored input is accepted",
        );
        await writeFile(
          path.join(project, "prior-report.json"),
          JSON.stringify(baselineReport),
        );
        const sarif = JSON.parse(
          invoke([
            "export-sarif",
            "--root",
            project,
            "--input",
            "prior-report.json",
          ]),
        );
        assert.equal(sarif.version, "2.1.0");
        assert.deepEqual(
          sarif.runs.map((run) => ({
            version: run.tool.driver.version,
            runId: run.properties.runId,
            sourceFingerprint: run.properties.sourceFingerprint,
            outcome: run.properties.outcome,
            checkId: run.properties.checkId,
            status: run.properties.status,
            tests: run.properties.tests,
          })),
          baselineReport.checks.map((check) => ({
            version: baselineReport.engineVersion,
            runId: baselineReport.runId,
            sourceFingerprint: baselineReport.sourceFingerprint,
            outcome: baselineReport.outcome,
            checkId: check.id,
            status: check.status,
            tests: check.tests,
          })),
          "Imported SARIF must retain the actual older native report identity and check evidence",
        );
        await rm(path.join(project, "prior-report.json"));
      }
      if (phase === "rollback") assert.equal(version, stages[0].version);
      client = new Client(
        { name: "synthetic-upgrade-client", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [binary, "serve", "--root", project],
          stderr: "pipe",
        }),
      );
      const planned = await client.callTool({
        name: "validation_plan",
        arguments: {},
      });
      assert.notEqual(planned.isError, true);
      assert.ok(JSON.stringify(planned).includes("javascript.node-test"));
      for (const args of [{}, { trusted: true }, { allowExecution: true }]) {
        try {
          const denied = await client.callTool({
            name: "validation_run",
            arguments: args,
          });
          assert.equal(denied.isError, true);
          assert.match(
            JSON.stringify(denied),
            /Execution is disabled|Invalid|Unrecognized/i,
          );
        } catch (error) {
          assert.equal(
            error.code,
            -32602,
            "Only an actual invalid-arguments refusal is an alternate denied outcome",
          );
        }
      }
      assert.deepEqual(
        await reached(),
        observedBodies,
        "Read-only CLI/MCP operations executed additional native bodies",
      );
      await client.close();
      client = undefined;
      for (const [name, value] of Object.entries(source))
        assert.equal(
          await readFile(path.join(project, name), "utf8"),
          value,
          `${phase} changed ${name}`,
        );
      stages.push({
        phase,
        version,
        cli: legacyUnavailable ? "unavailable-in-older-release" : "passed",
        library: legacyUnavailable ? "unavailable-in-older-release" : "passed",
        mcp: "passed",
        executedBodies: observedBodies.length,
        configuration: "unchanged",
        ...(locked
          ? {
              dependencyManifestSha256: createHash("sha256")
                .update(locked.manifest)
                .digest("hex"),
              dependencyLockSha256: createHash("sha256")
                .update(locked.lock)
                .digest("hex"),
            }
          : {}),
      });
    }
    assert.deepEqual(
      hashes,
      { baseline: await digest(baseline), candidate: await digest(candidate) },
      "Upgrade input artifacts changed during execution",
    );
    return {
      hashes,
      stages,
      installation: "offline",
      dependencySelection: installationInputs
        ? "locked-production-inputs"
        : "ambient-offline-resolution",
      priorReportImport: "passed",
      inferenceInvoked: false,
      fieldEvaluationExecuted: false,
    };
  } finally {
    try {
      await client?.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
