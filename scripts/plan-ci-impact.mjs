import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, appendFile } from "node:fs/promises";
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
  }
} catch (error) {
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
