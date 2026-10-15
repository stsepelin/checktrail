import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { mavenHash } from "../src/maven.js";
import { createPlan, validate } from "../src/engine.js";
import {
  kustomizeResources,
  kustomizeSourceAddress,
} from "../src/kustomize.js";
import { kustomizeGeneratedConfigMapHash } from "../src/kustomize-extensions.js";
import {
  kustomizeEvidence,
  kustomizePacketSchema,
} from "../src/kustomize-evidence.js";
import {
  originalKustomizeExtensionInvocation,
  extendedKustomizeFixture,
  kustomizeExtensionNative,
} from "./kustomize-extensions-fixture.js";
test("Kustomize extension derives complete transformed values and addresses without native execution", () => {
  const models = kustomizeResources(originalKustomizeExtensionInvocation());
  assert.equal(models.length, 3);
  const deployment = models.find((m) => m.value.kind === "Deployment")!,
    generated = models.find((m) => m.value.kind === "ConfigMap")!;
  assert.equal(deployment.value.spec!.replicas, 3);
  assert.equal(
    deployment.value.metadata.name,
    "original-preview-original-worker",
  );
  assert.equal(deployment.value.metadata.namespace, "original-preview");
  assert.equal(
    kustomizeGeneratedConfigMapHash({ channel: "review", mode: "original" }),
    "6tf4mft8tf",
  );
  assert.equal(
    generated.value.metadata.name,
    "original-preview-original-settings-6tf4mft8tf",
  );
  assert.equal(
    kustomizeSourceAddress(
      deployment,
      "/spec/template/spec/containers/0/env/0/value",
    ).file,
    "overlay/strategic.yaml",
  );
  assert.equal(
    kustomizeSourceAddress(
      deployment,
      "/spec/template/spec/containers/0/env/1/valueFrom/configMapKeyRef/name",
    ).file,
    "base/deployment.yaml",
  );
  assert.equal(
    kustomizeSourceAddress(deployment, "/spec/template/spec/containers/0/image")
      .file,
    "overlay/kustomization.yaml",
  );
  const missing = originalKustomizeExtensionInvocation();
  missing.config = {
    ...missing.config,
    patches: [...missing.config.patches!, "overlay/omitted.yaml"],
  };
  assert.throws(() => kustomizeResources(missing), /closure/);
});
test(
  "native Kustomize extension reconciles patches namespace images replicas generated hashes and all reference paths with source-bound defects",
  kustomizeExtensionNative,
  async (t) => {
    const root = await extendedKustomizeFixture(t),
      clean = await validate(root, { trusted: true, timeoutMs: 120000 });
    assert.equal(clean.outcome, "passed", JSON.stringify(clean.checks));
    const packet = kustomizePacketSchema.parse(
      JSON.parse(clean.checks[0]!.processes[0]!.stdout),
    );
    assert.equal(packet.documents.length, 3);
    assert.match(
      packet.receipts[2]!.stdout,
      /original-preview-original-settings-6tf4mft8tf/g,
    );
    const file = path.join(root, "overlay/strategic.yaml"),
      text = await readFile(file, "utf8");
    await writeFile(
      file,
      text.replace("value: original-extra", "value: [original-extra]"),
    );
    const broken = await validate(root, { trusted: true, timeoutMs: 120000 });
    assert.equal(broken.outcome, "failed", JSON.stringify(broken.checks));
    assert.equal(broken.checks[0]!.findingsComplete, true);
    assert.ok(
      broken.checks[0]!.findings!.some(
        (f) =>
          f.file === "overlay/strategic.yaml" &&
          f.line ===
            text.slice(0, text.indexOf("value: original-extra")).split("\n")
              .length,
      ),
    );
    await writeFile(file, text);
    assert.equal(
      (await validate(root, { trusted: true, timeoutMs: 120000 })).outcome,
      "passed",
    );
    const json = path.join(root, "overlay/json.yaml"),
      original = await readFile(json, "utf8");
    await writeFile(
      json,
      "- op: add\n  path: /spec/template/spec/containers/0/resources\n  value:\n    limits:\n      cpu: [original-invalid]\n",
    );
    const jsonBroken = await validate(root, {
      trusted: true,
      timeoutMs: 120000,
    });
    assert.equal(
      jsonBroken.outcome,
      "failed",
      JSON.stringify(jsonBroken.checks),
    );
    assert.equal(jsonBroken.checks[0]!.findingsComplete, true);
    assert.ok(
      jsonBroken.checks[0]!.findings!.some(
        (f) => f.file === "overlay/json.yaml" && f.line === 5,
      ),
    );
    await writeFile(json, original);
    assert.equal(
      (await validate(root, { trusted: true, timeoutMs: 120000 })).outcome,
      "passed",
    );
  },
);
test(
  "native Kustomize extension old receipts reject current physical patch policy schema and source drift",
  kustomizeExtensionNative,
  async (t) => {
    const root = await extendedKustomizeFixture(t),
      check = (await createPlan(root)).plan.checks[0]!,
      clean = await validate(root, { trusted: true, timeoutMs: 120000 }),
      process = clean.checks[0]!.processes[0]!;
    assert.equal(clean.outcome, "passed", JSON.stringify(clean.checks));
    for (const file of [
      "overlay/json.yaml",
      "overlay/strategic.yaml",
      "base/deployment.yaml",
      "checktrail.kustomize.json",
      "tools/kubernetes/service-v1.json",
    ]) {
      const physical = path.join(root, file),
        bytes = await readFile(physical);
      try {
        const altered = Buffer.from(bytes);
        altered[0] = altered[0]! ^ 1;
        await writeFile(physical, altered);
        assert.equal(
          kustomizeEvidence(check, [process]).status,
          "inconclusive",
          file,
        );
      } finally {
        await writeFile(physical, bytes);
      }
      assert.equal(kustomizeEvidence(check, [process]).status, "passed", file);
    }
  },
);

test(
  "native Kustomize extension preserves all JSON operators strategic directives init containers and adjacent image names",
  kustomizeExtensionNative,
  async (t) => {
    const root = await extendedKustomizeFixture(t),
      file = path.join(root, "overlay/json.yaml"),
      strategic = path.join(root, "overlay/strategic.yaml"),
      overlay = path.join(root, "overlay/kustomization.yaml"),
      deployment = path.join(root, "base/deployment.yaml");
    await writeFile(
      overlay,
      (await readFile(overlay, "utf8")).replace(
        "namePrefix: original-preview-",
        "namePrefix: original-preview-\nnameSuffix: -checked",
      ),
    );
    await writeFile(
      deployment,
      (await readFile(deployment, "utf8")) +
        `      initContainers:\n        - name: original-init\n          image: registry.example.invalid/original:v1\n        - name: original-adjacent\n          image: registry.example.invalid/original-other:v1\n`,
    );
    await writeFile(
      file,
      `- op: test
  path: /spec/replicas
  value: 1
- op: add
  path: /metadata/labels
  value:
    original: keep
- op: copy
  from: /metadata/labels/original
  path: /metadata/labels/copied
- op: move
  from: /metadata/labels/copied
  path: /metadata/labels/moved
- op: replace
  path: /metadata/labels/moved
  value: replaced
- op: remove
  path: /metadata/labels/original
- op: add
  path: /spec/template/spec/containers/0/env/-
  value:
    name: ORIGINAL_APPENDED
    value: appended
`,
    );
    await writeFile(
      strategic,
      (await readFile(strategic, "utf8")) +
        `            - name: ORIGINAL_MODE\n              $patch: delete\n`,
    );
    const report = await validate(root, { trusted: true, timeoutMs: 120000 });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    const build = kustomizePacketSchema.parse(
      JSON.parse(report.checks[0]!.processes[0]!.stdout),
    ).receipts[2]!.stdout;
    assert.match(build, /name: original-preview-original-worker-checked/);
    assert.match(build, /moved: replaced/);
    assert.ok(!build.includes("name: ORIGINAL_MODE"));
    assert.match(build, /name: ORIGINAL_APPENDED/);
    assert.match(build, /image: registry.example.invalid\/repaired:v2/);
    assert.match(build, /image: registry.example.invalid\/original-other:v1/);
    await writeFile(
      strategic,
      `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: original-worker\nspec:\n  template:\n    spec:\n      containers:\n        - $patch: replace\n        - name: original-worker\n          image: registry.example.invalid/original:v1\n          env:\n            - name: ORIGINAL_REPLACED\n              value: replaced\n`,
    );
    await writeFile(file, `- op: test\n  path: /spec/replicas\n  value: 1\n`);
    assert.equal(
      (await validate(root, { trusted: true, timeoutMs: 120000 })).outcome,
      "passed",
    );
  },
);

test(
  "native Kustomize extension binds generated content hashes disabled hashes and physical addresses after strategic list insertion",
  kustomizeExtensionNative,
  async (t) => {
    for (const globalDisable of [false, true])
      for (const localDisable of [undefined, false, true]) {
        const root = await extendedKustomizeFixture(t),
          base = path.join(root, "base/kustomization.yaml");
        let text = await readFile(base, "utf8");
        text = text.replace(
          "  - name: original-settings",
          `  - name: original-settings${localDisable === undefined ? "" : "\n    options:\n      disableNameSuffixHash: " + localDisable}`,
        );
        if (globalDisable)
          text += "generatorOptions:\n  disableNameSuffixHash: true\n";
        await writeFile(base, text);
        const report = await validate(root, {
          trusted: true,
          timeoutMs: 120000,
        });
        assert.equal(
          report.outcome,
          "passed",
          JSON.stringify({
            globalDisable,
            localDisable,
            checks: report.checks,
          }),
        );
      }
    const root = await extendedKustomizeFixture(t),
      deployment = path.join(root, "base/deployment.yaml"),
      source = await readFile(deployment, "utf8");
    await writeFile(
      deployment,
      source.replace(
        "name: ORIGINAL_MODE\n              valueFrom:",
        "name: ORIGINAL_EXISTING\n              value: [original-invalid]\n            - name: ORIGINAL_MODE\n              valueFrom:",
      ),
    );
    const report = await validate(root, { trusted: true, timeoutMs: 120000 });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.findingsComplete, true);
    assert.ok(
      report.checks[0]!.findings!.some(
        (f) =>
          f.file === "base/deployment.yaml" &&
          f.line ===
            source.slice(0, source.indexOf("name: ORIGINAL_MODE")).split("\n")
              .length +
              1,
      ),
    );
  },
);

test("Kustomize extension image declarations require repository identities and keep registry ports", () => {
  for (const field of ["name", "newName"] as const) {
    const invocation = originalKustomizeExtensionInvocation(),
      item = invocation.inputs.find(
        (p) => p.path === "overlay/kustomization.yaml",
      )!;
    item.text = item.text.replace(
      field === "name"
        ? "name: registry.example.invalid/original"
        : "newName: registry.example.invalid/repaired",
      field + ": registry.example.invalid/original:v1",
    );
    item.sha256 = mavenHash(item.text);
    assert.throws(() => kustomizeResources(invocation), /repository identity/);
  }
  const invocation = originalKustomizeExtensionInvocation();
  for (const item of invocation.inputs) {
    item.text = item.text.replaceAll(
      "registry.example.invalid/",
      "registry.example.invalid:5000/",
    );
    item.sha256 = mavenHash(item.text);
  }
  assert.equal(kustomizeResources(invocation).length, 3);
});
test(
  "native Kustomize extension binds escaped Unicode generator data binary data and registry port image rewrites",
  kustomizeExtensionNative,
  async (t) => {
    const root = await extendedKustomizeFixture(t),
      base = path.join(root, "base/kustomization.yaml");
    await writeFile(
      base,
      (await readFile(base, "utf8")) +
        "      - 'html=<>&'\n      - 'unicode=雪<&>'\n",
    );
    await writeFile(
      path.join(root, "overlay/strategic.yaml"),
      "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: original-settings\nbinaryData:\n  original: b3JpZ2luYWw=\n",
    );
    for (const relative of [
      "base/deployment.yaml",
      "overlay/kustomization.yaml",
    ]) {
      const file = path.join(root, relative);
      await writeFile(
        file,
        (await readFile(file, "utf8")).replaceAll(
          "registry.example.invalid/",
          "registry.example.invalid:5000/",
        ),
      );
    }
    const report = await validate(root, { trusted: true, timeoutMs: 120000 });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    const build = kustomizePacketSchema.parse(
      JSON.parse(report.checks[0]!.processes[0]!.stdout),
    ).receipts[2]!.stdout;
    assert.match(build, /b3JpZ2luYWw=/);
    assert.match(build, /registry.example.invalid:5000\/repaired:v2/);
    assert.match(build, /雪<&>/);
  },
);
