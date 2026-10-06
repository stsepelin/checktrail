import { runProcess } from "../src/runner.js";
import { helmEvidence } from "../src/helm-evidence.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, access, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { validate, createPlan } from "../src/engine.js";
import { helmFixture, helmNative } from "./helm-fixture.js";
test(
  "native Helm missing tools are unavailable and deadlines cancellations retain incomplete outcomes",
  helmNative,
  async (t) => {
    const root = await helmFixture(t),
      missing = path.join(root, "missing"),
      before = process.env.PATH; // An empty search directory cannot supply the pinned executable.
    await mkdir(missing);
    try {
      process.env.PATH = missing;
      const unavailable = await validate(root, { trusted: true });
      assert.equal(unavailable.outcome, "incomplete");
      assert.equal(unavailable.checks[0]!.status, "unavailable");
      assert.equal(unavailable.checks[0]!.findingsComplete, false);
    } finally {
      if (before === undefined) delete process.env.PATH;
      else process.env.PATH = before;
    }
    const timed = await validate(root, { trusted: true, timeoutMs: 1 });
    assert.equal(timed.outcome, "incomplete");
    const check = (await createPlan(root)).plan.checks[0]!;
    const timedProcess = await runProcess(root, check.commands[0]!, {
      timeoutMs: 1,
    });
    assert.equal(timedProcess.timedOut, true);
    assert.equal(helmEvidence(check, [timedProcess]).status, "inconclusive");
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 10);
    let cancelled;
    try {
      cancelled = await validate(root, {
        trusted: true,
        signal: controller.signal,
        timeoutMs: 120000,
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(cancelled.outcome, "incomplete");
    const cancelledProcess = await runProcess(root, check.commands[0]!, {
      timeoutMs: 120000,
      signal: controller.signal,
    });
    assert.equal(cancelledProcess.cancelled, true);
    assert.equal(
      helmEvidence(check, [cancelledProcess]).status,
      "inconclusive",
    );
    const [a, b] = await Promise.all([
      validate(root, { trusted: true, timeoutMs: 120000 }),
      validate(root, { trusted: true, timeoutMs: 120000 }),
    ]);
    assert.equal(a.outcome, "passed", JSON.stringify(a.checks));
    assert.equal(b.outcome, "passed");
    const packets = [a, b].map((r) =>
      JSON.parse(r.checks[0]!.processes[0]!.stdout),
    );
    assert.notEqual(packets[0].temporary, packets[1].temporary);
    for (const packet of packets)
      await assert.rejects(access(packet.temporary), { code: "ENOENT" });
  },
);

test(
  "native Helm frozen collection rejects source and configuration changed after planning",
  helmNative,
  async (t) => {
    for (const selected of [
      "templates/settings.yaml",
      "checktrail.helm.json",
      "templates/original.key",
    ]) {
      const root = await helmFixture(t),
        check = (await createPlan(root)).plan.checks[0]!,
        file = path.join(root, selected),
        original = selected.endsWith(".key")
          ? undefined
          : await readFile(file, "utf8");
      await writeFile(file, (original ?? "original") + "\n");
      const result = await runProcess(root, check.commands[0]!, {
        timeoutMs: 120000,
      });
      assert.equal(result.exitCode, 2, selected);
      assert.equal(result.stdout, "");
      assert.equal(
        result.stderr,
        "Helm native collection unavailable or incomplete\n",
      );
      assert.equal(helmEvidence(check, [result]).status, "inconclusive");
      if (original === undefined) await unlink(file);
      else await writeFile(file, original);
      assert.equal(
        (await validate(root, { trusted: true, timeoutMs: 120000 })).outcome,
        "passed",
      );
    }
  },
);
