import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers.js";
const { captureControllerSourceScope, executeOriginalControllerScript } =
  await import(
    new URL(
      "../../scripts/preserved-baseline-source-worker.mjs",
      import.meta.url,
    ).href
  );
const { nativeBaselineBindings, originalReviewSourceProfiles } = await import(
  new URL(
    "../../scripts/preserved-native-baseline-bindings.mjs",
    import.meta.url,
  ).href
);
const { freshNativeDockerArgs, ownedDockerRun } = await import(
  new URL(
    "../../scripts/preserved-native-baseline-controller.mjs",
    import.meta.url,
  ).href
);
const repository = fileURLToPath(new URL("../../", import.meta.url));

test("finite native controller scopes retain every original frozen callback and reject changed source selections", async () => {
  const registry = JSON.parse(
    await readFile(
      path.join(repository, "scripts/preserved-baseline-cohorts.v1.json"),
      "utf8",
    ),
  );
  const frozen = JSON.parse(
    await readFile(
      path.join(repository, "docs/gate-a-native-baseline.v1.json"),
      "utf8",
    ),
  );
  const profiles = new Set<string>(),
    callbacks = new Set<string>();
  for (const name of Object.keys(nativeBaselineBindings)) {
    const cohort = registry.cohorts[name];
    const selections =
      name === "external-adapters"
        ? [["external-protocol"], ["policy-distribution"]]
        : [cohort.profiles];
    for (const selection of selections) {
      const scope = await captureControllerSourceScope(
        repository,
        name,
        selection,
      );
      assert.deepEqual(scope.sourceScope.selection, selection);
      for (const profile of scope.sourceScope.baselineSelection) {
        profiles.add(profile);
        assert.deepEqual(
          scope.sourceScope.baselineProfiles[profile],
          frozen[profile],
        );
        for (const row of frozen[profile])
          callbacks.add(JSON.stringify([row.file, row.name]));
      }
      await assert.rejects(
        captureControllerSourceScope(repository, name, [
          ...selection,
          ...selection,
        ]),
        /Duplicate|strictly equal/,
      );
    }
  }
  assert.equal(profiles.size, 12);
  assert.equal(callbacks.size, 65);
  const review = await captureControllerSourceScope(
    repository,
    "packaged-review",
    [...originalReviewSourceProfiles],
  );
  assert.ok(review.sourceScope.selection.includes("mcp-tasks"));
  assert.ok(!review.sourceScope.baselineSelection.includes("mcp-tasks"));
  await assert.rejects(
    captureControllerSourceScope(
      repository,
      "packaged-review",
      originalReviewSourceProfiles.filter(
        (name: string) => name !== "mcp-tasks",
      ),
    ),
    /Original review source selection changed/,
  );
  await assert.rejects(
    captureControllerSourceScope(repository, "external-adapters", [
      "external-protocol",
      "policy-distribution",
    ]),
    /must stay separate/,
  );
  await assert.rejects(
    captureControllerSourceScope(repository, "host-core", ["core"]),
    /Unknown native baseline source cohort/,
  );
  await assert.rejects(
    captureControllerSourceScope(repository, "ruby-suffix", ["ruby"]),
    /Unknown source cohort/,
  );
});

test("native source scope refuses altered frozen bytes and missing original callback before native execution", async (t) => {
  const files: Record<string, string> = {};
  for (const file of [
    "scripts/preserved-baseline-cohorts.v1.json",
    "scripts/required-native-tests.json",
    "docs/gate-a-native-baseline.v1.json",
  ]) {
    files[file] = await readFile(path.join(repository, file), "utf8");
  }
  const changed = JSON.parse(files["scripts/required-native-tests.json"]!);
  changed.ruby = [];
  const root = await fixture(t, {
    ...files,
    "scripts/required-native-tests.json": JSON.stringify(changed),
  });
  await assert.rejects(captureControllerSourceScope(root, "ruby", ["ruby"]));
  const stale = await fixture(t, {
    ...files,
    "docs/gate-a-native-baseline.v1.json":
      files["docs/gate-a-native-baseline.v1.json"] + "\n",
  });
  await assert.rejects(
    captureControllerSourceScope(stale, "ruby", ["ruby"]),
    /Frozen source baseline bytes changed/,
  );
});

test("fresh native transport retains original Ruby libraries and Nuxt source mount while adding readonly canonical harness paths", () => {
  const base = [
    "run",
    "--rm",
    "--init",
    "--network",
    "none",
    "--mount",
    "type=bind,src=/synthetic/node,target=/usr/local/bin/node,readonly",
    "--mount",
    "type=bind,src=/synthetic/libgcc,target=/usr/lib/libgcc_s.so.1,readonly",
    "--mount",
    "type=bind,src=/synthetic/nuxt,target=/workspace/.checktrail/nuxt-tools,readonly",
    "--workdir",
    "/workspace",
    "sha256:" + "a".repeat(64),
  ];
  const copy = structuredClone(base);
  const args = freshNativeDockerArgs({
    containerArgs: base,
    repository: "/synthetic repository",
    temporary: "/synthetic temp",
    harness: "/synthetic temp/harness",
    worker: "/synthetic temp/harness/scripts/preserved-baseline-worker.mjs",
    inputFile: "/synthetic temp/input.json",
    extraMounts: [
      "--mount",
      "type=bind,src=/synthetic/nuxt,target=/synthetic temp/harness/.checktrail/nuxt-tools,readonly",
    ],
  });
  assert.deepEqual(base, copy);
  assert.ok(
    args.includes(
      "type=bind,src=/synthetic/node,target=/usr/local/bin/node,readonly",
    ),
  );
  assert.ok(
    args.includes(
      "type=bind,src=/synthetic/libgcc,target=/usr/lib/libgcc_s.so.1,readonly",
    ),
  );
  assert.ok(
    args.includes(
      "type=bind,src=/synthetic/nuxt,target=/workspace/.checktrail/nuxt-tools,readonly",
    ),
  );
  assert.ok(
    args.includes(
      "type=bind,src=/synthetic repository,target=/synthetic repository,readonly",
    ),
  );
  assert.ok(
    args.includes(
      "type=bind,src=/synthetic temp,target=/synthetic temp,readonly",
    ),
  );
  assert.equal(args.filter((arg: string) => arg === "--workdir").length, 1);
  assert.equal(args[args.indexOf("--workdir") + 1], "/synthetic temp/harness");
  assert.deepEqual(args.slice(-4), [
    "sha256:" + "a".repeat(64),
    "node",
    "/synthetic temp/harness/scripts/preserved-baseline-worker.mjs",
    "/synthetic temp/input.json",
  ]);
});

test("owned native transport cleans only its generated container on success failure timeout and already-removed near miss", () => {
  for (const outcome of ["success", "failure", "timeout", "already-removed"]) {
    const calls: string[][] = [];
    const failure = Object.assign(
      new Error("synthetic native transport failure"),
      outcome === "timeout" ? { code: "ETIMEDOUT" } : {},
    );
    const invoke = (args: string[]) => {
      calls.push(args);
      if (args[0] === "run" && ["failure", "timeout"].includes(outcome))
        throw failure;
      if (args[0] === "rm" && outcome === "already-removed")
        throw Object.assign(new Error("synthetic cleanup"), {
          stderr: "Error response from daemon: No such container",
        });
      return "synthetic transport output";
    };
    if (["failure", "timeout"].includes(outcome))
      assert.throws(
        () => ownedDockerRun(["run", "--rm", "image"], invoke),
        (error) => error === failure,
      );
    else
      assert.equal(
        ownedDockerRun(["run", "--rm", "image"], invoke),
        "synthetic transport output",
      );
    assert.equal(calls.length, 2);
    const name = calls[0]![2]!;
    assert.match(name, /^checktrail-native-baseline-/);
    assert.deepEqual(calls[1], ["rm", "--force", name]);
  }
  let calls = 0;
  assert.throws(
    () =>
      ownedDockerRun(["run", "--name", "unrelated", "image"], () => {
        calls++;
        return "";
      }),
    /already own/,
  );
  assert.equal(calls, 0);
});

test("source process transport invokes the exact original fixed script once and rejects failed or unavailable processes", () => {
  const calls: Array<{
    command: string;
    args: string[];
    options: {
      cwd: string;
      env: Record<string, string | undefined>;
      timeout: number;
    };
  }> = [];
  const invoke = (
    command: string,
    args: string[],
    options: (typeof calls)[number]["options"],
  ) => {
    calls.push({ command, args, options });
    return {
      status: 0,
      stdout: JSON.stringify({ syntheticTransportOnly: true }),
      stderr: "",
    };
  };
  const output = executeOriginalControllerScript(
    "/synthetic repository",
    ["ruby"],
    invoke,
  );
  assert.deepEqual(output, { syntheticTransportOnly: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.command, process.execPath);
  assert.deepEqual(calls[0]!.args, [
    "scripts/verify-required-native-tests.mjs",
    "ruby",
  ]);
  assert.equal(calls[0]!.options.cwd, "/synthetic repository");
  assert.equal(calls[0]!.options.env.NODE_TEST_CONTEXT, undefined);
  assert.equal(calls[0]!.options.timeout, 660000);
  assert.throws(
    () =>
      executeOriginalControllerScript("/synthetic", ["ruby"], () => ({
        status: 1,
        stdout: "",
        stderr: "",
      })),
    /Original source cohort failed/,
  );
  assert.throws(
    () =>
      executeOriginalControllerScript("/synthetic", ["ruby"], () => ({
        status: null,
        error: new Error("synthetic unavailable"),
        stdout: "",
        stderr: "",
      })),
    /Original source process failed/,
  );
});
