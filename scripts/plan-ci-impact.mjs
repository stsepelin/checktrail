import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, appendFile } from "node:fs/promises";
import process from "node:process";
import { Buffer } from "node:buffer";
const { fetch, AbortSignal } = globalThis;
import { parse } from "yaml";
import {
  buildNativeInputs,
  acceptFullBaseline,
  requestFullBaselineJobs,
  workflowJobNames,
  nativeJobIds,
  planNativeJobs,
} from "./ci-impact.mjs";
const workflow = parse(await readFile(".github/workflows/ci.yml", "utf8"));
const jobs = nativeJobIds(workflow);
const inputs = JSON.parse(
  await readFile("scripts/ci-native-inputs.json", "utf8"),
);
let changed = null,
  baseline = null,
  contractCurrent = false;
try {
  const files = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 4 * 1048576,
  })
    .split("\0")
    .filter(Boolean);
  const current = await buildNativeInputs({
    workflow,
    requirements: JSON.parse(
      await readFile("scripts/required-native-tests.json", "utf8"),
    ),
    files,
    readText: (file) => readFile(file, "utf8"),
  });
  contractCurrent = JSON.stringify(current) === JSON.stringify(inputs);
  if (process.env.GITHUB_EVENT_NAME === "pull_request" && contractCurrent) {
    const event = JSON.parse(
      await readFile(process.env.GITHUB_EVENT_PATH, "utf8"),
    );
    const base = event.pull_request.base.sha,
      head = event.pull_request.head.sha;
    assert.match(base, /^[a-f0-9]{40}$/);
    assert.match(head, /^[a-f0-9]{40}$/);
    changed = execFileSync(
      "git",
      ["diff", "--name-only", "-z", "--no-renames", base + "..." + head],
      { encoding: "utf8", maxBuffer: 4 * 1048576 },
    )
      .split("\0")
      .filter(Boolean);
    assert.match(
      process.env.GITHUB_REPOSITORY,
      /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/,
    );
    const request = async (url) => {
      const response = await fetch(url, {
        headers: {
          Authorization: "Bearer " + process.env.GITHUB_TOKEN,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
      assert.equal(response.status, 200, "Baseline API request failed");
      const body = await response.text();
      assert.ok(Buffer.byteLength(body) <= 4 * 1048576);
      return JSON.parse(body);
    };
    const api = "https://api.github.com/repos/" + process.env.GITHUB_REPOSITORY;
    const runs = await request(
      api +
        "/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=" +
        base +
        "&status=completed&per_page=10",
    );
    const run = runs.workflow_runs.find(
      (r) =>
        r.head_sha === base &&
        r.head_branch === "main" &&
        r.event === "push" &&
        r.conclusion === "success",
    );
    if (run) {
      assert.ok(Number.isSafeInteger(run.id) && run.id > 0);
      assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
      const expectedNames = workflowJobNames(workflow);
      const result = await requestFullBaselineJobs(
        request,
        api +
          "/actions/runs/" +
          run.id +
          "/attempts/" +
          run.run_attempt +
          "/jobs",
        expectedNames.length,
      );
      // A successful push is full by policy. Bind the exact runtime job names,
      // run ID and commit; no skip or truncated inventory supplies a baseline.
      baseline = acceptFullBaseline(run, result, {
        base,
        expectedNames,
      });
    }
  }
} catch (error) {
  process.stderr.write(
    "Selective CI unavailable; keeping all native jobs: " +
      error.message +
      "\n",
  );
}
const plan = planNativeJobs({
  jobs,
  inputs,
  changed,
  baseline,
  contractCurrent,
  eventName: process.env.GITHUB_EVENT_NAME,
});
process.stdout.write(JSON.stringify(plan) + "\n");
await appendFile(
  process.env.GITHUB_OUTPUT,
  "plan=" + JSON.stringify(plan) + "\n",
);
await appendFile(
  process.env.GITHUB_STEP_SUMMARY,
  "### Native CI selection\n\nMode: **" +
    plan.mode +
    "**. " +
    plan.reason +
    ".\n\nSelected: " +
    Object.entries(plan.selected)
      .filter(([, selected]) => selected)
      .map(([id]) => "`" + id + "`")
      .join(", ") +
    ".\n\nNot selected (not passing evidence): " +
    (plan.notSelected.map((id) => "`" + id + "`").join(", ") || "none") +
    ".\n\nShared full-suite and fresh package/mutation verification remain required.\n",
);
