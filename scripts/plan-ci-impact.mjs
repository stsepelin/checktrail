import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, appendFile, open } from "node:fs/promises";
import { constants } from "node:fs";
import process from "node:process";
import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
const { fetch, AbortSignal } = globalThis;
import { parse } from "yaml";
import {
  buildNativeInputs,
  acceptFullBaseline,
  requestFullBaselineJobs,
  requestFullBaselineChecks,
  acceptFullBaselineChecks,
  workflowJobNames,
  nativeJobIds,
  planNativeJobs,
} from "./ci-impact.mjs";
async function boundedPushEvent(file) {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    assert.ok(
      before.isFile() && before.size > 0n && before.size <= 4n * 1048576n,
      "Push event must be bounded regular metadata",
    );
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    for (let reads = 0; offset < bytes.length; reads++) {
      assert.ok(reads < 64, "Push event read budget exceeded");
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    assert.ok(
      offset === Number(before.size) &&
        ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(
          (key) => before[key] === after[key],
        ),
      "Push event changed during capture",
    );
    return JSON.parse(bytes.subarray(0, offset).toString("utf8"));
  } finally {
    await handle.close();
  }
}
const metadataGit = (args) =>
  execFileSync(
    "git",
    [
      "--no-pager",
      "--no-replace-objects",
      "-c",
      "core.fsmonitor=false",
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 4 * 1048576,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_NO_LAZY_FETCH: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
    },
  );

const workflow = parse(await readFile(".github/workflows/ci.yml", "utf8"));
const jobs = nativeJobIds(workflow);
const inputs = JSON.parse(
  await readFile("scripts/ci-native-inputs.json", "utf8"),
);
let changed = null,
  baseline = null,
  contractCurrent = false,
  producerInventory = null,
  qualifiedPush = null;
try {
  const files = metadataGit(["ls-files", "-z"]).split("\0").filter(Boolean);
  producerInventory = files;
  const current = await buildNativeInputs({
    workflow,
    requirements: JSON.parse(
      await readFile("scripts/required-native-tests.json", "utf8"),
    ),
    files,
    readText: (file) => readFile(file, "utf8"),
  });
  contractCurrent = isDeepStrictEqual(current, inputs);
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
    // Optional historical context is never a prerequisite for testing the PR's
    // current declared inputs. It cannot qualify an omitted job at this revision.
    if (process.env.CHECKTRAIL_CI_OBSERVE_BASELINE === "1") {
      assert.match(
        process.env.GITHUB_REPOSITORY,
        /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/,
      );
      const request = async (url) => {
        let response;
        try {
          response = await fetch(url, {
            headers: {
              Authorization: "Bearer " + process.env.GITHUB_TOKEN,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            signal: AbortSignal.timeout(15000),
            redirect: "error",
          });
        } catch {
          throw Object.assign(new Error("Baseline API transport unavailable"), {
            code: "CI_BASELINE_API_UNAVAILABLE",
          });
        }
        if ([429, 500, 502, 503, 504].includes(response.status)) {
          throw Object.assign(
            new Error("Baseline API temporarily unavailable"),
            {
              code: "CI_BASELINE_API_UNAVAILABLE",
            },
          );
        }
        assert.equal(response.status, 200, "Baseline API request failed");
        const body = await response.text();
        assert.ok(Buffer.byteLength(body) <= 4 * 1048576);
        return JSON.parse(body);
      };
      const api =
        "https://api.github.com/repos/" + process.env.GITHUB_REPOSITORY;
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
        const seenJobNames = new Set(),
          seenJobIds = new Set();
        const requestJobs = async (url) => {
          const page = await request(url);
          assert.ok(Array.isArray(page.jobs), "Baseline job page is malformed");
          for (const job of page.jobs) {
            assert.ok(
              job &&
                Number.isSafeInteger(job.id) &&
                job.id > 0 &&
                job.run_id === run.id &&
                job.status === "completed" &&
                job.conclusion === "success" &&
                expectedNames.includes(job.name) &&
                !seenJobIds.has(job.id) &&
                !seenJobNames.has(job.name),
              "Observed baseline job is not a distinct successful expected job",
            );
            seenJobIds.add(job.id);
            seenJobNames.add(job.name);
          }
          return page;
        };
        try {
          const result = await requestFullBaselineJobs(
            requestJobs,
            api +
              "/actions/runs/" +
              run.id +
              "/attempts/" +
              run.run_attempt +
              "/jobs",
            expectedNames.length,
          );
          // Valid but failed, skipped or incomplete jobs remain unqualified.
          baseline = acceptFullBaseline(run, result, { base, expectedNames });
        } catch (error) {
          if (error?.code !== "CI_BASELINE_API_UNAVAILABLE") throw error;
          assert.ok(
            Number.isSafeInteger(run.check_suite_id) && run.check_suite_id > 0,
          );
          const result = await requestFullBaselineChecks(
            request,
            api + "/check-suites/" + run.check_suite_id + "/check-runs",
            expectedNames.length,
          );
          // Pagination is bounded; the run must still be the same successful
          // attempt after the final page. A concurrent retry invalidates reuse.
          const observedRun = await request(api + "/actions/runs/" + run.id);
          baseline = acceptFullBaselineChecks(run, result, {
            base,
            expectedNames,
            repository: process.env.GITHUB_REPOSITORY,
            observedRun,
          });
        }
      }
    }
  } else if (process.env.GITHUB_EVENT_NAME === "push" && contractCurrent) {
    const event = await boundedPushEvent(process.env.GITHUB_EVENT_PATH);
    assert.equal(process.env.GITHUB_REF, "refs/heads/main");
    assert.equal(event.ref, "refs/heads/main");
    assert.equal(event.forced, false);
    assert.equal(event.deleted, false);
    const repository = process.env.GITHUB_REPOSITORY;
    assert.equal(typeof repository, "string");
    assert.ok(repository.length <= 201);
    assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
    assert.ok(
      repository
        .split("/")
        .every((part) => part !== "." && part !== ".." && part.length <= 100),
    );
    assert.equal(event.repository?.full_name, repository);
    const [owner, name] = repository.split("/");
    assert.equal(event.repository.name, name);
    assert.equal(event.repository.owner?.login, owner);
    const before = event.before,
      after = event.after;
    for (const value of [before, after]) {
      assert.equal(typeof value, "string");
      assert.match(value, /^[a-f0-9]{40}$/u);
      assert.notEqual(value, "0".repeat(40));
    }
    assert.notEqual(before, after);
    assert.equal(process.env.GITHUB_SHA, after);
    const checkoutSha = metadataGit([
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]).trim();
    assert.equal(checkoutSha, after);
    for (const value of [before, after])
      assert.equal(metadataGit(["cat-file", "-t", value]).trim(), "commit");
    metadataGit(["merge-base", "--is-ancestor", before, after]);
    changed = metadataGit([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
      "-z",
      "--no-renames",
      before + ".." + after,
      "--",
    ])
      .split("\0")
      .filter(Boolean);
    qualifiedPush = Object.freeze({
      schemaVersion: 1,
      repository: event.repository.full_name,
      githubRepository: repository,
      ref: event.ref,
      before,
      after,
      githubSha: process.env.GITHUB_SHA,
      checkoutSha,
      ancestorVerified: true,
      comparison: "before..after",
      forced: false,
      deleted: false,
    });
  }
} catch (error) {
  if (process.env.GITHUB_EVENT_NAME === "push") {
    changed = null;
    qualifiedPush = null;
    process.stderr.write(
      "Main push qualification unavailable; full verification is required.\n",
    );
  } else
    process.stderr.write(
      "CI planning or optional baseline observation failed: " +
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
  producerInventory,
  qualifiedPush,
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
    ".\n\n" +
    (plan.mode === "full"
      ? "Full shared suites and package/mutation verification are required."
      : "Shared typecheck, lint, formatting, audits and selected full test files are required. Omitted native jobs and package/mutation phases are untested at this revision; no Gate A qualification is claimed.") +
    "\n",
);
