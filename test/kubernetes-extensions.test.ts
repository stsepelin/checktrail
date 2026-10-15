import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPlan, validate } from "../src/engine.js";
import {
  kubeDocuments,
  kubeSchemaPins,
  kubeSchemaPinsFor,
} from "../src/kubeconform.js";
import {
  kubeconformEvidence,
  kubeconformPacketSchema,
} from "../src/kubeconform-evidence.js";
import { kubernetesExtensionPins } from "../src/kubernetes-extensions.js";
import { mavenHash } from "../src/maven.js";
import {
  extendedKubernetesConfig,
  extendedKubernetesNative,
  extendedKubernetesFixture,
  originalKubernetesResources,
  originalKubernetesText,
  originalKubernetesFaults,
  breakOriginalResource,
} from "./kubernetes-extensions-fixture.js";
const invocation = (text = originalKubernetesText(), extended = true) => {
  const config = extended
    ? extendedKubernetesConfig
    : { ...extendedKubernetesConfig, schemaProfile: undefined };
  return {
    config,
    inputs: [
      { path: "checktrail.kubeconform.json", text: JSON.stringify(config) },
      { path: "manifests/original.yaml", text },
    ].map((p) => ({ ...p, sha256: mavenHash(p.text) })),
  };
};
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
test("Kubernetes extended kinds preserve baseline pins and require exact whole kind and API identities", () => {
  assert.equal(kubeSchemaPins.length, 3);
  assert.equal(kubernetesExtensionPins.length, 10);
  assert.equal(kubeSchemaPinsFor(extendedKubernetesConfig).length, 13);
  const data = invocation();
  assert.equal(kubeDocuments(data.inputs, data.config).length, 13);
  const baseline = invocation(originalKubernetesText(), false);
  assert.throws(
    () => kubeDocuments(baseline.inputs, baseline.config),
    /kind\/version/,
  );
  for (const resources of [
    originalKubernetesResources().map((r) =>
      r.kind === "RoleBinding" ? { ...r, kind: "RoleBindingExtra" } : r,
    ),
    originalKubernetesResources().map((r) =>
      r.kind === "Role"
        ? { ...r, apiVersion: "rbac.authorization.k8s.io/v1beta1" }
        : r,
    ),
  ]) {
    const changed = invocation(originalKubernetesText(resources));
    assert.throws(
      () => kubeDocuments(changed.inputs, changed.config),
      /kind\/version/,
    );
  }
});
test(
  "native Kubernetes extension validates every added schema and source-bound type defect with paired repairs",
  extendedKubernetesNative,
  async (t) => {
    const root = await extendedKubernetesFixture(t),
      source = path.join(root, "manifests/original.yaml"),
      clean = await readFile(source, "utf8");
    const initial = await run(root);
    assert.equal(initial.outcome, "passed", JSON.stringify(initial.checks));
    const check = (await createPlan(root)).plan.checks[0]!,
      good = initial.checks[0]!.processes[0]!;
    const packet = kubeconformPacketSchema.parse(JSON.parse(good.stdout));
    assert.equal(packet.schemas.length, 13);
    assert.equal(packet.documents.length, 13);
    for (const fault of originalKubernetesFaults) {
      const resources = originalKubernetesResources();
      breakOriginalResource(resources, fault);
      await writeFile(source, originalKubernetesText(resources));
      const broken = await run(root),
        result = broken.checks[0]!;
      assert.equal(
        result.status,
        "failed",
        fault.kind + ": " + JSON.stringify(result),
      );
      assert.equal(result.findingsComplete, true, fault.kind);
      assert.ok(
        result.findings?.some(
          (f) =>
            f.file === "manifests/original.yaml" &&
            f.line! > 0 &&
            f.message.startsWith(fault.kind + " "),
        ),
        fault.kind + " has actual source-bound native diagnostic",
      );
      await writeFile(source, clean);
      assert.equal(
        (await run(root)).outcome,
        "passed",
        fault.kind + " paired repair",
      );
    }
    for (const corrupt of [
      (p: typeof packet) => p.schemas.pop(),
      (p: typeof packet) => (p.schemas[3]!.sha256 = "0".repeat(64)),
      (p: typeof packet) => (p.schemas[3]!.afterSha256 = "0".repeat(64)),
      (p: typeof packet) => p.documents.pop(),
    ]) {
      const changed = structuredClone(packet);
      corrupt(changed);
      assert.equal(
        kubeconformEvidence(check, [
          { ...good, stdout: JSON.stringify(changed) },
        ]).status,
        "inconclusive",
      );
    }
  },
);
test(
  "native Kubernetes extended receipts bind current physical source policy and schema bytes",
  extendedKubernetesNative,
  async (t) => {
    const root = await extendedKubernetesFixture(t),
      check = (await createPlan(root)).plan.checks[0]!,
      report = await run(root),
      process = report.checks[0]!.processes[0]!;
    assert.equal(report.outcome, "passed");
    for (const file of [
      "manifests/original.yaml",
      "checktrail.kubeconform.json",
      "tools/kubernetes/rolebinding-rbac-v1.json",
    ]) {
      const target = path.join(root, file),
        original = await readFile(target);
      try {
        await writeFile(target, Buffer.concat([original, Buffer.from("\n")]));
        assert.equal(
          kubeconformEvidence(check, [process]).status,
          "inconclusive",
          file +
            " drift must invalidate an otherwise coherent retained receipt",
        );
      } finally {
        await writeFile(target, original);
      }
      assert.equal(
        kubeconformEvidence(check, [process]).status,
        "passed",
        file + " exact restoration",
      );
    }
  },
);
