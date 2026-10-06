import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, cp, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseAllDocuments } from "yaml";
import { fixture } from "./helpers.js";
import { mavenHash } from "../src/maven.js";
import {
  kustomizeBinarySha256,
  kustomizeResources,
  kustomizeSourceAddress,
  kustomizeCanonical,
} from "../src/kustomize.js";
import { kustomizeInvocation as original } from "./kustomize-fixture.js";

test("Kustomize passive assembly distinguishes raw source addresses from explicit overlay overrides", () => {
  const input = original(),
    resources = kustomizeResources(input);
  assert.equal(resources.length, 2);
  const deployment = resources.find((r) => r.value.kind === "Deployment")!;
  assert.equal(deployment.value.metadata.name, "original-original-worker");
  assert.equal(deployment.value.spec!.replicas, 3);
  assert.equal(
    deployment.value.metadata.annotations!["config.kubernetes.io/origin"],
    "path: ../base/deployment.yaml\n",
  );
  assert.deepEqual(kustomizeSourceAddress(deployment, "/spec/replicas"), {
    file: "overlay/kustomization.yaml",
    line: 8,
  });
  assert.deepEqual(kustomizeSourceAddress(deployment, "/metadata/name"), {
    file: "overlay/kustomization.yaml",
    line: 5,
  });
  assert.deepEqual(
    kustomizeSourceAddress(
      deployment,
      "/spec/template/spec/containers/0/image",
    ),
    { file: "base/deployment.yaml", line: 17 },
  );
  assert.equal(
    kustomizeCanonical({ b: [{ x: 1, y: 2 }], a: 0 }),
    kustomizeCanonical({ a: 0, b: [{ y: 2, x: 1 }] }),
  );
  assert.notEqual(kustomizeCanonical([1, 2]), kustomizeCanonical([2, 1]));
});
test("Kustomize passive assembly rejects remote cyclic omitted duplicate plugin generator and ambiguous selectors", () => {
  for (const [label, file, edit] of [
    [
      "remote",
      "overlay/kustomization.yaml",
      (s: string) => s.replace("../base", "https://example.invalid/base"),
    ],
    [
      "cycle",
      "base/kustomization.yaml",
      (s: string) => s.replace("deployment.yaml", "../overlay"),
    ],
    [
      "omitted",
      "base/kustomization.yaml",
      (s: string) => s.replace("  - settings.yaml\n", ""),
    ],
    [
      "duplicate",
      "base/kustomization.yaml",
      (s: string) => s.replace("  - settings.yaml", "  - deployment.yaml"),
    ],
    [
      "plugin",
      "overlay/kustomization.yaml",
      (s: string) => s + "generators:\n  - original.yaml\n",
    ],
    [
      "unknown selector",
      "overlay/kustomization.yaml",
      (s: string) =>
        s.replace("name: original-worker", "name: original-worker-other"),
    ],
    [
      "origin spoof",
      "base/deployment.yaml",
      (s: string) =>
        s.replace(
          "  name: original-worker",
          "  name: original-worker\n  annotations:\n    config.kubernetes.io/origin: original-spoof",
        ),
    ],
  ] as const) {
    const input = original(),
      source = input.inputs.find((i) => i.path === file)!;
    source.text = edit(source.text);
    source.sha256 = mavenHash(source.text);
    const reasons = {
      remote: /Local canonical resources required/,
      cycle: /Cyclic or repeated assembly/,
      omitted: /Complete assembly scope required/,
      duplicate: /Foreign or repeated resource/,
      plugin: /generators/,
      "unknown selector": /Replica selector must match one Deployment/,
      "origin spoof": /Source cannot claim native origin/,
    };
    assert.throws(() => kustomizeResources(input), reasons[label], label);
  }
});

test("Kustomize source ownership rejects empty claimed origins and native scratch collisions while preserving unrelated annotations", () => {
  const empty = original(),
    resource = empty.inputs.find((i) => i.path === "base/deployment.yaml")!;
  resource.text = resource.text.replace(
    "  name: original-worker",
    '  name: original-worker\n  annotations:\n    config.kubernetes.io/origin: ""',
  );
  resource.sha256 = mavenHash(resource.text);
  assert.throws(
    () => kustomizeResources(empty),
    /Source cannot claim native origin/,
  );
  const reserved = original();
  reserved.config.kustomizations = reserved.config.kustomizations.map((file) =>
    file.replace("base/", "schemas/"),
  );
  reserved.config.resources = reserved.config.resources.map((file) =>
    file.replace("base/", "schemas/"),
  );
  for (const input of reserved.inputs) {
    input.path = input.path.replace("base/", "schemas/");
    input.text =
      input.path === "checktrail.kustomize.json"
        ? JSON.stringify(reserved.config)
        : input.text.replace("../base", "../schemas");
    input.sha256 = mavenHash(input.text);
  }
  assert.throws(
    () => kustomizeResources(reserved),
    /Native scratch names are reserved/,
  );
  const nonfinite = original(),
    nonfiniteSource = nonfinite.inputs.find(
      (i) => i.path === "base/settings.yaml",
    )!;
  nonfiniteSource.text = nonfiniteSource.text.replace(
    'original: "value"',
    "original: .nan",
  );
  nonfiniteSource.sha256 = mavenHash(nonfiniteSource.text);
  assert.throws(
    () => kustomizeResources(nonfinite),
    /Finite JSON values required/,
  );
  assert.throws(
    () => kustomizeCanonical({ value: Number.POSITIVE_INFINITY }),
    /Finite JSON values required/,
  );
  assert.equal(kustomizeCanonical({ value: null }), '{"value":null}');
  const near = original(),
    source = near.inputs.find((i) => i.path === "base/deployment.yaml")!;
  source.text = source.text.replace(
    "  name: original-worker",
    "  name: original-worker\n  annotations:\n    original: literal",
  );
  source.sha256 = mavenHash(source.text);
  const built = kustomizeResources(near).find(
    (r) => r.value.kind === "Deployment",
  )!;
  assert.equal(built.value.metadata.annotations!.original, "literal");
  assert.equal(
    built.value.metadata.annotations!["config.kubernetes.io/origin"],
    "path: ../base/deployment.yaml\n",
  );
});

test(
  "native Kustomize output reconciles passive multi-file origins prefix and replica overrides including zero",
  {
    skip:
      process.env.CHECKTRAIL_INFRA_TOOLS_NATIVE !== "1"
        ? "Pinned infrastructure native profile not selected"
        : false,
    timeout: 120000,
  },
  async (t) => {
    const input = original(),
      root = await fixture(
        t,
        Object.fromEntries(input.inputs.map((i) => [i.path, i.text])),
      );
    assert.equal(
      mavenHash(await readFile("/usr/local/bin/kustomize")),
      kustomizeBinarySha256,
    );
    const version = spawnSync("/usr/local/bin/kustomize", ["version"], {
      encoding: "utf8",
    });
    assert.equal(version.status, 0);
    assert.equal(version.stdout, "v5.8.2\n");
    assert.equal(version.stderr, "");
    const compare = () => {
      const result = spawnSync(
        "/usr/local/bin/kustomize",
        [
          "build",
          input.config.root,
          "--load-restrictor",
          "LoadRestrictionsRootOnly",
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: { PATH: process.env.PATH, HOME: root },
          timeout: 30000,
          maxBuffer: 1024 * 1024,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      const documents = parseAllDocuments(result.stdout, {
        uniqueKeys: true,
        strict: true,
      });
      assert.equal(documents.length, input.config.resources.length);
      const observed = documents
        .map((d) => {
          assert.deepEqual(d.errors, []);
          assert.deepEqual(d.warnings, []);
          return kustomizeCanonical(d.toJS());
        })
        .sort();
      assert.deepEqual(
        observed,
        kustomizeResources(input)
          .map((r) => kustomizeCanonical(r.value))
          .sort(),
      );
    };
    compare();
    const overlay = input.inputs.find(
      (i) => i.path === "overlay/kustomization.yaml",
    )!;
    overlay.text = overlay.text.replace("count: 3", "count: 0");
    overlay.sha256 = mavenHash(overlay.text);
    await writeFile(path.join(root, overlay.path), overlay.text);
    compare();
  },
);

test(
  "native Kustomize collector reconciles rendered schema defects original source addresses repair and cleanup",
  {
    skip:
      process.env.CHECKTRAIL_INFRA_TOOLS_NATIVE !== "1"
        ? "Pinned infrastructure native profile not selected"
        : false,
    timeout: 120000,
  },
  async (t) => {
    const input = original(),
      root = await fixture(
        t,
        Object.fromEntries(input.inputs.map((i) => [i.path, i.text])),
      );
    await cp(
      "/opt/checktrail-schemas",
      path.join(root, input.config.schemaDirectory),
      { recursive: true },
    );
    const invoke = () => {
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("../src/kustomize-runner.js", import.meta.url)),
          root,
          JSON.stringify(input),
        ],
        { cwd: root, encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024 },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      return JSON.parse(result.stdout);
    };
    const passed = invoke();
    assert.equal(passed.receipts.length, 4);
    assert.equal(passed.receipts[2].exitCode, 0);
    const good = JSON.parse(passed.receipts[3].stdout);
    assert.equal(passed.receipts[3].exitCode, 0);
    assert.deepEqual(good.summary, {
      valid: 2,
      invalid: 0,
      errors: 0,
      skipped: 0,
    });
    await assert.rejects(access(passed.temporary), { code: "ENOENT" });
    const source = input.inputs.find((i) => i.path === "base/settings.yaml")!,
      originalText = source.text;
    source.text = source.text.replace('original: "value"', "original: 2");
    source.sha256 = mavenHash(source.text);
    await writeFile(path.join(root, source.path), source.text);
    const broken = invoke(),
      native = JSON.parse(broken.receipts[3].stdout);
    assert.equal(broken.receipts[3].exitCode, 1);
    assert.deepEqual(native.summary, {
      valid: 1,
      invalid: 1,
      errors: 0,
      skipped: 0,
    });
    const invalid = native.resources.find(
      (r: { status: string }) => r.status === "statusInvalid",
    );
    assert.equal(invalid.validationErrors.length, 1);
    const rendered = broken.documents.find(
      (d: { file: string }) => d.file === invalid.filename,
    );
    assert.equal(rendered.source, "base/settings.yaml");
    const model = kustomizeResources(input).find(
      (r) => r.source.file === rendered.source,
    )!;
    assert.deepEqual(
      kustomizeSourceAddress(model, invalid.validationErrors[0].path),
      {
        file: "base/settings.yaml",
        line:
          source.text
            .split("\n")
            .findIndex((line) => line.includes("original: 2")) + 1,
      },
    );
    assert.match(
      invalid.validationErrors[0].msg,
      /got number, want null or string/,
    );
    await assert.rejects(access(broken.temporary), { code: "ENOENT" });
    source.text = originalText;
    source.sha256 = mavenHash(source.text);
    await writeFile(path.join(root, source.path), source.text);
    assert.equal(invoke().receipts[3].exitCode, 0);
  },
);
