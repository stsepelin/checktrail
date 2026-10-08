import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { readFile, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ReviewWorkflowEngine } from "../src/review-workflow.js";
import {
  ReviewHostAssignmentLease,
  createReviewHostAssignmentServer,
} from "../src/review-host-lease.js";
import {
  reviewWorkflowAssignmentSchema,
  type ReviewWorkflowAssignment,
} from "../src/review-workflow-schema.js";
import { runProcess } from "../src/runner.js";
import {
  setup,
  source,
  pin,
  recipe,
  response,
} from "./review-workflow-fixture.js";
const hostProgram = fileURLToPath(
  new URL("./review-host-process-fixture.js", import.meta.url),
);
const assigned = (value: unknown) =>
  reviewWorkflowAssignmentSchema.parse(value);
const options = { allowSourceDisclosure: true, wallMs: 30000 };
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw e;
  }
};
async function configs(
  root: string,
  assignment: ReviewWorkflowAssignment,
  extra: Record<string, unknown> = {},
) {
  const id = randomUUID();
  const serverConfig = path.join(root, ".checktrail", id + "-server.json");
  const hostConfig = path.join(root, ".checktrail", id + "-host.json");
  await writeFile(serverConfig, JSON.stringify({ assignment, options }));
  await writeFile(hostConfig, JSON.stringify({ serverConfig, ...extra }));
  return { serverConfig, hostConfig };
}
async function host(
  root: string,
  assignment: ReviewWorkflowAssignment,
  extra: Record<string, unknown> = {},
) {
  const { hostConfig } = await configs(root, assignment, extra);
  let observedPid: number | undefined;
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hostProgram, "host", hostConfig],
      {
        cwd: root,
        env: { PATH: process.env.PATH ?? "", LANG: "C" },
        timeout: 10000,
        maxBuffer: 1048576,
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(String(error) + "\n" + stderr));
        else {
          assert.equal(stderr, "");
          resolve(stdout);
        }
      },
    );
    observedPid = child.pid;
  });
  const receipt = JSON.parse(output);
  if (receipt.workerPid !== undefined) {
    assert.equal(receipt.workerPid, observedPid);
    assert.notEqual(receipt.workerPid, process.pid);
    assert.equal(alive(receipt.workerPid), false);
    assert.equal(receipt.serverClosed, true);
    assert.equal(alive(receipt.serverPid), false);
  }
  return receipt;
}
async function stages(t: TestContext, content: string, actual: boolean) {
  const { root, context, target } = await setup(t, content);
  const engine = new ReviewWorkflowEngine(root, {
    allowReviewSource: true,
    trusted: true,
    probes: [pin()],
  });
  try {
    await writeFile(
      path.join(root, ".checktrail/hidden-answer.json"),
      "OriginalHiddenAnswerCanary",
    );
    const id = (await engine.open(context)).workflowId;
    const reviewer = assigned(await engine.next(id));
    const first = await host(root, reviewer, { candidate: target });
    let state = await engine.submit(id, first.response);
    assert.equal(state.nextStage, "refuter");
    const refuter = assigned(await engine.next(id, state.candidateHandles[0]));
    const second = await host(root, refuter);
    const blind = JSON.parse(second.packet);
    assert.equal(blind.refutationTarget.claim, target.claim);
    for (const key of ["id", "severity", "attribution", "fixScope"])
      assert.equal(blind.refutationTarget[key], undefined);
    for (const hidden of [
      target.id,
      first.response.host.sessionId,
      reviewer.assignmentId,
      "OriginalHiddenAnswerCanary",
    ])
      assert.equal(second.packet.includes(hidden), false);
    state = await engine.submit(id, second.response);
    assert.equal(state.nextStage, "probe");
    state = await engine.probe(id, recipe.id);
    assert.equal(state.native.status, "completed");
    assert.equal(state.native.calls, 3);
    assert.equal(state.native.accountingComplete, true);
    const adjudicator = assigned(await engine.next(id));
    const third = await host(root, adjudicator);
    const raw = JSON.parse(third.packet);
    assert.equal(raw.nativeObservations.cases[1].actual, actual);
    assert.equal(raw.nativeObservations.cases[1].expected, false);
    assert.equal(raw.nativeObservations.status, undefined);
    assert.equal(raw.unverifiedTarget.id, undefined);
    for (const hidden of [
      target.id,
      first.response.host.sessionId,
      second.response.host.sessionId,
      refuter.assignmentId,
    ])
      assert.equal(third.packet.includes(hidden), false);
    const workers = [first, second, third];
    assert.equal(new Set(workers.map((x) => x.workerPid)).size, 3);
    assert.equal(new Set(workers.map((x) => x.serverPid)).size, 3);
    for (const value of workers) {
      assert.deepEqual(value.tools, [
        "review_host_assignment",
        "review_host_status",
        "review_host_submit",
      ]);
      for (const flag of [
        "sourceRevoked",
        "duplicateResponseRejected",
        "siblingSourceRejected",
        "toolGrantRejected",
        "executionToolRejected",
        "sourceFreeStatus",
      ])
        assert.equal(value[flag], true, flag);
      assert.equal(value.stderrBytes, 0);
      assert.equal(value.hostIsolationVerified, false);
      assert.equal(value.modelFreshnessVerified, false);
      assert.equal(value.inferenceInvoked, false);
      assert.equal(value.receipt.sourceAccessRevoked, true);
      assert.equal(value.receipt.hostProvenance, "host-declared-unverified");
    }
    state = await engine.submit(id, third.response);
    assert.equal(state.status, "completed");
    assert.equal(state.disposition, "advisory-stages-completed");
    assert.equal(state.claimsVerified, false);
    assert.equal(state.hostIsolationVerified, false);
    assert.equal(state.resolution, "unresolved");
    assert.equal(state.severity, "unassigned");
    assert.equal(state.assignments.length, 3);
    assert.equal(
      state.assignments.every((x) => x.status === "accepted"),
      true,
    );
    assert.equal(JSON.stringify(state).includes("subject.mjs"), false);
    assert.equal(engine.close(id).retainedBytes, 0);
  } finally {
    engine.dispose();
  }
}
test("host-session-readiness broken acceptance", async (t) => {
  await stages(t, source, true);
});
test("host-session-readiness fixed acceptance", async (t) => {
  await stages(
    t,
    "export function decision(name){return name==='grant' || name.startsWith('grant:');}\n",
    false,
  );
});
test("host-session-readiness near-miss acceptance", async (t) => {
  await stages(
    t,
    "export function decision(name){return ['grant:read','grant:write'].includes(name);}\n",
    false,
  );
  const { root, context } = await setup(t);
  const engine = new ReviewWorkflowEngine(root, { allowReviewSource: true });
  try {
    const packet = assigned(
      await engine.next((await engine.open(context)).workflowId),
    );
    const lease = new ReviewHostAssignmentLease(packet, {
      ...options,
      maxReads: 2,
    });
    try {
      const clone = lease.read();
      clone.packet = "changed";
      assert.equal(lease.read().packet, packet.packet);
      const submission = response(packet);
      lease.submit(submission);
      submission.host.model = "changed";
      const actual = lease.takeSubmission();
      assert.notEqual(actual.host.model, "changed");
      assert.throws(() => lease.takeSubmission(), /unavailable/);
      assert.equal(
        lease.summary().responseDigest,
        createHash("sha256").update(JSON.stringify(actual)).digest("hex"),
      );
      assert.equal(lease.summary().claimsVerified, false);
    } finally {
      lease.revoke();
    }
  } finally {
    engine.dispose();
  }
});
test("host-session-readiness prerequisite acceptance", async (t) => {
  const { root, context } = await setup(t);
  const engine = new ReviewWorkflowEngine(root, { allowReviewSource: true });
  try {
    const packet = assigned(
      await engine.next((await engine.open(context)).workflowId),
    );
    assert.throws(
      () =>
        new ReviewHostAssignmentLease(packet, { allowSourceDisclosure: false }),
      /operator/,
    );
    assert.throws(
      () => new ReviewHostAssignmentLease(packet, { ...options, maxReads: 33 }),
    );
    assert.throws(
      () =>
        new ReviewHostAssignmentLease(packet, {
          ...options,
          maxPacketBytes: Buffer.byteLength(JSON.stringify(packet)) - 1,
        }),
      /packet limit/,
    );
    assert.throws(
      () =>
        new ReviewHostAssignmentLease(packet, {
          ...options,
          allowExecution: true,
        }),
    );
    const altered = { ...packet, packet: packet.packet + " " };
    assert.throws(
      () => new ReviewHostAssignmentLease(altered, options),
      /digest differs/,
    );
    const client = new Client({
      name: "original-missing-runtime",
      version: "1",
    });
    try {
      await assert.rejects(
        client.connect(
          new StdioClientTransport({
            command: path.join(root, "missing-native-node"),
            args: [],
          }),
        ),
      );
    } finally {
      await client.close();
    }
  } finally {
    engine.dispose();
  }
});
test("host-session-readiness stale acceptance", async (t) => {
  const { root, context } = await setup(t);
  const engine = new ReviewWorkflowEngine(root, { allowReviewSource: true });
  try {
    const id = (await engine.open(context)).workflowId;
    const packet = assigned(await engine.next(id));
    for (const foreign of [
      { assignmentId: randomUUID() },
      { assignmentDigest: "0".repeat(64) },
    ]) {
      const lease = new ReviewHostAssignmentLease(packet, options);
      lease.read();
      assert.throws(
        () => lease.submit({ ...response(packet), ...foreign }),
        /another assignment/,
      );
      assert.equal(lease.summary().sourceAccessRevoked, true);
      assert.throws(() => lease.submit(response(packet)), /unavailable/);
      assert.throws(() => lease.takeSubmission(), /unavailable/);
    }
    await writeFile(path.join(root, "subject.mjs"), source + "// changed\n");
    const state = await engine.submit(id, response(packet));
    assert.equal(state.status, "stale");
    assert.equal(state.disposition, "not-complete");
  } finally {
    engine.dispose();
  }
});
test("host-session-readiness empty acceptance", async (t) => {
  const { root, context } = await setup(t);
  const engine = new ReviewWorkflowEngine(root, { allowReviewSource: true });
  try {
    const id = (await engine.open(context)).workflowId;
    const packet = assigned(await engine.next(id));
    for (const malformed of [
      undefined,
      null,
      {},
      {
        ...response(packet),
        output: { files: [], candidates: [] },
        allowExecution: true,
      },
    ]) {
      const lease = new ReviewHostAssignmentLease(packet, options);
      lease.read();
      assert.throws(() => lease.submit(malformed));
      assert.equal(lease.summary().state, "revoked");
      assert.throws(() => lease.read(), /unavailable/);
    }
    const notDelivered = new ReviewHostAssignmentLease(packet, options);
    assert.throws(() => notDelivered.submit(response(packet)), /not delivered/);
    const tooLarge = new ReviewHostAssignmentLease(packet, {
      ...options,
      maxResponseBytes: Buffer.byteLength(JSON.stringify(response(packet))) - 1,
    });
    tooLarge.read();
    assert.throws(() => tooLarge.submit(response(packet)), /operator limit/);
    const exhausted = new ReviewHostAssignmentLease(packet, options);
    exhausted.read();
    assert.throws(() => exhausted.read(), /read limit/);
    assert.equal(exhausted.summary().sourceAccessRevoked, true);
    const state = await engine.submit(id, response(packet));
    assert.equal(state.status, "completed");
    assert.equal(state.disposition, "no-candidates-declared");
    assert.equal(state.native.status, "not-started");
    assert.equal(state.resolution, "unresolved");
    assert.equal(state.severity, "unassigned");
    assert.equal(state.claimsVerified, false);
  } finally {
    engine.dispose();
  }
});
test("host-session-readiness privacy acceptance", async (t) => {
  const { root, context } = await setup(t);
  const engine = new ReviewWorkflowEngine(root, { allowReviewSource: true });
  try {
    const packet = assigned(
      await engine.next((await engine.open(context)).workflowId),
    );
    const lease = new ReviewHostAssignmentLease(packet, options);
    const discovery = createReviewHostAssignmentServer(lease);
    await discovery.close();
    assert.equal(lease.summary().state, "issued");
    assert.equal(
      JSON.stringify(lease.summary()).includes("subject.mjs"),
      false,
    );
    lease.revoke();
    const result = await host(root, packet, { operation: "malformed" });
    assert.equal(result.rejected, true);
    assert.equal(result.revoked, true);
    assert.equal(result.status.state, "revoked");
    assert.equal(JSON.stringify(result).includes(source), false);
    assert.equal(result.status.hostIsolationVerified, false);
  } finally {
    engine.dispose();
  }
});
test("host-session-readiness lifecycle acceptance", async (t) => {
  const { root, context } = await setup(t);
  const engine = new ReviewWorkflowEngine(root, { allowReviewSource: true });
  try {
    const packet = assigned(
      await engine.next((await engine.open(context)).workflowId),
    );
    const expiring = new ReviewHostAssignmentLease(packet, {
      ...options,
      wallMs: 10,
    });
    const sibling = new ReviewHostAssignmentLease(packet, options);
    try {
      expiring.read();
      await delay(25);
      assert.throws(() => expiring.read(), /unavailable/);
      assert.equal(expiring.summary().state, "revoked");
      assert.equal(sibling.summary().state, "issued");
      const { serverConfig } = await configs(root, packet);
      const client = new Client(
        { name: "original-close-host", version: "1" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [hostProgram, "server", serverConfig],
        env: { PATH: process.env.PATH ?? "", LANG: "C" },
        stderr: "pipe",
      });
      try {
        await client.connect(transport);
        assert.equal(
          (
            await client.callTool({
              name: "review_host_assignment",
              arguments: {},
            })
          ).isError,
          undefined,
        );
      } finally {
        await client.close();
      }
      assert.equal(transport.pid, null);
    } finally {
      expiring.revoke();
      sibling.revoke();
    }
    const blocking = new ReviewHostAssignmentLease(packet, {
      ...options,
      wallMs: 20,
    });
    blocking.read();
    const slow = response(packet);
    const declaredHost = slow.host;
    Object.defineProperty(slow, "host", {
      enumerable: true,
      get() {
        const until = performance.now() + 50;
        while (performance.now() < until) {
          /* Original synthetic synchronous validation load. */
        }
        return declaredHost;
      },
    });
    assert.throws(() => blocking.submit(slow), /deadline reached/);
    assert.equal(blocking.summary().state, "revoked");
    assert.throws(() => blocking.takeSubmission(), /unavailable/);
    for (const submitted of [false, true]) {
      const lease = new ReviewHostAssignmentLease(packet, options);
      const server = createReviewHostAssignmentServer(lease);
      const client = new Client(
        { name: "original-close-lease", version: "1" },
        { versionNegotiation: { mode: "legacy" } },
      );
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        assert.equal(
          (
            await client.callTool({
              name: "review_host_assignment",
              arguments: {},
            })
          ).isError,
          undefined,
        );
        if (submitted)
          assert.equal(
            (
              await client.callTool({
                name: "review_host_submit",
                arguments: response(packet),
              })
            ).isError,
            undefined,
          );
        await client.close();
        await server.close();
        assert.equal(
          lease.summary().state,
          submitted ? "submitted" : "revoked",
        );
        assert.equal(lease.summary().sourceAccessRevoked, true);
        if (submitted)
          assert.equal(
            lease.takeSubmission().assignmentId,
            packet.assignmentId,
          );
        else assert.throws(() => lease.takeSubmission(), /unavailable/);
      } finally {
        await client.close();
        await server.close();
        lease.revoke();
      }
    }
    for (const termination of ["cancel", "timeout", "output"] as const) {
      const readyPath = path.join(
        root,
        ".checktrail",
        randomUUID() + "-ready.json",
      );
      const { hostConfig } = await configs(root, packet, {
        operation: termination === "output" ? "flood" : "hold",
        readyPath,
      });
      const controller = new AbortController();
      const pending = runProcess(
        root,
        {
          executable: process.execPath,
          args: [hostProgram, "host", hostConfig],
          cwd: ".",
        },
        {
          timeoutMs: termination === "timeout" ? 5000 : 10000,
          signal: controller.signal,
          maxOutputBytes: termination === "output" ? 1024 : 65536,
        },
      );
      let identities: { workerPid: number; serverPid: number } | undefined;
      for (let attempt = 0; attempt < 150; attempt++) {
        identities = await readFile(readyPath, "utf8")
          .then(JSON.parse)
          .catch((e) => {
            if (e.code !== "ENOENT") throw e;
          });
        if (identities) break;
        await delay(20);
      }
      assert.ok(identities, "Reached SDK assignment before termination");
      if (termination === "cancel") {
        assert.equal(alive(identities.workerPid), true);
        assert.equal(alive(identities.serverPid), true);
        controller.abort();
      }
      const result = await pending;
      assert.equal(result.cancelled, termination === "cancel");
      assert.equal(result.timedOut, termination === "timeout");
      assert.equal(result.truncated, termination === "output");
      assert.equal(result.errorCode, undefined);
      assert.equal(alive(identities.workerPid), false);
      assert.equal(alive(identities.serverPid), false);
    }
  } finally {
    engine.dispose();
  }
});
test("host-session-readiness installed acceptance", async () => {
  if (process.env.CHECKTRAIL_HOST_SESSION_INSTALLED === "1") {
    const runtime = await realpath(
      fileURLToPath(new URL("../src/review-host-lease.js", import.meta.url)),
    );
    assert.ok(
      runtime.includes(
        path.join("node_modules", "@stsepelin", "checktrail", "dist", "src"),
      ),
    );
    return;
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "host-session-readiness",
  };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL(
          "../../scripts/verify-import-context-package.mjs",
          import.meta.url,
        ),
      ),
    ],
    { env, encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1048576 },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  assert.equal(receipt.offlineProductionInstall, true);
  assert.equal(receipt.installedRuntimeEvaluated, true);
  assert.equal(receipt.profile.complete, true);
  assert.equal(receipt.profile.required, 9);
  assert.equal(receipt.profile.passed, 9);
});
