import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { kubeDocuments } from "../src/kubeconform.js";
import {
  kubeconformEvidence,
  kubeconformPacketSchema,
} from "../src/kubeconform-evidence.js";
import { mavenHash } from "../src/maven.js";
import type { Check, ProcessResult } from "../src/types.js";
import {
  extendedKubernetesConfig,
  originalKubernetesResources,
  originalKubernetesText,
} from "./kubernetes-extensions-fixture.js";
const receipt = process.env.CHECKTRAIL_KUBERNETES_GUARD_RECEIPT,
  options = {
    skip: receipt
      ? false
      : "Fresh native Kubernetes guard receipt not selected",
  };
async function current() {
  const data = JSON.parse(await readFile(receipt!, "utf8")) as {
    root: string;
    check: Check;
    process: ProcessResult;
  };
  assert.equal(
    kubeconformEvidence(data.check, [data.process]).status,
    "passed",
    "Fresh original native receipt remains valid",
  );
  return data;
}
for (const [label, relative] of [
  ["source", "manifests/original.yaml"],
  ["policy", "checktrail.kubeconform.json"],
  ["schema", "tools/kubernetes/rolebinding-rbac-v1.json"],
  ["tool", null],
] as const)
  test(
    "Kubernetes guard checks current physical " + label + " bytes",
    options,
    async () => {
      const d = await current(),
        packet = kubeconformPacketSchema.parse(JSON.parse(d.process.stdout)),
        file = relative ? path.join(d.root, relative) : packet.tool.entry,
        original = await readFile(file);
      try {
        const changed = Buffer.from(original);
        changed[0] = changed[0]! ^ 1;
        await writeFile(file, changed);
        assert.equal(
          kubeconformEvidence(d.check, [d.process]).status,
          "inconclusive",
          label + " integrity guard",
        );
      } finally {
        await writeFile(file, original);
      }
    },
  );
const faults = [
  [
    "native schema inventory",
    (p: Packet) => {
      p.schemas.pop();
    },
  ],
  [
    "native schema pre-hash",
    (p: Packet) => {
      p.schemas[3]!.sha256 = "0".repeat(64);
    },
  ],
  [
    "native schema post-hash",
    (p: Packet) => {
      p.schemas[3]!.afterSha256 = "0".repeat(64);
    },
  ],
  [
    "native stdout hash",
    (p: Packet) => {
      p.receipts[0]!.stdoutSha256 = "0".repeat(64);
    },
  ],
  [
    "native stderr hash",
    (p: Packet) => {
      p.receipts[0]!.stderrSha256 = "0".repeat(64);
    },
  ],
  [
    "native command arguments",
    (p: Packet) => {
      p.receipts[1]!.args.push("-ignore-missing-schemas");
    },
  ],
  [
    "native resource participation",
    (p: Packet) => {
      const row = p.receipts[1]!,
        native = JSON.parse(row.stdout);
      native.resources.pop();
      native.summary.valid--;
      row.stdout = JSON.stringify(native);
      row.stdoutSha256 = mavenHash(row.stdout);
    },
  ],
  [
    "native skipped resources",
    (p: Packet) => {
      const row = p.receipts[1]!,
        native = JSON.parse(row.stdout);
      native.resources[0].status = "statusSkipped";
      native.summary.valid--;
      native.summary.skipped++;
      row.stdout = JSON.stringify(native);
      row.stdoutSha256 = mavenHash(row.stdout);
    },
  ],
] as const;
type Packet = ReturnType<typeof kubeconformPacketSchema.parse>;
for (const [label, mutate] of faults)
  test("Kubernetes guard checks " + label, options, async () => {
    const d = await current(),
      packet = kubeconformPacketSchema.parse(JSON.parse(d.process.stdout));
    mutate(packet);
    assert.equal(
      kubeconformEvidence(d.check, [
        { ...d.process, stdout: JSON.stringify(packet) },
      ]).status,
      "inconclusive",
      label,
    );
  });
for (const identity of ["kind", "API"] as const)
  test(
    "Kubernetes guard checks whole " + identity + " identifiers",
    options,
    () => {
      const resources = originalKubernetesResources();
      if (identity === "kind")
        resources.find((r) => r.kind === "RoleBinding")!.kind =
          "RoleBindingExtra";
      else
        resources.find((r) => r.kind === "Role")!.apiVersion =
          "rbac.authorization.k8s.io/v1beta1";
      const inputs = [
        {
          path: "checktrail.kubeconform.json",
          text: JSON.stringify(extendedKubernetesConfig),
        },
        {
          path: "manifests/original.yaml",
          text: originalKubernetesText(resources),
        },
      ].map((p) => ({ ...p, sha256: mavenHash(p.text) }));
      assert.throws(
        () => kubeDocuments(inputs, extendedKubernetesConfig),
        /kind\/version/,
      );
    },
  );
